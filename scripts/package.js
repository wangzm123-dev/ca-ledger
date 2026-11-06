// Builds the final submission package required by the project guidelines (Section 11):
//   StudentID_FullName_CSIT5760_FinalProject.zip
// Usage: node scripts/package.js <StudentID> "<Full Name>"
// Never copies .env, node_modules, artifacts or cache.
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
const copyDir = (src, dst, filter = () => true) => {
  for (const f of fs.readdirSync(src)) {
    if (filter(f)) copy(path.join(src, f), path.join(dst, f));
  }
};
const missing = [];

// report.pdf
const pdf = path.join(REPORT_DIR, "CSIT5760_Final_Report_A6Carbon.pdf");
if (fs.existsSync(pdf)) copy(pdf, path.join(OUT, "report.pdf"));
else missing.push("Report/CSIT5760_Final_Report_A6Carbon.pdf (compile the .tex on Overleaf and save it here)");

// README: the repository copy is anonymous; the submitted copy gets name and ID (guideline Section 10, item 2)
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const header = "| | |\n|---|---|\n";
if (!readme.includes(header)) throw new Error("README header table not found");
const identity = `| Student name | ${fullName.replace(/_/g, " ")} |\n| Student ID | ${studentId} |\n`;
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "README.md"), readme.replace(header, header + identity));
copyDir(path.join(ROOT, "contracts"), path.join(OUT, "contracts"), (f) => f.endsWith(".sol"));
copyDir(path.join(ROOT, "test"), path.join(OUT, "tests"), (f) => f.endsWith(".js"));
copy(path.join(ROOT, "reports", "test-output.txt"), path.join(OUT, "tests", "test-output.txt"));
copy(path.join(ROOT, "reports", "coverage-summary.txt"), path.join(OUT, "tests", "coverage-summary.txt"));
copy(path.join(ROOT, "reports", "gas-report.txt"), path.join(OUT, "tests", "gas-report.txt"));

// deployment/
const dep = path.join(OUT, "deployment");
for (const f of ["deploy.js", "demo.js", "verify.js"]) copy(path.join(ROOT, "scripts", f), path.join(dep, f));
for (const f of ["hardhat.config.js", "package.json", "package-lock.json", ".env.example"]) {
  if (fs.existsSync(path.join(ROOT, f))) copy(path.join(ROOT, f), path.join(dep, f));
}
copy(path.join(ROOT, "deployments", "sepolia.json"), path.join(dep, "sepolia.json"));
for (const f of ["demo-sepolia.txt", "verify-sepolia.txt", "onchain-state-sepolia.txt"]) {
  copy(path.join(ROOT, "reports", f), path.join(dep, f));
}
const d = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "sepolia.json"), "utf8"));
const info = [
  "A6Carbon - deployment information",
  "",
  `Network:            Ethereum Sepolia (chain ID ${d.chainId})`,
  `Deployer:           ${d.deployer}`,
  `Compiler:           solc ${d.compiler.version}, optimizer ${d.compiler.settings.optimizer.enabled ? "enabled" : "disabled"} (${d.compiler.settings.optimizer.runs} runs), EVM ${d.compiler.settings.evmVersion}`,
  "OpenZeppelin:       @openzeppelin/contracts 5.6.1",
  "Deployment tool:    Hardhat 2.29.1 (hardhat-toolbox 5.0.0, ethers 6.17.0, hardhat-verify 2.1.3)",
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
  `  Created in tx:    ${d.demo.transactions.find((t) => t.step.startsWith("issuer issueBatch")).txHash}`,
  "  Block:            12063845 (2026-11-04 17:16:24 UTC)",
  `  Constructor args: ${JSON.stringify(d.contracts.CarbonBatchToken.constructorArgs)}`,
  `  Etherscan:        https://sepolia.etherscan.io/address/${d.contracts.CarbonBatchToken.address}#code`,
  "",
  `Setup: approveMethodology(${d.setup.approveMethodology.code}) tx ${d.setup.approveMethodology.txHash}`,
  "",
  "Demonstration transactions:",
  ...d.demo.transactions.map((t, i) => `  ${String(i + 1).padStart(2)}. ${t.step.padEnd(42)} ${t.txHash}  block ${t.blockNumber}`),
  "",
].join("\n");
fs.writeFileSync(path.join(dep, "deployment-information.txt"), info);

// audit/
const audit = path.join(OUT, "audit");
copy(path.join(ROOT, "reports", "slither-initial.txt"), path.join(audit, "slither-initial.txt"));
copy(path.join(ROOT, "reports", "slither-final.txt"), path.join(audit, "slither-final.txt"));
fs.writeFileSync(
  path.join(audit, "security-report.txt"),
  [
    "A6Carbon - security analysis summary (full discussion: report.pdf, Chapter 6)",
    "Tool: Slither 0.11.6, solc 0.8.24, command: slither . --filter-paths node_modules --exclude-dependencies",
    "",
    "F-01 Low (reentrancy-events) CarbonRegistry.issueBatch: BatchIssued emitted after external mint call.",
    "     Fixed: event emitted before the call. Retested: Slither re-run clean for this detector; T-18, T-21 pass.",
    "F-02 Informational (timestamp) CarbonBatchToken.getRetirement: false positive (array-length comparison).",
    "     Accepted: block.timestamp is only recorded, never used in a condition.",
    "F-03 Informational (manual) ERC-20 approve race. Accepted and documented (reset allowance to 0 first).",
    "F-04 Low (manual) Admin/pauser centralization. Mitigated by delayed two-step admin transfer; multisig in production.",
    "",
    "Initial scan: slither-initial.txt (2 results). Final scan: slither-final.txt (1 result, F-02).",
    "",
  ].join("\n")
);

// screenshots/
const figs = path.join(REPORT_DIR, "figures");
for (const f of ["deployment.png", "verification.png", "testing.png", "verification_token.png"]) {
  if (fs.existsSync(path.join(figs, f))) copy(path.join(figs, f), path.join(OUT, "screenshots", f));
  else if (f !== "verification_token.png") missing.push(`Report/figures/${f}`);
}

// safety check: nothing secret
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
for (const f of walk(OUT)) {
  if (path.basename(f) === ".env") throw new Error(".env must not be packaged");
  const txt = fs.readFileSync(f, "latin1");
  if (/PRIVATE_KEY\s*=\s*0x[0-9a-fA-F]{64}/.test(txt)) throw new Error(`Private key found in ${f}`);
}

const zip = `${OUT}.zip`;
fs.rmSync(zip, { force: true });
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${OUT}' -DestinationPath '${zip}'`]);
console.log(`Created ${zip}`);
if (missing.length) console.log("Still missing (add them, then run again):\n  - " + missing.join("\n  - "));
