// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISupplyChain
/// @notice Custody and traceability. This is where the chain of custody
///         gets built, one validated handoff at a time.
/// @dev Owner: Pranav Arora.
///
///      Implement as:
///        contract SupplyChain is ISupplyChain, ReentrancyGuard
///        constructor(address registry)
///
///      Admin checks: registry.hasRole(Roles.ADMIN, msg.sender).
///
///      HOW STOCK MOVES. A batch can be split across many facilities, so
///      custody is tracked as stock per facility in InventoryManager, not as
///      a single "current holder". A transfer is two steps:
///
///        transferCustody   sender's units move into escrow (this contract)
///        acceptConsignment escrow moves to the recipient, trail is appended
///        rejectConsignment escrow returns to the sender
///        cancelTransfer    escrow returns to the sender
///        expireTransfer    after TRANSFER_TTL, anyone returns escrow to the sender
///
///      Every move goes through inventory.updateStock(batchId, from, to, qty),
///      with address(this) as the escrow account. Units in transit therefore
///      show up in getAffectedHolders() during a recall, which is correct.
///
///      ALLOWED ROUTES
///        MANUFACTURER -> DISTRIBUTOR | PHARMACY
///        DISTRIBUTOR  -> DISTRIBUTOR | PHARMACY
///      Nobody sends to a MANUFACTURER or REGULATOR. A PHARMACY never sends;
///      it dispenses through InventoryManager.
interface ISupplyChain {
    // ------------------------------------------------------------------ types

    struct TransferRecord {
        address from; // address(0) for the first record (manufacture)
        address to;
        uint256 quantity;
        uint64 timestamp; // when the recipient accepted
        string location;
    }

    struct PendingTransfer {
        address from;
        uint256 quantity;
        uint64 initiatedAt;
        string location;
    }

    // ----------------------------------------------------------------- events

    event CustodyInitialised(uint256 indexed batchId, address indexed manufacturer, uint256 quantity);
    event CustodyTransferInitiated(
        uint256 indexed batchId, address indexed from, address indexed to, uint256 quantity, string location
    );
    event CustodyTransferAccepted(uint256 indexed batchId, address indexed from, address indexed to, uint256 quantity);
    event TransferRejected(uint256 indexed batchId, address indexed from, address indexed to, string reason);
    event TransferCancelled(uint256 indexed batchId, address indexed from, address indexed to, uint256 quantity);
    /// @dev A consignment nobody accepted within TRANSFER_TTL went back to its sender.
    event TransferLapsed(uint256 indexed batchId, address indexed from, address indexed to, uint256 quantity, address by);
    event StockReturned(
        uint256 indexed batchId, address indexed from, address indexed manufacturer, uint256 quantity, string reason
    );

    // ----------------------------------------------------------------- errors

    event InventoryManagerSet(address inventoryManager);
    /// @dev An admin or regulator moved a revoked holder's stranded units back to the manufacturer.
    event StockForceReturned(
        uint256 indexed batchId, address indexed holder, address indexed manufacturer, uint256 quantity, address by, string reason
    );

    error CallerNotRegistry(address caller);
    error NotAuthorisedToForceReturn(address caller);
    error HolderStillActive(address holder);
    error NotAdmin(address caller);
    error NotRegistered(address account);
    error InvalidRoute(bytes32 fromRole, bytes32 toRole);
    error InsufficientStock(uint256 batchId, uint256 available, uint256 requested);
    error BatchIsExpired(uint256 batchId);
    error BatchIsRecalled(uint256 batchId);
    error BatchIsQuarantined(uint256 batchId);
    /// @dev Good stock moves only downstream. A return upstream is allowed
    ///      only once the batch is recalled, quarantined or expired.
    error ReturnNotAllowed(uint256 batchId);
    /// @dev The network is paused (DrugRegistry.paused()). Returns, rejections
    ///      and cancellations still work; new dispatches and acceptances don't.
    error Paused();
    /// @dev The consignment sat unaccepted past TRANSFER_TTL; it can only go back now.
    error TransferHasLapsed(uint256 batchId, address to, uint64 lapsedAt);
    /// @dev expireTransfer was called before the consignment's TTL ran out.
    error TransferNotLapsed(uint256 batchId, address to, uint64 lapsesAt);
    error TransferAlreadyPending(uint256 batchId, address to);
    error NoPendingTransfer(uint256 batchId, address to);
    error SelfTransfer();
    error ZeroQuantity();
    error ZeroAddress();
    error AddressAlreadySet();

    // -------------------------------------------------------------- transfers

    /// @notice Dispatch `quantity` units of a batch to `to`.
    /// @dev All checks live in one internal validateTransfer(), in this order:
    ///      Paused, ZeroQuantity, ZeroAddress, SelfTransfer,
    ///      NotRegistered (msg.sender, then `to`), InvalidRoute,
    ///      BatchIsRecalled, BatchIsQuarantined, BatchIsExpired, InsufficientStock,
    ///      TransferAlreadyPending (one open transfer per batch per recipient).
    ///      Then: inventory.updateStock(batchId, msg.sender, address(this), quantity).
    function transferCustody(uint256 batchId, address to, uint256 quantity, string calldata location) external;

