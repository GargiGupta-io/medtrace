// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISupplyChain} from "./interfaces/ISupplyChain.sol";
import {IDrugRegistry} from "./interfaces/IDrugRegistry.sol";
import {IInventoryManager} from "./interfaces/IInventoryManager.sol";
import {Roles} from "./libraries/Roles.sol";

/// @title SupplyChain
/// @notice Validates every handoff of a drug batch and records the custody
///         trail. Stock balances live in InventoryManager; this contract
///         decides whether a move is allowed and holds units in escrow
///         while they are in transit.
/// @dev Owner: Pranav Arora. Spec: contracts/interfaces/ISupplyChain.sol.
contract SupplyChain is ISupplyChain, ReentrancyGuard {
    /// @inheritdoc ISupplyChain
    uint64 public constant TRANSFER_TTL = 30 days;

    /// @notice The DrugRegistry: the single list of participants, roles and admins.
    IDrugRegistry public immutable registry;

    /// @notice The InventoryManager that keeps per-facility stock. Set once after deployment.
    IInventoryManager public inventory;

    /// @dev Append-only custody history per batch. Entry 0 is the manufacture record.
    mapping(uint256 => TransferRecord[]) private custodyTrail;

    /// @dev Open transfers, keyed by batch and recipient. An entry exists when `from != address(0)`.
    mapping(uint256 => mapping(address => PendingTransfer)) private pending;

    /// @dev Recipients with an open transfer, per batch, with 1-based slots for
    ///      O(1) removal (swap with last, pop). Kept in step with `pending`.
    mapping(uint256 => address[]) private pendingRecipients;
    mapping(uint256 => mapping(address => uint256)) private pendingSlot;

    constructor(address registry_) {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = IDrugRegistry(registry_);
    }

    // ------------------------------------------------------------------ wiring

    /// @inheritdoc ISupplyChain
    function setInventoryManager(address inventoryManager) external {
        if (!registry.hasRole(Roles.ADMIN, msg.sender)) revert NotAdmin(msg.sender);
        if (inventoryManager == address(0)) revert ZeroAddress();
        if (address(inventory) != address(0)) revert AddressAlreadySet();
        inventory = IInventoryManager(inventoryManager);
        emit InventoryManagerSet(inventoryManager);
    }

    // --------------------------------------------------------------- transfers

    /// @inheritdoc ISupplyChain
    function transferCustody(uint256 batchId, address to, uint256 quantity, string calldata location)
        external
        nonReentrant
    {
        validateTransfer(batchId, msg.sender, to, quantity);

        pending[batchId][to] = PendingTransfer({
            from: msg.sender,
            quantity: quantity,
            initiatedAt: uint64(block.timestamp),
            location: location
        });
        _addRecipient(batchId, to);
        emit CustodyTransferInitiated(batchId, msg.sender, to, quantity, location);

        // Interaction last: sender's units move into escrow (this contract).
        inventory.updateStock(batchId, msg.sender, address(this), quantity);
    }

    /// @inheritdoc ISupplyChain
    function acceptConsignment(uint256 batchId) external nonReentrant {
        if (registry.paused()) revert Paused();
        PendingTransfer memory p = pending[batchId][msg.sender];
        if (p.from == address(0)) revert NoPendingTransfer(batchId, msg.sender);
        uint64 lapsesAt = p.initiatedAt + TRANSFER_TTL;
        if (block.timestamp >= lapsesAt) revert TransferHasLapsed(batchId, msg.sender, lapsesAt);
        // The recipient may have been revoked, or moved to a role that can't
        // hold stock, after the sender dispatched. Re-check before handing over.
        if (!registry.isRegistered(msg.sender)) revert NotRegistered(msg.sender);
        bytes32 toRole = _roleOf(msg.sender);
        if (toRole != Roles.DISTRIBUTOR && toRole != Roles.PHARMACY) revert InvalidRoute(_roleOf(p.from), toRole);
        // A batch can be recalled or expire while it is on the road.
        if (inventory.isRecalled(batchId)) revert BatchIsRecalled(batchId);
        if (inventory.isQuarantined(batchId)) revert BatchIsQuarantined(batchId);
        if (!inventory.checkExpiry(batchId)) revert BatchIsExpired(batchId);

        // Delete before calling out, so a consignment can never be accepted twice.
        _closePending(batchId, msg.sender);
        custodyTrail[batchId].push(
            TransferRecord({
                from: p.from,
                to: msg.sender,
                quantity: p.quantity,
                timestamp: uint64(block.timestamp),
                location: p.location
            })
        );
        emit CustodyTransferAccepted(batchId, p.from, msg.sender, p.quantity);

        inventory.updateStock(batchId, address(this), msg.sender, p.quantity);
    }

    /// @inheritdoc ISupplyChain
    function rejectConsignment(uint256 batchId, string calldata reason) external nonReentrant {
        PendingTransfer memory p = pending[batchId][msg.sender];
        if (p.from == address(0)) revert NoPendingTransfer(batchId, msg.sender);

        // No recall or expiry checks: returning stock must always work.
        _closePending(batchId, msg.sender);
        emit TransferRejected(batchId, p.from, msg.sender, reason);

        inventory.updateStock(batchId, address(this), p.from, p.quantity);
    }

    /// @inheritdoc ISupplyChain
    function cancelTransfer(uint256 batchId, address to) external nonReentrant {
        PendingTransfer memory p = pending[batchId][to];
        // Covers both "no such transfer" and "not yours to cancel".
        if (p.from != msg.sender) revert NoPendingTransfer(batchId, to);

        _closePending(batchId, to);
        emit TransferCancelled(batchId, msg.sender, to, p.quantity);

        inventory.updateStock(batchId, address(this), msg.sender, p.quantity);
    }

    /// @inheritdoc ISupplyChain
    function expireTransfer(uint256 batchId, address to) external nonReentrant {
        PendingTransfer memory p = pending[batchId][to];
        if (p.from == address(0)) revert NoPendingTransfer(batchId, to);
        uint64 lapsesAt = p.initiatedAt + TRANSFER_TTL;
        if (block.timestamp < lapsesAt) revert TransferNotLapsed(batchId, to, lapsesAt);

        _closePending(batchId, to);
        emit TransferLapsed(batchId, p.from, to, p.quantity, msg.sender);

        inventory.updateStock(batchId, address(this), p.from, p.quantity);
    }

    /// @inheritdoc ISupplyChain
    function returnToManufacturer(uint256 batchId, uint256 quantity, string calldata reason)
        external
        nonReentrant
    {
        if (quantity == 0) revert ZeroQuantity();
        bool dead = inventory.isRecalled(batchId) || inventory.isQuarantined(batchId) || !inventory.checkExpiry(batchId);
        if (!dead) revert ReturnNotAllowed(batchId);

        address manufacturer = registry.getManufacturer(batchId);
        if (msg.sender == manufacturer) revert SelfTransfer();

        uint256 available = inventory.getFacilityStock(msg.sender, batchId);
        if (available < quantity) revert InsufficientStock(batchId, available, quantity);

        custodyTrail[batchId].push(
            TransferRecord({
                from: msg.sender,
                to: manufacturer,
                quantity: quantity,
                timestamp: uint64(block.timestamp),
                location: reason
            })
        );
        emit StockReturned(batchId, msg.sender, manufacturer, quantity, reason);

        inventory.updateStock(batchId, msg.sender, manufacturer, quantity);
    }

    /// @inheritdoc ISupplyChain
    function forceReturn(uint256 batchId, address holder, uint256 quantity, string calldata reason)
        external
        nonReentrant
    {
        if (!registry.hasRole(Roles.ADMIN, msg.sender) && !registry.hasRole(Roles.REGULATOR, msg.sender)) {
            revert NotAuthorisedToForceReturn(msg.sender);
        }
        if (quantity == 0) revert ZeroQuantity();
        // Only stock nobody can move any more: an active holder can ship or
        // return it, and escrowed units already have their own exits.
        if (holder == address(this) || registry.isRegistered(holder)) revert HolderStillActive(holder);

        address manufacturer = registry.getManufacturer(batchId);
        if (holder == manufacturer) revert SelfTransfer();

        uint256 available = inventory.getFacilityStock(holder, batchId);
        if (available < quantity) revert InsufficientStock(batchId, available, quantity);

        custodyTrail[batchId].push(
            TransferRecord({
                from: holder,
                to: manufacturer,
                quantity: quantity,
                timestamp: uint64(block.timestamp),
                location: reason
            })
        );
        emit StockForceReturned(batchId, holder, manufacturer, quantity, msg.sender, reason);

        inventory.updateStock(batchId, holder, manufacturer, quantity);
    }

    /// @inheritdoc ISupplyChain
    function initialiseCustody(uint256 batchId, address manufacturer, uint256 quantity) external {
        if (msg.sender != address(registry)) revert CallerNotRegistry(msg.sender);

        custodyTrail[batchId].push(
            TransferRecord({
                from: address(0),
                to: manufacturer,
                quantity: quantity,
                timestamp: uint64(block.timestamp),
                location: "Manufactured"
            })
        );
        emit CustodyInitialised(batchId, manufacturer, quantity);

        // from = address(0) tells InventoryManager this is new stock, not a move.
        inventory.updateStock(batchId, address(0), manufacturer, quantity);
    }

    // ------------------------------------------------------------------- views

    /// @inheritdoc ISupplyChain
    function getCustodyHistory(uint256 batchId) external view returns (TransferRecord[] memory) {
        return custodyTrail[batchId];
    }

    /// @inheritdoc ISupplyChain
    function getCustodyHistoryCount(uint256 batchId) external view returns (uint256) {
        return custodyTrail[batchId].length;
    }

    /// @inheritdoc ISupplyChain
    function getCustodyHistoryPage(uint256 batchId, uint256 offset, uint256 limit)
        external
        view
        returns (TransferRecord[] memory page)
    {
        TransferRecord[] storage trail = custodyTrail[batchId];
        uint256 total = trail.length;
        if (offset >= total) return page;
        uint256 end = limit > total - offset ? total : offset + limit;
        page = new TransferRecord[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = trail[i];
        }
    }

    /// @inheritdoc ISupplyChain
    function getPendingTransfer(uint256 batchId, address to) external view returns (PendingTransfer memory) {
        return pending[batchId][to];
    }

    /// @inheritdoc ISupplyChain
    function hasPendingTransfer(uint256 batchId, address to) external view returns (bool) {
        return pending[batchId][to].from != address(0);
    }

    /// @inheritdoc ISupplyChain
    function getPendingRecipients(uint256 batchId) external view returns (address[] memory) {
        return pendingRecipients[batchId];
    }

    /// @inheritdoc ISupplyChain
    function getPendingRecipientsCount(uint256 batchId) external view returns (uint256) {
        return pendingRecipients[batchId].length;
    }

    // ---------------------------------------------------------------- internal

    function _addRecipient(uint256 batchId, address to) private {
        pendingRecipients[batchId].push(to);
        pendingSlot[batchId][to] = pendingRecipients[batchId].length;
    }

    /// @dev Removes an open transfer and its recipient-list entry together.
    function _closePending(uint256 batchId, address to) private {
        delete pending[batchId][to];

        address[] storage list = pendingRecipients[batchId];
        uint256 slot = pendingSlot[batchId][to];
        address last = list[list.length - 1];
        list[slot - 1] = last;
        pendingSlot[batchId][last] = slot;
        list.pop();
        delete pendingSlot[batchId][to];
    }

    /// @dev Every pre-transfer rule, in the exact order the interface specifies.
    function validateTransfer(uint256 batchId, address from, address to, uint256 quantity) internal view {
        if (registry.paused()) revert Paused();
        if (quantity == 0) revert ZeroQuantity();
        if (to == address(0)) revert ZeroAddress();
        if (to == from) revert SelfTransfer();
        if (!registry.isRegistered(from)) revert NotRegistered(from);
        if (!registry.isRegistered(to)) revert NotRegistered(to);

        bytes32 fromRole = _roleOf(from);
        bytes32 toRole = _roleOf(to);
        if (!_isAllowedRoute(fromRole, toRole)) revert InvalidRoute(fromRole, toRole);

        if (inventory.isRecalled(batchId)) revert BatchIsRecalled(batchId);
        if (inventory.isQuarantined(batchId)) revert BatchIsQuarantined(batchId);
        if (!inventory.checkExpiry(batchId)) revert BatchIsExpired(batchId);

        uint256 available = inventory.getFacilityStock(from, batchId);
        if (available < quantity) revert InsufficientStock(batchId, available, quantity);

        if (pending[batchId][to].from != address(0)) revert TransferAlreadyPending(batchId, to);
    }

    /// @dev The participant's supply-chain role, or bytes32(0) if it has none.
    function _roleOf(address account) private view returns (bytes32) {
        if (registry.hasRole(Roles.MANUFACTURER, account)) return Roles.MANUFACTURER;
        if (registry.hasRole(Roles.DISTRIBUTOR, account)) return Roles.DISTRIBUTOR;
        if (registry.hasRole(Roles.PHARMACY, account)) return Roles.PHARMACY;
        if (registry.hasRole(Roles.REGULATOR, account)) return Roles.REGULATOR;
        return bytes32(0);
    }

    /// @dev Medicine flows downstream only:
    ///      MANUFACTURER -> DISTRIBUTOR | PHARMACY, DISTRIBUTOR -> DISTRIBUTOR | PHARMACY.
    function _isAllowedRoute(bytes32 fromRole, bytes32 toRole) private pure returns (bool) {
        bool senderOk = fromRole == Roles.MANUFACTURER || fromRole == Roles.DISTRIBUTOR;
        bool recipientOk = toRole == Roles.DISTRIBUTOR || toRole == Roles.PHARMACY;
        return senderOk && recipientOk;
    }
}
