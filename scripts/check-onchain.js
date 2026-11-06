// Independent post-deployment check of the Sepolia deployment, without the Etherscan web page:
//   1. re-reads every recorded transaction receipt and compares gasUsed and status;
//   2. compares the on-chain runtime bytecode with the local compiler output;
//   3. asks the Etherscan V2 API whether the source is verified, and with which settings;
//   4. probes the network's gas schedule: a plain transfer to an existing vs a new address.
// Usage: npx hardhat compile && npx hardhat run scripts/check-onchain.js --network sepolia
// Output: printed and written to deployment/onchain-check-sepolia.txt (no secrets are written).
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
  const { ethers, network, artifacts } = hre;
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployment", `${network.name}.json`), "utf8"));
  const p = ethers.provider;
  const out = [];
  const log = (s = "") => { console.log(s); out.push(s); };

  log(`A6Carbon on-chain check - ${network.name} (chain ${d.chainId}) - run ${new Date().toISOString()}`);

  // 1. receipts
  log("\n1. Transaction receipts (recorded gasUsed vs receipt gasUsed)");
  const txs = [
    { step: "deploy CarbonRegistry", txHash: d.contracts.CarbonRegistry.txHash },
    { step: "approveMethodology", txHash: d.setup.approveMethodology.txHash },
    ...d.demo.transactions,
  ];
  let mismatches = 0;
  for (const t of txs) {
    const rc = await retry(() => p.getTransactionReceipt(t.txHash));
    const ok = rc.status === 1 && (t.gasUsed === undefined || BigInt(t.gasUsed) === rc.gasUsed);
    if (!ok) mismatches++;
    log(`  ${ok ? "OK " : "BAD"} ${t.step.padEnd(42)} block ${rc.blockNumber}  gasUsed ${rc.gasUsed}`);
  }
  log(`  ${txs.length} receipts, ${mismatches} mismatches`);

  // 2. bytecode
  log("\n2. Runtime bytecode vs local build (solc 0.8.24, 200 runs, cancun)");
  const reg = await artifacts.readArtifact("CarbonRegistry");
  const regCode = (await retry(() => p.getCode(d.contracts.CarbonRegistry.address))).toLowerCase();
  log(`  CarbonRegistry   identical: ${regCode === reg.deployedBytecode.toLowerCase()} (${(regCode.length - 2) / 2} bytes)`);
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
  log(`  CarbonBatchToken identical apart from ${refs.length} immutable slots (registry, batchId): ${mask(tokCode) === mask(tokArt.deployedBytecode)} (${(tokCode.length - 2) / 2} bytes)`);

  // 3. Etherscan API
  log("\n3. Etherscan V2 API getsourcecode");
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) log("  skipped: ETHERSCAN_API_KEY not set");
  else
    for (const [name, c] of Object.entries(d.contracts)) {
      const r = await fetch(
        `https://api.etherscan.io/v2/api?chainid=${d.chainId}&module=contract&action=getsourcecode&address=${c.address}&apikey=${key}`
      );
      const x = (await r.json()).result?.[0] || {};
      const verified = (x.SourceCode || "").length > 0;
      log(`  ${name.padEnd(16)} verified: ${verified}; name ${x.ContractName}; compiler ${x.CompilerVersion}; optimization ${x.OptimizationUsed === "1" ? "on" : "off"}, runs ${x.Runs}; EVM ${x.EVMVersion}`);
    }

  // 4. gas schedule probe
  log("\n4. Gas schedule probe (estimateGas for a 1-wei transfer from the deployer)");
  const to1 = "0x000000000000000000000000000000000000dEaD";
  const to2 = ethers.Wallet.createRandom().address;
  const g1 = await retry(() => p.estimateGas({ from: d.deployer, to: to1, value: 1n }));
  const g2 = await retry(() => p.estimateGas({ from: d.deployer, to: to2, value: 1n }));
  log(`  to an existing account: ${g1}`);
  log(`  to a new, empty account: ${g2}`);
  log("  The local Hardhat EVM (Cancun) charges 21000 in both cases.");

  fs.writeFileSync(path.join(__dirname, "..", "deployment", `onchain-check-${network.name}.txt`), out.join("\n") + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
