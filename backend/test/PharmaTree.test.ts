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

    it("Should allow the owner to reclaim a rejected unit", async function () {
      await pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address);
      await pharmaTree.connect(distributor).rejectTransfer(1);

      await expect(pharmaTree.connect(manufacturer).reclaimRejectedUnit(1))
        .to.emit(pharmaTree, "UnitReclaimed")
        .withArgs(1, manufacturer.address);

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
});