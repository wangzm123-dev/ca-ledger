// Verifies CarbonRegistry and the demo CarbonBatchToken on Etherscan.
// Usage: npx hardhat run scripts/verify.js --network sepolia
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function verify(name, address, constructorArguments, contract) {
  console.log(`Verifying ${name} at ${address} ...`);
  try {
    await hre.run("verify:verify", { address, constructorArguments, contract });
  } catch (e) {
    if (/already verified/i.test(e.message)) console.log("  already verified");
    else throw e;
  }
  console.log(`  https://sepolia.etherscan.io/address/${address}#code`);
}

async function main() {
  const file = path.join(__dirname, "..", "deployment", `${hre.network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const reg = d.contracts.CarbonRegistry;
  await verify("CarbonRegistry", reg.address, reg.constructorArgs, "contracts/CarbonRegistry.sol:CarbonRegistry");

  const tok = d.contracts.CarbonBatchToken;
  if (tok) {
    await verify("CarbonBatchToken", tok.address, tok.constructorArgs, "contracts/CarbonBatchToken.sol:CarbonBatchToken");
  } else {
    console.log("No CarbonBatchToken in deployment file yet (run scripts/demo.js first).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
