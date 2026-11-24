const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const role = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const ADMIN = ethers.ZeroHash;
const MANUFACTURER = role("MANUFACTURER_ROLE");
const DISTRIBUTOR = role("DISTRIBUTOR_ROLE");
const PHARMACY = role("PHARMACY_ROLE");
const REGULATOR = role("REGULATOR_ROLE");
const DAY = 86400;
const CID = "bafkreigh2akiscaildc";

async function deployFixture() {
  const [admin, mfg, dist, stranger, inventory] = await ethers.getSigners();
  const registry = await ethers.deployContract("DrugRegistry", [admin.address]);
  const mockSC = await ethers.deployContract("MockSupplyChainForRegistry");
  await registry.setSupplyChain(await mockSC.getAddress());
  await registry.setInventoryManager(inventory.address);
  await registry.registerParticipant(mfg.address, "Cipla", "MFG-001", MANUFACTURER);
  await registry.registerParticipant(dist.address, "MedDist", "DST-001", DISTRIBUTOR);
  const now = await time.latest();
  return { registry, mockSC, admin, mfg, dist, stranger, inventory, now };
}

async function withBatchFixture() {
  const f = await deployFixture();
  await f.registry.connect(f.mfg).registerBatch("Paracetamol 500mg", "Paracetamol IP", f.now - DAY, f.now + 365 * DAY, 10000, CID);
  return f;
}

