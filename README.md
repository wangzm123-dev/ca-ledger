# A6Carbon — An Article 6–Aware Carbon Credit Registry with ERC-20 Batch Tokens

CSIT5760 Blockchain and Smart Contracts — individual final project.

| | |
|---|---|
| Network | Ethereum Sepolia (chain ID 11155111) |

## Summary

A6Carbon is a registry-native carbon-credit system on Ethereum. "Article 6" refers to Article 6 of the
Paris Agreement, under which host-country authorization and a corresponding adjustment decide whether
a credit may be used for compliance claims such as CORSIA (international aviation offsetting).

- **CarbonRegistry**: `AccessControlDefaultAdminRules` + `Pausable`.
  - Runs the batch lifecycle (*Pending → Verified → Issued*, or *Rejected*).
  - Enforces separation of duties (developer ≠ VVB ≠ issuer).
  - Records Article 6 authorization (*None → Authorized → Adjusted*, with revocation).
  - Acts as a factory that deploys one batch token per issued batch.
- **CarbonBatchToken**: `ERC20` + `ERC20Capped` + `ERC20Pausable` + `AccessControl`.
  - One token per verified batch; 1 token = 1 tCO2e (3 decimals, smallest unit 1 kg).
  - Only the registry can mint, and the cap equals the verified quantity.
  - `retire()` burns credits and stores a certificate that snapshots the CCP label and the Article 6
    status at the time of retirement.
  - CORSIA retirement requires status `Adjusted`.

No contract holds or accepts Ether.

## Deployed contracts (Sepolia)

| Contract | Address | Verified source |
|---|---|---|
| CarbonRegistry | `0x14271dFc0Fc280aF216eBDA022C5A19Ee36BA952` | https://sepolia.etherscan.io/address/0x14271dFc0Fc280aF216eBDA022C5A19Ee36BA952#code |
| CarbonBatchToken (A6C-2, batch 2) | `0xec07cBDBaB48bD691Dc6d56CE96Ef7169CF0a33C` | https://sepolia.etherscan.io/address/0xec07cBDBaB48bD691Dc6d56CE96Ef7169CF0a33C#code |

- Deployer: `0x6307BE141e9295f84C42aAEE882D62c995406977`.
- Registry deployment:
  - tx `0xda99256da978cbf78c7c143042ec4a507005be670db70f3c58364e1103f0b3c9`
  - block 12063762, 4 Nov 2026 16:59:48 UTC.
- Token creation:
  - happened inside the `issueBatch` tx `0xd26e6f4d286bbc1f9c56baed47c79ed73d6354aee51750d356058cc26804d96a`
  - block 12063845.
- All addresses, constructor arguments and the 21 demonstration transaction hashes are in
  `deployment/sepolia.json` (summary: `deployment/deployment-information.txt`).
- Batches 0 and 1 are left over from interrupted demo runs: they are Pending and have no token.

## Prerequisites

- Node.js ≥ 18 (tested with Node 24.19.0) and npm
- For Sepolia only:
  - a test-only wallet holding Sepolia ETH; it can be mined from the PoW faucet
    <https://sepolia-faucet.pk910.de/> using the wallet address;
  - an Etherscan API key.
- For the security scan only: Python 3 and `pip install slither-analyzer solc-select`, then
  `solc-select install 0.8.24 && solc-select use 0.8.24`.

## External libraries and exact versions

| Component | Version |
|---|---|
| Solidity | 0.8.24, optimizer enabled (200 runs), EVM `cancun` |
| @openzeppelin/contracts | 5.6.1 |
| hardhat | 2.29.1 |
| @nomicfoundation/hardhat-toolbox | 5.0.0 (ethers 6.17.0, hardhat-verify 2.1.3, solidity-coverage 0.8.17, hardhat-gas-reporter 1.0.10) |
| Slither | 0.11.6 |

## Installation, compilation and tests

