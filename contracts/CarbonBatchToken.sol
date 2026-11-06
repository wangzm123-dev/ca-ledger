// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {AuthStatus, UseType, ICarbonRegistryView} from "./CarbonTypes.sol";

/// @title CarbonBatchToken
/// @notice ERC-20 token for ONE verified carbon-credit batch. 1 token = 1 tCO2e (3 decimals, 1 unit = 1 kg).
/// @dev Deployed by CarbonRegistry, which is the only holder of MINTER_ROLE and PAUSER_ROLE.
///      The cap equals the verified quantity, so supply can never exceed what the VVB verified.
contract CarbonBatchToken is ERC20, ERC20Capped, ERC20Pausable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Maximum byte length of beneficiary / purpose strings (gas and storage bound).
    uint256 public constant MAX_TEXT_LENGTH = 128;

    struct Retirement {
        address account; // holder whose tokens were burned
        uint256 amount; // token units (kg)
        UseType useType; // Voluntary or CORSIA
        bool ccpLabel; // CCP label snapshot at retirement time
        AuthStatus auth; // Article 6 status snapshot at retirement time
        uint64 timestamp;
        string beneficiary; // entity on whose behalf the claim is made
        string purpose; // e.g. "FY2026 Scope 1 offset"
    }

    ICarbonRegistryView public immutable registry;
    uint256 public immutable batchId;

    /// @notice Cumulative units burned through retire(); totalSupply() + totalRetired == cap() once fully minted.
    uint256 public totalRetired;

    Retirement[] private _retirements;

    event CreditsRetired(
        uint256 indexed retirementId,
        address indexed account,
        uint256 amount,
        UseType useType,
        bool ccpLabel,
        AuthStatus auth,
        string beneficiary,
        string purpose
    );

    error ZeroAmount();
    error StringTooLong();
    error EmptyBeneficiary();
    error NotCorsiaEligible(AuthStatus current);
    error RetirementNotFound(uint256 retirementId);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 cap_,
        address registry_,
        uint256 batchId_
    ) ERC20(name_, symbol_) ERC20Capped(cap_) {
        registry = ICarbonRegistryView(registry_);
        batchId = batchId_;
        _grantRole(DEFAULT_ADMIN_ROLE, registry_);
        _grantRole(MINTER_ROLE, registry_);
        _grantRole(PAUSER_ROLE, registry_);
    }

    /// @notice 3 decimals so that 1 token = 1 tonne and the smallest unit = 1 kg.
    function decimals() public pure override returns (uint8) {
        return 3;
    }

    /// @notice Mint new credits. Only the registry can call this, and ERC20Capped enforces the verified quantity.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Permanently retire (burn) the caller's credits and record a certificate.
    /// @param amount Units to retire (1000 units = 1 tCO2e).
    /// @param beneficiary Entity claiming the reduction (non-empty, <= 128 bytes).
    /// @param purpose Free-text purpose of the claim (<= 128 bytes).
    /// @param useType Voluntary, or CORSIA (requires Article 6 status Adjusted).
    /// @return retirementId Index of the new certificate.
    function retire(
        uint256 amount,
        string calldata beneficiary,
        string calldata purpose,
        UseType useType
    ) external returns (uint256 retirementId) {
        if (amount == 0) revert ZeroAmount();
        if (bytes(beneficiary).length == 0) revert EmptyBeneficiary();
        if (bytes(beneficiary).length > MAX_TEXT_LENGTH || bytes(purpose).length > MAX_TEXT_LENGTH) {
            revert StringTooLong();
        }

        // Read-only call to the trusted registry that deployed this token.
        (bool ccpLabel, AuthStatus auth) = registry.batchIntegrity(batchId);
        if (useType == UseType.Corsia && auth != AuthStatus.Adjusted) revert NotCorsiaEligible(auth);

        // Burn first: reverts on insufficient balance or while paused.
        _burn(msg.sender, amount);
        totalRetired += amount;

        retirementId = _retirements.length;
        _retirements.push(
            Retirement({
                account: msg.sender,
                amount: amount,
                useType: useType,
                ccpLabel: ccpLabel,
                auth: auth,
                timestamp: uint64(block.timestamp),
                beneficiary: beneficiary,
                purpose: purpose
            })
        );

        emit CreditsRetired(retirementId, msg.sender, amount, useType, ccpLabel, auth, beneficiary, purpose);
    }

    /// @notice Returns a retirement certificate.
    function getRetirement(uint256 retirementId) external view returns (Retirement memory) {
        if (retirementId >= _retirements.length) revert RetirementNotFound(retirementId);
        return _retirements[retirementId];
    }

    function retirementCount() external view returns (uint256) {
        return _retirements.length;
    }

    // ---------------------------------------------------------------------
    // Required overrides (OpenZeppelin v5 uses a single _update hook)
    // ---------------------------------------------------------------------

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20, ERC20Capped, ERC20Pausable) {
        super._update(from, to, value);
    }
}
