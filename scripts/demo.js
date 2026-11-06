// End-to-end demonstration on a deployed CarbonRegistry.
// Every role is a DIFFERENT account, so separation of duties is shown on-chain.
//
// Usage:
//   npx hardhat run scripts/deploy.js --network sepolia
//   npx hardhat run scripts/demo.js   --network sepolia
//
// Role accounts: on the local Hardhat network the built-in signers are used. On Sepolia, either set
// DEVELOPER_PRIVATE_KEY, VVB_PRIVATE_KEY, ISSUER_PRIVATE_KEY, HOST_PRIVATE_KEY, AIRLINE_PRIVATE_KEY
// in .env, or leave them empty and the script creates throw-away wallets funded with a little test
// ETH from the deployer. Throw-away keys are never written to disk.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ROLE_NAMES = ["developer", "vvb", "issuer", "host", "airline"];
const FUND_ETH = { developer: "0.004", vvb: "0.002", issuer: "0.012", host: "0.002", airline: "0.003" };
const UseType = { Voluntary: 0, Corsia: 1 };
const AuthStatus = { None: 0, Authorized: 1, Adjusted: 2, Revoked: 3 };

async function main() {
  const { ethers, network } = hre;
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  let deployment;
  if (network.name === "hardhat") {
    // The in-process Hardhat network is fresh on every run: always deploy first.
    await require("./deploy").main();
    deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  } else if (fs.existsSync(file)) {
    deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    throw new Error(`No deployment file ${file}. Run scripts/deploy.js first.`);
  }

  const [admin, ...localSigners] = await ethers.getSigners();
  const registry = await ethers.getContractAt("CarbonRegistry", deployment.contracts.CarbonRegistry.address, admin);
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const live = network.name !== "hardhat";
  // `send` is a function returning a tx promise, so it can be retried when a public RPC node drops
  // the connection or gas-estimates against a block it has not seen yet.
  const record = async (step, send) => {
    let tx;
    for (let attempt = 1; ; attempt++) {
      try {
        tx = await send();
        break;
      } catch (e) {
        if (!live || attempt >= 5) throw e;
        console.log(`  [retry ${attempt}] ${step}: ${e.shortMessage || e.message}`.slice(0, 160));
        await sleep(6000);
      }
    }
    let rc;
    for (let attempt = 1; ; attempt++) {
      try {
        // On a public testnet wait 2 confirmations so every backend node sees the new state.
        rc = await tx.wait(live ? 2 : 1);
        break;
      } catch (e) {
        if (!live || attempt >= 5) throw e;
        await sleep(6000);
      }
    }
    log.push({ step, txHash: tx.hash, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed.toString() });
    console.log(`  [ok] ${step.padEnd(42)} ${tx.hash}`);
    return rc;
  };

  // ---------------------------------------------------------------- role accounts
  const roles = {};
  for (const [i, name] of ROLE_NAMES.entries()) {
    const key = process.env[`${name.toUpperCase()}_PRIVATE_KEY`];
    if (network.name === "hardhat" || network.name === "localhost") roles[name] = localSigners[i];
    else if (key) roles[name] = new ethers.Wallet(key, ethers.provider);
    else {
      roles[name] = ethers.Wallet.createRandom().connect(ethers.provider);
      await record(`fund ${name} with ${FUND_ETH[name]} ETH`, () => admin.sendTransaction({
        to: roles[name].address,
        value: ethers.parseEther(FUND_ETH[name]),
      }));
    }
  }
  console.log("Accounts:");
  console.log(`  admin     ${admin.address}`);
  for (const n of ROLE_NAMES) console.log(`  ${n.padEnd(9)} ${roles[n].address}`);

  // ---------------------------------------------------------------- 1. roles (AccessControl)
  console.log("\n1. Grant roles");
  await record("grant DEVELOPER_ROLE", async () => registry.grantRole(await registry.DEVELOPER_ROLE(), roles.developer.address));
  await record("grant VVB_ROLE", async () => registry.grantRole(await registry.VVB_ROLE(), roles.vvb.address));
  await record("grant ISSUER_ROLE", async () => registry.grantRole(await registry.ISSUER_ROLE(), roles.issuer.address));
  await record("grant HOST_AUTHORITY_ROLE", async () => registry.grantRole(await registry.HOST_AUTHORITY_ROLE(), roles.host.address));
  await record("grant PAUSER_ROLE (admin)", async () => registry.grantRole(await registry.PAUSER_ROLE(), admin.address));

  // ---------------------------------------------------------------- 2. lifecycle
  console.log("\n2. Batch lifecycle");
  const serial = process.env.DEMO_SERIAL || `VCS-4321-2024-${Date.now()}`;
  const methodology = deployment.setup.approveMethodology.id;
  // IDs and addresses are read from receipt events: public RPC nodes may serve stale state right
  // after a transaction is mined, so a follow-up view call (e.g. batchCount) is not reliable.
  const eventArgs = (rc, name) => {
    for (const lg of rc.logs) {
      try {
        const parsed = registry.interface.parseLog(lg);
        if (parsed && parsed.name === name) return parsed.args;
      } catch (_) {}
    }
    throw new Error(`${name} event not found`);
  };
  const submitRc = await record(
    "developer submitBatch (10,000 t)",
    () =>
    registry
      .connect(roles.developer)
      .submitBatch(serial, "VCS-4321", 2024, methodology, 10_000n, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")
  );
  const batchId = eventArgs(submitRc, "BatchSubmitted").batchId;
  console.log(`  batchId ${batchId}`);
  await record("VVB verifyBatch", () => registry.connect(roles.vvb).verifyBatch(batchId));
  const issueRc = await record("issuer issueBatch (deploy + mint ERC-20)", () => registry.connect(roles.issuer).issueBatch(batchId));
  const batch = { token: eventArgs(issueRc, "BatchIssued").token };
  const token = await ethers.getContractAt("CarbonBatchToken", batch.token);
  console.log(`  token at ${batch.token}`);
  console.log(`  developer balance: ${ethers.formatUnits(await token.balanceOf(roles.developer.address), 3)} t`);

  // ---------------------------------------------------------------- 3. Article 6 + label
  console.log("\n3. Article 6 authorization and CCP label");
  await record("host setAuthorization(Authorized, LoA)", () => registry
    .connect(roles.host)
    .setAuthorization(batchId, AuthStatus.Authorized, ethers.id("LoA-demo")));
  await record("host setAuthorization(Adjusted, CA)", () => registry
    .connect(roles.host)
    .setAuthorization(batchId, AuthStatus.Adjusted, ethers.id("CA-demo")));
  await record("issuer setCCPLabel(true)", () => registry.connect(roles.issuer).setCCPLabel(batchId, true));
  console.log(`  isCorsiaEligible: ${await registry.isCorsiaEligible(batchId)}`);

  // ---------------------------------------------------------------- 4. ERC-20 operations
  console.log("\n4. ERC-20 transfer / approve / transferFrom");
  const t = (n) => ethers.parseUnits(String(n), 3);
  await record("developer transfer 1,000 t to airline", () => token.connect(roles.developer).transfer(roles.airline.address, t(1000)));
  await record("developer approve airline 500 t", () => token.connect(roles.developer).approve(roles.airline.address, t(500)));
  await record("airline transferFrom 200 t", () => token
    .connect(roles.airline)
    .transferFrom(roles.developer.address, roles.airline.address, t(200)));

  // ---------------------------------------------------------------- 5. retirement
  console.log("\n5. Retirement");
  await record("airline retire 800 t (CORSIA)", () => token
    .connect(roles.airline)
    .retire(t(800), "Demo Airline", "CORSIA first phase", UseType.Corsia));
  await record("developer retire 50 t (Voluntary)", () => token
    .connect(roles.developer)
    .retire(t(50), "Demo Developer", "Voluntary offset", UseType.Voluntary));

  // ---------------------------------------------------------------- 6. negative checks (no gas)
  console.log("\n6. Expected reverts (static calls, no transaction)");
  if (network.name !== "hardhat") await new Promise((r) => setTimeout(r, 8000)); // let RPC state settle
  const expectRevert = async (label, fn) => {
    try {
      await fn();
      console.log(`  [!!] ${label}: did NOT revert`);
    } catch (e) {
      const reason = e.revert?.name || e.shortMessage || e.message;
      console.log(`  [ok] ${label}: reverted (${reason})`);
    }
  };
  await expectRevert("airline mints tokens", () => token.connect(roles.airline).mint.staticCall(roles.airline.address, 1));
  await expectRevert("issuer re-issues batch", () => registry.connect(roles.issuer).issueBatch.staticCall(batchId));
  await expectRevert("developer resubmits same serial", () =>
    registry.connect(roles.developer).submitBatch.staticCall(serial, "VCS-4321", 2024, methodology, 1n, "cid"));

  // ---------------------------------------------------------------- summary
  // Retry a few times so a lagging RPC node has caught up with the last mined block.
  let supply, retired, cap;
  for (let i = 0; i < 6; i++) {
    [supply, retired, cap] = await Promise.all([token.totalSupply(), token.totalRetired(), token.cap()]);
    if (supply + retired === cap && retired > 0n) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log("\nSummary");
  console.log(`  totalSupply ${ethers.formatUnits(supply, 3)} t + totalRetired ${ethers.formatUnits(retired, 3)} t = cap ${ethers.formatUnits(cap, 3)} t -> ${supply + retired === cap ? "OK" : "MISMATCH"}`);
  console.log(`  retirement certificates: ${await token.retirementCount()}`);

  deployment.contracts.CarbonBatchToken = {
    address: batch.token,
    batchId: Number(batchId),
    constructorArgs: [await token.name(), await token.symbol(), cap.toString(), await registry.getAddress(), Number(batchId)],
  };
  deployment.demo = {
    serial,
    accounts: Object.fromEntries([["admin", admin.address], ...ROLE_NAMES.map((n) => [n, roles[n].address])]),
    transactions: log,
  };
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2));
  console.log(`\nSaved transaction log to ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
