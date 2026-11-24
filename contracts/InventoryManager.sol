
 // SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IInventoryManager} from "./interfaces/IInventoryManager.sol";
import {IDrugRegistry} from "./interfaces/IDrugRegistry.sol";
import {Roles} from "./libraries/Roles.sol";

contract InventoryManager is IInventoryManager, ReentrancyGuard {
    uint256 public constant EXPIRY_WARNING_WINDOW = 30 days;

    IDrugRegistry public immutable registry;
    address public immutable supplyChain;

    mapping(address => mapping(uint256 => uint256)) private facilityStock;
    mapping(uint256 => bool) private recalled;
    mapping(address => mapping(uint256 => uint256)) private reorderThreshold;
    mapping(uint256 => DispenseRecord[]) private dispensingLog;
    mapping(uint256 => address[]) private holders;
    mapping(uint256 => mapping(address => uint256)) private holderSlot;

    mapping(uint256 => bool) private quarantined;
    /// @dev True when a regulator imposed the current quarantine, so the manufacturer can't lift it.
    mapping(uint256 => bool) private quarantinedByRegulator;
    mapping(uint256 => DestructionRecord[]) private destructionLog;
    mapping(uint256 => uint256) private totalDispensed;
    mapping(uint256 => uint256) private totalDestroyed;

    constructor(address registry_, address supplyChain_) {
        registry = IDrugRegistry(registry_);
        supplyChain = supplyChain_;
    }

    function _addHolder(uint256 batchId, address facility) private {
        if (holderSlot[batchId][facility] != 0) return;

        holders[batchId].push(facility);
        holderSlot[batchId][facility] = holders[batchId].length;
    }

    function _removeHolder(uint256 batchId, address facility) private {
        uint256 slot = holderSlot[batchId][facility];
        if (slot == 0) return;

        address[] storage list = holders[batchId];
        address last = list[list.length - 1];

        list[slot - 1] = last;
        holderSlot[batchId][last] = slot;
        list.pop();

        delete holderSlot[batchId][facility];
    }

    /// @dev `alert` is false for write-offs: a low-stock warning for a recalled
    ///      or expired batch would only be noise.
    function _debit(uint256 batchId, address facility, uint256 quantity, bool alert) private {
        uint256 available = facilityStock[facility][batchId];

        if (available < quantity) {
            revert InsufficientStock(batchId, facility, available, quantity);
        }

        uint256 remaining = available - quantity;
        facilityStock[facility][batchId] = remaining;

        if (remaining == 0) {
            _removeHolder(batchId, facility);
        }

        uint256 threshold = reorderThreshold[facility][batchId];

        if (alert && remaining < threshold) {
            emit LowStockAlert(batchId, facility, remaining, threshold);
        }
    }

    /// @dev The batch's original manufacturer, and only while it still holds
    ///      MANUFACTURER: a revoked manufacturer loses recall and quarantine powers.
    function _isOwnManufacturer(uint256 batchId) private view returns (bool) {
        return msg.sender == registry.getBatchDetails(batchId).manufacturer &&
            registry.hasRole(Roles.MANUFACTURER, msg.sender);
    }

    function _maybeWarnExpiry(uint256 batchId) private {
        uint64 expiryDate = registry.getBatchDetails(batchId).expiryDate;

        if (
            block.timestamp < expiryDate &&
            expiryDate - block.timestamp <= EXPIRY_WARNING_WINDOW
        ) {
            emit ExpiryWarning(batchId, expiryDate);
        }
    }

    function updateStock(
        uint256 batchId,
        address from,
        address to,
        uint256 quantity
    ) external override {
        if (msg.sender != supplyChain) {
            revert CallerNotSupplyChain(msg.sender);
        }

        if (quantity == 0) {
            revert ZeroQuantity();
        }

        if (from != address(0)) {
            _debit(batchId, from, quantity, true);
        }

        if (facilityStock[to][batchId] == 0) {
            _addHolder(batchId, to);
        }

        facilityStock[to][batchId] += quantity;

        emit StockUpdated(batchId, from, to, quantity);
        _maybeWarnExpiry(batchId);
    }

    function dispenseDrug(
        uint256 batchId,
        uint256 quantity
    ) external override nonReentrant {
        if (registry.paused()) {
            revert Paused();
        }

        if (!registry.hasRole(Roles.PHARMACY, msg.sender)) {
            revert NotPharmacy(msg.sender);
        }

        if (quantity == 0) {
            revert ZeroQuantity();
        }

        if (recalled[batchId]) {
            revert BatchIsRecalled(batchId);
        }

        if (quarantined[batchId]) {
            revert BatchIsQuarantined(batchId);
        }

        if (!checkExpiry(batchId)) {
            revert BatchIsExpired(batchId);
        }

        _debit(batchId, msg.sender, quantity, true);
        totalDispensed[batchId] += quantity;

        dispensingLog[batchId].push(
            DispenseRecord(msg.sender, quantity, uint64(block.timestamp))
        );

        emit DrugDispensed(batchId, msg.sender, quantity);
        _maybeWarnExpiry(batchId);
    }

    function flagRecall(
        uint256 batchId,
        string calldata reason
    ) external override nonReentrant {
        if (!_isOwnManufacturer(batchId) && !registry.hasRole(Roles.REGULATOR, msg.sender)) {
            revert NotAuthorisedToRecall(msg.sender);
        }

        if (recalled[batchId]) {
            revert AlreadyRecalled(batchId);
        }

        // A quarantine can be escalated: the recall replaces it.
        recalled[batchId] = true;
        delete quarantined[batchId];
        delete quarantinedByRegulator[batchId];

        emit BatchRecalled(batchId, msg.sender, reason);

        registry.setBatchStatus(
            batchId,
            IDrugRegistry.BatchStatus.Recalled
        );
    }

    function quarantineBatch(
        uint256 batchId,
        string calldata reason
    ) external override nonReentrant {
        bool isRegulator = registry.hasRole(Roles.REGULATOR, msg.sender);
        if (!isRegulator && !_isOwnManufacturer(batchId)) {
            revert NotAuthorisedToQuarantine(msg.sender);
        }

        if (recalled[batchId]) {
            revert BatchIsRecalled(batchId);
        }

        if (quarantined[batchId]) {
            revert AlreadyQuarantined(batchId);
        }

        quarantined[batchId] = true;
        quarantinedByRegulator[batchId] = isRegulator;

        emit BatchQuarantined(batchId, msg.sender, reason);

        registry.setBatchStatus(
            batchId,
            IDrugRegistry.BatchStatus.Quarantined
        );
    }

    function releaseQuarantine(
        uint256 batchId
    ) external override nonReentrant {
        if (!quarantined[batchId]) {
            revert NotQuarantined(batchId);
        }

        // A regulator can always release. The manufacturer can release only a
        // hold it placed itself, never one a regulator imposed.
        bool allowed = registry.hasRole(Roles.REGULATOR, msg.sender) ||
            (!quarantinedByRegulator[batchId] && _isOwnManufacturer(batchId));
        if (!allowed) {
            revert NotAuthorisedToQuarantine(msg.sender);
        }

        delete quarantined[batchId];
        delete quarantinedByRegulator[batchId];

        emit QuarantineReleased(batchId, msg.sender);

        registry.setBatchStatus(
            batchId,
            IDrugRegistry.BatchStatus.Active
        );
    }

    function destroyStock(
        uint256 batchId,
        uint256 quantity,
        string calldata reason
    ) external override nonReentrant {
        if (quantity == 0) {
            revert ZeroQuantity();
        }

        // Only dead stock can be written off. Good stock, and stock that is
        // merely quarantined (it may be released, and is evidence), stays put.
        if (!recalled[batchId] && checkExpiry(batchId)) {
            revert StockNotDisposable(batchId);
        }

        _debit(batchId, msg.sender, quantity, false);
        totalDestroyed[batchId] += quantity;

        destructionLog[batchId].push(
            DestructionRecord(msg.sender, quantity, uint64(block.timestamp), reason)
        );

        emit StockDestroyed(batchId, msg.sender, quantity, reason);
    }

    function setReorderThreshold(
        uint256 batchId,
        uint256 threshold
    ) external override {
        reorderThreshold[msg.sender][batchId] = threshold;
    }

    function checkExpiry(
        uint256 batchId
    ) public view override returns (bool valid) {
        return block.timestamp < registry.getBatchDetails(batchId).expiryDate;
    }

    function isRecalled(
        uint256 batchId
    ) external view override returns (bool) {
        return recalled[batchId];
    }

    function isQuarantined(
        uint256 batchId
    ) external view override returns (bool) {
        return quarantined[batchId];
    }

    function getFacilityStock(
        address facility,
        uint256 batchId
    ) external view override returns (uint256) {
        return facilityStock[facility][batchId];
    }

    function getAffectedHolders(
        uint256 batchId
    ) external view override returns (address[] memory) {
        return holders[batchId];
    }

    function getDispensingLog(
        uint256 batchId
    ) external view override returns (DispenseRecord[] memory) {
        return dispensingLog[batchId];
    }

    function getDestructionLog(
        uint256 batchId
    ) external view override returns (DestructionRecord[] memory) {
        return destructionLog[batchId];
    }

    function getRecallProgress(
        uint256 batchId
    ) external view override returns (RecallProgress memory progress) {
        progress.produced = registry.getBatchDetails(batchId).quantity;
        progress.dispensed = totalDispensed[batchId];
        progress.destroyed = totalDestroyed[batchId];
        progress.outstanding = progress.produced - progress.dispensed - progress.destroyed;
    }

    function getAffectedHoldersCount(
        uint256 batchId
    ) external view override returns (uint256) {
        return holders[batchId].length;
    }

    function getAffectedHoldersPage(
        uint256 batchId,
        uint256 offset,
        uint256 limit
    ) external view override returns (address[] memory page) {
        address[] storage list = holders[batchId];
        (uint256 start, uint256 end) = _window(list.length, offset, limit);
        page = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            page[i - start] = list[i];
        }
    }

    function getDispensingLogCount(
        uint256 batchId
    ) external view override returns (uint256) {
        return dispensingLog[batchId].length;
    }

    function getDispensingLogPage(
        uint256 batchId,
        uint256 offset,
        uint256 limit
    ) external view override returns (DispenseRecord[] memory page) {
        DispenseRecord[] storage log = dispensingLog[batchId];
        (uint256 start, uint256 end) = _window(log.length, offset, limit);
        page = new DispenseRecord[](end - start);
        for (uint256 i = start; i < end; i++) {
            page[i - start] = log[i];
        }
    }

    /// @dev The [start, end) slice of a list of `total` items for one page.
    ///      Written so a huge `limit` can't overflow.
    function _window(
        uint256 total,
        uint256 offset,
        uint256 limit
    ) private pure returns (uint256 start, uint256 end) {
        if (offset >= total) return (total, total);
        start = offset;
        end = limit > total - offset ? total : offset + limit;
    }

    function getReorderThreshold(
        address facility,
        uint256 batchId
    ) external view override returns (uint256) {
        return reorderThreshold[facility][batchId];
    }
}
