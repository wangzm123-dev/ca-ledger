// Runs eight key test scenarios on a fresh local Hardhat network and records what was actually
// observed (decoded revert error and arguments, balances, stored fields), next to the expected result.
// Output: tests/key-cases-observed.txt. Exit code 1 if any observation differs from the expectation.
// Usage: npm run observe   (npx hardhat run scripts/observe-key-cases.js)
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const {
  AuthStatus,
  UseType,
  DEFAULT_BATCH,
  EVIDENCE_LOA,
  EVIDENCE_CA,
  EVIDENCE_REVOKE,
  deployRegistryFixture,
  issuedBatchFixture,
  submit,
} = require("../tests/fixtures");

const { ethers } = hre;
const T = (t) => BigInt(t) * 1000n; // tonnes -> token units (3 decimals)
const AUTH = ["None", "Authorized", "Adjusted", "Revoked"];
const STATUS = ["Pending", "Verified", "Rejected", "Issued"];
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;

// Send a transaction and describe the outcome: "success" or the decoded custom error with arguments.
async function outcome(contracts, send) {
  try {
    const tx = await send();
    await tx.wait();
    return "success";
  } catch (e) {
    const data = e.data || e.error?.data || e.info?.error?.data;
    for (const c of contracts) {
      try {
        const err = c.interface.parseError(data);
        if (err) {
          const args = err.args.map((v, i) => {
            const type = err.fragment.inputs[i].type;
            if (type === "address") return short(v);
            if (type === "bytes32") return `${v.slice(0, 10)}...`;
            if (err.name === "NotCorsiaEligible" || err.name === "InvalidAuthTransition") return AUTH[Number(v)];
            if (err.name === "InvalidStatus") return STATUS[Number(v)];
            return v.toString();
          });
          return `revert ${err.name}(${args.join(", ")})`;
        }
      } catch {
        /* try the next interface */
      }
    }
    return `revert (undecoded): ${e.shortMessage || e.message}`;
  }
}

