// Builds the final submission package (course guideline Section 11):
//   StudentID_FullName_CSIT5760_FinalProject.zip
// The package is the project itself plus report.pdf and screenshots/, so it is a runnable Hardhat
// project: unzip, `npm ci`, `npm test`. Layout:
//   report.pdf  README.md  package.json  package-lock.json  hardhat.config.js  .env.example  .gitignore
//   contracts/  tests/  scripts/  deployment/  audit/  screenshots/
// Usage: node scripts/package.js <StudentID> "<Full Name>"
// Never copies .env, node_modules, artifacts, cache or coverage.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPORT_DIR = path.join(ROOT, "..", "Report");
const studentId = process.argv[2];
const fullName = (process.argv[3] || "").trim().replace(/\s+/g, "_");
if (!studentId || !fullName) {
  console.error('Usage: node scripts/package.js <StudentID> "<Full Name>"');
  process.exit(1);
}
const name = `${studentId}_${fullName}_CSIT5760_FinalProject`;
const OUT = path.join(ROOT, "..", "submission", name);
fs.rmSync(OUT, { recursive: true, force: true });

const copy = (src, dst) => {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
};
const copyDir = (dir, skip = () => false) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (skip(e.name)) continue;
    if (e.isDirectory()) copyDir(rel, skip);
    else copy(path.join(ROOT, rel), path.join(OUT, rel));
  }
};
const missing = [];

// deployment/deployment-information.txt (regenerated from deployment/sepolia.json, also kept in the repo)
const d = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment", "sepolia.json"), "utf8"));
const issueTx = d.demo.transactions.find((t) => t.step.startsWith("issuer issueBatch"));
const info = [
  "A6Carbon - deployment information",
  "",
  `Network:            Ethereum Sepolia (chain ID ${d.chainId})`,
  `Deployer:           ${d.deployer}`,
  `Compiler:           solc ${d.compiler.version}, optimizer ${d.compiler.settings.optimizer.enabled ? "enabled" : "disabled"} (${d.compiler.settings.optimizer.runs} runs), EVM ${d.compiler.settings.evmVersion}`,
  "OpenZeppelin:       @openzeppelin/contracts 5.6.1",
  "Deployment tool:    Hardhat 2.29.1 (hardhat-toolbox 5.0.0, ethers 6.17.0, hardhat-verify 2.1.3)",
  "Deployment script:  scripts/deploy.js (npm run deploy:sepolia); demo: scripts/demo.js; verification: scripts/verify.js",
  "",
  "CarbonRegistry",
  `  Address:          ${d.contracts.CarbonRegistry.address}`,
  `  Deploy tx:        ${d.contracts.CarbonRegistry.txHash}`,
  `  Block:            ${d.contracts.CarbonRegistry.blockNumber} (2026-11-04 16:59:48 UTC)`,
  `  Constructor args: ${JSON.stringify(d.contracts.CarbonRegistry.constructorArgs)}`,
  `  Etherscan:        https://sepolia.etherscan.io/address/${d.contracts.CarbonRegistry.address}#code`,
  "",
  "CarbonBatchToken (A6C-2, batch 2) - created by the registry in issueBatch",
  `  Address:          ${d.contracts.CarbonBatchToken.address}`,
  `  Created in tx:    ${issueTx.txHash}`,
  `  Block:            ${issueTx.blockNumber} (2026-11-04 17:16:24 UTC)`,
  `  Constructor args: ${JSON.stringify(d.contracts.CarbonBatchToken.constructorArgs)}`,
  `  Etherscan:        https://sepolia.etherscan.io/address/${d.contracts.CarbonBatchToken.address}#code`,
  "",
  `Setup: approveMethodology(${d.setup.approveMethodology.code}) tx ${d.setup.approveMethodology.txHash}`,
  "",
  "Demonstration transactions (gasUsed as in the Sepolia receipts; see onchain-check-sepolia.txt",
  "for why state-creating operations cost more on Sepolia than in the local gas report):",
  ...d.demo.transactions.map(
    (t, i) => `  ${String(i + 1).padStart(2)}. ${t.step.padEnd(42)} ${t.txHash}  block ${t.blockNumber}  gas ${t.gasUsed}`
  ),
  "",
].join("\n");
fs.writeFileSync(path.join(ROOT, "deployment", "deployment-information.txt"), info);

// project files (a runnable Hardhat project)
for (const f of ["package.json", "package-lock.json", "hardhat.config.js", ".env.example", ".gitignore"]) {
  copy(path.join(ROOT, f), path.join(OUT, f));
}
copyDir("contracts");
copyDir("tests");
copyDir("scripts");
copyDir("deployment", (n) => n === "hardhat.json" || n === "localhost.json");
copyDir("audit");

// README: the repository copy is anonymous; the submitted copy gets name and ID (guideline Section 10, item 2)
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const header = "| | |\n|---|---|\n";
if (!readme.includes(header)) throw new Error("README header table not found");
const identity = `| Student name | ${fullName.replace(/_/g, " ")} |\n| Student ID | ${studentId} |\n`;
fs.writeFileSync(path.join(OUT, "README.md"), readme.replace(header, header + identity));

// report.pdf
const pdf = path.join(REPORT_DIR, "CSIT5760_Final_Report_A6Carbon.pdf");
if (fs.existsSync(pdf)) copy(pdf, path.join(OUT, "report.pdf"));
else missing.push("Report/CSIT5760_Final_Report_A6Carbon.pdf (compile the .tex on Overleaf and save it here)");

// screenshots/
const figs = path.join(REPORT_DIR, "figures");
for (const f of ["deployment.png", "verification.png", "testing.png", "verification_token.png"]) {
  if (fs.existsSync(path.join(figs, f))) copy(path.join(figs, f), path.join(OUT, "screenshots", f));
  else if (f !== "verification_token.png") missing.push(`Report/figures/${f}`);
}

// safety check: nothing secret, no build output
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
for (const f of walk(OUT)) {
  const rel = path.relative(OUT, f);
  if (path.basename(f) === ".env") throw new Error(".env must not be packaged");
  if (/^(node_modules|artifacts|cache|coverage)[\\/]/.test(rel)) throw new Error(`build output packaged: ${rel}`);
  const txt = fs.readFileSync(f, "latin1");
  if (/PRIVATE_KEY\s*=\s*(0x)?[0-9a-fA-F]{64}/.test(txt)) throw new Error(`Private key found in ${rel}`);
  if (/ETHERSCAN_API_KEY\s*=\s*[A-Za-z0-9]{20,}/.test(txt)) throw new Error(`API key found in ${rel}`);
}

const zip = `${OUT}.zip`;
fs.rmSync(zip, { force: true });
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${OUT}' -DestinationPath '${zip}'`]);
console.log(`Created ${zip}`);
console.log("Check it: unzip, then `npm ci` and `npm test` in the unzipped folder.");
if (missing.length) console.log("Still missing (add them, then run again):\n  - " + missing.join("\n  - "));
