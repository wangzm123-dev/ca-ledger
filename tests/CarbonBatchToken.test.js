const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  AuthStatus,
  UseType,
  UNITS_PER_TONNE,
  DEFAULT_BATCH,
  EVIDENCE_LOA,
  EVIDENCE_CA,
  EVIDENCE_REVOKE,
  issuedBatchFixture,
  submit,
} = require("./fixtures");

const T = (tonnes) => BigInt(tonnes) * UNITS_PER_TONNE; // tonnes -> token units
const CAP = DEFAULT_BATCH.quantity * UNITS_PER_TONNE;

async function expectSupplyInvariant(token) {
  // Every unit ever minted is either still circulating or has been retired.
  expect((await token.totalSupply()) + (await token.totalRetired())).to.equal(await token.cap());
}

describe("CarbonBatchToken", function () {
  // ===================================================================
  describe("ERC-20 standard behaviour", function () {
    it("T-36 transfer moves balances and emits Transfer", async function () {
      const { token, developer, buyer } = await loadFixture(issuedBatchFixture);
      await expect(token.connect(developer).transfer(buyer.address, T(100)))
        .to.emit(token, "Transfer")
        .withArgs(developer.address, buyer.address, T(100));
      await expect(token.connect(developer).transfer(buyer.address, T(1))).to.changeTokenBalances(
        token,
        [developer, buyer],
        [-T(1), T(1)]
      );
      expect(await token.balanceOf(buyer.address)).to.equal(T(101));
    });

    it("T-37 approve + transferFrom use and reduce the allowance", async function () {
      const { token, developer, airline, buyer } = await loadFixture(issuedBatchFixture);
      await expect(token.connect(developer).approve(airline.address, T(50)))
        .to.emit(token, "Approval")
        .withArgs(developer.address, airline.address, T(50));
      expect(await token.allowance(developer.address, airline.address)).to.equal(T(50));

      await token.connect(airline).transferFrom(developer.address, buyer.address, T(30));
      expect(await token.allowance(developer.address, airline.address)).to.equal(T(20));
      expect(await token.balanceOf(buyer.address)).to.equal(T(30));

      await expect(token.connect(airline).transferFrom(developer.address, buyer.address, T(21)))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance")
        .withArgs(airline.address, T(20), T(21));
    });

    it("T-38 transferring more than the balance reverts", async function () {
      const { token, buyer, developer } = await loadFixture(issuedBatchFixture);
      await expect(token.connect(buyer).transfer(developer.address, 1))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
        .withArgs(buyer.address, 0, 1);
    });

    it("T-39 transfer to the zero address reverts", async function () {
      const { token, developer } = await loadFixture(issuedBatchFixture);
      await expect(token.connect(developer).transfer(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(
        token,
        "ERC20InvalidReceiver"
      );
    });
  });

  // ===================================================================
  describe("Retirement", function () {
    it("T-40 voluntary retirement burns tokens and stores a certificate", async function () {
      const { token, developer, buyer } = await loadFixture(issuedBatchFixture);
      await token.connect(developer).transfer(buyer.address, T(10));

      await expect(token.connect(buyer).retire(T(4), "Acme Ltd", "FY2026 Scope 1", UseType.Voluntary))
        .to.emit(token, "CreditsRetired")
        .withArgs(0, buyer.address, T(4), UseType.Voluntary, false, AuthStatus.None, "Acme Ltd", "FY2026 Scope 1")
        .and.to.emit(token, "Transfer")
        .withArgs(buyer.address, ethers.ZeroAddress, T(4));

      expect(await token.balanceOf(buyer.address)).to.equal(T(6));
      expect(await token.totalRetired()).to.equal(T(4));
      expect(await token.retirementCount()).to.equal(1);

      const r = await token.getRetirement(0);
      expect(r.account).to.equal(buyer.address);
      expect(r.amount).to.equal(T(4));
      expect(r.useType).to.equal(UseType.Voluntary);
      expect(r.ccpLabel).to.be.false;
      expect(r.auth).to.equal(AuthStatus.None);
      expect(r.beneficiary).to.equal("Acme Ltd");
      expect(r.purpose).to.equal("FY2026 Scope 1");
      expect(r.timestamp).to.be.greaterThan(0);
      await expectSupplyInvariant(token);
    });

    it("T-41 CORSIA retirement denied for None, Authorized and Revoked; allowed for Adjusted", async function () {
      const { registry, token, developer, airline, host } = await loadFixture(issuedBatchFixture);
      await token.connect(developer).transfer(airline.address, T(100));
      const corsia = () => token.connect(airline).retire(T(1), "Airline X", "CORSIA 2026", UseType.Corsia);

      await expect(corsia()).to.be.revertedWithCustomError(token, "NotCorsiaEligible").withArgs(AuthStatus.None);

      await registry.connect(host).setAuthorization(0, AuthStatus.Authorized, EVIDENCE_LOA);
      await expect(corsia()).to.be.revertedWithCustomError(token, "NotCorsiaEligible").withArgs(AuthStatus.Authorized);

      await registry.connect(host).setAuthorization(0, AuthStatus.Adjusted, EVIDENCE_CA);
      await expect(corsia())
        .to.emit(token, "CreditsRetired")
        .withArgs(0, airline.address, T(1), UseType.Corsia, false, AuthStatus.Adjusted, "Airline X", "CORSIA 2026");

      await registry.connect(host).setAuthorization(0, AuthStatus.Revoked, EVIDENCE_REVOKE);
      await expect(corsia()).to.be.revertedWithCustomError(token, "NotCorsiaEligible").withArgs(AuthStatus.Revoked);

      // Earlier CORSIA certificate keeps its Adjusted snapshot.
      expect((await token.getRetirement(0)).auth).to.equal(AuthStatus.Adjusted);
      // Voluntary use is still possible after revocation.
      await expect(token.connect(airline).retire(T(1), "Airline X", "voluntary", UseType.Voluntary)).to.not.be
        .reverted;
      await expectSupplyInvariant(token);
    });

    it("T-42 CCP label is snapshotted: later label changes never rewrite past certificates", async function () {
      const { registry, token, developer, issuer } = await loadFixture(issuedBatchFixture);
      await token.connect(developer).retire(T(1), "Dev", "before label", UseType.Voluntary);
      await registry.connect(issuer).setCCPLabel(0, true);
      await token.connect(developer).retire(T(1), "Dev", "after label", UseType.Voluntary);
      await registry.connect(issuer).setCCPLabel(0, false);

      expect((await token.getRetirement(0)).ccpLabel).to.be.false; // not upgraded retroactively
      expect((await token.getRetirement(1)).ccpLabel).to.be.true; // not downgraded retroactively
    });

    it("T-43 boundary: zero amount, empty beneficiary and over-long strings revert", async function () {
      const { token, developer } = await loadFixture(issuedBatchFixture);
      await expect(token.connect(developer).retire(0, "A", "B", UseType.Voluntary)).to.be.revertedWithCustomError(
        token,
        "ZeroAmount"
      );
      await expect(token.connect(developer).retire(1, "", "B", UseType.Voluntary)).to.be.revertedWithCustomError(
        token,
        "EmptyBeneficiary"
      );
      await expect(
        token.connect(developer).retire(1, "x".repeat(129), "B", UseType.Voluntary)
      ).to.be.revertedWithCustomError(token, "StringTooLong");
      await expect(
        token.connect(developer).retire(1, "A", "y".repeat(129), UseType.Voluntary)
      ).to.be.revertedWithCustomError(token, "StringTooLong");
      await expect(token.connect(developer).retire(1, "x".repeat(128), "y".repeat(128), UseType.Voluntary)).to.not.be
        .reverted;
      await expect(token.connect(developer).retire(1, "A", "", UseType.Voluntary)).to.not.be.reverted; // purpose optional
    });

    it("T-44 boundary: retiring the full balance succeeds; one more unit fails", async function () {
      const { token, developer } = await loadFixture(issuedBatchFixture);
      await token.connect(developer).retire(CAP, "Dev", "all", UseType.Voluntary);
      expect(await token.balanceOf(developer.address)).to.equal(0);
      expect(await token.totalSupply()).to.equal(0);
      await expect(token.connect(developer).retire(1, "Dev", "again", UseType.Voluntary))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
        .withArgs(developer.address, 0, 1);
      await expectSupplyInvariant(token);
    });

    it("T-45 retired credits cannot be retired again by anyone (no double claiming)", async function () {
      const { token, developer, buyer } = await loadFixture(issuedBatchFixture);
      await token.connect(developer).transfer(buyer.address, T(1));
      await token.connect(buyer).retire(T(1), "Buyer", "claim", UseType.Voluntary);
      await expect(token.connect(buyer).retire(T(1), "Buyer", "claim again", UseType.Voluntary)).to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientBalance"
      );
    });

    it("T-46 retirement is blocked while the batch is paused", async function () {
      const { registry, token, pauser, developer } = await loadFixture(issuedBatchFixture);
      await registry.connect(pauser).pauseBatch(0);
      await expect(token.connect(developer).retire(1, "Dev", "x", UseType.Voluntary)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause"
      );
    });

    it("T-47 unknown retirement ID reverts", async function () {
      const { token } = await loadFixture(issuedBatchFixture);
      await expect(token.getRetirement(0)).to.be.revertedWithCustomError(token, "RetirementNotFound").withArgs(0);
    });
  });

  // ===================================================================
  describe("Supply cap and invariants", function () {
    it("T-48 the cap equals the verified quantity and the registry cannot exceed it", async function () {
      const { registry, token } = await loadFixture(issuedBatchFixture);
      expect(await token.cap()).to.equal(CAP);
      expect(await token.totalSupply()).to.equal(CAP);
      // Even the MINTER (the registry) is bounded: impersonate it to prove ERC20Capped enforcement.
      const regAddr = await registry.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [regAddr]);
      await ethers.provider.send("hardhat_setBalance", [regAddr, "0x56BC75E2D63100000"]);
      const regSigner = await ethers.getSigner(regAddr);
      await expect(token.connect(regSigner).mint(regAddr, 1))
        .to.be.revertedWithCustomError(token, "ERC20ExceededCap")
        .withArgs(CAP + 1n, CAP);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [regAddr]);
    });

    it("T-49 totalSupply + totalRetired == cap after a mixed sequence of actions", async function () {
      const { token, developer, buyer, airline } = await loadFixture(issuedBatchFixture);
      const steps = [
        () => token.connect(developer).transfer(buyer.address, T(500)),
        () => token.connect(buyer).retire(T(120), "B", "p", UseType.Voluntary),
        () => token.connect(developer).approve(airline.address, T(300)),
        () => token.connect(airline).transferFrom(developer.address, airline.address, T(300)),
        () => token.connect(airline).retire(T(299), "A", "p", UseType.Voluntary),
        () => token.connect(buyer).transfer(airline.address, T(80)),
        () => token.connect(developer).retire(1n, "D", "1 kg", UseType.Voluntary),
      ];
      for (const step of steps) {
        await step();
        await expectSupplyInvariant(token);
      }
      expect(await token.totalRetired()).to.equal(T(120) + T(299) + 1n);
    });

    it("T-50 batches are isolated: separate tokens, supplies and authorization states", async function () {
      const { registry, token, developer, developer2, vvb, issuer, host } = await loadFixture(issuedBatchFixture);
      await submit(registry, developer2, { serial: "GS-777-2025-1", quantity: 500n, vintage: 2025 });
      await registry.connect(vvb).verifyBatch(1);
      await registry.connect(issuer).issueBatch(1);
      const token1 = await ethers.getContractAt("CarbonBatchToken", (await registry.getBatch(1)).token);

      expect(await token1.getAddress()).to.not.equal(await token.getAddress());
      expect(await token1.symbol()).to.equal("A6C-1");
      expect(await token1.cap()).to.equal(T(500));
      expect(await token1.balanceOf(developer2.address)).to.equal(T(500));
      expect(await token1.balanceOf(developer.address)).to.equal(0);

      await registry.connect(host).setAuthorization(1, AuthStatus.Authorized, EVIDENCE_LOA);
      await registry.connect(host).setAuthorization(1, AuthStatus.Adjusted, EVIDENCE_CA);
      expect(await registry.isCorsiaEligible(1)).to.be.true;
      expect(await registry.isCorsiaEligible(0)).to.be.false;

      await expect(token.connect(developer).retire(1, "D", "x", UseType.Corsia)).to.be.revertedWithCustomError(
        token,
        "NotCorsiaEligible"
      );
      await expect(token1.connect(developer2).retire(1, "D2", "x", UseType.Corsia)).to.not.be.reverted;
    });
  });
});
