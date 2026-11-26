// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IDrugRegistry} from "./interfaces/IDrugRegistry.sol";
import {ISupplyChain} from "./interfaces/ISupplyChain.sol";
import {Roles} from "./libraries/Roles.sol";

contract DrugRegistry is IDrugRegistry, AccessControl, ReentrancyGuard {
    mapping(address => Participant) private participants;
    mapping(uint256 => Batch) private batches;

    uint256 public batchCount;
    ISupplyChain public supplyChain;
    address public inventoryManager;

    /// @notice How many accounts hold the admin role. Never allowed to reach zero.
    uint256 public adminCount;

    /// @notice True while the emergency stop is on.
    bool public paused;

    /// @dev Accounts invited to become admin that haven't accepted yet.
    mapping(address => bool) private adminProposed;

    uint256 internal constant MAX_NAME_BYTES = 64;
    uint256 internal constant MAX_COMPOSITION_BYTES = 256;
    uint256 internal constant MAX_CID_BYTES = 100;

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(Roles.ADMIN, admin);
    }

    // ----------------------------------------------------------------- wiring

    function setSupplyChain(address supplyChain_) external onlyRole(Roles.ADMIN) {
        if (supplyChain_ == address(0)) revert ZeroAddress();
        if (address(supplyChain) != address(0)) revert AddressAlreadySet();
        supplyChain = ISupplyChain(supplyChain_);
        emit SupplyChainSet(supplyChain_);
    }

    function setInventoryManager(address inventoryManager_) external onlyRole(Roles.ADMIN) {
        if (inventoryManager_ == address(0)) revert ZeroAddress();
        if (inventoryManager != address(0)) revert AddressAlreadySet();
        inventoryManager = inventoryManager_;
        emit InventoryManagerSet(inventoryManager_);
    }

    // ------------------------------------------------------ participant admin

    function registerParticipant(address account, string calldata name, string calldata licenceId, bytes32 role)
        external
        onlyRole(Roles.ADMIN)
    {
        if (account == address(0)) revert ZeroAddress();
        if (participants[account].role != bytes32(0)) revert AlreadyRegistered(account);
        if (!_isParticipantRole(role)) revert InvalidRole(role);
        if (bytes(name).length == 0 || bytes(licenceId).length == 0) revert EmptyField();
        if (bytes(name).length > MAX_NAME_BYTES || bytes(licenceId).length > MAX_NAME_BYTES) revert FieldTooLong();

        participants[account] = Participant(name, licenceId, role, true);
        _grantRole(role, account);
        emit ParticipantRegistered(account, role, name, licenceId);
    }

    function assignRole(address account, bytes32 role) external onlyRole(Roles.ADMIN) {
        Participant storage p = participants[account];
        if (!p.active) revert NotRegistered(account);
        if (!_isParticipantRole(role)) revert InvalidRole(role);

        _revokeRole(p.role, account);
        p.role = role;
        _grantRole(role, account);
        emit RoleAssigned(account, role);
    }

    function revokeParticipant(address account) external onlyRole(Roles.ADMIN) {
        Participant storage p = participants[account];
        if (!p.active) revert NotRegistered(account);

        p.active = false;
        _revokeRole(p.role, account);
        emit ParticipantRevoked(account);
    }

    /// @dev A revoked participant keeps its record with active = false and its
    ///      last role, so "never registered" is role == 0.
    function reinstateParticipant(address account, bytes32 role) external onlyRole(Roles.ADMIN) {
        Participant storage p = participants[account];
        if (p.role == bytes32(0)) revert NotRegistered(account);
        if (p.active) revert AlreadyRegistered(account);
        if (!_isParticipantRole(role)) revert InvalidRole(role);

        p.active = true;
        p.role = role;
        _grantRole(role, account);
        emit ParticipantReinstated(account, role);
    }

    // ---------------------------------------------------------------- batches

    function registerBatch(
        string calldata drugName,
        string calldata composition,
        uint64 mfgDate,
        uint64 expiryDate,
        uint256 quantity,
        string calldata ipfsHash
    ) external onlyRole(Roles.MANUFACTURER) nonReentrant returns (uint256 batchId) {
        if (paused) revert Paused();
        if (quantity == 0) revert ZeroQuantity();
        if (bytes(drugName).length == 0 || bytes(ipfsHash).length == 0) revert EmptyField();
        if (
            bytes(drugName).length > MAX_NAME_BYTES || bytes(composition).length > MAX_COMPOSITION_BYTES
                || bytes(ipfsHash).length > MAX_CID_BYTES
        ) revert FieldTooLong();
        if (!_looksLikeCid(ipfsHash)) revert InvalidCid();
        if (mfgDate == 0 || mfgDate > block.timestamp || expiryDate <= mfgDate || expiryDate <= block.timestamp) {
            revert InvalidDates(mfgDate, expiryDate);
        }

        batchId = ++batchCount;
        batches[batchId] = Batch({
            batchId: batchId,
            drugName: drugName,
            composition: composition,
            manufacturer: msg.sender,
            mfgDate: mfgDate,
            expiryDate: expiryDate,
            quantity: quantity,
            ipfsHash: ipfsHash,
            status: BatchStatus.Active
        });
        emit BatchRegistered(batchId, msg.sender, drugName, quantity, expiryDate);

        // Interaction last: every state change above is already done.
        supplyChain.initialiseCustody(batchId, msg.sender, quantity);
    }

    function setBatchStatus(uint256 batchId, BatchStatus status) external {
        if (msg.sender != inventoryManager) revert CallerNotInventory(msg.sender);
        if (!batchExists(batchId)) revert BatchNotFound(batchId);

        BatchStatus current = batches[batchId].status;
        if (!_isAllowedStatusMove(current, status)) revert InvalidStatusTransition(current, status);

        batches[batchId].status = status;
        emit BatchStatusChanged(batchId, status);
    }

    // ------------------------------------------------------------------ admins

    function proposeAdmin(address account) external onlyRole(Roles.ADMIN) {
        if (account == address(0)) revert ZeroAddress();
        if (hasRole(Roles.ADMIN, account)) revert AlreadyRegistered(account);
        adminProposed[account] = true;
        emit AdminProposed(account, msg.sender);
    }

    function cancelAdminProposal(address account) external onlyRole(Roles.ADMIN) {
        if (!adminProposed[account]) revert NoAdminProposal(account);
        delete adminProposed[account];
        emit AdminProposalCancelled(account);
    }

    function acceptAdmin() external {
        if (!adminProposed[msg.sender]) revert NoAdminProposal(msg.sender);
        delete adminProposed[msg.sender];
        _grantRole(Roles.ADMIN, msg.sender);
    }

    function isAdminProposed(address account) external view returns (bool) {
        return adminProposed[account];
    }

    // ------------------------------------------------------------------- pause

    function pause(string calldata reason) external {
        if (!hasRole(Roles.ADMIN, msg.sender) && !hasRole(Roles.REGULATOR, msg.sender)) {
            revert NotAuthorisedToPause(msg.sender);
        }
        if (paused) revert Paused();
        paused = true;
        emit SystemPaused(msg.sender, reason);
    }

    function unpause() external {
        if (!hasRole(Roles.ADMIN, msg.sender)) revert NotAuthorisedToPause(msg.sender);
        if (!paused) revert NotPaused();
        paused = false;
        emit SystemUnpaused(msg.sender);
    }

    // ---------------------------------------------------- role lockdown (v2)

    /// @notice No role can be granted directly. Participant roles go through
    ///         registerParticipant / assignRole, and admins through
    ///         proposeAdmin / acceptAdmin.
    function grantRole(bytes32 role, address) public pure override(AccessControl, IAccessControl) {
        revert RoleManagedByRegistry(role);
    }

    /// @notice Only the admin role can be revoked directly. Use revokeParticipant for participants.
    function revokeRole(bytes32 role, address account) public override(AccessControl, IAccessControl) {
        if (role != Roles.ADMIN) revert RoleManagedByRegistry(role);
        super.revokeRole(role, account);
    }

    /// @notice Participants can't silently drop their own role, and the last admin can't leave.
    function renounceRole(bytes32 role, address callerConfirmation) public override(AccessControl, IAccessControl) {
        if (role != Roles.ADMIN) revert RoleManagedByRegistry(role);
        super.renounceRole(role, callerConfirmation);
    }

    /// @dev Keeps adminCount in step with every admin grant.
    function _grantRole(bytes32 role, address account) internal override returns (bool granted) {
        granted = super._grantRole(role, account);
        if (granted && role == Roles.ADMIN) adminCount++;
    }

    /// @dev Refuses to remove the last admin, whichever path tries it.
    function _revokeRole(bytes32 role, address account) internal override returns (bool revoked) {
        if (role == Roles.ADMIN && adminCount == 1 && hasRole(Roles.ADMIN, account)) revert LastAdmin();
        revoked = super._revokeRole(role, account);
        if (revoked && role == Roles.ADMIN) adminCount--;
    }

    // ------------------------------------------------------------------ views

    function getBatchDetails(uint256 batchId) external view returns (Batch memory) {
        if (!batchExists(batchId)) revert BatchNotFound(batchId);
        return batches[batchId];
    }

    function getExpiry(uint256 batchId) external view returns (uint64) {
        if (!batchExists(batchId)) revert BatchNotFound(batchId);
        return batches[batchId].expiryDate;
    }

    function getManufacturer(uint256 batchId) external view returns (address) {
        if (!batchExists(batchId)) revert BatchNotFound(batchId);
        return batches[batchId].manufacturer;
    }

    function getParticipant(address account) external view returns (Participant memory) {
        return participants[account];
    }

    function isRegistered(address account) external view returns (bool) {
        return participants[account].active;
    }

    function batchExists(uint256 batchId) public view returns (bool) {
        return batchId > 0 && batchId <= batchCount;
    }

    /// @dev A cheap shape check, not full CID decoding: CIDv0 starts with "Qm",
    ///      CIDv1 in base32 starts with "b". The frontend does the full check.
    /// @dev Active <-> Quarantined, and either of them -> Recalled. Recalled is final.
    function _isAllowedStatusMove(BatchStatus from, BatchStatus to) private pure returns (bool) {
        if (from == BatchStatus.Recalled || from == to) return false;
        return true;
    }

    function _looksLikeCid(string calldata cid) private pure returns (bool) {
        bytes calldata b = bytes(cid);
        if (b.length >= 2 && b[0] == "Q" && b[1] == "m") return true;
        return b.length >= 2 && b[0] == "b";
    }

    function _isParticipantRole(bytes32 role) private pure returns (bool) {
        return role == Roles.MANUFACTURER || role == Roles.DISTRIBUTOR || role == Roles.PHARMACY
            || role == Roles.REGULATOR;
    }
}
