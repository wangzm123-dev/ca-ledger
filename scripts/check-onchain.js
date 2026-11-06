// Independent post-deployment check of the Sepolia deployment, without the Etherscan web page:
//   1. re-reads every recorded transaction receipt and compares gasUsed and status;
//   2. compares the on-chain runtime bytecode with the local compiler output;
//   3. asks the Etherscan V2 API whether the source is verified, and with which settings;
//   4. probes the network's gas schedule: a plain transfer to an existing vs a new address.
// Usage: npx hardhat compile && npx hardhat run scripts/check-onchain.js --network sepolia
// Output: printed and written to deployment/onchain-check-sepolia.txt (no secrets are written).
// Exit code: 0 only if every check passes; any failed check, missing receipt or API error exits 1,
// so the script can be used as an automated gate (e.g. in CI). Section 4 is information only.
// CHECK_DEPLOYMENT_FILE=<path> checks another deployment record (used to test the failure path).
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn) {
  for (let i = 0; ; i++) {
    try {
      const v = await fn();
      if (v === null && i < 5) throw new Error("null result from lagging node");
      return v;
    } catch (e) {
      if (i >= 6) throw e;
      await sleep(2500);
    }
  }
}

async function main() {
  const { ethers, network, artifacts, config } = hre;
  const file = process.env.CHECK_DEPLOYMENT_FILE || path.join(__dirname, "..", "deployment", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const p = ethers.provider;
  const out = [];
  const log = (s = "") => { console.log(s); out.push(s); };
  // Every check goes through check(): a failure is logged as FAIL and makes the script exit non-zero.
  let passed = 0;
  const failures = [];
  const check = (ok, label, detail = "") => {
    if (ok) passed++;
    else failures.push(label);
    log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
    return ok;
  };

  log(`A6Carbon on-chain check - ${network.name} (chain ${d.chainId}) - run ${new Date().toISOString()}`);
  const chainId = (await p.getNetwork()).chainId;
  check(chainId === BigInt(d.chainId), "connected to the recorded chain", `chainId ${chainId}`);

  // 1. receipts
  log("\n1. Transaction receipts (status 1 and recorded gasUsed == receipt gasUsed)");
  const txs = [
    { step: "deploy CarbonRegistry", txHash: d.contracts.CarbonRegistry.txHash, blockNumber: d.contracts.CarbonRegistry.blockNumber },
    { step: "approveMethodology", txHash: d.setup.approveMethodology.txHash },
    ...d.demo.transactions,
  ];
  for (const t of txs) {
    const rc = await retry(() => p.getTransactionReceipt(t.txHash));
    if (!rc) {
      check(false, t.step, `receipt not found for ${t.txHash}`);
      continue;
    }
    const ok =
      rc.status === 1 &&
      (t.gasUsed === undefined || BigInt(t.gasUsed) === rc.gasUsed) &&
      (t.blockNumber === undefined || t.blockNumber === rc.blockNumber);
    check(ok, t.step.padEnd(42), `block ${rc.blockNumber}  status ${rc.status}  gasUsed ${rc.gasUsed}${t.gasUsed ? ` (recorded ${t.gasUsed})` : ""}`);
  }
  const deployRc = await retry(() => p.getTransactionReceipt(d.contracts.CarbonRegistry.txHash));
  check(
    deployRc && deployRc.contractAddress?.toLowerCase() === d.contracts.CarbonRegistry.address.toLowerCase(),
    "deploy transaction created the recorded CarbonRegistry address"
  );

  // 2. bytecode
  const s = config.solidity.compilers[0];
  log(`\n2. Runtime bytecode vs local build (solc ${s.version}, ${s.settings.optimizer.runs} runs, ${s.settings.evmVersion})`);
  const reg = await artifacts.readArtifact("CarbonRegistry");
  const regCode = (await retry(() => p.getCode(d.contracts.CarbonRegistry.address))).toLowerCase();
  check(regCode !== "0x" && regCode === reg.deployedBytecode.toLowerCase(), "CarbonRegistry bytecode identical", `(${(regCode.length - 2) / 2} bytes)`);
  const tokArt = await artifacts.readArtifact("CarbonBatchToken");
  const build = await artifacts.getBuildInfo("contracts/CarbonBatchToken.sol:CarbonBatchToken");
  const refs = Object.values(
    build.output.contracts["contracts/CarbonBatchToken.sol"].CarbonBatchToken.evm.deployedBytecode.immutableReferences || {}
  ).flat();
  const mask = (hex) => {
    const a = hex.toLowerCase().slice(2).split("");
    for (const r of refs) for (let i = r.start * 2; i < (r.start + r.length) * 2; i++) a[i] = "0";
    return a.join("");
  };
  const tokCode = await retry(() => p.getCode(d.contracts.CarbonBatchToken.address));
  check(
    tokCode !== "0x" && tokCode.length === tokArt.deployedBytecode.length && mask(tokCode) === mask(tokArt.deployedBytecode),
    `CarbonBatchToken bytecode identical apart from ${refs.length} immutable slots (registry, batchId)`,
    `(${(tokCode.length - 2) / 2} bytes)`
  );
  const tok = await ethers.getContractAt("CarbonBatchToken", d.contracts.CarbonBatchToken.address);
  const read = async (fn) => {
    try { return await retry(fn); } catch (e) { return `call failed: ${e.shortMessage || e.message}`; }
  };
  const tokRegistry = String(await read(() => tok.registry()));
  check(tokRegistry.toLowerCase() === d.contracts.CarbonRegistry.address.toLowerCase(), "token immutable registry == recorded registry", tokRegistry);
  const tokBatch = await read(() => tok.batchId());
  check(tokBatch === BigInt(d.contracts.CarbonBatchToken.batchId), "token immutable batchId == recorded batchId", String(tokBatch));

  // 3. Etherscan API: source verified with the same settings as hardhat.config.js
  log("\n3. Etherscan V2 API getsourcecode (verified, and settings equal hardhat.config.js)");
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) {
    if (process.env.CHECK_SKIP_ETHERSCAN === "true") log("  SKIPPED: CHECK_SKIP_ETHERSCAN=true and no ETHERSCAN_API_KEY");
    else check(false, "ETHERSCAN_API_KEY is set (or set CHECK_SKIP_ETHERSCAN=true to skip this section)");
  } else
    for (const [name, c] of Object.entries(d.contracts)) {
      let x = {};
      try {
        const r = await fetch(
          `https://api.etherscan.io/v2/api?chainid=${d.chainId}&module=contract&action=getsourcecode&address=${c.address}&apikey=${key}`
        );
        const j = await r.json();
        if (!r.ok || j.status !== "1") throw new Error(`HTTP ${r.status}, API status ${j.status} ${j.message}`);
        x = j.result?.[0] || {};
      } catch (e) {
        check(false, `${name} Etherscan API request`, e.message);
        continue;
      }
      check((x.SourceCode || "").length > 0 && x.ContractName === name, `${name} source verified on Etherscan`, `name ${x.ContractName}`);
      check(
        (x.CompilerVersion || "").startsWith(`v${s.version}+`) &&
          x.OptimizationUsed === (s.settings.optimizer.enabled ? "1" : "0") &&
          x.Runs === String(s.settings.optimizer.runs) &&
          (x.EVMVersion || "").toLowerCase() === s.settings.evmVersion,
        `${name} verification settings match the build`,
        `compiler ${x.CompilerVersion}; optimization ${x.OptimizationUsed}, runs ${x.Runs}; EVM ${x.EVMVersion}`
      );
    }

  // 4. gas schedule probe (information only, not a pass/fail check)
  log("\n4. Gas schedule probe, information only (estimateGas for a 1-wei transfer from the deployer)");
  const to1 = "0x000000000000000000000000000000000000dEaD";
  const to2 = ethers.Wallet.createRandom().address;
  const g1 = await retry(() => p.estimateGas({ from: d.deployer, to: to1, value: 1n }));
  const g2 = await retry(() => p.estimateGas({ from: d.deployer, to: to2, value: 1n }));
  log(`  to an existing account: ${g1}`);
  log(`  to a new, empty account: ${g2}`);
  log("  The local Hardhat EVM (Cancun) charges 21000 in both cases.");

  log(`\nRESULT: ${failures.length === 0 ? "PASS" : "FAIL"} - ${passed} checks passed, ${failures.length} failed`);
  if (!process.env.CHECK_DEPLOYMENT_FILE) {
    fs.writeFileSync(path.join(__dirname, "..", "deployment", `onchain-check-${network.name}.txt`), out.join("\n") + "\n");
  }
  if (failures.length) throw new Error(`On-chain check failed:\n  - ${failures.join("\n  - ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
