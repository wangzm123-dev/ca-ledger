const { ethers } = require("hardhat");

// Enum values mirror contracts/CarbonTypes.sol
const BatchStatus = { Pending: 0, Verified: 1, Rejected: 2, Issued: 3 };
const AuthStatus = { None: 0, Authorized: 1, Adjusted: 2, Revoked: 3 };
const UseType = { Voluntary: 0, Corsia: 1 };

const ADMIN_DELAY = 3 * 24 * 60 * 60; // 3 days
const MIN_VINTAGE = 2016;
const METHODOLOGY = ethers.id("VM0047"); // keccak256 of methodology code
const UNITS_PER_TONNE = 1000n;

const DEFAULT_BATCH = {
  serial: "VCS-4321-2024-0001",
  projectId: "VCS-4321",
  vintage: 2024,
  methodology: METHODOLOGY,
  quantity: 10_000n, // tonnes
  reportCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
};

const EVIDENCE_LOA = ethers.id("LoA-PDF-v1");
const EVIDENCE_CA = ethers.id("CA-record-2026");
const EVIDENCE_REVOKE = ethers.id("Revocation-notice");

/** Registry deployed, roles granted to distinct accounts, one methodology approved. */
async function deployRegistryFixture() {
  const [admin, developer, vvb, issuer, host, pauser, buyer, airline, attacker, developer2, host2] =
    await ethers.getSigners();

  const Registry = await ethers.getContractFactory("CarbonRegistry");
  const registry = await Registry.deploy(ADMIN_DELAY, admin.address, MIN_VINTAGE);
  await registry.waitForDeployment();

  await registry.grantRole(await registry.DEVELOPER_ROLE(), developer.address);
  await registry.grantRole(await registry.DEVELOPER_ROLE(), developer2.address);
  await registry.grantRole(await registry.VVB_ROLE(), vvb.address);
  await registry.grantRole(await registry.ISSUER_ROLE(), issuer.address);
  await registry.grantRole(await registry.HOST_AUTHORITY_ROLE(), host.address);
  await registry.grantRole(await registry.HOST_AUTHORITY_ROLE(), host2.address);
  await registry.grantRole(await registry.PAUSER_ROLE(), pauser.address);
  await registry.approveMethodology(METHODOLOGY, true);

  return { registry, admin, developer, vvb, issuer, host, pauser, buyer, airline, attacker, developer2, host2 };
}

async function submit(registry, signer, overrides = {}) {
  const b = { ...DEFAULT_BATCH, ...overrides };
  return registry
    .connect(signer)
    .submitBatch(b.serial, b.projectId, b.vintage, b.methodology, b.quantity, b.reportCID);
}

/** One batch submitted and verified. */
async function verifiedBatchFixture() {
  const ctx = await deployRegistryFixture();
  await submit(ctx.registry, ctx.developer);
  await ctx.registry.connect(ctx.vvb).verifyBatch(0);
  return ctx;
}

/** One batch issued; returns its ERC-20 token. */
async function issuedBatchFixture() {
  const ctx = await verifiedBatchFixture();
  await ctx.registry.connect(ctx.issuer).issueBatch(0);
  const batch = await ctx.registry.getBatch(0);
  const token = await ethers.getContractAt("CarbonBatchToken", batch.token);
  return { ...ctx, token };
}

module.exports = {
  BatchStatus,
  AuthStatus,
  UseType,
  ADMIN_DELAY,
  MIN_VINTAGE,
  METHODOLOGY,
  UNITS_PER_TONNE,
  DEFAULT_BATCH,
  EVIDENCE_LOA,
  EVIDENCE_CA,
  EVIDENCE_REVOKE,
  deployRegistryFixture,
  verifiedBatchFixture,
  issuedBatchFixture,
  submit,
};
