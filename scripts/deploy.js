// Deploys CarbonRegistry and approves the demo methodology.
// Usage: npx hardhat run scripts/deploy.js --network sepolia
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ADMIN_DELAY = Number(process.env.ADMIN_DELAY || 24 * 60 * 60); // 1 day
const MIN_VINTAGE = Number(process.env.MIN_VINTAGE || 2016);
const METHODOLOGY_CODE = process.env.METHODOLOGY_CODE || "VM0047";

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account. Set DEPLOYER_PRIVATE_KEY in .env");

  console.log(`Network:  ${network.name} (chainId ${network.config.chainId ?? "hardhat"})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  const args = [ADMIN_DELAY, deployer.address, MIN_VINTAGE];
  const Registry = await ethers.getContractFactory("CarbonRegistry");
  const registry = await Registry.deploy(...args);
  const deployTx = registry.deploymentTransaction();
  const receipt = await deployTx.wait();
  const registryAddress = await registry.getAddress();
  console.log(`CarbonRegistry deployed at ${registryAddress} (tx ${deployTx.hash}, block ${receipt.blockNumber})`);

  const methodology = ethers.id(METHODOLOGY_CODE);
  const approveTx = await registry.approveMethodology(methodology, true);
  await approveTx.wait();
  console.log(`Approved methodology ${METHODOLOGY_CODE} (${methodology}) tx ${approveTx.hash}`);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    compiler: hre.config.solidity.compilers[0],
    contracts: {
      CarbonRegistry: {
        address: registryAddress,
        constructorArgs: args,
        txHash: deployTx.hash,
        blockNumber: receipt.blockNumber,
      },
    },
    setup: { approveMethodology: { code: METHODOLOGY_CODE, id: methodology, txHash: approveTx.hash } },
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Saved ${path.relative(process.cwd(), file)}`);
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