    /// @notice Recipient confirms physical receipt. msg.sender is the recipient.
    /// @dev Reverts: Paused, NoPendingTransfer, TransferHasLapsed (older than
    ///      TRANSFER_TTL: stock that sat that long can't be trusted to be what
    ///      was sent), NotRegistered (the recipient was
    ///      revoked while the stock was in transit), InvalidRoute (the
    ///      recipient's role changed to one that may not hold stock),
    ///      BatchIsRecalled, BatchIsQuarantined, BatchIsExpired. A blocked
    ///      consignment stays in escrow until the sender cancels it.
    ///      Then: updateStock(batchId, address(this), msg.sender, qty),
    ///      append a TransferRecord, delete the pending entry.
    function acceptConsignment(uint256 batchId) external;

    /// @notice Recipient refuses a consignment. Units go back to the sender.
    /// @dev ALWAYS allowed, even for recalled or expired batches, so stock
    ///      can always be returned. Reverts only NoPendingTransfer.
    function rejectConsignment(uint256 batchId, string calldata reason) external;

    /// @notice Sender withdraws a dispatch the recipient hasn't accepted yet.
    /// @dev ALWAYS allowed. This is what stops a batch getting stuck in limbo
    ///      if a recipient never responds. Reverts only NoPendingTransfer.
    function cancelTransfer(uint256 batchId, address to) external;

    /// @notice Return a consignment nobody accepted within TRANSFER_TTL to its sender.
    /// @dev Callable by ANYONE once initiatedAt + TRANSFER_TTL has passed, so
    ///      escrow never fills with abandoned stock even if both sides go
    ///      quiet. Works while paused, like reject and cancel.
    ///      Reverts in order: NoPendingTransfer, TransferNotLapsed.
    ///      Then: updateStock(batchId, address(this), sender, qty), delete the pending entry.
    function expireTransfer(uint256 batchId, address to) external;

    /// @notice Send msg.sender's own units of a recalled, quarantined or
    ///         expired batch straight back to the batch's manufacturer.
    /// @dev The reverse-logistics path: no escrow and no acceptance step, so a
    ///      return can't be blocked. Works even if the sender has since been
    ///      revoked. Appends a TransferRecord whose location is `reason`.
    ///      Reverts in order: ZeroQuantity, ReturnNotAllowed, SelfTransfer
    ///      (the manufacturer itself), InsufficientStock.
    ///      Then: inventory.updateStock(batchId, msg.sender, manufacturer, quantity).
    function returnToManufacturer(uint256 batchId, uint256 quantity, string calldata reason) external;

    /// @notice Recover stock stranded with a revoked participant: moves `quantity`
    ///         of `holder`'s units straight back to the batch's manufacturer.
    /// @dev Admin or regulator. Works while paused and for any batch status,
    ///      since the holder can no longer act. Units in escrow are not
    ///      "stranded": cancel, reject and expireTransfer already free them.
    ///      Reverts in order: NotAuthorisedToForceReturn, ZeroQuantity,
    ///      HolderStillActive (holder is active, or is this contract), SelfTransfer
    ///      (holder is the manufacturer), InsufficientStock.
    function forceReturn(uint256 batchId, address holder, uint256 quantity, string calldata reason) external;

    /// @notice Give the manufacturer custody of a newly registered batch.
    ///         Callable ONLY by the DrugRegistry contract.
    /// @dev Appends the first TransferRecord (from = address(0)) and calls
    ///      inventory.updateStock(batchId, address(0), manufacturer, quantity).
    ///      Reverts: CallerNotRegistry.
    function initialiseCustody(uint256 batchId, address manufacturer, uint256 quantity) external;

    // ------------------------------------------------------------------ views

    /// @notice Full ordered trail. Entry 0 is always the manufacture record.
    function getCustodyHistory(uint256 batchId) external view returns (TransferRecord[] memory);

    function getPendingTransfer(uint256 batchId, address to) external view returns (PendingTransfer memory);

    function hasPendingTransfer(uint256 batchId, address to) external view returns (bool);

    /// @notice Everyone with a consignment of this batch waiting for them. With
    ///         InventoryManager.getAffectedHolders (where in-transit units show
    ///         only as this contract's address), this is the full list to contact
    ///         in a recall.
    function getPendingRecipients(uint256 batchId) external view returns (address[] memory);

    function getPendingRecipientsCount(uint256 batchId) external view returns (uint256);

    /// @notice How long a consignment may wait for acceptance (30 days).
    function TRANSFER_TTL() external view returns (uint64);

    /// @notice Number of records in a batch's custody trail.
    function getCustodyHistoryCount(uint256 batchId) external view returns (uint256);

    /// @notice Up to `limit` trail records starting at `offset`, so a long
    ///         trail can be read in pages instead of one unbounded call.
    /// @dev An offset past the end returns an empty array; the page is clipped
    ///      at the end of the trail.
    function getCustodyHistoryPage(uint256 batchId, uint256 offset, uint256 limit)
        external
        view
        returns (TransferRecord[] memory);

    // ----------------------------------------------------------------- wiring

    /// @notice One-time wiring, called by the deploy script. Admin only.
    /// @dev Reverts: NotAdmin, ZeroAddress, AddressAlreadySet.
    function setInventoryManager(address inventoryManager) external;
}
