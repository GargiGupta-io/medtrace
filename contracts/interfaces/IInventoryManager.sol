// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IInventoryManager
/// @notice Stock, expiry and recall. Tracks how much is where, and enforces
///         the rules about what may be dispensed.
/// @dev Owner: Ronit Rao.
///
///      Implement as:
///        contract InventoryManager is IInventoryManager, ReentrancyGuard
///        constructor(address registry, address supplyChain)
///
///      This contract is the stock LEDGER. updateStock() does bookkeeping
///      only. Transfer policy (routes, expiry, recall) belongs to SupplyChain,
///      which is the only caller of updateStock().
///
///      Recall is the headline feature of the project. flagRecall() sets one
///      flag that SupplyChain and dispenseDrug() both read, so the freeze is
///      network-wide in the same block.
interface IInventoryManager {
    // ------------------------------------------------------------------ types

    struct DispenseRecord {
        address pharmacy;
        uint256 quantity;
        uint64 timestamp;
    }

    /// @dev One write-off of recalled or expired stock.
    struct DestructionRecord {
        address holder;
        uint256 quantity;
        uint64 timestamp;
        string reason;
    }

    /// @dev Where every unit of a batch has gone. produced = dispensed +
    ///      destroyed + outstanding, always. During a recall, outstanding is
    ///      the number still to be found.
    struct RecallProgress {
        uint256 produced;
        uint256 dispensed;
        uint256 destroyed;
        uint256 outstanding;
    }

    // ----------------------------------------------------------------- events

    event StockUpdated(uint256 indexed batchId, address indexed from, address indexed to, uint256 quantity);
    event DrugDispensed(uint256 indexed batchId, address indexed pharmacy, uint256 quantity);
    event BatchRecalled(uint256 indexed batchId, address indexed issuedBy, string reason);
    event LowStockAlert(uint256 indexed batchId, address indexed facility, uint256 remaining, uint256 threshold);
    /// @dev Emitted by dispenseDrug and updateStock when the batch is within
    ///      30 days of expiry. (View functions can't emit, so checkExpiry can't.)
    event ExpiryWarning(uint256 indexed batchId, uint64 expiryDate);
    event BatchQuarantined(uint256 indexed batchId, address indexed issuedBy, string reason);
    event QuarantineReleased(uint256 indexed batchId, address indexed releasedBy);
    event StockDestroyed(uint256 indexed batchId, address indexed holder, uint256 quantity, string reason);

    // ----------------------------------------------------------------- errors

    error CallerNotSupplyChain(address caller);
    error NotPharmacy(address caller);
    error NotAuthorisedToRecall(address caller);
    error InsufficientStock(uint256 batchId, address facility, uint256 available, uint256 requested);
    error BatchIsExpired(uint256 batchId);
    error BatchIsRecalled(uint256 batchId);
    error AlreadyRecalled(uint256 batchId);
    error ZeroQuantity();
    error BatchIsQuarantined(uint256 batchId);
    error AlreadyQuarantined(uint256 batchId);
    error NotQuarantined(uint256 batchId);
    /// @dev Only the batch's active manufacturer or a regulator may quarantine;
    ///      a quarantine a regulator imposed can only be lifted by a regulator.
    error NotAuthorisedToQuarantine(address caller);
    /// @dev Stock can be destroyed only once its batch is recalled or expired.
    error StockNotDisposable(uint256 batchId);
    /// @dev The network is paused (DrugRegistry.paused()). Recall, quarantine
    ///      and destruction still work; dispensing doesn't.
    error Paused();

    // ---------------------------------------------------------------- actions

    /// @notice Move `quantity` units of a batch from one account to another.
    ///         Callable ONLY by the SupplyChain contract.
    /// @dev from == address(0) means new stock (initial custody).
    ///      Otherwise debit `from` (reverts InsufficientStock) and credit `to`.
    ///      Keep the holders list in sync: add on first credit, remove when a
    ///      balance hits zero, so getAffectedHolders() is always exact.
    ///      Emits StockUpdated, plus LowStockAlert if `from` drops below its
    ///      reorder threshold.
    ///      Reverts: CallerNotSupplyChain, ZeroQuantity, InsufficientStock.
    function updateStock(uint256 batchId, address from, address to, uint256 quantity) external;

