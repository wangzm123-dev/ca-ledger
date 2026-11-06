// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Lifecycle of a carbon-credit batch inside the registry.
enum BatchStatus {
    Pending, // submitted by a developer, waiting for a VVB
    Verified, // approved by an independent VVB
    Rejected, // refused by a VVB (terminal)
    Issued // ERC-20 batch token deployed and minted (terminal for the registry)
}

/// @notice Paris Agreement Article 6 authorization state recorded by the host authority.
enum AuthStatus {
    None, // no Letter of Authorization (LoA)
    Authorized, // LoA issued, corresponding adjustment (CA) not yet applied
    Adjusted, // LoA issued and CA applied: eligible for compliance (CORSIA) use
    Revoked // authorization withdrawn (terminal)
}

/// @notice Purpose of a retirement.
enum UseType {
    Voluntary,
    Corsia
}

/// @notice Minimal view used by batch tokens to read integrity data from the registry.
interface ICarbonRegistryView {
    function batchIntegrity(uint256 batchId) external view returns (bool ccpLabel, AuthStatus auth);
}
