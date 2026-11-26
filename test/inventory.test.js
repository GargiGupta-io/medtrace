
const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
  time,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("InventoryManager", function () {
  const DAY = 24 * 60 * 60;
  const ZERO = ethers.ZeroAddress;

  const role = (name) =>
    ethers.keccak256(ethers.toUtf8Bytes(name));

  const PHARMACY = role("PHARMACY_ROLE");
  const REGULATOR = role("REGULATOR_ROLE");
  const MANUFACTURER = role("MANUFACTURER_ROLE");

  async function deployFixture() {
    // Reserve account 0 for the existing setup tests.
    const signers = await ethers.getSigners();

    const [scAccount, mfg, pharm, pharm2, reg, stranger] =
      signers.slice(1, 7);

    // Deploy using scAccount, not the default account 0.
    const registry = await ethers.deployContract(
      "MockRegistryForInventory",
      [],
      scAccount
    );

    const inv = await ethers.deployContract(
      "InventoryManager",
      [await registry.getAddress(), scAccount.address],
      scAccount
    );

    const expiry = (await time.latest()) + 365 * DAY;

    await registry.setBatch(1, mfg.address, expiry);
    await registry.setRole(PHARMACY, pharm.address);
    await registry.setRole(PHARMACY, pharm2.address);
    await registry.setRole(REGULATOR, reg.address);
    await registry.setRole(MANUFACTURER, mfg.address);

    // Initial stock: 1000 units to manufacturer.
    await inv.connect(scAccount).updateStock(
      1, ZERO, mfg.address, 1000
    );

    // Transfer 100 units to pharmacy.
    await inv.connect(scAccount).updateStock(
      1, mfg.address, pharm.address, 100
    );

    return {
      inv,
      registry,
      scAccount,
      mfg,
      pharm,
      pharm2,
      reg,
      stranger,
      expiry,
    };
  }

  describe("Stock management", function () {

    it("tracks initial stock correctly", async function () {
      const { inv, mfg, pharm } =
        await loadFixture(deployFixture);

      expect(await inv.getFacilityStock(mfg.address, 1))
        .to.equal(900n);

      expect(await inv.getFacilityStock(pharm.address, 1))
        .to.equal(100n);

      expect([...(await inv.getAffectedHolders(1))])
        .to.have.members([mfg.address, pharm.address]);
    });

    it("emits StockUpdated on transfer", async function () {
      const { inv, scAccount, mfg, pharm } =
        await loadFixture(deployFixture);

      await expect(
        inv.connect(scAccount).updateStock(
          1, mfg.address, pharm.address, 20
        )
      ).to.emit(inv, "StockUpdated")
        .withArgs(1, mfg.address, pharm.address, 20);
    });

    it("rejects unauthorized stock updates", async function () {
      const { inv, stranger, mfg, pharm } =
        await loadFixture(deployFixture);

      await expect(
        inv.connect(stranger).updateStock(
          1, mfg.address, pharm.address, 10
        )
      ).to.be.revertedWithCustomError(
        inv, "CallerNotSupplyChain"
      ).withArgs(stranger.address);
    });

    it("rejects zero-quantity updates", async function () {
      const { inv, scAccount, mfg, pharm } =
        await loadFixture(deployFixture);

      await expect(
        inv.connect(scAccount).updateStock(
          1, mfg.address, pharm.address, 0
        )
      ).to.be.revertedWithCustomError(
        inv, "ZeroQuantity"
      );
    });

    it("rejects transfers exceeding available stock", async function () {
      const { inv, scAccount, mfg, pharm } =
        await loadFixture(deployFixture);

      await expect(
        inv.connect(scAccount).updateStock(
          1, pharm.address, mfg.address, 101
        )
      ).to.be.revertedWithCustomError(
        inv, "InsufficientStock"
      ).withArgs(1, pharm.address, 100, 101);
    });

    it("removes a holder when their balance reaches zero", async function () {
      const { inv, pharm, mfg } =
        await loadFixture(deployFixture);

      await inv.connect(pharm).dispenseDrug(1, 100);

      expect(await inv.getFacilityStock(pharm.address, 1))
        .to.equal(0n);

      expect([...(await inv.getAffectedHolders(1))])
        .to.have.members([mfg.address]);
    });

    it("correctly removes a middle holder using swap-and-pop", async function () {
      const { inv, scAccount, mfg, pharm, pharm2, reg } =
        await loadFixture(deployFixture);

      await inv.connect(scAccount).updateStock(
        1, mfg.address, pharm2.address, 50
      );

      await inv.connect(scAccount).updateStock(
        1, mfg.address, reg.address, 20
      );

      await inv.connect(pharm).dispenseDrug(1, 100);

      const holders = [
        ...(await inv.getAffectedHolders(1)),
      ];

      expect(holders).to.have.members([
        mfg.address,
        pharm2.address,
        reg.address,
      ]);

      expect(holders).to.have.length(3);
    });
  });

  describe("Dispensing", function () {

    it("allows a pharmacy to dispense medicine", async function () {
      const { inv, pharm } =
        await loadFixture(deployFixture);

      await expect(
        inv.connect(pharm).dispenseDrug(1, 40)
      ).to.emit(inv, "DrugDispensed")
        .withArgs(1, pharm.address, 40);

      expect(await inv.getFacilityStock(pharm.address, 1))
        .to.equal(60n);

      const log = await inv.getDispensingLog(1);

      expect(log).to.have.length(1);
      expect(log[0].pharmacy).to.equal(pharm.address);
      expect(log[0].quantity).to.equal(40n);
      expect(log[0].timestamp).to.be.greaterThan(0n);
    });

    it("rejects dispensing more than available", async function () {
      const { inv, pharm } =
        await loadFixture(deployFixture);

      await expect(
        inv.connect(pharm).dispenseDrug(1, 150)
      ).to.be.revertedWithCustomError(
        inv, "InsufficientStock"
      ).withArgs(1, pharm.address, 100, 150);
    });

    it("rejects non-pharmacy dispensing", async function () {
      const { inv, stranger } =
        await loadFixture(deployFixture);

      await expect(
        inv.connect(stranger).dispenseDrug(1, 10)
      ).to.be.revertedWithCustomError(
        inv, "NotPharmacy"
      ).withArgs(stranger.address);
    });

    it("rejects dispensing zero units", async function () {
      const { inv, pharm } =
        await loadFixture(deployFixture);

      await expect(
        inv.connect(pharm).dispenseDrug(1, 0)
      ).to.be.revertedWithCustomError(
        inv, "ZeroQuantity"
      );
    });

    it("rejects expired medicine", async function () {
      const { inv, pharm } =
        await loadFixture(deployFixture);

      await time.increase(366 * DAY);

      expect(await inv.checkExpiry(1)).to.equal(false);

      await expect(
        inv.connect(pharm).dispenseDrug(1, 10)
      ).to.be.revertedWithCustomError(
        inv, "BatchIsExpired"
      ).withArgs(1);
    });
  });

  describe("Batch recall", function () {

    it("allows a regulator to recall a batch", async function () {
      const { inv, registry, reg } =
        await loadFixture(deployFixture);

      await expect(
        inv.connect(reg).flagRecall(1, "Quality issue")
      ).to.emit(inv, "BatchRecalled")
        .withArgs(1, reg.address, "Quality issue");

      expect(await inv.isRecalled(1)).to.equal(true);
      expect(await registry.lastStatus(1)).to.equal(1n);
    });

    it("allows the manufacturer to recall their batch", async function () {
      const { inv, registry, mfg } =
        await loadFixture(deployFixture);

      await inv.connect(mfg).flagRecall(
        1, "Manufacturing defect"
      );

      expect(await inv.isRecalled(1)).to.equal(true);
      expect(await registry.lastStatus(1)).to.equal(1n);
    });

    it("rejects a recall from the batch's manufacturer once it is no longer a manufacturer", async function () {
      const { inv, registry, mfg } =
        await loadFixture(deployFixture);

      // The mock has no revoke, so a fresh account stands in: it is the
      // batch's recorded manufacturer but holds no MANUFACTURER role.
      const [, , , , , , , ex] = await ethers.getSigners();
      await registry.setBatch(7, ex.address, (await time.latest()) + 86400);

      await expect(inv.connect(ex).flagRecall(7, "x"))
        .to.be.revertedWithCustomError(inv, "NotAuthorisedToRecall")
        .withArgs(ex.address);
    });

    it("rejects unauthorized recall attempts", async function () {
      const { inv, stranger } =
        await loadFixture(deployFixture);

      await expect(
        inv.connect(stranger).flagRecall(1, "Fake recall")
      ).to.be.revertedWithCustomError(
        inv, "NotAuthorisedToRecall"
      ).withArgs(stranger.address);
    });

    it("rejects recalling the same batch twice", async function () {
      const { inv, reg } =
        await loadFixture(deployFixture);

      await inv.connect(reg).flagRecall(1, "Defect");

      await expect(
        inv.connect(reg).flagRecall(1, "Again")
      ).to.be.revertedWithCustomError(
        inv, "AlreadyRecalled"
      ).withArgs(1);
    });

    it("rejects recalls of nonexistent batches", async function () {
      const { inv, registry, reg } =
        await loadFixture(deployFixture);

      await expect(
        inv.connect(reg).flagRecall(42, "Unknown batch")
      ).to.be.revertedWithCustomError(
        registry, "BatchNotFound"
      ).withArgs(42);
    });

    it("blocks dispensing after a recall", async function () {
      const { inv, reg, pharm } =
        await loadFixture(deployFixture);

      await inv.connect(reg).flagRecall(1, "Unsafe");

      await expect(
        inv.connect(pharm).dispenseDrug(1, 10)
      ).to.be.revertedWithCustomError(
        inv, "BatchIsRecalled"
      ).withArgs(1);
    });

    it("allows stock movement after recall for returns", async function () {
      const { inv, scAccount, mfg, pharm, reg } =
        await loadFixture(deployFixture);

      await inv.connect(reg).flagRecall(1, "Unsafe");

      await inv.connect(scAccount).updateStock(
        1, pharm.address, mfg.address, 100
      );

      expect(await inv.getFacilityStock(pharm.address, 1))
        .to.equal(0n);

      expect(await inv.getFacilityStock(mfg.address, 1))
        .to.equal(1000n);
    });
  });

  describe("Alerts and thresholds", function () {

    it("stores facility-specific reorder thresholds", async function () {
      const { inv, pharm, pharm2 } =
        await loadFixture(deployFixture);

      await inv.connect(pharm).setReorderThreshold(1, 80);
      await inv.connect(pharm2).setReorderThreshold(1, 30);

      expect(
        await inv.getReorderThreshold(pharm.address, 1)
      ).to.equal(80n);

      expect(
        await inv.getReorderThreshold(pharm2.address, 1)
      ).to.equal(30n);
    });

    it("emits LowStockAlert below the threshold", async function () {
      const { inv, pharm } =
        await loadFixture(deployFixture);

      await inv.connect(pharm).setReorderThreshold(1, 80);

      await expect(
        inv.connect(pharm).dispenseDrug(1, 40)
      ).to.emit(inv, "LowStockAlert")
        .withArgs(1, pharm.address, 60, 80);
    });

    it("warns when dispensing medicine near expiry", async function () {
      const { inv, registry, mfg, pharm } =
        await loadFixture(deployFixture);

      const expiry = (await time.latest()) + 10 * DAY;

      await registry.setBatch(1, mfg.address, expiry);

      await expect(
        inv.connect(pharm).dispenseDrug(1, 10)
      ).to.emit(inv, "ExpiryWarning")
        .withArgs(1, expiry);
    });

    it("warns when transferring medicine near expiry", async function () {
      const { inv, registry, scAccount, mfg, pharm } =
        await loadFixture(deployFixture);

      const expiry = (await time.latest()) + 10 * DAY;

      await registry.setBatch(1, mfg.address, expiry);

      await expect(
        inv.connect(scAccount).updateStock(
          1, mfg.address, pharm.address, 10
        )
      ).to.emit(inv, "ExpiryWarning")
        .withArgs(1, expiry);
    });

    it("does not warn when expiry is far away", async function () {
      const { inv, pharm } =
        await loadFixture(deployFixture);

      await expect(
        inv.connect(pharm).dispenseDrug(1, 10)
      ).to.not.emit(inv, "ExpiryWarning");
    });
  });

  describe("v2: quarantine", function () {
    const QUARANTINED = 2, ACTIVE = 0, RECALLED = 1;

    it("the manufacturer can quarantine its batch, which blocks dispensing", async function () {
      const { inv, registry, mfg, pharm } = await loadFixture(deployFixture);
      await expect(inv.connect(mfg).quarantineBatch(1, "Odd test result"))
        .to.emit(inv, "BatchQuarantined").withArgs(1, mfg.address, "Odd test result");
      expect(await inv.isQuarantined(1)).to.equal(true);
      expect(await registry.lastStatus(1)).to.equal(QUARANTINED);
      await expect(inv.connect(pharm).dispenseDrug(1, 1))
        .to.be.revertedWithCustomError(inv, "BatchIsQuarantined").withArgs(1);
    });

    it("dispensing works again once the quarantine is released", async function () {
      const { inv, registry, mfg, pharm } = await loadFixture(deployFixture);
      await inv.connect(mfg).quarantineBatch(1, "check");
      await expect(inv.connect(mfg).releaseQuarantine(1))
        .to.emit(inv, "QuarantineReleased").withArgs(1, mfg.address);
      expect(await inv.isQuarantined(1)).to.equal(false);
      expect(await registry.lastStatus(1)).to.equal(ACTIVE);
      await inv.connect(pharm).dispenseDrug(1, 1);
    });

    it("refuses quarantine from anyone but the active manufacturer or a regulator", async function () {
      const { inv, registry, stranger, pharm } = await loadFixture(deployFixture);
      await expect(inv.connect(stranger).quarantineBatch(1, "x"))
        .to.be.revertedWithCustomError(inv, "NotAuthorisedToQuarantine").withArgs(stranger.address);
      await expect(inv.connect(pharm).quarantineBatch(1, "x"))
        .to.be.revertedWithCustomError(inv, "NotAuthorisedToQuarantine");

      // The recorded manufacturer without the role (revoked) can't either.
      const [, , , , , , , exMfg] = await ethers.getSigners();
      await registry.setBatch(7, exMfg.address, (await time.latest()) + 100 * DAY);
      await expect(inv.connect(exMfg).quarantineBatch(7, "x"))
        .to.be.revertedWithCustomError(inv, "NotAuthorisedToQuarantine");
    });

    it("refuses quarantining twice, or quarantining a recalled batch", async function () {
      const { inv, mfg, reg } = await loadFixture(deployFixture);
      await inv.connect(mfg).quarantineBatch(1, "x");
      await expect(inv.connect(reg).quarantineBatch(1, "x"))
        .to.be.revertedWithCustomError(inv, "AlreadyQuarantined").withArgs(1);

      await inv.connect(reg).flagRecall(1, "confirmed");
      await expect(inv.connect(reg).quarantineBatch(1, "x"))
        .to.be.revertedWithCustomError(inv, "BatchIsRecalled").withArgs(1);
    });

    it("a manufacturer can't lift a quarantine a regulator imposed", async function () {
      const { inv, mfg, reg } = await loadFixture(deployFixture);
      await inv.connect(reg).quarantineBatch(1, "Regulator hold");
      await expect(inv.connect(mfg).releaseQuarantine(1))
        .to.be.revertedWithCustomError(inv, "NotAuthorisedToQuarantine").withArgs(mfg.address);
      await inv.connect(reg).releaseQuarantine(1);
    });

    it("a regulator can lift a manufacturer's quarantine; strangers can't lift any", async function () {
      const { inv, mfg, reg, stranger } = await loadFixture(deployFixture);
      await inv.connect(mfg).quarantineBatch(1, "x");
      await expect(inv.connect(stranger).releaseQuarantine(1))
        .to.be.revertedWithCustomError(inv, "NotAuthorisedToQuarantine");
      await inv.connect(reg).releaseQuarantine(1);
    });

    it("refuses releasing a batch that isn't quarantined", async function () {
      const { inv, reg } = await loadFixture(deployFixture);
      await expect(inv.connect(reg).releaseQuarantine(1))
        .to.be.revertedWithCustomError(inv, "NotQuarantined").withArgs(1);
    });

    it("a quarantine can be escalated to a recall, which clears it for good", async function () {
      const { inv, registry, mfg, reg } = await loadFixture(deployFixture);
      await inv.connect(reg).quarantineBatch(1, "x");
      await inv.connect(mfg).flagRecall(1, "confirmed contamination");
      expect(await inv.isQuarantined(1)).to.equal(false);
      expect(await inv.isRecalled(1)).to.equal(true);
      expect(await registry.lastStatus(1)).to.equal(RECALLED);
      await expect(inv.connect(reg).releaseQuarantine(1))
        .to.be.revertedWithCustomError(inv, "NotQuarantined");
    });
  });

  describe("v2: destroying dead stock", function () {
    it("refuses to destroy good stock", async function () {
      const { inv, pharm } = await loadFixture(deployFixture);
      await expect(inv.connect(pharm).destroyStock(1, 10, "x"))
        .to.be.revertedWithCustomError(inv, "StockNotDisposable").withArgs(1);
    });

    it("refuses to destroy quarantined stock, which may yet be released", async function () {
      const { inv, mfg, pharm } = await loadFixture(deployFixture);
      await inv.connect(mfg).quarantineBatch(1, "x");
      await expect(inv.connect(pharm).destroyStock(1, 10, "x"))
        .to.be.revertedWithCustomError(inv, "StockNotDisposable");
    });

    it("a holder can destroy recalled stock, and it is logged", async function () {
      const { inv, reg, pharm } = await loadFixture(deployFixture);
      await inv.connect(reg).flagRecall(1, "bad");
      await expect(inv.connect(pharm).destroyStock(1, 40, "Incinerated on site"))
        .to.emit(inv, "StockDestroyed").withArgs(1, pharm.address, 40, "Incinerated on site");
      expect(await inv.getFacilityStock(pharm.address, 1)).to.equal(60);
      const log = await inv.getDestructionLog(1);
      expect(log.length).to.equal(1);
      expect(log[0].holder).to.equal(pharm.address);
      expect(log[0].quantity).to.equal(40);
      expect(log[0].reason).to.equal("Incinerated on site");
    });

    it("destroying a holder's last unit removes it from the affected holders", async function () {
      const { inv, reg, pharm } = await loadFixture(deployFixture);
      await inv.connect(reg).flagRecall(1, "bad");
      await inv.connect(pharm).destroyStock(1, 100, "x");
      expect([...(await inv.getAffectedHolders(1))]).to.not.include(pharm.address);
    });

    it("expired stock can be destroyed even without a recall", async function () {
      const { inv, pharm, expiry } = await loadFixture(deployFixture);
      await time.increaseTo(expiry + 1);
      await inv.connect(pharm).destroyStock(1, 100, "Expired");
      expect(await inv.getFacilityStock(pharm.address, 1)).to.equal(0);
    });

    it("refuses zero, or more than the holder has", async function () {
      const { inv, reg, pharm } = await loadFixture(deployFixture);
      await inv.connect(reg).flagRecall(1, "bad");
      await expect(inv.connect(pharm).destroyStock(1, 0, "x"))
        .to.be.revertedWithCustomError(inv, "ZeroQuantity");
      await expect(inv.connect(pharm).destroyStock(1, 101, "x"))
        .to.be.revertedWithCustomError(inv, "InsufficientStock")
        .withArgs(1, pharm.address, 100, 101);
    });

    it("a write-off doesn't raise a low-stock alert", async function () {
      const { inv, reg, pharm } = await loadFixture(deployFixture);
      await inv.connect(pharm).setReorderThreshold(1, 90);
      await inv.connect(reg).flagRecall(1, "bad");
      await expect(inv.connect(pharm).destroyStock(1, 50, "x")).to.not.emit(inv, "LowStockAlert");
    });
  });

  describe("v2: recall progress", function () {
    it("accounts for every unit: dispensed + destroyed + outstanding = produced", async function () {
      const { inv, registry, reg, pharm, mfg } = await loadFixture(deployFixture);
      await registry.setQuantity(1, 1000);
      await inv.connect(pharm).dispenseDrug(1, 30);
      await inv.connect(reg).flagRecall(1, "bad");
      await inv.connect(pharm).destroyStock(1, 70, "x");
      await inv.connect(mfg).destroyStock(1, 500, "x");

      const p = await inv.getRecallProgress(1);
      expect(p.produced).to.equal(1000);
      expect(p.dispensed).to.equal(30);
      expect(p.destroyed).to.equal(570);
      expect(p.outstanding).to.equal(400);
    });
  });

  describe("v2: emergency pause", function () {
    it("no dispensing while paused, and it resumes after", async function () {
      const { inv, registry, pharm } = await loadFixture(deployFixture);
      await registry.setPaused(true);
      await expect(inv.connect(pharm).dispenseDrug(1, 1)).to.be.revertedWithCustomError(inv, "Paused");
      await registry.setPaused(false);
      await inv.connect(pharm).dispenseDrug(1, 1);
    });

    it("recall, quarantine and destruction still work while paused", async function () {
      const { inv, registry, mfg, reg, pharm } = await loadFixture(deployFixture);
      await registry.setPaused(true);
      await inv.connect(mfg).quarantineBatch(1, "x");
      await inv.connect(reg).flagRecall(1, "bad");
      await inv.connect(pharm).destroyStock(1, 100, "x");
      expect(await inv.getFacilityStock(pharm.address, 1)).to.equal(0);
    });
  });

  describe("v2: paged reads", function () {
    async function withManyRecords() {
      const f = await deployFixture();
      const signers = await ethers.getSigners();
      // Spread stock over five more holders: mfg, pharm + five = 7 holders.
      for (const s of signers.slice(10, 15)) {
        await f.inv.connect(f.scAccount).updateStock(1, f.mfg.address, s.address, 10);
      }
      for (let i = 1; i <= 5; i++) await f.inv.connect(f.pharm).dispenseDrug(1, i);
      return f;
    }

    it("pages through the holders and matches the full list", async function () {
      const { inv } = await loadFixture(withManyRecords);
      expect(await inv.getAffectedHoldersCount(1)).to.equal(7n);
      const full = [...(await inv.getAffectedHolders(1))];
      const paged = [...(await inv.getAffectedHoldersPage(1, 0, 3)), ...(await inv.getAffectedHoldersPage(1, 3, 3)), ...(await inv.getAffectedHoldersPage(1, 6, 3))];
      expect(paged).to.deep.equal(full);
    });

    it("pages through the dispensing log and matches the full log", async function () {
      const { inv } = await loadFixture(withManyRecords);
      expect(await inv.getDispensingLogCount(1)).to.equal(5n);
      const page = await inv.getDispensingLogPage(1, 1, 2);
      expect(page.map((r) => r.quantity)).to.deep.equal([2n, 3n]);
    });

    it("clips at the end and handles an offset past the end, limit 0 and a huge limit", async function () {
      const { inv } = await loadFixture(withManyRecords);
      expect((await inv.getDispensingLogPage(1, 3, 100)).length).to.equal(2);
      expect((await inv.getDispensingLogPage(1, 5, 1)).length).to.equal(0);
      expect((await inv.getAffectedHoldersPage(1, 50, 1)).length).to.equal(0);
      expect((await inv.getAffectedHoldersPage(1, 0, 0)).length).to.equal(0);
      expect((await inv.getAffectedHoldersPage(1, 2, ethers.MaxUint256)).length).to.equal(5);
      expect((await inv.getDispensingLogPage(99, 0, 10)).length).to.equal(0);
    });
  });

  describe("v2: deployment checks", function () {
    it("refuses a zero registry or supply chain address", async function () {
      const [, other] = await ethers.getSigners();
      const factory = await ethers.getContractFactory("InventoryManager");
      await expect(factory.deploy(ZERO, other.address)).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.deploy(other.address, ZERO)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("v2: reorder level validation", function () {
    it("announces a new reorder level", async function () {
      const { inv, pharm } = await loadFixture(deployFixture);
      await expect(inv.connect(pharm).setReorderThreshold(1, 80))
        .to.emit(inv, "ReorderThresholdSet")
        .withArgs(1, pharm.address, 80);
    });

    it("refuses a batch that doesn't exist", async function () {
      const { inv, pharm } = await loadFixture(deployFixture);
      await expect(inv.connect(pharm).setReorderThreshold(99, 80))
        .to.be.revertedWithCustomError(inv, "BatchNotFound")
        .withArgs(99);
      expect(await inv.getReorderThreshold(pharm.address, 99)).to.equal(0n);
    });
  });

  describe("v2: expiry warning once per batch", function () {
    it("warns on the first move inside the window, then stays quiet", async function () {
      const { inv, registry, scAccount, mfg, pharm } = await loadFixture(deployFixture);
      const expiry = (await time.latest()) + 10 * DAY;
      await registry.setBatch(1, mfg.address, expiry);

      await expect(inv.connect(scAccount).updateStock(1, mfg.address, pharm.address, 10)).to.emit(inv, "ExpiryWarning").withArgs(1, expiry);
      await expect(inv.connect(scAccount).updateStock(1, mfg.address, pharm.address, 10)).to.not.emit(inv, "ExpiryWarning");
      await expect(inv.connect(pharm).dispenseDrug(1, 5)).to.not.emit(inv, "ExpiryWarning");
    });

    it("moves outside the window don't use up the warning", async function () {
      const { inv, scAccount, mfg, pharm, expiry } = await loadFixture(deployFixture);
      await inv.connect(pharm).dispenseDrug(1, 5); // a year out: no warning
      await time.increaseTo(expiry - 5 * DAY);
      await expect(inv.connect(scAccount).updateStock(1, mfg.address, pharm.address, 10)).to.emit(inv, "ExpiryWarning").withArgs(1, expiry);
    });
  });
});