async function main() {
  if (hre.network.name !== "hardhat") throw new Error("Run on the local hardhat network only.");
  const cases = [];
  const record = (id, test, pre, input, expected, actual) => {
    const pass = actual === expected;
    cases.push({ id, test, pre, input, expected, actual, pass });
  };

  // K-1 (T-07) duplicate serial by another developer
  {
    const { registry, developer, developer2 } = await deployRegistryFixture();
    await submit(registry, developer);
    const h = ethers.keccak256(ethers.toUtf8Bytes(DEFAULT_BATCH.serial));
    record("K-1", "T-07", "Batch with serial VCS-4321-2024-0001 already submitted by developer",
      "developer2 submits the same serial",
      `revert DuplicateSerial(${h.slice(0, 10)}...)`,
      await outcome([registry], () => submit(registry, developer2)));
  }

  // K-2 (T-13) developer who also holds VVB_ROLE verifies its own batch
  {
    const { registry, developer } = await deployRegistryFixture();
    await registry.grantRole(await registry.VVB_ROLE(), developer.address);
    await submit(registry, developer);
    record("K-2", "T-13", "Developer also holds VVB_ROLE; batch 0 Pending",
      "developer calls verifyBatch(0)",
      `revert ConflictOfInterest(${short(developer.address)})`,
      await outcome([registry], () => registry.connect(developer).verifyBatch(0)));
  }

  // K-3 (T-21) double issuance
  {
    const { registry, issuer, token } = await issuedBatchFixture();
    const supply = await token.totalSupply();
    const r = await outcome([registry], () => registry.connect(issuer).issueBatch(0));
    const after = await token.totalSupply();
    record("K-3", "T-21", "Batch 0 Issued; 10,000 t minted",
      "issuer calls issueBatch(0) again",
      `revert InvalidStatus(Issued); supply ${ethers.formatUnits(supply, 3).replace(/\.0$/, "")} t unchanged`,
      `${r}; supply ${ethers.formatUnits(after, 3).replace(/\.0$/, "")} t ${after === supply ? "unchanged" : "CHANGED"}`);
  }

  // K-4 (T-23) only the registry can mint
  {
    const { token, attacker } = await issuedBatchFixture();
    const role = await token.MINTER_ROLE();
    record("K-4", "T-23", "Batch token deployed by the registry",
      "attacker calls token.mint(attacker, 1 t)",
      `revert AccessControlUnauthorizedAccount(${short(attacker.address)}, ${role.slice(0, 10)}...)`,
      await outcome([token], () => token.connect(attacker).mint(attacker.address, T(1))));
  }

  // K-5 (T-41) CORSIA gate before adjustment, after adjustment, after revocation; snapshot kept
  {
    const { registry, token, developer, host } = await issuedBatchFixture();
    const corsia = () => token.connect(developer).retire(T(10), "Airline X", "CORSIA", UseType.Corsia);
    const a1 = await outcome([token, registry], corsia);
    await registry.connect(host).setAuthorization(0, AuthStatus.Authorized, EVIDENCE_LOA);
    const a2 = await outcome([token, registry], corsia);
    await registry.connect(host).setAuthorization(0, AuthStatus.Adjusted, EVIDENCE_CA);
    const a3 = await outcome([token, registry], corsia);
    await registry.connect(host).setAuthorization(0, AuthStatus.Revoked, EVIDENCE_REVOKE);
    const a4 = await outcome([token, registry], corsia);
    const cert = await token.getRetirement(0);
    record("K-5", "T-41", "Batch 0 Issued; developer holds 10,000 t",
      "CORSIA retire 10 t at status None, Authorized, Adjusted, then Revoked; read certificate 0",
      "None: revert NotCorsiaEligible(None) | Authorized: revert NotCorsiaEligible(Authorized) | Adjusted: success | Revoked: revert NotCorsiaEligible(Revoked) | certificate 0 auth = Adjusted",
      `None: ${a1} | Authorized: ${a2} | Adjusted: ${a3} | Revoked: ${a4} | certificate 0 auth = ${AUTH[Number(cert.auth)]}`);
  }

  // K-6 (T-43) boundaries on retire()
  {
    const { token, developer } = await issuedBatchFixture();
    const s128 = "a".repeat(128);
    const s129 = "a".repeat(129);
    const r0 = await outcome([token], () => token.connect(developer).retire(0, "B", "P", UseType.Voluntary));
    const rE = await outcome([token], () => token.connect(developer).retire(T(1), "", "P", UseType.Voluntary));
    const r129 = await outcome([token], () => token.connect(developer).retire(T(1), s129, "P", UseType.Voluntary));
    const r128 = await outcome([token], () => token.connect(developer).retire(T(1), s128, "P", UseType.Voluntary));
    record("K-6", "T-43", "Developer holds 10,000 t",
      "retire 0; retire with empty beneficiary; 129-byte beneficiary; 128-byte beneficiary",
      "revert ZeroAmount() | revert EmptyBeneficiary() | revert StringTooLong() | success",
      `${r0} | ${rE} | ${r129} | ${r128}`);
  }

  // K-7 (T-45) retired credits cannot be retired again
  {
    const { token, developer } = await issuedBatchFixture();
    await token.connect(developer).transfer((await ethers.getSigners())[7].address, T(9_990)); // keep 10 t
    await token.connect(developer).retire(T(10), "Dev", "offset", UseType.Voluntary);
    const bal = await token.balanceOf(developer.address);
    const r = await outcome([token], () => token.connect(developer).retire(T(10), "Dev", "again", UseType.Voluntary));
    record("K-7", "T-45", "Developer holds exactly 10 t and retires all of it",
      "developer retires the same 10 t again",
      `balance 0 t; revert ERC20InsufficientBalance(${short(developer.address)}, 0, 10000)`,
      `balance ${ethers.formatUnits(bal, 3)} t; ${r}`.replace("0.0 t", "0 t"));
  }

  // K-8 (T-49) supply invariant after mixed actions
  {
    const { token, developer, airline } = await issuedBatchFixture();
    await token.connect(developer).transfer(airline.address, T(1_000));
    await token.connect(developer).approve(airline.address, T(500));
    await token.connect(airline).transferFrom(developer.address, airline.address, T(200));
    await token.connect(developer).retire(T(50), "Dev", "voluntary", UseType.Voluntary);
    await token.connect(airline).retire(T(120), "Airline", "voluntary", UseType.Voluntary);
    const [supply, retired, cap] = await Promise.all([token.totalSupply(), token.totalRetired(), token.cap()]);
    const f = (x) => ethers.formatUnits(x, 3).replace(/\.0$/, "");
    record("K-8", "T-49", "Batch 0 Issued, cap 10,000 t",
      "transfer 1,000 t; approve 500 t; transferFrom 200 t; retire 50 t and 120 t",
      "supply 9830 t + retired 170 t = cap 10000 t",
      `supply ${f(supply)} t + retired ${f(retired)} t = cap ${f(cap)} t${supply + retired === cap ? "" : " (MISMATCH)"}`);
  }

  const out = [
    "# Key test cases: expected vs observed (fresh local Hardhat network)",
    `# Run at: ${new Date().toISOString()}  Node ${process.version}  Hardhat ${require("hardhat/package.json").version}`,
    "",
  ];
  for (const c of cases) {
    out.push(`${c.id} (${c.test})  ${c.pass ? "PASS" : "FAIL"}`);
    out.push(`  Precondition: ${c.pre}`);
    out.push(`  Input:        ${c.input}`);
    out.push(`  Expected:     ${c.expected}`);
    out.push(`  Observed:     ${c.actual}`);
    out.push("");
  }
  const failed = cases.filter((c) => !c.pass);
  out.push(`RESULT: ${failed.length ? "FAIL" : "PASS"} - ${cases.length - failed.length} of ${cases.length} cases matched`);
  const text = out.join("\n") + "\n";
  console.log(text);
  fs.writeFileSync(path.join(__dirname, "..", "tests", "key-cases-observed.txt"), text);
  if (failed.length) throw new Error(`Observed results differ for: ${failed.map((c) => c.id).join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
