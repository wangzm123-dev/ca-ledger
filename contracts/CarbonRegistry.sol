// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {CarbonBatchToken} from "./CarbonBatchToken.sol";
import {BatchStatus, AuthStatus, ICarbonRegistryView} from "./CarbonTypes.sol";

/// @title CarbonRegistry (A6Carbon)
/// @notice Registry-native issuance of carbon-credit batches with separation of duties and
///         Paris Agreement Article 6 authorization tracking. Each issued batch gets its own
///         capped ERC-20 token (CarbonBatchToken) deployed by this contract.
/// @dev Workflow: Developer submits -> independent VVB verifies/rejects -> independent Issuer issues
///      (deploys + mints once). Host authority records LoA / corresponding adjustment / revocation.
contract CarbonRegistry is AccessControlDefaultAdminRules, Pausable, ICarbonRegistryView {
    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------
    bytes32 public constant DEVELOPER_ROLE = keccak256("DEVELOPER_ROLE");
    bytes32 public constant VVB_ROLE = keccak256("VVB_ROLE");
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant HOST_AUTHORITY_ROLE = keccak256("HOST_AUTHORITY_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------
    uint256 public constant MAX_TEXT_LENGTH = 128;
    /// @notice Token units per tonne (token has 3 decimals).
    uint256 public constant UNITS_PER_TONNE = 1e3;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------
    struct Batch {
        address developer;
        address verifier;
        address issuer;
        address hostAuthority; // bound on first authorization update
        address token; // CarbonBatchToken once issued
        BatchStatus status;
        AuthStatus auth;
        bool ccpLabel;
        uint16 vintage;
        bytes32 serialHash; // keccak256 of the registry serial number
        bytes32 methodology; // e.g. keccak256("VM0047")
        bytes32 authEvidence; // hash / CID digest of the latest LoA or CA document
        uint256 quantity; // verified tonnes of CO2e
        string projectId;
        string reportCID; // IPFS CID of the verification report
    }

    mapping(uint256 => Batch) private _batches;
    uint256 public batchCount;

    mapping(bytes32 => bool) public serialUsed;
    mapping(bytes32 => bool) public approvedMethodology;
    uint16 public minVintage;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event BatchSubmitted(
        uint256 indexed batchId,
        address indexed developer,
        bytes32 indexed serialHash,
        string serial,
        uint256 quantity
    );
    event BatchVerified(uint256 indexed batchId, address indexed verifier);
    event BatchRejected(uint256 indexed batchId, address indexed verifier, string reason);
    event BatchIssued(uint256 indexed batchId, address indexed token, address indexed developer, uint256 units);
    event AuthorizationUpdated(
        uint256 indexed batchId,
        address indexed hostAuthority,
        AuthStatus previous,
        AuthStatus current,
        bytes32 evidence
    );
    event CCPLabelSet(uint256 indexed batchId, bool labelled);
    event MethodologyApproved(bytes32 indexed methodology, bool approved);
    event MinVintageUpdated(uint16 previous, uint16 current);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error BatchNotFound(uint256 batchId);
    error InvalidStatus(BatchStatus current);
    error DuplicateSerial(bytes32 serialHash);
    error ConflictOfInterest(address account);
    error VintageTooOld(uint16 vintage, uint16 minimum);
    error MethodologyNotApproved(bytes32 methodology);
    error InvalidAuthTransition(AuthStatus from, AuthStatus to);
    error NotBatchHostAuthority(address expected);
    error ZeroAmount();
    error EmptyField();
    error StringTooLong();

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------
    /// @param initialAdminDelay Delay (seconds) before a default-admin transfer can be accepted.
    /// @param initialAdmin Governance account (a multisig in production).
    /// @param minVintage_ Oldest acceptable vintage year (quality floor).
    constructor(
        uint48 initialAdminDelay,
        address initialAdmin,
        uint16 minVintage_
    ) AccessControlDefaultAdminRules(initialAdminDelay, initialAdmin) {
        minVintage = minVintage_;
        emit MinVintageUpdated(0, minVintage_);
    }

    // ------------------------------------------------------------------
    // Governance (DEFAULT_ADMIN_ROLE)
    // ------------------------------------------------------------------
    function approveMethodology(bytes32 methodology, bool approved) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (methodology == bytes32(0)) revert EmptyField();
        approvedMethodology[methodology] = approved;
        emit MethodologyApproved(methodology, approved);
    }

    function setMinVintage(uint16 newMinVintage) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit MinVintageUpdated(minVintage, newMinVintage);
        minVintage = newMinVintage;
    }

    // ------------------------------------------------------------------
    // Batch lifecycle
    // ------------------------------------------------------------------

    /// @notice Developer submits a batch for verification. Each serial can be used only once, ever.
    function submitBatch(
        string memory serial,
        string memory projectId,
        uint16 vintage,
        bytes32 methodology,
        uint256 quantity,
        string memory reportCID
    ) external onlyRole(DEVELOPER_ROLE) whenNotPaused returns (uint256 batchId) {
        if (quantity == 0) revert ZeroAmount();
        _checkText(serial);
        _checkText(projectId);
        _checkText(reportCID);
        if (vintage < minVintage) revert VintageTooOld(vintage, minVintage);
        if (!approvedMethodology[methodology]) revert MethodologyNotApproved(methodology);

        bytes32 serialHash = keccak256(bytes(serial));
        if (serialUsed[serialHash]) revert DuplicateSerial(serialHash);
        serialUsed[serialHash] = true;

        batchId = batchCount++;
        Batch storage b = _batches[batchId];
        b.developer = msg.sender;
        b.status = BatchStatus.Pending;
        b.vintage = vintage;
        b.serialHash = serialHash;
        b.methodology = methodology;
        b.quantity = quantity;
        b.projectId = projectId;
        b.reportCID = reportCID;

        emit BatchSubmitted(batchId, msg.sender, serialHash, serial, quantity);
    }

    /// @notice An independent VVB (not the developer) approves a pending batch.
    function verifyBatch(uint256 batchId) external onlyRole(VVB_ROLE) whenNotPaused {
        Batch storage b = _getBatch(batchId);
        _requireStatus(b, BatchStatus.Pending);
        if (msg.sender == b.developer) revert ConflictOfInterest(msg.sender);

        b.verifier = msg.sender;
        b.status = BatchStatus.Verified;
        emit BatchVerified(batchId, msg.sender);
    }

    /// @notice An independent VVB rejects a pending batch. The serial stays consumed.
    function rejectBatch(uint256 batchId, string memory reason) external onlyRole(VVB_ROLE) whenNotPaused {
        Batch storage b = _getBatch(batchId);
        _requireStatus(b, BatchStatus.Pending);
        if (msg.sender == b.developer) revert ConflictOfInterest(msg.sender);
        _checkText(reason);

        b.verifier = msg.sender;
        b.status = BatchStatus.Rejected;
        emit BatchRejected(batchId, msg.sender, reason);
    }

    /// @notice An issuer (neither developer nor verifier) deploys the batch token and mints the
    ///         verified quantity to the developer. Can happen only once per batch.
    function issueBatch(uint256 batchId) external onlyRole(ISSUER_ROLE) whenNotPaused returns (address token) {
        Batch storage b = _getBatch(batchId);
        _requireStatus(b, BatchStatus.Verified);
        if (msg.sender == b.verifier || msg.sender == b.developer) revert ConflictOfInterest(msg.sender);

        // Effects before interactions.
        b.status = BatchStatus.Issued;
        b.issuer = msg.sender;
        uint256 units = b.quantity * UNITS_PER_TONNE;

        string memory id = Strings.toString(batchId);
        CarbonBatchToken t = new CarbonBatchToken(
            string.concat("A6Carbon Batch ", id),
            string.concat("A6C-", id),
            units,
            address(this),
            batchId
        );
        token = address(t);
        b.token = token;
        emit BatchIssued(batchId, token, b.developer, units);

        // Interaction last (Slither reentrancy-events, finding F-01).
        t.mint(b.developer, units);
    }

    // ------------------------------------------------------------------
    // Article 6 authorization (host authority)
    // ------------------------------------------------------------------

    /// @notice Records the host country's Article 6 decision for a batch.
    /// @dev Allowed transitions: None->Authorized, Authorized->Adjusted, Authorized->Revoked, Adjusted->Revoked.
    ///      The first host authority that acts on a batch becomes its only authority.
    function setAuthorization(
        uint256 batchId,
        AuthStatus newStatus,
        bytes32 evidence
    ) external onlyRole(HOST_AUTHORITY_ROLE) whenNotPaused {
        Batch storage b = _getBatch(batchId);
        if (b.status == BatchStatus.Rejected) revert InvalidStatus(b.status);
        if (msg.sender == b.developer) revert ConflictOfInterest(msg.sender);
        if (evidence == bytes32(0)) revert EmptyField();

        if (b.hostAuthority == address(0)) {
            b.hostAuthority = msg.sender;
        } else if (b.hostAuthority != msg.sender) {
            revert NotBatchHostAuthority(b.hostAuthority);
        }

        AuthStatus previous = b.auth;
        if (!_validAuthTransition(previous, newStatus)) revert InvalidAuthTransition(previous, newStatus);

        b.auth = newStatus;
        b.authEvidence = evidence;
        emit AuthorizationUpdated(batchId, msg.sender, previous, newStatus, evidence);
    }

    // ------------------------------------------------------------------
    // Quality label (issuer)
    // ------------------------------------------------------------------

    /// @notice Sets or clears the ICVCM CCP label for an issued batch. Retirement certificates
    ///         snapshot the label, so a later change can never upgrade an earlier claim.
    function setCCPLabel(uint256 batchId, bool labelled) external onlyRole(ISSUER_ROLE) whenNotPaused {
        Batch storage b = _getBatch(batchId);
        _requireStatus(b, BatchStatus.Issued);
        b.ccpLabel = labelled;
        emit CCPLabelSet(batchId, labelled);
    }

    // ------------------------------------------------------------------
    // Emergency controls (PAUSER_ROLE)
    // ------------------------------------------------------------------
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Pauses transfers and retirements of one batch token (e.g. suspected fraud).
    function pauseBatch(uint256 batchId) external onlyRole(PAUSER_ROLE) {
        Batch storage b = _getBatch(batchId);
        _requireStatus(b, BatchStatus.Issued);
        CarbonBatchToken(b.token).pause();
    }

    function unpauseBatch(uint256 batchId) external onlyRole(PAUSER_ROLE) {
        Batch storage b = _getBatch(batchId);
        _requireStatus(b, BatchStatus.Issued);
        CarbonBatchToken(b.token).unpause();
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    function getBatch(uint256 batchId) external view returns (Batch memory) {
        return _getBatch(batchId);
    }

    /// @inheritdoc ICarbonRegistryView
    function batchIntegrity(uint256 batchId) external view returns (bool ccpLabel, AuthStatus auth) {
        Batch storage b = _getBatch(batchId);
        return (b.ccpLabel, b.auth);
    }

    function isCorsiaEligible(uint256 batchId) external view returns (bool) {
        Batch storage b = _getBatch(batchId);
        return b.status == BatchStatus.Issued && b.auth == AuthStatus.Adjusted;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------
    function _getBatch(uint256 batchId) internal view returns (Batch storage) {
        if (batchId >= batchCount) revert BatchNotFound(batchId);
        return _batches[batchId];
    }

    function _requireStatus(Batch storage b, BatchStatus expected) internal view {
        if (b.status != expected) revert InvalidStatus(b.status);
    }

    /// @dev Required, length-bounded text field.
    function _checkText(string memory s) internal pure {
        uint256 len = bytes(s).length;
        if (len == 0) revert EmptyField();
        if (len > MAX_TEXT_LENGTH) revert StringTooLong();
    }

    function _validAuthTransition(AuthStatus from, AuthStatus to) internal pure returns (bool) {
        if (from == AuthStatus.None) return to == AuthStatus.Authorized;
        if (from == AuthStatus.Authorized) return to == AuthStatus.Adjusted || to == AuthStatus.Revoked;
        if (from == AuthStatus.Adjusted) return to == AuthStatus.Revoked;
        return false; // Revoked is terminal
    }
}
