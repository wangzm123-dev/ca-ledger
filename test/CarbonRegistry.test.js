const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const {
  BatchStatus,
  AuthStatus,
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
} = require("./fixtures");

describe("CarbonRegistry", function () {
  // ===================================================================
  describe("Deployment and governance (AccessControlDefaultAdminRules)", function () {
    it("T-01 sets admin, admin delay and minimum vintage", async function () {
      const { registry, admin } = await loadFixture(deployRegistryFixture);
      expect(await registry.defaultAdmin()).to.equal(admin.address);
      expect(await registry.defaultAdminDelay()).to.equal(ADMIN_DELAY);
      expect(await registry.minVintage()).to.equal(MIN_VINTAGE);
      expect(await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
    });

    it("T-02 only admin can approve methodologies and set the vintage floor", async function () {
      const { registry, attacker } = await loadFixture(deployRegistryFixture);
      const m = ethers.id("VM0042");
      await expect(registry.approveMethodology(m, true))
        .to.emit(registry, "MethodologyApproved")
        .withArgs(m, true);
      expect(await registry.approvedMethodology(m)).to.be.true;

      await expect(registry.connect(attacker).approveMethodology(m, false))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, await registry.DEFAULT_ADMIN_ROLE());
      await expect(registry.approveMethodology(ethers.ZeroHash, true)).to.be.revertedWithCustomError(
        registry,
        "EmptyField"
      );

      await expect(registry.setMinVintage(2018)).to.emit(registry, "MinVintageUpdated").withArgs(MIN_VINTAGE, 2018);
      await expect(registry.connect(attacker).setMinVintage(2000)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("T-03 non-admin cannot grant roles (privilege escalation)", async function () {
      const { registry, attacker } = await loadFixture(deployRegistryFixture);
      await expect(
        registry.connect(attacker).grantRole(await registry.ISSUER_ROLE(), attacker.address)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("T-04 default admin cannot be granted directly; two-step transfer enforces the delay", async function () {
      const { registry, admin, attacker, buyer } = await loadFixture(deployRegistryFixture);
      const ADMIN = await registry.DEFAULT_ADMIN_ROLE();

      await expect(registry.grantRole(ADMIN, attacker.address)).to.be.revertedWithCustomError(
        registry,
        "AccessControlEnforcedDefaultAdminRules"
      );

      await registry.beginDefaultAdminTransfer(buyer.address);
      await expect(registry.connect(buyer).acceptDefaultAdminTransfer()).to.be.revertedWithCustomError(
        registry,
        "AccessControlEnforcedDefaultAdminDelay"
      );
      await expect(registry.connect(attacker).acceptDefaultAdminTransfer()).to.be.revertedWithCustomError(
        registry,
        "AccessControlInvalidDefaultAdmin"
      );

      await time.increase(ADMIN_DELAY + 1);
      await registry.connect(buyer).acceptDefaultAdminTransfer();
      expect(await registry.defaultAdmin()).to.equal(buyer.address);
      expect(await registry.hasRole(ADMIN, admin.address)).to.be.false;
    });
  });

  // ===================================================================
  describe("submitBatch", function () {
    it("T-05 developer submits a batch: state stored and event emitted", async function () {
      const { registry, developer } = await loadFixture(deployRegistryFixture);
      const serialHash = ethers.keccak256(ethers.toUtf8Bytes(DEFAULT_BATCH.serial));

      await expect(submit(registry, developer))
        .to.emit(registry, "BatchSubmitted")
        .withArgs(0, developer.address, serialHash, DEFAULT_BATCH.serial, DEFAULT_BATCH.quantity);

      const b = await registry.getBatch(0);
      expect(b.developer).to.equal(developer.address);
      expect(b.status).to.equal(BatchStatus.Pending);
      expect(b.auth).to.equal(AuthStatus.None);
      expect(b.vintage).to.equal(DEFAULT_BATCH.vintage);
      expect(b.methodology).to.equal(METHODOLOGY);
      expect(b.quantity).to.equal(DEFAULT_BATCH.quantity);
      expect(b.projectId).to.equal(DEFAULT_BATCH.projectId);
      expect(b.reportCID).to.equal(DEFAULT_BATCH.reportCID);
      expect(b.token).to.equal(ethers.ZeroAddress);
      expect(await registry.serialUsed(serialHash)).to.be.true;
      expect(await registry.batchCount()).to.equal(1);
    });

    it("T-06 account without DEVELOPER_ROLE cannot submit", async function () {
      const { registry, attacker } = await loadFixture(deployRegistryFixture);
      await expect(submit(registry, attacker))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, await registry.DEVELOPER_ROLE());
    });

    it("T-07 the same serial can never be submitted twice (even by another developer)", async function () {
      const { registry, developer, developer2 } = await loadFixture(deployRegistryFixture);
      await submit(registry, developer);
      const serialHash = ethers.keccak256(ethers.toUtf8Bytes(DEFAULT_BATCH.serial));
      await expect(submit(registry, developer))
        .to.be.revertedWithCustomError(registry, "DuplicateSerial")
        .withArgs(serialHash);
      await expect(submit(registry, developer2)).to.be.revertedWithCustomError(registry, "DuplicateSerial");
    });

    it("T-08 rejects zero quantity and empty required fields", async function () {
      const { registry, developer } = await loadFixture(deployRegistryFixture);
      await expect(submit(registry, developer, { quantity: 0n })).to.be.revertedWithCustomError(registry, "ZeroAmount");
      await expect(submit(registry, developer, { serial: "" })).to.be.revertedWithCustomError(registry, "EmptyField");
      await expect(submit(registry, developer, { projectId: "" })).to.be.revertedWithCustomError(
        registry,
        "EmptyField"
      );
      await expect(submit(registry, developer, { reportCID: "" })).to.be.revertedWithCustomError(
        registry,
        "EmptyField"
      );
    });

    it("T-09 boundary: 128-byte text accepted, 129-byte text rejected", async function () {
      const { registry, developer } = await loadFixture(deployRegistryFixture);
      await expect(submit(registry, developer, { serial: "S".repeat(128) })).to.not.be.reverted;
      await expect(submit(registry, developer, { serial: "T".repeat(129) })).to.be.revertedWithCustomError(
        registry,
        "StringTooLong"
      );
    });

    it("T-10 boundary: vintage equal to the floor accepted, one year older rejected", async function () {
      const { registry, developer } = await loadFixture(deployRegistryFixture);
      await expect(submit(registry, developer, { serial: "A", vintage: MIN_VINTAGE })).to.not.be.reverted;
      await expect(submit(registry, developer, { serial: "B", vintage: MIN_VINTAGE - 1 }))
        .to.be.revertedWithCustomError(registry, "VintageTooOld")
        .withArgs(MIN_VINTAGE - 1, MIN_VINTAGE);
    });

    it("T-11 unapproved or withdrawn methodology is rejected", async function () {
      const { registry, developer } = await loadFixture(deployRegistryFixture);
      const m = ethers.id("UNKNOWN");
      await expect(submit(registry, developer, { methodology: m }))
        .to.be.revertedWithCustomError(registry, "MethodologyNotApproved")
        .withArgs(m);
      await registry.approveMethodology(METHODOLOGY, false);
      await expect(submit(registry, developer)).to.be.revertedWithCustomError(registry, "MethodologyNotApproved");
    });
  });

  // ===================================================================
  describe("verifyBatch / rejectBatch", function () {
    it("T-12 independent VVB verifies a pending batch", async function () {
      const { registry, developer, vvb } = await loadFixture(deployRegistryFixture);
      await submit(registry, developer);
      await expect(registry.connect(vvb).verifyBatch(0)).to.emit(registry, "BatchVerified").withArgs(0, vvb.address);
      const b = await registry.getBatch(0);
      expect(b.status).to.equal(BatchStatus.Verified);
      expect(b.verifier).to.equal(vvb.address);
    });

    it("T-13 developer holding VVB_ROLE cannot verify or reject its own batch", async function () {
      const { registry, developer } = await loadFixture(deployRegistryFixture);
      await registry.grantRole(await registry.VVB_ROLE(), developer.address);
      await submit(registry, developer);
      await expect(registry.connect(developer).verifyBatch(0))
        .to.be.revertedWithCustomError(registry, "ConflictOfInterest")
        .withArgs(developer.address);
      await expect(registry.connect(developer).rejectBatch(0, "self")).to.be.revertedWithCustomError(
        registry,
        "ConflictOfInterest"
      );
    });

    it("T-14 non-VVB cannot verify; unknown batch reverts", async function () {
      const { registry, developer, vvb, attacker } = await loadFixture(deployRegistryFixture);
      await submit(registry, developer);
      await expect(registry.connect(attacker).verifyBatch(0)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount"
      );
      await expect(registry.connect(vvb).verifyBatch(5))
        .to.be.revertedWithCustomError(registry, "BatchNotFound")
        .withArgs(5);
    });

    it("T-15 a batch cannot be verified twice", async function () {
      const { registry, vvb } = await loadFixture(verifiedBatchFixture);
      await expect(registry.connect(vvb).verifyBatch(0))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(BatchStatus.Verified);
    });

    it("T-16 rejected batch is terminal and its serial stays consumed", async function () {
      const { registry, developer, vvb, issuer } = await loadFixture(deployRegistryFixture);
      await submit(registry, developer);
      await expect(registry.connect(vvb).rejectBatch(0, "Baseline overstated"))
        .to.emit(registry, "BatchRejected")
        .withArgs(0, vvb.address, "Baseline overstated");
      expect((await registry.getBatch(0)).status).to.equal(BatchStatus.Rejected);

      await expect(registry.connect(vvb).verifyBatch(0)).to.be.revertedWithCustomError(registry, "InvalidStatus");
      await expect(registry.connect(issuer).issueBatch(0)).to.be.revertedWithCustomError(registry, "InvalidStatus");
      await expect(submit(registry, developer)).to.be.revertedWithCustomError(registry, "DuplicateSerial");
    });

    it("T-17 rejection requires a non-empty reason", async function () {
      const { registry, developer, vvb } = await loadFixture(deployRegistryFixture);
      await submit(registry, developer);
      await expect(registry.connect(vvb).rejectBatch(0, "")).to.be.revertedWithCustomError(registry, "EmptyField");
    });
  });

  // ===================================================================
  describe("issueBatch (token minting)", function () {
    it("T-18 issuer deploys a capped ERC-20 and mints the verified quantity to the developer", async function () {
      const { registry, developer, issuer } = await loadFixture(verifiedBatchFixture);
      const units = DEFAULT_BATCH.quantity * UNITS_PER_TONNE;

      await expect(registry.connect(issuer).issueBatch(0))
        .to.emit(registry, "BatchIssued")
        .withArgs(0, anyValue, developer.address, units);

      const b = await registry.getBatch(0);
      expect(b.status).to.equal(BatchStatus.Issued);
      expect(b.issuer).to.equal(issuer.address);

      const token = await ethers.getContractAt("CarbonBatchToken", b.token);
      expect(await token.name()).to.equal("A6Carbon Batch 0");
      expect(await token.symbol()).to.equal("A6C-0");
      expect(await token.decimals()).to.equal(3);
      expect(await token.cap()).to.equal(units);
      expect(await token.totalSupply()).to.equal(units);
      expect(await token.balanceOf(developer.address)).to.equal(units);
      expect(await token.batchId()).to.equal(0);
      expect(await token.registry()).to.equal(await registry.getAddress());
    });

    it("T-19 a pending (unverified) batch cannot be issued", async function () {
      const { registry, developer, issuer } = await loadFixture(deployRegistryFixture);
      await submit(registry, developer);
      await expect(registry.connect(issuer).issueBatch(0))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(BatchStatus.Pending);
    });

    it("T-20 issuer must differ from verifier and developer", async function () {
      const { registry, vvb, developer } = await loadFixture(verifiedBatchFixture);
      const ISSUER = await registry.ISSUER_ROLE();
      await registry.grantRole(ISSUER, vvb.address);
      await registry.grantRole(ISSUER, developer.address);
      await expect(registry.connect(vvb).issueBatch(0))
        .to.be.revertedWithCustomError(registry, "ConflictOfInterest")
        .withArgs(vvb.address);
      await expect(registry.connect(developer).issueBatch(0))
        .to.be.revertedWithCustomError(registry, "ConflictOfInterest")
        .withArgs(developer.address);
    });

    it("T-21 a batch cannot be issued twice (no double issuance)", async function () {
      const { registry, issuer } = await loadFixture(issuedBatchFixture);
      await expect(registry.connect(issuer).issueBatch(0))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(BatchStatus.Issued);
    });

    it("T-22 account without ISSUER_ROLE cannot issue", async function () {
      const { registry, attacker } = await loadFixture(verifiedBatchFixture);
      await expect(registry.connect(attacker).issueBatch(0)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("T-23 nobody except the registry can mint batch tokens directly", async function () {
      const { token, admin, issuer, developer, attacker } = await loadFixture(issuedBatchFixture);
      const MINTER = await token.MINTER_ROLE();
      for (const s of [admin, issuer, developer, attacker]) {
        await expect(token.connect(s).mint(s.address, 1))
          .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
          .withArgs(s.address, MINTER);
      }
    });
  });

  // ===================================================================
  describe("Article 6 authorization (host authority)", function () {
    it("T-24 None -> Authorized -> Adjusted makes the batch CORSIA-eligible", async function () {
      const { registry, host } = await loadFixture(issuedBatchFixture);
      expect(await registry.isCorsiaEligible(0)).to.be.false;

      await expect(registry.connect(host).setAuthorization(0, AuthStatus.Authorized, EVIDENCE_LOA))
        .to.emit(registry, "AuthorizationUpdated")
        .withArgs(0, host.address, AuthStatus.None, AuthStatus.Authorized, EVIDENCE_LOA);
      expect(await registry.isCorsiaEligible(0)).to.be.false;

      await expect(registry.connect(host).setAuthorization(0, AuthStatus.Adjusted, EVIDENCE_CA))
        .to.emit(registry, "AuthorizationUpdated")
        .withArgs(0, host.address, AuthStatus.Authorized, AuthStatus.Adjusted, EVIDENCE_CA);
      expect(await registry.isCorsiaEligible(0)).to.be.true;

      const b = await registry.getBatch(0);
      expect(b.hostAuthority).to.equal(host.address);
      expect(b.authEvidence).to.equal(EVIDENCE_CA);
    });

    it("T-25 revocation after adjustment removes CORSIA eligibility", async function () {
      const { registry, host } = await loadFixture(issuedBatchFixture);
      await registry.connect(host).setAuthorization(0, AuthStatus.Authorized, EVIDENCE_LOA);
      await registry.connect(host).setAuthorization(0, AuthStatus.Adjusted, EVIDENCE_CA);
      await registry.connect(host).setAuthorization(0, AuthStatus.Revoked, EVIDENCE_REVOKE);
      expect(await registry.isCorsiaEligible(0)).to.be.false;
    });

    it("T-26 invalid transitions are rejected (state-machine matrix)", async function () {
      const { registry, host } = await loadFixture(issuedBatchFixture);
      const bad = async (to) =>
        expect(registry.connect(host).setAuthorization(0, to, EVIDENCE_LOA)).to.be.revertedWithCustomError(
          registry,
          "InvalidAuthTransition"
        );

      // from None
      await bad(AuthStatus.None);
      await bad(AuthStatus.Adjusted);
      await bad(AuthStatus.Revoked);
      // from Authorized
      await registry.connect(host).setAuthorization(0, AuthStatus.Authorized, EVIDENCE_LOA);
      await bad(AuthStatus.None);
      await bad(AuthStatus.Authorized);
      // from Adjusted
      await registry.connect(host).setAuthorization(0, AuthStatus.Adjusted, EVIDENCE_CA);
      await bad(AuthStatus.Authorized);
      await bad(AuthStatus.Adjusted);
      // from Revoked (terminal)
      await registry.connect(host).setAuthorization(0, AuthStatus.Revoked, EVIDENCE_REVOKE);
      await bad(AuthStatus.Authorized);
      await bad(AuthStatus.Adjusted);
    });

    it("T-27 Authorized -> Revoked is allowed", async function () {
      const { registry, host } = await loadFixture(issuedBatchFixture);
      await registry.connect(host).setAuthorization(0, AuthStatus.Authorized, EVIDENCE_LOA);
      await expect(registry.connect(host).setAuthorization(0, AuthStatus.Revoked, EVIDENCE_REVOKE)).to.not.be.reverted;
      expect((await registry.getBatch(0)).auth).to.equal(AuthStatus.Revoked);
    });

    it("T-28 only the first host authority may update a batch", async function () {
      const { registry, host, host2 } = await loadFixture(issuedBatchFixture);
      await registry.connect(host).setAuthorization(0, AuthStatus.Authorized, EVIDENCE_LOA);
      await expect(registry.connect(host2).setAuthorization(0, AuthStatus.Adjusted, EVIDENCE_CA))
        .to.be.revertedWithCustomError(registry, "NotBatchHostAuthority")
        .withArgs(host.address);
    });

    it("T-29 developer with host role, empty evidence, rejected batch and non-host all revert", async function () {
      const { registry, developer, vvb, host, attacker } = await loadFixture(issuedBatchFixture);
      await registry.grantRole(await registry.HOST_AUTHORITY_ROLE(), developer.address);
      await expect(
        registry.connect(developer).setAuthorization(0, AuthStatus.Authorized, EVIDENCE_LOA)
      ).to.be.revertedWithCustomError(registry, "ConflictOfInterest");
      await expect(
        registry.connect(host).setAuthorization(0, AuthStatus.Authorized, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(registry, "EmptyField");
      await expect(
        registry.connect(attacker).setAuthorization(0, AuthStatus.Authorized, EVIDENCE_LOA)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");

      await submit(registry, developer, { serial: "REJ-1" });
      await registry.connect(vvb).rejectBatch(1, "invalid");
      await expect(registry.connect(host).setAuthorization(1, AuthStatus.Authorized, EVIDENCE_LOA))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(BatchStatus.Rejected);
    });

    it("T-30 authorization may be recorded before issuance but eligibility needs issuance", async function () {
      const { registry, developer, host } = await loadFixture(deployRegistryFixture);
      await submit(registry, developer);
      await registry.connect(host).setAuthorization(0, AuthStatus.Authorized, EVIDENCE_LOA);
      await registry.connect(host).setAuthorization(0, AuthStatus.Adjusted, EVIDENCE_CA);
      expect(await registry.isCorsiaEligible(0)).to.be.false;
    });
  });

  // ===================================================================
  describe("CCP label", function () {
    it("T-31 issuer labels an issued batch; pending batch and non-issuer revert", async function () {
      const { registry, issuer, developer, attacker } = await loadFixture(issuedBatchFixture);
      await expect(registry.connect(issuer).setCCPLabel(0, true)).to.emit(registry, "CCPLabelSet").withArgs(0, true);
      expect((await registry.batchIntegrity(0)).ccpLabel).to.be.true;

      await expect(registry.connect(attacker).setCCPLabel(0, false)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount"
      );
      await submit(registry, developer, { serial: "P-2" });
      await expect(registry.connect(issuer).setCCPLabel(1, true))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(BatchStatus.Pending);
    });
  });

  // ===================================================================
  describe("Emergency pause", function () {
    it("T-32 registry pause blocks lifecycle actions; unpause restores them", async function () {
      const { registry, pauser, developer, vvb, attacker } = await loadFixture(deployRegistryFixture);
      await expect(registry.connect(attacker).pause()).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount"
      );
      await registry.connect(pauser).pause();
      await expect(submit(registry, developer)).to.be.revertedWithCustomError(registry, "EnforcedPause");

      await registry.connect(pauser).unpause();
      await submit(registry, developer);
      await registry.connect(pauser).pause();
      await expect(registry.connect(vvb).verifyBatch(0)).to.be.revertedWithCustomError(registry, "EnforcedPause");
      await expect(registry.connect(attacker).unpause()).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("T-33 pauseBatch freezes one token; only issued batches can be paused", async function () {
      const { registry, token, pauser, developer, buyer, attacker } = await loadFixture(issuedBatchFixture);
      await registry.connect(pauser).pauseBatch(0);
      expect(await token.paused()).to.be.true;
      await expect(token.connect(developer).transfer(buyer.address, 1)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause"
      );
      await expect(registry.connect(attacker).unpauseBatch(0)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount"
      );
      await expect(token.connect(attacker).unpause()).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount"
      );
      await registry.connect(pauser).unpauseBatch(0);
      await expect(token.connect(developer).transfer(buyer.address, 1)).to.not.be.reverted;

      await submit(registry, developer, { serial: "P-3" });
      await expect(registry.connect(pauser).pauseBatch(1)).to.be.revertedWithCustomError(registry, "InvalidStatus");
      await expect(registry.connect(pauser).unpauseBatch(1)).to.be.revertedWithCustomError(registry, "InvalidStatus");
    });
  });

  // ===================================================================
  describe("Views", function () {
    it("T-34 views revert for unknown batches", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      await expect(registry.getBatch(0)).to.be.revertedWithCustomError(registry, "BatchNotFound");
      await expect(registry.batchIntegrity(0)).to.be.revertedWithCustomError(registry, "BatchNotFound");
      await expect(registry.isCorsiaEligible(0)).to.be.revertedWithCustomError(registry, "BatchNotFound");
    });

    it("T-35 supports AccessControl interface (ERC-165)", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      // IAccessControl interfaceId = 0x7965db0b
      expect(await registry.supportsInterface("0x7965db0b")).to.be.true;
      expect(await registry.supportsInterface("0xffffffff")).to.be.false;
    });
  });
});
