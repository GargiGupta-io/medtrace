// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title IDrugRegistry
/// @notice Identity and batch registration. Answers two questions:
///         who may take part, and what exactly is this batch.
/// @dev Owner: Khush Patel. Read by SupplyChain and InventoryManager.
///
///      Implement as:
///        contract DrugRegistry is IDrugRegistry, AccessControl, ReentrancyGuard
///        constructor(address admin)   // grants Roles.ADMIN to `admin`
///
///      Roles come from contracts/libraries/Roles.sol.
///      Batch IDs start at 1, so 0 always means "no batch".
interface IDrugRegistry is IAccessControl {
    // ------------------------------------------------------------------ types

    /// @dev Expiry is never stored as a status. It is derived from
    ///      expiryDate vs block.timestamp, because a stored flag can't
    ///      flip itself when the date passes.
    ///
    ///      Allowed moves (anything else reverts InvalidStatusTransition):
    ///        Active      -> Quarantined | Recalled
    ///        Quarantined -> Active      | Recalled
    ///        Recalled    -> (nothing: a recall is final)
    ///      Quarantined is appended last so Active = 0 and Recalled = 1 keep
    ///      the values they had before it existed.
    enum BatchStatus {
        Active,
        Recalled,
        Quarantined
    }

    struct Participant {
        string name;
        string licenceId;
        bytes32 role;
        bool active;
    }

    struct Batch {
        uint256 batchId;
        string drugName;
        string composition;
        address manufacturer;
        uint64 mfgDate;
        uint64 expiryDate;
        uint256 quantity; // units produced. Never changes after registration.
        string ipfsHash; // CID of the QA certificate on IPFS
        BatchStatus status;
    }

    // ----------------------------------------------------------------- events

    event ParticipantRegistered(address indexed account, bytes32 indexed role, string name, string licenceId);
    event RoleAssigned(address indexed account, bytes32 indexed role);
    event ParticipantRevoked(address indexed account);
    event BatchRegistered(
        uint256 indexed batchId, address indexed manufacturer, string drugName, uint256 quantity, uint64 expiryDate
    );
    event BatchStatusChanged(uint256 indexed batchId, BatchStatus status);
    event SystemPaused(address indexed by, string reason);
    event SystemUnpaused(address indexed by);
    event AdminProposed(address indexed account, address indexed proposedBy);
    event AdminProposalCancelled(address indexed account);

    // ----------------------------------------------------------------- errors

    error AlreadyRegistered(address account);
    error NotRegistered(address account);
    error InvalidRole(bytes32 role);
    error InvalidDates(uint64 mfgDate, uint64 expiryDate);
    error ZeroQuantity();
    error EmptyField();
    error BatchNotFound(uint256 batchId);
    error CallerNotInventory(address caller);
    error AddressAlreadySet();
    error ZeroAddress();
    /// @dev No role can be granted with grantRole. Participant roles change
    ///      only through registerParticipant, assignRole and revokeParticipant,
    ///      so the role and the participant record can never disagree; admins
    ///      are added with proposeAdmin + acceptAdmin. revokeRole and
    ///      renounceRole work for the admin role only.
    error RoleManagedByRegistry(bytes32 role);
    /// @dev The last admin cannot be removed, or nobody could ever manage the network again.
    error LastAdmin();
    /// @dev A text field is longer than its limit (see the constants in DrugRegistry).
    error FieldTooLong();
    /// @dev The certificate reference doesn't look like an IPFS CID (Qm... or b...).
    error InvalidCid();
    /// @dev The status change isn't one of the allowed moves listed on BatchStatus.
    error InvalidStatusTransition(BatchStatus from, BatchStatus to);
    /// @dev The network is paused: no new batches, transfers, acceptances or dispensing.
    error Paused();
    error NotPaused();
    /// @dev Only an admin or a regulator can pause; only an admin can unpause.
    error NotAuthorisedToPause(address caller);
    /// @dev acceptAdmin was called by an account nobody proposed.
    error NoAdminProposal(address account);

    // ------------------------------------------------------ participant admin

    /// @notice Onboard a supply-chain actor. Admin only.
    /// @dev `role` must be MANUFACTURER, DISTRIBUTOR, PHARMACY or REGULATOR.
    ///      Must grant `role` through AccessControl so hasRole() works for
    ///      the other two contracts.
    ///      Reverts: ZeroAddress, AlreadyRegistered, InvalidRole, EmptyField,
    ///      FieldTooLong (name or licenceId over 64 bytes).
    function registerParticipant(address account, string calldata name, string calldata licenceId, bytes32 role)
        external;

