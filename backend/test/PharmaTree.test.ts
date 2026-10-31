import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployPharmaTreeFixture,
  UnitLevel,
  Status,
} from "./fixtures/pharmaTreeFixture";

describe("PharmaTree Smart Contract", function () {
  let pharmaTree: any;
  let admin: any;
  let manufacturer: any;
  let distributor: any;
  let pharmacy: any;
  let unauthorized: any;

  beforeEach(async function () {
    const fixture = await loadFixture(deployPharmaTreeFixture);
    pharmaTree = fixture.pharmaTree;
    admin = fixture.admin;
    manufacturer = fixture.manufacturer;
    distributor = fixture.distributor;
    pharmacy = fixture.pharmacy;
    unauthorized = fixture.unauthorized;
  });

  describe("Admin & Role Authorization", function () {
    it("Should properly assign admin on deployment", async function () {
      expect(await pharmaTree.admin()).to.equal(admin.address);
    });

    it("Should allow admin to add manufacturers and handlers", async function () {
      expect(await pharmaTree.isManufacturer(manufacturer.address)).to.be.true;
      expect(await pharmaTree.isHandler(distributor.address)).to.be.true;
    });

    it("Should prevent non-admins from adding roles", async function () {
      await expect(
        pharmaTree.connect(unauthorized).addManufacturer(unauthorized.address)
      ).to.be.revertedWith("Not admin");

      await expect(
        pharmaTree.connect(unauthorized).addHandler(unauthorized.address)
      ).to.be.revertedWith("Not admin");
    });
  });

  describe("Hierarchical Creation", function () {
    it("Should allow an authorized manufacturer to create a root unit", async function () {
      const tx = await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Container,
      "IPFS_CID_CONTAINER_METADATA",
      1
      );

      await expect(tx)
        .to.emit(pharmaTree, "UnitCreated")
        .withArgs(1, 0, UnitLevel.Container, manufacturer.address);

      const unit = await pharmaTree.getUnitDetails(1);
      expect(unit.parentId).to.equal(0);
      expect(unit.level).to.equal(UnitLevel.Container);
      expect(unit.manufacturer).to.equal(manufacturer.address);
      expect(unit.currentOwner).to.equal(manufacturer.address);
      expect(unit.status).to.equal(Status.Active);
    });

    it("Should prevent unauthorized users from creating root units", async function () {
      await expect(
        pharmaTree.connect(unauthorized).createRootUnit(UnitLevel.Container, "Meta", 1)
      ).to.be.revertedWith("Only manufacturers can create root units");
    });

    it("Should preserve the sender remainder when transferring a partial quantity", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(UnitLevel.Batch, "Paracetamol", 100);

      await pharmaTree.connect(manufacturer).initiatePartialTransfer(1, distributor.address, 40);

      const source = await pharmaTree.getUnitDetails(1);
      const split = await pharmaTree.getUnitDetails(2);
      expect(source.quantity).to.equal(60);
      expect(source.status).to.equal(Status.Active);
      expect(split.quantity).to.equal(40);
      expect(split.parentId).to.equal(1);
      expect(split.rootId).to.equal(1);
      expect(split.status).to.equal(Status.PendingTransfer);

      await pharmaTree.connect(distributor).acceptTransfer(2);
      const received = await pharmaTree.getUnitDetails(2);
      expect(received.currentOwner).to.equal(distributor.address);
      expect(received.quantity).to.equal(40);
      expect(received.status).to.equal(Status.Active);
      expect(source.metadata).to.equal("Paracetamol, 60 tablets");
      expect(split.metadata).to.equal("Paracetamol, 40 tablets");
    });

    it("Should allow packing child units under a parent unit", async function () {
      // 1. Create Parent Container (ID 1)
      await pharmaTree.connect(manufacturer).createRootUnit(UnitLevel.Container, "Container-01", 1);

      // 2. Pack 5 Boxes (Child units) under Parent ID 1
      await pharmaTree.connect(manufacturer).createChildUnits(
        1,
        UnitLevel.Box,
        "Box-Metadata",
        5
      );

      expect(await pharmaTree.unitCounter()).to.equal(6); // 1 Parent + 5 Children

      const childUnit = await pharmaTree.getUnitDetails(2);
      expect(childUnit.parentId).to.equal(1);
      expect(childUnit.level).to.equal(UnitLevel.Box);
      expect(childUnit.manufacturer).to.equal(manufacturer.address);
      expect(childUnit.currentOwner).to.equal(manufacturer.address);
    });

    it("Should prevent non-owners from packing children under a parent", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(UnitLevel.Container, "Container-01", 1);

      await expect(
        pharmaTree.connect(unauthorized).createChildUnits(1, UnitLevel.Box, "Meta", 2)
      ).to.be.revertedWith("Must own the parent to pack children");
    });

    it("Should prevent packing children at an inverted or equal hierarchy level", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(UnitLevel.Box, "Box-01", 1);

      await expect(
        pharmaTree.connect(manufacturer).createChildUnits(1, UnitLevel.Container, "Container-Meta", 1)
      ).to.be.revertedWith("Child level must be strictly lower in hierarchy");
    });

    it("Should revert if packing child count exceeds batch limit", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(UnitLevel.Container, "Container-01", 1);

      await expect(
        pharmaTree.connect(manufacturer).createChildUnits(1, UnitLevel.Box, "Box-Meta", 251)
      ).to.be.revertedWith("Batch count exceeds limit");
    });
  });

  describe("Two-Party Transfer Handshake", function () {
    beforeEach(async function () {
      // Setup: Create a root unit (ID 1)
      await pharmaTree.connect(manufacturer).createRootUnit(UnitLevel.Container, "Batch-001", 1);
    });

    it("Should successfully initiate and accept a transfer", async function () {
      // Step A: Initiate transfer from Manufacturer -> Distributor
      await expect(pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address))
        .to.emit(pharmaTree, "TransferInitiated")
        .withArgs(1, manufacturer.address, distributor.address);

      let unit = await pharmaTree.getUnitDetails(1);
      expect(unit.status).to.equal(Status.PendingTransfer);
      expect(unit.pendingReceiver).to.equal(distributor.address);

      // Step B: Distributor accepts transfer
      await expect(pharmaTree.connect(distributor).acceptTransfer(1))
        .to.emit(pharmaTree, "TransferCompleted")
        .withArgs(1, manufacturer.address, distributor.address);

      unit = await pharmaTree.getUnitDetails(1);
      expect(unit.currentOwner).to.equal(distributor.address);
      expect(unit.pendingReceiver).to.equal(ethers.ZeroAddress);
      expect(unit.status).to.equal(Status.Active);
    });

    it("Should prevent non-owners from initiating a transfer", async function () {
      await expect(
        pharmaTree.connect(unauthorized).initiateTransfer(1, distributor.address)
      ).to.be.revertedWith("Not the current owner");
    });

    it("Should prevent transfers to unauthorized receivers", async function () {
      await expect(
        pharmaTree.connect(manufacturer).initiateTransfer(1, unauthorized.address)
      ).to.be.revertedWith("Receiver is not authorized");
    });

    it("Should prevent wrong accounts from accepting a transfer", async function () {
      await pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address);

      await expect(
        pharmaTree.connect(pharmacy).acceptTransfer(1)
      ).to.be.revertedWith("You are not the pending receiver");
    });

    it("Should allow the pending receiver to reject a compromised transfer", async function () {
      await pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address);

      await expect(pharmaTree.connect(distributor).rejectTransfer(1))
        .to.emit(pharmaTree, "TransferRejected")
        .withArgs(1, manufacturer.address, distributor.address);

      const unit = await pharmaTree.getUnitDetails(1);
      expect(unit.status).to.equal(Status.Rejected);
      expect(unit.pendingReceiver).to.equal(ethers.ZeroAddress);
    });

    it("Should allow the owner to cancel a pending transfer", async function () {
      await pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address);
      await expect(pharmaTree.connect(manufacturer).cancelTransfer(1))
        .to.emit(pharmaTree, "TransferCancelled")
        .withArgs(1, manufacturer.address);

      const unit = await pharmaTree.getUnitDetails(1);
      expect(unit.status).to.equal(Status.Active);
      expect(unit.pendingReceiver).to.equal(ethers.ZeroAddress);
    });

    it("Should allow authorized QA to clear a rejected unit with evidence hash and prevent unprivileged sender", async function () {
      await pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address);
      await pharmaTree.connect(distributor).rejectTransfer(1);

      // Sender (non-QA) cannot clear rejected
      const dummyHash = ethers.keccak256(ethers.toUtf8Bytes("QA-INSPECTION-PASS-DOC-42"));
      await expect(
        pharmaTree.connect(manufacturer).clearRejected(1, dummyHash)
      ).to.be.revertedWith("Caller is not authorized QA");

      // Authorized QA clears rejected
      await expect(pharmaTree.connect(admin).clearRejected(1, dummyHash))
        .to.emit(pharmaTree, "RejectedCleared")
        .withArgs(1, admin.address, dummyHash);

      const unit = await pharmaTree.getUnitDetails(1);
      expect(unit.status).to.equal(Status.Active);
    });
  });

  describe("Final Sale & Inventory Detachment", function () {
    beforeEach(async function () {
      // Manufacturer -> Distributor -> Pharmacy -> Sold
      await pharmaTree.connect(manufacturer).createRootUnit(UnitLevel.IndividualItem, "Pill-01", 1);
      await pharmaTree.connect(manufacturer).initiateTransfer(1, pharmacy.address);
      await pharmaTree.connect(pharmacy).acceptTransfer(1);
    });

    it("Should allow the current owner to mark an item as sold", async function () {
      await expect(pharmaTree.connect(pharmacy).markAsSold(1))
        .to.emit(pharmaTree, "UnitSold")
        .withArgs(1, pharmacy.address);

      const unit = await pharmaTree.getUnitDetails(1);
      expect(unit.status).to.equal(Status.Sold);
    });

    it("Should prevent initiating a transfer on a sold unit", async function () {
      await pharmaTree.connect(pharmacy).markAsSold(1);

      await expect(
        pharmaTree.connect(pharmacy).initiateTransfer(1, distributor.address)
      ).to.be.revertedWith("Unit not active");
    });
  });

  describe("Partial Sales (sellQuantity) & Dynamic Metadata", function () {
    beforeEach(async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Batch,
        "Ibuprofen 400mg, 100 tablets",
        100
      );
    });

    it("Should allow the owner to sell a partial quantity and split inventory", async function () {
      await expect(pharmaTree.connect(manufacturer).sellQuantity(1, 30))
        .to.emit(pharmaTree, "UnitSold")
        .withArgs(2, manufacturer.address);

      const parentUnit = await pharmaTree.getUnitDetails(1);
      const soldUnit = await pharmaTree.getUnitDetails(2);

      expect(parentUnit.quantity).to.equal(70);
      expect(parentUnit.status).to.equal(Status.Active);
      expect(parentUnit.metadata).to.equal("Ibuprofen 400mg, 70 tablets");

      expect(soldUnit.quantity).to.equal(30);
      expect(soldUnit.status).to.equal(Status.Sold);
      expect(soldUnit.parentId).to.equal(1);
      expect(soldUnit.rootId).to.equal(1);
      expect(soldUnit.metadata).to.equal("Ibuprofen 400mg, 30 tablets");
    });

    it("Should mark the entire unit as sold if selling the full available quantity", async function () {
      await expect(pharmaTree.connect(manufacturer).sellQuantity(1, 100))
        .to.emit(pharmaTree, "UnitSold")
        .withArgs(1, manufacturer.address);

      const unit = await pharmaTree.getUnitDetails(1);
      expect(unit.quantity).to.equal(100);
      expect(unit.status).to.equal(Status.Sold);
    });

    it("Should revert if selling 0 quantity", async function () {
      await expect(
        pharmaTree.connect(manufacturer).sellQuantity(1, 0)
      ).to.be.revertedWith("Invalid sale quantity");
    });

    it("Should revert if selling more than available quantity", async function () {
      await expect(
        pharmaTree.connect(manufacturer).sellQuantity(1, 101)
      ).to.be.revertedWith("Invalid sale quantity");
    });

    it("Should prevent non-owners from selling units", async function () {
      await expect(
        pharmaTree.connect(unauthorized).sellQuantity(1, 20)
      ).to.be.revertedWith("Not the current owner");
    });

    it("Should prevent selling an already sold unit", async function () {
      await pharmaTree.connect(manufacturer).sellQuantity(1, 100);

      await expect(
        pharmaTree.connect(manufacturer).sellQuantity(1, 1)
      ).to.be.revertedWith("Unit is not active");
    });
  });

  describe("Security Hardening: RBAC, Revocation, Expiry & Recalls", function () {
    it("Should prevent a Handler without Dispenser role from selling", async function () {
      // Distributor has HANDLER_ROLE but NOT DISPENSER_ROLE
      await pharmaTree.connect(manufacturer).createRootUnit(UnitLevel.IndividualItem, "Item 1", 1);
      await pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address);
      await pharmaTree.connect(distributor).acceptTransfer(1);

      await expect(
        pharmaTree.connect(distributor).markAsSold(1)
      ).to.be.revertedWith("Caller is not an authorized dispenser");

      await expect(
        pharmaTree.connect(distributor).sellQuantity(1, 1)
      ).to.be.revertedWith("Caller is not an authorized dispenser");
    });

    it("Should allow admin to revoke roles and cut off compromised actors", async function () {
      // Revoke handler
      await pharmaTree.connect(admin).removeHandler(distributor.address);
      expect(await pharmaTree.isHandler(distributor.address)).to.be.false;

      await pharmaTree.connect(manufacturer).createRootUnit(UnitLevel.IndividualItem, "Item 2", 1);
      await expect(
        pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address)
      ).to.be.revertedWith("Receiver is not authorized");

      // Revoke dispenser
      await pharmaTree.connect(admin).removeDispenser(pharmacy.address);
      expect(await pharmaTree.isDispenser(pharmacy.address)).to.be.false;
      await pharmaTree.connect(manufacturer).initiateTransfer(1, pharmacy.address);
      await pharmaTree.connect(pharmacy).acceptTransfer(1);

      await expect(
        pharmaTree.connect(pharmacy).markAsSold(1)
      ).to.be.revertedWith("Caller is not an authorized dispenser");

      // Revoke QA
      await pharmaTree.connect(admin).removeQA(admin.address);
      expect(await pharmaTree.isQA(admin.address)).to.be.false;
      const dummyHash = ethers.keccak256(ethers.toUtf8Bytes("EVIDENCE-HASH"));
      // Even if admin, admin modifier check in onlyQA checks role
      // But onlyQA checks hasRole(QA_ROLE) || hasRole(DEFAULT_ADMIN_ROLE).
      // Let's create an explicit QA account
      const [, , , , , , qaUser] = await ethers.getSigners();
      await pharmaTree.connect(admin).addQA(qaUser.address);
      expect(await pharmaTree.isQA(qaUser.address)).to.be.true;
      await pharmaTree.connect(admin).removeQA(qaUser.address);
      expect(await pharmaTree.isQA(qaUser.address)).to.be.false;
      await expect(
        pharmaTree.connect(qaUser).clearRejected(1, dummyHash)
      ).to.be.revertedWith("Caller is not authorized QA");
    });

    it("Should verify serial numbers against stored serialHash and prevent cloned QR codes", async function () {
      const serial = "SN-2026-XYZ-998877";
      const pastExpiry = 0;

      // Revert on empty serial for new mints
      await expect(
        pharmaTree.connect(manufacturer).createRootUnitWithSerial(
          UnitLevel.Box,
          "Box with Empty Serial",
          10,
          "",
          0
        )
      ).to.be.revertedWith("Serial number required for new mints");

      await pharmaTree.connect(manufacturer).createRootUnitWithSerial(
        UnitLevel.Box,
        "Box with Secure Serial",
        10,
        serial,
        pastExpiry
      );

      const unit = await pharmaTree.getUnitDetails(1);
      const expectedHash = ethers.keccak256(ethers.toUtf8Bytes(serial));
      expect(unit.serialHash).to.equal(expectedHash);

      // Verification check on-chain
      expect(await pharmaTree.verifySerial(1, serial)).to.be.true;
      expect(await pharmaTree.verifySerial(1, "WRONG-SERIAL-FORGED")).to.be.false;
    });

    it("Should prevent selling an expired unit", async function () {
      const now = Math.floor(Date.now() / 1000);
      const expiredTimestamp = now - 3600; // expired 1 hour ago
      await pharmaTree.connect(manufacturer).createRootUnitWithSerial(
        UnitLevel.IndividualItem,
        "Expired Ampoule",
        1,
        "SN-EXPIRED-01",
        expiredTimestamp
      );

      await expect(
        pharmaTree.connect(manufacturer).sellQuantity(1, 1)
      ).to.be.revertedWith("Unit is expired");

      await expect(
        pharmaTree.connect(manufacturer).markAsSold(1)
      ).to.be.revertedWith("Unit is expired");
    });

    it("Should enforce recall freeze and prevent dispensing recalled roots", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Batch,
        "Batch Under Investigation",
        50
      );

      // Recall root
      await expect(pharmaTree.connect(manufacturer).recallRoot(1))
        .to.emit(pharmaTree, "RootRecalled")
        .withArgs(1, manufacturer.address);

      expect(await pharmaTree.recalledRoots(1)).to.be.true;

      // Sale must revert
      await expect(
        pharmaTree.connect(manufacturer).sellQuantity(1, 10)
      ).to.be.revertedWith("Batch is recalled");

      await expect(
        pharmaTree.connect(manufacturer).markAsSold(1)
      ).to.be.revertedWith("Batch is recalled");

      // Non-privileged cannot unrecall
      await expect(
        pharmaTree.connect(unauthorized).unrecallRoot(1)
      ).to.be.revertedWith("Not authorized to unrecall");

      // Authorized manufacturer unrecalls after investigation
      await expect(pharmaTree.connect(manufacturer).unrecallRoot(1))
        .to.emit(pharmaTree, "RootUnrecalled")
        .withArgs(1, manufacturer.address);

      expect(await pharmaTree.recalledRoots(1)).to.be.false;

      // Sale succeeds once un-recalled
      await expect(pharmaTree.connect(manufacturer).sellQuantity(1, 10))
        .to.emit(pharmaTree, "UnitSold");
    });
  });
});