```bash
npm ci                # installs the exact versions from package-lock.json
npm run compile       # compiles with solc 0.8.24
npm test              # 50 tests (T-01 … T-50)
npm run coverage      # coverage report in ./coverage (100 % lines, 93 % branches)
npm run gas           # gas report -> tests/gas-report.txt
npm run observe       # 8 key cases: expected vs observed -> tests/key-cases-observed.txt
npm run evidence      # re-runs tests, coverage and gas; rewrites tests/*.txt with a header
                      # (time, git commit, versions); exits non-zero if any test fails
npm run demo:local    # full lifecycle on the in-process Hardhat network
npm run slither       # static analysis (requires Slither + solc 0.8.24)
```

## Deployment (Sepolia)

1. `cp .env.example .env` and fill in:
   - `DEPLOYER_PRIVATE_KEY`: a **test-only** wallet; about 0.05 Sepolia ETH is enough.
   - `ETHERSCAN_API_KEY`.
   - Optionally `SEPOLIA_RPC_URL`.
2. Deploy the registry and approve the demo methodology:
   ```bash
   npm run deploy:sepolia      # writes deployment/sepolia.json
   ```
3. Run the demonstration, which grants roles to separate accounts, submits, verifies, issues,
   authorizes, transfers and retires:
   ```bash
   npm run demo:sepolia        # appends the token address and all tx hashes to deployment/sepolia.json
   ```
   If the optional `*_PRIVATE_KEY` role variables are empty, the script creates throw-away role wallets
   and funds each with a small amount of test ETH from the deployer. Their keys are never saved.
4. Verify both contracts on Etherscan:
   ```bash
   npm run verify:sepolia
   ```
5. Optionally re-check the deployment without the Etherscan web page (receipts, bytecode match,
   Etherscan API status, gas schedule):
   ```bash
   npm run check:sepolia       # writes deployment/onchain-check-sepolia.txt; exits 1 if any check fails
   ```

**Gas on Sepolia vs local.** Operations that create new state (new accounts, new storage slots,
new contracts) cost several times more on Sepolia than in the local gas report, e.g. `issueBatch`
10.9 M vs 1.55 M gas, and a plain ETH transfer to a new account 204,600 vs 21,000 gas. Updates of
existing storage cost about the same. All receipts were re-checked (`deployment/onchain-check-sepolia.txt`);
the difference comes from the Glamsterdam upgrade, active on Sepolia since 6 October 2026,
whose EIP-8037 charges 183,600 gas for a new account and 97,920 gas for a new storage slot.
It does not come from the contracts.

## Roles and account assumptions

| Role | Holder (intended) | Can |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | registry governance (multisig in production) | grant/revoke roles, approve methodologies, set minimum vintage; transfer is two-step with a delay (1 day on Sepolia) |
| `DEVELOPER_ROLE` | project developer | `submitBatch` |
| `VVB_ROLE` | validation/verification body | `verifyBatch`, `rejectBatch` (not on own batch) |
| `ISSUER_ROLE` | registry operator | `issueBatch` (not if developer/verifier), `setCCPLabel` |
| `HOST_AUTHORITY_ROLE` | host-country Article 6 authority | `setAuthorization` (first authority binds to the batch) |
| `PAUSER_ROLE` | emergency operator | `pause`/`unpause`, `pauseBatch`/`unpauseBatch` |
| (none) | any token holder | ERC-20 `transfer`, `approve`, `transferFrom`; `retire` |

Each role is assumed to be held by a different, independently controlled account. The contracts also
enforce this per batch, because one account may hold several roles.

## Interacting with the contracts

**Scripted.** `scripts/demo.js` performs the full workflow and prints every transaction hash.

**Manual, from the Hardhat console** (`npx hardhat console --network sepolia`):

```js
const reg = await ethers.getContractAt("CarbonRegistry", "0x14271dFc0Fc280aF216eBDA022C5A19Ee36BA952");
await reg.getBatch(2);                 // stored batch record
await reg.isCorsiaEligible(2);         // true (Issued + Adjusted)
const tok = await ethers.getContractAt("CarbonBatchToken", "0xec07cBDBaB48bD691Dc6d56CE96Ef7169CF0a33C");
await tok.totalSupply(); await tok.totalRetired(); await tok.cap();   // 9150000 + 850000 = 10000000 units
await tok.getRetirement(0);            // CORSIA retirement certificate
// as a holder: await tok.retire(1000n, "Beneficiary", "Purpose", 0)   // retire 1 t (Voluntary)
```