describe("DrugRegistry", function () {
  describe("deployment and wiring", function () {
    it("makes the constructor argument the admin", async function () {
      const { registry, admin } = await loadFixture(deployFixture);
      expect(await registry.hasRole(ADMIN, admin.address)).to.equal(true);
    });

    it("rejects a zero admin", async function () {
      const registry = await ethers.getContractFactory("DrugRegistry");
      await expect(registry.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("refuses to set SupplyChain twice", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(registry.setSupplyChain(stranger.address)).to.be.revertedWithCustomError(registry, "AddressAlreadySet");
    });

    it("refuses to set InventoryManager twice", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(registry.setInventoryManager(stranger.address)).to.be.revertedWithCustomError(registry, "AddressAlreadySet");
    });

    it("refuses zero addresses when wiring", async function () {
      const [admin] = await ethers.getSigners();
      const registry = await ethers.deployContract("DrugRegistry", [admin.address]);
      await expect(registry.setSupplyChain(ethers.ZeroAddress)).to.be.revertedWithCustomError(registry, "ZeroAddress");
      await expect(registry.setInventoryManager(ethers.ZeroAddress)).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("lets only the admin wire the contracts", async function () {
      const [admin, other] = await ethers.getSigners();
      const registry = await ethers.deployContract("DrugRegistry", [admin.address]);
      await expect(registry.connect(other).setSupplyChain(other.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, ADMIN);
      await expect(registry.connect(other).setInventoryManager(other.address)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("participants", function () {
    it("registers a participant, grants the role and emits ParticipantRegistered", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(registry.registerParticipant(stranger.address, "Apollo", "PH-001", PHARMACY))
        .to.emit(registry, "ParticipantRegistered")
        .withArgs(stranger.address, PHARMACY, "Apollo", "PH-001");
      expect(await registry.hasRole(PHARMACY, stranger.address)).to.equal(true);
      expect(await registry.isRegistered(stranger.address)).to.equal(true);
      const p = await registry.getParticipant(stranger.address);
      expect([p.name, p.licenceId, p.role, p.active]).to.deep.equal(["Apollo", "PH-001", PHARMACY, true]);
    });

    it("accepts the regulator role", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await registry.registerParticipant(stranger.address, "CDSCO", "REG-001", REGULATOR);
      expect(await registry.hasRole(REGULATOR, stranger.address)).to.equal(true);
    });

    it("rejects a duplicate registration", async function () {
      const { registry, mfg } = await loadFixture(deployFixture);
      await expect(registry.registerParticipant(mfg.address, "Cipla", "MFG-001", MANUFACTURER))
        .to.be.revertedWithCustomError(registry, "AlreadyRegistered")
        .withArgs(mfg.address);
    });

    it("rejects the zero address", async function () {
      const { registry } = await loadFixture(deployFixture);
      await expect(registry.registerParticipant(ethers.ZeroAddress, "X", "Y", PHARMACY)).to.be.revertedWithCustomError(
        registry,
        "ZeroAddress",
      );
    });

    it("rejects a role that is not one of the four", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(registry.registerParticipant(stranger.address, "X", "Y", role("ADMIN_X")))
        .to.be.revertedWithCustomError(registry, "InvalidRole")
        .withArgs(role("ADMIN_X"));
    });

    it("rejects the admin role as a participant role", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(registry.registerParticipant(stranger.address, "X", "Y", ADMIN)).to.be.revertedWithCustomError(
        registry,
        "InvalidRole",
      );
    });

    it("rejects an empty name or licence", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(registry.registerParticipant(stranger.address, "", "PH-1", PHARMACY)).to.be.revertedWithCustomError(
        registry,
        "EmptyField",
      );
      await expect(registry.registerParticipant(stranger.address, "Apollo", "", PHARMACY)).to.be.revertedWithCustomError(
        registry,
        "EmptyField",
      );
    });

    it("lets only the admin register participants", async function () {
      const { registry, mfg, stranger } = await loadFixture(deployFixture);
      await expect(registry.connect(mfg).registerParticipant(stranger.address, "X", "Y", PHARMACY))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(mfg.address, ADMIN);
    });

    it("assignRole swaps distributor for pharmacy", async function () {
      const { registry, dist } = await loadFixture(deployFixture);
      await expect(registry.assignRole(dist.address, PHARMACY)).to.emit(registry, "RoleAssigned").withArgs(dist.address, PHARMACY);
      expect(await registry.hasRole(DISTRIBUTOR, dist.address)).to.equal(false);
      expect(await registry.hasRole(PHARMACY, dist.address)).to.equal(true);
      expect((await registry.getParticipant(dist.address)).role).to.equal(PHARMACY);
    });

    it("assignRole rejects an unregistered account and a bad role", async function () {
      const { registry, dist, stranger } = await loadFixture(deployFixture);
      await expect(registry.assignRole(stranger.address, PHARMACY))
        .to.be.revertedWithCustomError(registry, "NotRegistered")
        .withArgs(stranger.address);
      await expect(registry.assignRole(dist.address, role("NOPE"))).to.be.revertedWithCustomError(registry, "InvalidRole");
    });

    it("revokeParticipant removes the role but keeps the record", async function () {
      const { registry, dist } = await loadFixture(deployFixture);
      await expect(registry.revokeParticipant(dist.address)).to.emit(registry, "ParticipantRevoked").withArgs(dist.address);
      expect(await registry.isRegistered(dist.address)).to.equal(false);
      expect(await registry.hasRole(DISTRIBUTOR, dist.address)).to.equal(false);
      expect((await registry.getParticipant(dist.address)).name).to.equal("MedDist");
    });

    it("a revoked participant cannot be revoked, reassigned or re-registered", async function () {
      const { registry, dist } = await loadFixture(deployFixture);
      await registry.revokeParticipant(dist.address);
      await expect(registry.revokeParticipant(dist.address)).to.be.revertedWithCustomError(registry, "NotRegistered");
      await expect(registry.assignRole(dist.address, PHARMACY)).to.be.revertedWithCustomError(registry, "NotRegistered");
      await expect(registry.registerParticipant(dist.address, "MedDist", "DST-001", DISTRIBUTOR)).to.be.revertedWithCustomError(
        registry,
        "AlreadyRegistered",
      );
    });

    it("only the admin can reassign or revoke", async function () {
      const { registry, mfg, dist } = await loadFixture(deployFixture);
      await expect(registry.connect(mfg).assignRole(dist.address, PHARMACY)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );
      await expect(registry.connect(mfg).revokeParticipant(dist.address)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("batches", function () {
    it("manufacturer registers a batch and custody is handed over", async function () {
      const { registry, mockSC, mfg, now } = await loadFixture(deployFixture);
      const expiry = now + 365 * DAY;
      await expect(registry.connect(mfg).registerBatch("Paracetamol 500mg", "Paracetamol IP", now - DAY, expiry, 10000, CID))
        .to.emit(registry, "BatchRegistered")
        .withArgs(1, mfg.address, "Paracetamol 500mg", 10000, expiry);
      expect(await registry.batchCount()).to.equal(1);

      const b = await registry.getBatchDetails(1);
      expect(b.batchId).to.equal(1);
      expect(b.drugName).to.equal("Paracetamol 500mg");
      expect(b.composition).to.equal("Paracetamol IP");
      expect(b.manufacturer).to.equal(mfg.address);
      expect(b.mfgDate).to.equal(now - DAY);
      expect(b.expiryDate).to.equal(expiry);
      expect(b.quantity).to.equal(10000);
      expect(b.ipfsHash).to.equal(CID);
      expect(b.status).to.equal(0);

      expect(await mockSC.lastBatchId()).to.equal(1);
      expect(await mockSC.lastManufacturer()).to.equal(mfg.address);
      expect(await mockSC.lastQuantity()).to.equal(10000);
    });

    it("second batch gets ID 2", async function () {
      const { registry, mfg, now } = await loadFixture(withBatchFixture);
      await registry.connect(mfg).registerBatch("Amoxicillin 250mg", "", now, now + 90 * DAY, 500, CID);
      expect(await registry.batchCount()).to.equal(2);
      expect((await registry.getBatchDetails(2)).drugName).to.equal("Amoxicillin 250mg");
    });

    it("a distributor cannot register a batch", async function () {
      const { registry, dist, now } = await loadFixture(deployFixture);
      await expect(registry.connect(dist).registerBatch("X", "", now, now + DAY, 1, CID))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(dist.address, MANUFACTURER);
    });

    it("a stranger cannot register a batch", async function () {
      const { registry, stranger, now } = await loadFixture(deployFixture);
      await expect(registry.connect(stranger).registerBatch("X", "", now, now + DAY, 1, CID)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("rejects zero quantity", async function () {
      const { registry, mfg, now } = await loadFixture(deployFixture);
      await expect(registry.connect(mfg).registerBatch("X", "", now, now + DAY, 0, CID)).to.be.revertedWithCustomError(
        registry,
        "ZeroQuantity",
      );
    });

    it("rejects an empty drug name", async function () {
      const { registry, mfg, now } = await loadFixture(deployFixture);
      await expect(registry.connect(mfg).registerBatch("", "", now, now + DAY, 1, CID)).to.be.revertedWithCustomError(
        registry,
        "EmptyField",
      );
    });

    it("rejects an empty IPFS hash", async function () {
      const { registry, mfg, now } = await loadFixture(deployFixture);
      await expect(registry.connect(mfg).registerBatch("X", "", now, now + DAY, 1, "")).to.be.revertedWithCustomError(
        registry,
        "EmptyField",
      );
    });

    it("rejects expiry before the manufacture date", async function () {
      const { registry, mfg, now } = await loadFixture(deployFixture);
      await expect(registry.connect(mfg).registerBatch("X", "", now + 10 * DAY, now + 5 * DAY, 1, CID))
        .to.be.revertedWithCustomError(registry, "InvalidDates")
        .withArgs(now + 10 * DAY, now + 5 * DAY);
    });

    it("rejects an expiry already in the past", async function () {
      const { registry, mfg, now } = await loadFixture(deployFixture);
      await expect(registry.connect(mfg).registerBatch("X", "", now - 30 * DAY, now - DAY, 1, CID)).to.be.revertedWithCustomError(
        registry,
        "InvalidDates",
      );
    });

    it("a revoked manufacturer can no longer register batches", async function () {
      const { registry, mfg, now } = await loadFixture(deployFixture);
      await registry.revokeParticipant(mfg.address);
      await expect(registry.connect(mfg).registerBatch("X", "", now, now + DAY, 1, CID)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("getBatchDetails(999) fails, so forged IDs are detected", async function () {
      const { registry } = await loadFixture(withBatchFixture);
      await expect(registry.getBatchDetails(999)).to.be.revertedWithCustomError(registry, "BatchNotFound").withArgs(999);
      await expect(registry.getBatchDetails(0)).to.be.revertedWithCustomError(registry, "BatchNotFound").withArgs(0);
    });

    it("batchExists is false for 0 and unknown IDs", async function () {
      const { registry } = await loadFixture(withBatchFixture);
      expect(await registry.batchExists(0)).to.equal(false);
      expect(await registry.batchExists(1)).to.equal(true);
      expect(await registry.batchExists(2)).to.equal(false);
    });
  });

  describe("batch status", function () {
    it("InventoryManager can recall a batch", async function () {
      const { registry, inventory } = await loadFixture(withBatchFixture);
      await expect(registry.connect(inventory).setBatchStatus(1, 1)).to.emit(registry, "BatchStatusChanged").withArgs(1, 1);
      expect((await registry.getBatchDetails(1)).status).to.equal(1);
    });

    it("setBatchStatus from a stranger fails", async function () {
      const { registry, stranger } = await loadFixture(withBatchFixture);
      await expect(registry.connect(stranger).setBatchStatus(1, 1))
        .to.be.revertedWithCustomError(registry, "CallerNotInventory")
        .withArgs(stranger.address);
    });

    it("even the admin cannot set a batch status directly", async function () {
      const { registry, admin } = await loadFixture(withBatchFixture);
      await expect(registry.connect(admin).setBatchStatus(1, 1)).to.be.revertedWithCustomError(registry, "CallerNotInventory");
    });

    it("setBatchStatus on an unknown batch fails", async function () {
      const { registry, inventory } = await loadFixture(withBatchFixture);
      await expect(registry.connect(inventory).setBatchStatus(42, 1))
        .to.be.revertedWithCustomError(registry, "BatchNotFound")
        .withArgs(42);
    });
  });
  describe("v2: role lockdown", function () {
    it("refuses to grant a participant role directly", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(registry.grantRole(PHARMACY, stranger.address))
        .to.be.revertedWithCustomError(registry, "RoleManagedByRegistry")
        .withArgs(PHARMACY);
    });

    it("refuses to revoke a participant role directly", async function () {
      const { registry, mfg } = await loadFixture(deployFixture);
      await expect(registry.revokeRole(MANUFACTURER, mfg.address))
        .to.be.revertedWithCustomError(registry, "RoleManagedByRegistry")
        .withArgs(MANUFACTURER);
      expect(await registry.isRegistered(mfg.address)).to.equal(true);
    });

    it("stops a participant renouncing their own role", async function () {
      const { registry, mfg } = await loadFixture(deployFixture);
      await expect(registry.connect(mfg).renounceRole(MANUFACTURER, mfg.address))
        .to.be.revertedWithCustomError(registry, "RoleManagedByRegistry");
    });

    it("refuses to grant the admin role directly too", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(registry.grantRole(ADMIN, stranger.address))
        .to.be.revertedWithCustomError(registry, "RoleManagedByRegistry")
        .withArgs(ADMIN);
    });

    it("still lets the admin add (by invitation) and remove other admins", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await registry.proposeAdmin(stranger.address);
      await registry.connect(stranger).acceptAdmin();
      expect(await registry.adminCount()).to.equal(2n);
      await registry.revokeRole(ADMIN, stranger.address);
      expect(await registry.adminCount()).to.equal(1n);
      expect(await registry.hasRole(ADMIN, stranger.address)).to.equal(false);
    });

    it("never lets the last admin renounce", async function () {
      const { registry, admin } = await loadFixture(deployFixture);
      await expect(registry.renounceRole(ADMIN, admin.address)).to.be.revertedWithCustomError(registry, "LastAdmin");
      expect(await registry.hasRole(ADMIN, admin.address)).to.equal(true);
    });

    it("lets an admin leave once another admin exists", async function () {
      const { registry, admin, stranger } = await loadFixture(deployFixture);
      await registry.proposeAdmin(stranger.address);
      await registry.connect(stranger).acceptAdmin();
      await registry.renounceRole(ADMIN, admin.address);
      expect(await registry.adminCount()).to.equal(1n);
      await expect(registry.connect(stranger).revokeRole(ADMIN, stranger.address)).to.be.revertedWithCustomError(
        registry,
        "LastAdmin"
      );
    });

    it("won't invite someone who is already an admin, so the count can't double", async function () {
      const { registry, admin } = await loadFixture(deployFixture);
      await expect(registry.proposeAdmin(admin.address))
        .to.be.revertedWithCustomError(registry, "AlreadyRegistered")
        .withArgs(admin.address);
      expect(await registry.adminCount()).to.equal(1n);
    });
  });

  describe("v2: input limits", function () {
    const long = (n) => "x".repeat(n);

    it("rejects a participant name or licence over 64 bytes", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(registry.registerParticipant(stranger.address, long(65), "L-1", PHARMACY)).to.be.revertedWithCustomError(
        registry,
        "FieldTooLong"
      );
      await expect(registry.registerParticipant(stranger.address, "Apollo", long(65), PHARMACY)).to.be.revertedWithCustomError(
        registry,
        "FieldTooLong"
      );
    });

    it("accepts names exactly at the 64-byte limit", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await registry.registerParticipant(stranger.address, long(64), long(64), PHARMACY);
      expect(await registry.isRegistered(stranger.address)).to.equal(true);
    });

    it("rejects an over-long drug name, composition or CID", async function () {
      const { registry, mfg, now } = await loadFixture(deployFixture);
      const ok = [now - DAY, now + 30 * DAY, 1];
      await expect(registry.connect(mfg).registerBatch(long(65), "", ...ok, CID)).to.be.revertedWithCustomError(registry, "FieldTooLong");
      await expect(registry.connect(mfg).registerBatch("X", long(257), ...ok, CID)).to.be.revertedWithCustomError(registry, "FieldTooLong");
      await expect(registry.connect(mfg).registerBatch("X", "", ...ok, "b" + long(100))).to.be.revertedWithCustomError(
        registry,
        "FieldTooLong"
      );
    });

    it("rejects a certificate reference that isn't shaped like a CID", async function () {
      const { registry, mfg, now } = await loadFixture(deployFixture);
      for (const bad of ["https://example.com/cert.pdf", "Q", "QX123", "cert.pdf"]) {
        await expect(registry.connect(mfg).registerBatch("X", "", now - DAY, now + 30 * DAY, 1, bad)).to.be.revertedWithCustomError(
          registry,
          "InvalidCid"
        );
      }
    });

    it("accepts both CIDv0 (Qm...) and CIDv1 (b...) shapes", async function () {
      const { registry, mfg, now } = await loadFixture(deployFixture);
      await registry.connect(mfg).registerBatch("A", "", now - DAY, now + 30 * DAY, 1, "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
      await registry.connect(mfg).registerBatch("B", "", now - DAY, now + 30 * DAY, 1, CID);
      expect(await registry.batchCount()).to.equal(2n);
    });

    it("rejects a zero manufacture date", async function () {
      const { registry, mfg, now } = await loadFixture(deployFixture);
      await expect(registry.connect(mfg).registerBatch("X", "", 0, now + 30 * DAY, 1, CID)).to.be.revertedWithCustomError(
        registry,
        "InvalidDates"
      );
    });

    it("rejects a manufacture date in the future", async function () {
      const { registry, mfg, now } = await loadFixture(deployFixture);
      await expect(registry.connect(mfg).registerBatch("X", "", now + 10 * DAY, now + 30 * DAY, 1, CID))
        .to.be.revertedWithCustomError(registry, "InvalidDates")
        .withArgs(now + 10 * DAY, now + 30 * DAY);
    });
  });

  describe("v2: status transitions", function () {
    const ACTIVE = 0, RECALLED = 1, QUARANTINED = 2;

    it("a batch can be quarantined and released again", async function () {
      const { registry, inventory } = await loadFixture(withBatchFixture);
      await expect(registry.connect(inventory).setBatchStatus(1, QUARANTINED))
        .to.emit(registry, "BatchStatusChanged").withArgs(1, QUARANTINED);
      await registry.connect(inventory).setBatchStatus(1, ACTIVE);
      expect((await registry.getBatchDetails(1)).status).to.equal(ACTIVE);
    });

    it("a quarantined batch can be escalated to a recall", async function () {
      const { registry, inventory } = await loadFixture(withBatchFixture);
      await registry.connect(inventory).setBatchStatus(1, QUARANTINED);
      await registry.connect(inventory).setBatchStatus(1, RECALLED);
      expect((await registry.getBatchDetails(1)).status).to.equal(RECALLED);
    });

    it("a recall can never be undone", async function () {
      const { registry, inventory } = await loadFixture(withBatchFixture);
      await registry.connect(inventory).setBatchStatus(1, RECALLED);
      for (const to of [ACTIVE, QUARANTINED, RECALLED]) {
        await expect(registry.connect(inventory).setBatchStatus(1, to))
          .to.be.revertedWithCustomError(registry, "InvalidStatusTransition")
          .withArgs(RECALLED, to);
      }
    });

    it("setting the status a batch already has is refused", async function () {
      const { registry, inventory } = await loadFixture(withBatchFixture);
      await expect(registry.connect(inventory).setBatchStatus(1, ACTIVE))
        .to.be.revertedWithCustomError(registry, "InvalidStatusTransition")
        .withArgs(ACTIVE, ACTIVE);
    });
  });

  describe("v2: admin invitations", function () {
    it("nothing is granted until the invited account accepts", async function () {
      const { registry, admin, stranger } = await loadFixture(deployFixture);
      await expect(registry.proposeAdmin(stranger.address))
        .to.emit(registry, "AdminProposed").withArgs(stranger.address, admin.address);
      expect(await registry.isAdminProposed(stranger.address)).to.equal(true);
      expect(await registry.hasRole(ADMIN, stranger.address)).to.equal(false);

      await expect(registry.connect(stranger).acceptAdmin())
        .to.emit(registry, "RoleGranted").withArgs(ADMIN, stranger.address, stranger.address);
      expect(await registry.hasRole(ADMIN, stranger.address)).to.equal(true);
      expect(await registry.isAdminProposed(stranger.address)).to.equal(false);
      expect(await registry.adminCount()).to.equal(2n);
    });

    it("an account nobody invited can't accept", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(registry.connect(stranger).acceptAdmin())
        .to.be.revertedWithCustomError(registry, "NoAdminProposal").withArgs(stranger.address);
    });

    it("an invitation can be withdrawn before it's accepted", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      await registry.proposeAdmin(stranger.address);
      await expect(registry.cancelAdminProposal(stranger.address))
        .to.emit(registry, "AdminProposalCancelled").withArgs(stranger.address);
      await expect(registry.connect(stranger).acceptAdmin())
        .to.be.revertedWithCustomError(registry, "NoAdminProposal");
      await expect(registry.cancelAdminProposal(stranger.address))
        .to.be.revertedWithCustomError(registry, "NoAdminProposal");
    });

    it("only an admin can invite or withdraw, and never the zero address", async function () {
      const { registry, mfg, stranger } = await loadFixture(deployFixture);
      await expect(registry.connect(mfg).proposeAdmin(mfg.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await registry.proposeAdmin(stranger.address);
      await expect(registry.connect(mfg).cancelAdminProposal(stranger.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await expect(registry.proposeAdmin(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });
  });

  describe("v2: emergency pause", function () {
    async function withRegulator() {
      const f = await deployFixture();
      await f.registry.registerParticipant(f.stranger.address, "CDSCO", "REG-001", REGULATOR);
      return { ...f, reg: f.stranger };
    }

    it("an admin can pause, which stops new batches", async function () {
      const { registry, admin, mfg, now } = await loadFixture(deployFixture);
      await expect(registry.pause("Key compromise suspected"))
        .to.emit(registry, "SystemPaused").withArgs(admin.address, "Key compromise suspected");
      expect(await registry.paused()).to.equal(true);
      await expect(
        registry.connect(mfg).registerBatch("X", "Y", now - DAY, now + 365 * DAY, 10, CID)
      ).to.be.revertedWithCustomError(registry, "Paused");
    });

    it("a regulator can pause but only an admin can unpause", async function () {
      const { registry, admin, reg, mfg, now } = await loadFixture(withRegulator);
      await registry.connect(reg).pause("Counterfeits in circulation");
      await expect(registry.connect(reg).unpause())
        .to.be.revertedWithCustomError(registry, "NotAuthorisedToPause").withArgs(reg.address);
      await expect(registry.unpause()).to.emit(registry, "SystemUnpaused").withArgs(admin.address);
      expect(await registry.paused()).to.equal(false);
      await registry.connect(mfg).registerBatch("X", "Y", now - DAY, now + 365 * DAY, 10, CID);
    });

    it("nobody else can pause", async function () {
      const { registry, mfg } = await loadFixture(deployFixture);
      await expect(registry.connect(mfg).pause("x"))
        .to.be.revertedWithCustomError(registry, "NotAuthorisedToPause").withArgs(mfg.address);
    });

    it("refuses pausing twice or unpausing when running", async function () {
      const { registry } = await loadFixture(deployFixture);
      await expect(registry.unpause()).to.be.revertedWithCustomError(registry, "NotPaused");
      await registry.pause("x");
      await expect(registry.pause("x")).to.be.revertedWithCustomError(registry, "Paused");
    });

    it("participant management keeps working while paused, so a bad actor can be revoked", async function () {
      const { registry, mfg, stranger } = await loadFixture(deployFixture);
      await registry.pause("x");
      await registry.revokeParticipant(mfg.address);
      await registry.registerParticipant(stranger.address, "New Pharma", "PH-9", PHARMACY);
      expect(await registry.isRegistered(mfg.address)).to.equal(false);
    });
  });
});