    /// @notice Change an existing participant's role. Admin only.
    /// @dev Revokes the old role, grants the new one.
    ///      Reverts: NotRegistered, InvalidRole.
    function assignRole(address account, bytes32 role) external;

    /// @notice Deactivate a participant. Admin only.
    /// @dev Sets active = false and revokes their role. Their past
    ///      transactions stay on chain untouched.
    ///      Reverts: NotRegistered.
    function revokeParticipant(address account) external;

    // ------------------------------------------------------------------ admins

    /// @notice Invite `account` to become an admin. Admin only.
    /// @dev Two steps so the admin role can never land on a mistyped or
    ///      unreachable address: nothing is granted until `account` itself
    ///      calls acceptAdmin. Proposing again simply re-invites.
    ///      Reverts: ZeroAddress, AlreadyRegistered (already an admin).
    function proposeAdmin(address account) external;

    /// @notice Withdraw an admin invitation that hasn't been accepted. Admin only.
    /// @dev Reverts: NoAdminProposal.
    function cancelAdminProposal(address account) external;

    /// @notice Accept an admin invitation. msg.sender is the invited account.
    /// @dev Reverts: NoAdminProposal.
    function acceptAdmin() external;

    function isAdminProposed(address account) external view returns (bool);

    // ------------------------------------------------------------------- pause

    /// @notice Emergency stop. An admin or a regulator may pause.
    /// @dev While paused: registerBatch, SupplyChain.transferCustody,
    ///      SupplyChain.acceptConsignment and InventoryManager.dispenseDrug
    ///      revert. Everything that makes stock SAFER keeps working: recall,
    ///      quarantine, reject, cancel, return to manufacturer, destroy, and
    ///      all participant management (so a compromised account can be revoked).
    ///      Reverts: NotAuthorisedToPause, Paused (already paused).
    function pause(string calldata reason) external;

    /// @notice Resume normal operation. Admin only, so a regulator's stop
    ///         can't be lifted by the regulator alone.
    /// @dev Reverts: NotAuthorisedToPause, NotPaused.
    function unpause() external;

    function paused() external view returns (bool);

    // ---------------------------------------------------------------- batches

    /// @notice Register a new production batch. MANUFACTURER role only.
    /// @dev Reverts Paused while the network is paused. Assigns the next batchId, stores the metadata, then calls
    ///      supplyChain.initialiseCustody(batchId, msg.sender, quantity)
    ///      so the manufacturer holds the full quantity immediately.
    ///      Reverts: ZeroQuantity, EmptyField (drugName or ipfsHash empty),
    ///      FieldTooLong (drugName over 64, composition over 256, ipfsHash over 100 bytes),
    ///      InvalidCid (ipfsHash must start with "Qm" or "b"),
    ///      InvalidDates (mfgDate must be set and not in the future; expiryDate
    ///      must be after mfgDate AND after now).
    /// @return batchId The new batch identifier.
    function registerBatch(
        string calldata drugName,
        string calldata composition,
        uint64 mfgDate,
        uint64 expiryDate,
        uint256 quantity,
        string calldata ipfsHash
    ) external returns (uint256 batchId);

    /// @notice Update a batch's status. Callable ONLY by the InventoryManager contract.
    /// @dev Used by InventoryManager.flagRecall, quarantineBatch and releaseQuarantine.
    ///      Reverts: CallerNotInventory, BatchNotFound, InvalidStatusTransition.
    function setBatchStatus(uint256 batchId, BatchStatus status) external;

    // ------------------------------------------------------------------ views

    /// @dev Reverts BatchNotFound for an unknown ID. The public verification
    ///      portal relies on this to flag forged batch IDs.
    function getBatchDetails(uint256 batchId) external view returns (Batch memory);

    function getParticipant(address account) external view returns (Participant memory);

    /// @notice True only if `account` is registered AND still active.
    function isRegistered(address account) external view returns (bool);

    function batchExists(uint256 batchId) external view returns (bool);

    /// @notice Number of batches registered so far (also the latest batchId).
    function batchCount() external view returns (uint256);

    // ----------------------------------------------------------------- wiring

    /// @notice One-time wiring, called by the deploy script. Admin only.
    /// @dev Reverts: ZeroAddress, AddressAlreadySet.
    function setSupplyChain(address supplyChain) external;

    /// @notice One-time wiring, called by the deploy script. Admin only.
    /// @dev Reverts: ZeroAddress, AddressAlreadySet.
    function setInventoryManager(address inventoryManager) external;
}