**Without tools.** On Etherscan, open a contract's **Contract → Read Contract / Write Contract** tabs
and connect MetaMask to call the same functions.

Typical order of calls:
1. admin `grantRole`;
2. developer `submitBatch(serial, projectId, vintage, keccak256(methodology), tonnes, reportCID)`;
3. VVB `verifyBatch(id)`;
4. issuer `issueBatch(id)`;
5. host `setAuthorization(id, 1 /*Authorized*/, evidenceHash)`, then `setAuthorization(id, 2 /*Adjusted*/, evidenceHash)`;
6. holders `transfer` / `approve` / `transferFrom` / `retire`.

## Project layout

```
contracts/
  CarbonTypes.sol          shared enums + registry view interface
  CarbonRegistry.sol       lifecycle, roles, Article 6, factory
  CarbonBatchToken.sol     capped ERC-20 per batch + retirement certificates
tests/                     (Hardhat test folder, set by paths.tests in hardhat.config.js)
  fixtures.js              deployment fixtures and constants
  CarbonRegistry.test.js   T-01 … T-35
  CarbonBatchToken.test.js T-36 … T-50
  test-output.txt  coverage-summary.txt  gas-report.txt
scripts/
  deploy.js  demo.js  verify.js  check-onchain.js  package.js
deployment/
  sepolia.json             addresses, constructor arguments, all transaction hashes
  deployment-information.txt
  demo-sepolia.txt  verify-sepolia.txt  onchain-state-sepolia.txt  onchain-check-sepolia.txt
audit/
  slither-initial.txt  slither-final.txt  security-report.txt
```

## Known limitations

- The prototype demonstrates a traceable workflow, **not legally valid carbon credits**:
  - VVB accreditation and the authenticity of authorization letters happen off-chain;
  - only document hashes and IPFS CIDs are stored on-chain.
- Role holders are trusted to act honestly. The admin and pauser are single accounts on the testnet;
  in production they would be a multisig and a timelock.
- One contract is deployed per batch (about 1.55 M gas per issuance locally). Minimal proxy clones
  would reduce this cost.
- There is no web front end; use the scripts, the Hardhat console or Etherscan.
- There is no trading, payment or bridging, and no claim of official CORSIA eligibility.
  `isCorsiaEligible` applies a simplified demonstration rule: the batch is Issued and its Article 6
  status is `Adjusted`. Real eligibility also depends on the programme, the project, the vintage and
  compliance rules, which are not checked on-chain.
- Retirement certificates are **historical snapshots**. If a batch is revoked after a CORSIA
  retirement, the old certificate still shows `Adjusted`. To know whether a credit is valid today,
  read the batch's current status as well.
- `setCCPLabel` is trusted to the issuer. The contract does not check the external basis for the label.
- The registry `pause()` stops registry actions only. Issued tokens keep working until each one is
  frozen with `pauseBatch()`.

## Security considerations

- No Ether is held. The only external calls are registry → its own tokens and token → its own registry
  (`view`).
- Slither 0.11.6:
  - the initial scan reported `reentrancy-events` in `issueBatch`, fixed by emitting before the mint
    call (F-01);
  - it also reported a `timestamp` false positive, an array-length comparison (F-02).
  - See `audit/slither-initial.txt`, `audit/slither-final.txt` and `audit/security-report.txt`.
- Manual review findings: the ERC-20 approve race (F-03, documented) and admin/pauser centralization
  (F-04, mitigated by the delayed two-step admin transfer).
- Protections:
  - separation-of-duties checks on top of role checks;
  - one-way state machines;
  - permanently consumed serial hashes;
  - a capped supply;
  - input-length limits;
  - global and per-batch pause.
- Everything on-chain is public and permanent. `beneficiary`/`purpose` strings are stored in full,
  limited to 128 bytes each. Use only synthetic or non-sensitive data.
- A clean Slither result does not mean the system is secure. Static analysis cannot check whether
  authorizations are genuine, whether role holders are independent, or whether on-chain status
  matches the real world. These rest on the trust assumptions above.
- **Never commit `.env`** (private keys, API keys). `node_modules/`, `artifacts/`, `cache/` and
  `coverage/` are git-ignored.