    /// @notice Dispense units to a patient. PHARMACY role only.
    /// @dev Reverts in order: Paused, NotPharmacy, ZeroQuantity, BatchIsRecalled,
    ///      BatchIsQuarantined, BatchIsExpired, InsufficientStock.
    ///      Then debit, append a DispenseRecord, emit DrugDispensed (and
    ///      LowStockAlert / ExpiryWarning where they apply).
    function dispenseDrug(uint256 batchId, uint256 quantity) external;

    /// @notice Freeze a batch across the whole network.
    /// @dev Caller must be the batch's original manufacturer AND still hold
    ///      MANUFACTURER (a revoked manufacturer can't recall), OR hold REGULATOR.
    ///      Works on an Active or Quarantined batch (a quarantine can be
    ///      escalated; the quarantine flag is cleared). A recall is final.
    ///      Sets the recall flag, calls registry.setBatchStatus(batchId, Recalled),
    ///      emits BatchRecalled.
    ///      Reverts: NotAuthorisedToRecall, AlreadyRecalled.
    function flagRecall(uint256 batchId, string calldata reason) external;

    /// @notice Put a batch on hold while a suspected problem is investigated.
    /// @dev Same freeze as a recall (no transfers, no dispensing) but it can
    ///      be lifted. Caller: the batch's active manufacturer, or a regulator.
    ///      Calls registry.setBatchStatus(batchId, Quarantined), emits BatchQuarantined.
    ///      Reverts in order: NotAuthorisedToQuarantine, BatchIsRecalled, AlreadyQuarantined.
    function quarantineBatch(uint256 batchId, string calldata reason) external;

    /// @notice Lift a quarantine. The batch goes back to Active.
    /// @dev A regulator may always release. The manufacturer may release only
    ///      a quarantine it imposed itself.
    ///      Reverts in order: NotQuarantined, NotAuthorisedToQuarantine.
    function releaseQuarantine(uint256 batchId) external;

    /// @notice Write off msg.sender's own units of a recalled or expired batch.
    /// @dev Any account holding units may call it, even a revoked one, so dead
    ///      stock never sits on the books. Appends a DestructionRecord and
    ///      emits StockDestroyed.
    ///      Reverts in order: ZeroQuantity, StockNotDisposable, InsufficientStock.
    function destroyStock(uint256 batchId, uint256 quantity, string calldata reason) external;

    /// @notice Set the low-stock level for msg.sender's own facility.
    function setReorderThreshold(uint256 batchId, uint256 threshold) external;

    // ------------------------------------------------------------------ views

    /// @return valid True if block.timestamp is still before the expiry date.
    function checkExpiry(uint256 batchId) external view returns (bool valid);

    function isRecalled(uint256 batchId) external view returns (bool);

    function isQuarantined(uint256 batchId) external view returns (bool);

    function getFacilityStock(address facility, uint256 batchId) external view returns (uint256);

    /// @notice Every account still holding units of this batch, including the
    ///         SupplyChain contract itself if units are in transit.
    function getAffectedHolders(uint256 batchId) external view returns (address[] memory);

    function getDispensingLog(uint256 batchId) external view returns (DispenseRecord[] memory);

    function getDestructionLog(uint256 batchId) external view returns (DestructionRecord[] memory);

    // Paged reads. A popular batch can reach thousands of holders and
    // dispensing records; these keep every call bounded. An offset past the
    // end returns an empty array, and the page is clipped at the end.

    function getAffectedHoldersCount(uint256 batchId) external view returns (uint256);

    function getAffectedHoldersPage(uint256 batchId, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory);

    function getDispensingLogCount(uint256 batchId) external view returns (uint256);

    function getDispensingLogPage(uint256 batchId, uint256 offset, uint256 limit)
        external
        view
        returns (DispenseRecord[] memory);

    /// @notice How much of a batch has been dispensed, destroyed, or is still out there.
    function getRecallProgress(uint256 batchId) external view returns (RecallProgress memory);

    function getReorderThreshold(address facility, uint256 batchId) external view returns (uint256);
}
