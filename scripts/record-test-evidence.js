// Re-runs the test suite, coverage and gas report from the current layout and stores the outputs:
//   tests/test-output.txt      npx hardhat test (tests folder: tests/)
//   tests/coverage-summary.txt npx hardhat coverage (summary table)
//   tests/gas-report.txt       hardhat-gas-reporter (REPORT_GAS=true)
// Each file starts with a header (time, git commit, Node and Hardhat versions, command), so the
// evidence can be matched to the code it was produced from.
// Exit code: non-zero if any test fails, so stale or failing evidence is never written silently.
// Usage: npm run evidence
const { spawnSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TESTS = path.join(ROOT, "tests");
const tryCmd = (cmd) => {
  try { return execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "n/a"; }
};
const commit = tryCmd("git rev-parse --short HEAD");
const dirty = tryCmd("git status --porcelain -- contracts tests hardhat.config.js package.json package-lock.json");
const hardhatVersion = require(path.join(ROOT, "node_modules", "hardhat", "package.json")).version;

function header(command) {
  return [
    `# Command:   ${command}`,
    `# Run at:    ${new Date().toISOString()}`,
    `# Commit:    ${commit}${dirty && dirty !== "n/a" ? " (with uncommitted changes in contracts/tests/config)" : ""}`,
    `# Node:      ${process.version}; Hardhat ${hardhatVersion}; solc 0.8.24 (optimizer 200 runs, EVM cancun)`,
    `# Platform:  ${process.platform} ${process.arch}`,
    "",
  ].join("\n");
}

function run(args, env = {}) {
  const r = spawnSync("npx", ["hardhat", ...args], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "0", ...env },
    encoding: "utf8",
    shell: true,
  });
  const text = (r.stdout || "") + (r.stderr || "");
  // drop tool noise that is not part of the result
  const clean = text
    .split(/\r?\n/)
    .filter((l) => !/^npm notice|injected env|^\s*$\n?/.test(l) || l === "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { status: r.status, text: clean };
}

function requirePassing(name, res) {
  const pass = res.text.match(/(\d+) passing/);
  const fail = res.text.match(/(\d+) failing/);
  if (res.status !== 0 || !pass || fail) {
    console.error(res.text.slice(-3000));
    throw new Error(`${name}: tests did not all pass (exit ${res.status})`);
  }
  return Number(pass[1]);
}

// 1. tests
const test = run(["test"]);
const n = requirePassing("hardhat test", test);
fs.writeFileSync(path.join(TESTS, "test-output.txt"), header("npx hardhat test") + test.text + "\n");
console.log(`tests/test-output.txt: ${n} passing`);

// 2. coverage
const cov = run(["coverage"]);
requirePassing("hardhat coverage", cov);
const lines = cov.text.split("\n");
const start = lines.findIndex((l) => /^-+\|/.test(l));
const end = lines.findIndex((l, i) => i > start && /^All files/.test(l));
if (start < 1 || end < 0) throw new Error("coverage table not found in output");
const table = lines.slice(start - 1, end + 2).join("\n");
fs.writeFileSync(path.join(TESTS, "coverage-summary.txt"), header("npx hardhat coverage") + table + "\n");
console.log("tests/coverage-summary.txt:", lines[end].replace(/\s+/g, " "));

// 3. gas report (the reporter writes tests/gas-report.txt itself, see hardhat.config.js)
const gas = run(["test"], { REPORT_GAS: "true" });
requirePassing("gas run", gas);
const gasFile = path.join(TESTS, "gas-report.txt");
fs.writeFileSync(gasFile, header("REPORT_GAS=true npx hardhat test (hardhat-gas-reporter, local Hardhat EVM)") + fs.readFileSync(gasFile, "utf8"));
console.log("tests/gas-report.txt: written");
