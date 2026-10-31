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

  const defaultExpiry = Math.floor(Date.now() / 1000) + 730 * 86400; // 2 years future
  let serialCounter = 1;

  function nextSerialHash(prefix = "TEST-SN"): string {
    return ethers.keccak256(ethers.toUtf8Bytes(`${prefix}-${serialCounter++}-${Date.now()}`));
  }

  function getSerialHashes(count: number, prefix = "CHILD-SN"): string[] {
    const hashes: string[] = [];
    for (let i = 0; i < count; i++) {
      hashes.push(nextSerialHash(prefix));
    }
    return hashes;
  }

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
    it("Should allow an authorized manufacturer to create a root unit with serialHash and expiry", async function () {
      const sHash = nextSerialHash("CONTAINER");
      const tx = await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Container,
        "IPFS_CID_CONTAINER_METADATA",
        1,
        sHash,
        defaultExpiry
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
      expect(unit.serialHash).to.equal(sHash);
      expect(unit.expiry).to.equal(defaultExpiry);
    });

    it("Should prevent unauthorized users from creating root units", async function () {
      await expect(
        pharmaTree.connect(unauthorized).createRootUnit(
          UnitLevel.Container,
          "Meta",
          1,
          nextSerialHash(),
          defaultExpiry
        )
      ).to.be.revertedWith("Only manufacturers can create root units");
    });

    it("Should revert on zero serial hash", async function () {
      await expect(
        pharmaTree.connect(manufacturer).createRootUnit(
          UnitLevel.Container,
          "Meta",
          1,
          ethers.ZeroHash,
          defaultExpiry
        )
      ).to.be.revertedWith("Serial hash required");
    });

    it("Should revert on past or current expiry", async function () {
      const pastExpiry = Math.floor(Date.now() / 1000) - 100;
      await expect(
        pharmaTree.connect(manufacturer).createRootUnit(
          UnitLevel.Container,
          "Meta",
          1,
          nextSerialHash(),
          pastExpiry
        )
      ).to.be.revertedWith("Expiry must be in the future");
    });

    it("Should revert on duplicate serial hash", async function () {
      const sHash = nextSerialHash("DUP");
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Container,
        "Meta 1",
        1,
        sHash,
        defaultExpiry
      );

      await expect(
        pharmaTree.connect(manufacturer).createRootUnit(
          UnitLevel.Container,
          "Meta 2",
          1,
          sHash,
          defaultExpiry
        )
      ).to.be.revertedWith("Serial hash already used");
    });

    it("Should preserve the sender remainder when transferring a partial quantity", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Batch,
        "Paracetamol",
        100,
        nextSerialHash(),
        defaultExpiry
      );

      await pharmaTree.connect(manufacturer).initiatePartialTransfer(1, distributor.address, 40);

      const source = await pharmaTree.getUnitDetails(1);
      const split = await pharmaTree.getUnitDetails(2);
      expect(source.quantity).to.equal(60);
      expect(source.status).to.equal(Status.Active);
      expect(split.quantity).to.equal(40);
      expect(split.parentId).to.equal(1);
      expect(split.rootId).to.equal(1);
      expect(split.status).to.equal(Status.PendingTransfer);
      expect(split.expiry).to.equal(source.expiry); // Inherits expiry

      await pharmaTree.connect(distributor).acceptTransfer(2);
      const received = await pharmaTree.getUnitDetails(2);
      expect(received.currentOwner).to.equal(distributor.address);
      expect(received.quantity).to.equal(40);
      expect(received.status).to.equal(Status.Active);
      expect(source.metadata).to.equal("Paracetamol, 60 tablets");
      expect(split.metadata).to.equal("Paracetamol, 40 tablets");
    });

    it("Should allow packing child units under a parent unit with child serial hashes and inherited expiry", async function () {
      // 1. Create Parent Container (ID 1)
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Container,
        "Container-01",
        1,
        nextSerialHash(),
        defaultExpiry
      );

      // 2. Pack 5 Boxes (Child units) under Parent ID 1
      const childHashes = getSerialHashes(5, "BOX");
      await pharmaTree.connect(manufacturer).createChildUnitsBatch(
        1,
        UnitLevel.Box,
        "Box-Metadata",
        childHashes
      );

      expect(await pharmaTree.unitCounter()).to.equal(6); // 1 Parent + 5 Children

      const childUnit = await pharmaTree.getUnitDetails(2);
      expect(childUnit.parentId).to.equal(1);
      expect(childUnit.level).to.equal(UnitLevel.Box);
      expect(childUnit.manufacturer).to.equal(manufacturer.address);
      expect(childUnit.currentOwner).to.equal(manufacturer.address);
      expect(childUnit.serialHash).to.equal(childHashes[0]);
      expect(childUnit.expiry).to.equal(defaultExpiry); // Strictly inherited from parent
    });

    it("Should prevent non-owners from packing children under a parent", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Container,
        "Container-01",
        1,
        nextSerialHash(),
        defaultExpiry
      );

      const hashes = getSerialHashes(2);
      await expect(
        pharmaTree.connect(unauthorized).createChildUnitsBatch(1, UnitLevel.Box, "Meta", hashes)
      ).to.be.revertedWith("Must own the parent to pack children");
    });

    it("Should prevent packing children at an inverted or equal hierarchy level", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Box,
        "Box-01",
        1,
        nextSerialHash(),
        defaultExpiry
      );

      const hashes = getSerialHashes(1);
      await expect(
        pharmaTree.connect(manufacturer).createChildUnitsBatch(1, UnitLevel.Container, "Container-Meta", hashes)
      ).to.be.revertedWith("Child level must be strictly lower in hierarchy");
    });

    it("Should revert if packing child count exceeds batch limit (>100) or is 0", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Container,
        "Container-01",
        1,
        nextSerialHash(),
        defaultExpiry
      );

      // 0 count
      await expect(
        pharmaTree.connect(manufacturer).createChildUnitsBatch(1, UnitLevel.Box, "Box-Meta", [])
      ).to.be.revertedWith("Batch count must be between 1 and 100");

      // 101 count
      const tooManyHashes = getSerialHashes(101);
      await expect(
        pharmaTree.connect(manufacturer).createChildUnitsBatch(1, UnitLevel.Box, "Box-Meta", tooManyHashes)
      ).to.be.revertedWith("Batch count must be between 1 and 100");
    });
  });

  describe("Two-Party Transfer Handshake", function () {
    beforeEach(async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Container,
        "Batch-001",
        1,
        nextSerialHash(),
        defaultExpiry
      );
    });

    it("Should successfully initiate and accept a transfer", async function () {
      await expect(pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address))
        .to.emit(pharmaTree, "TransferInitiated")
        .withArgs(1, manufacturer.address, distributor.address);

      let unit = await pharmaTree.getUnitDetails(1);
      expect(unit.status).to.equal(Status.PendingTransfer);
      expect(unit.pendingReceiver).to.equal(distributor.address);

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

      const dummyHash = ethers.keccak256(ethers.toUtf8Bytes("QA-INSPECTION-PASS-DOC-42"));
      await expect(
        pharmaTree.connect(manufacturer).clearRejected(1, dummyHash)
      ).to.be.revertedWith("Caller is not authorized QA");

      await expect(pharmaTree.connect(admin).clearRejected(1, dummyHash))
        .to.emit(pharmaTree, "RejectedCleared")
        .withArgs(1, admin.address, dummyHash);

      const unit = await pharmaTree.getUnitDetails(1);
      expect(unit.status).to.equal(Status.Active);
    });
  });

  describe("Final Sale & Inventory Detachment", function () {
    beforeEach(async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.IndividualItem,
        "Pill-01",
        1,
        nextSerialHash(),
        defaultExpiry
      );
      await pharmaTree.connect(manufacturer).initiateTransfer(1, pharmacy.address);
      await pharmaTree.connect(pharmacy).acceptTransfer(1);
    });

    it("Should allow authorized dispenser to mark an item as sold", async function () {
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

  describe("Partial Sales (sellQuantityWithSerialHash) & Dynamic Metadata", function () {
    beforeEach(async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Batch,
        "Ibuprofen 400mg, 100 tablets",
        100,
        nextSerialHash(),
        defaultExpiry
      );
    });

    it("Should allow the owner to sell a partial quantity and split inventory with unique child serial hash", async function () {
      const childHash = nextSerialHash("CHILD-DISPENSED");
      await expect(pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(1, 30, childHash))
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
      expect(soldUnit.serialHash).to.equal(childHash);
      expect(soldUnit.expiry).to.equal(parentUnit.expiry);
      expect(soldUnit.metadata).to.equal("Ibuprofen 400mg, 30 tablets");
    });

    it("Should revert if child serial hash is zero for partial sale", async function () {
      await expect(
        pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(1, 30, ethers.ZeroHash)
      ).to.be.revertedWith("Child serial hash required for partial dispensing");
    });

    it("Should revert if child serial hash was already used", async function () {
      const dupHash = nextSerialHash("DUP-CHILD");
      await pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(1, 20, dupHash);

      await expect(
        pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(1, 20, dupHash)
      ).to.be.revertedWith("Child serial hash already used");
    });

    it("Should mark the entire unit as sold if selling the full available quantity", async function () {
      await expect(pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(1, 100, ethers.ZeroHash))
        .to.emit(pharmaTree, "UnitSold")
        .withArgs(1, manufacturer.address);

      const unit = await pharmaTree.getUnitDetails(1);
      expect(unit.quantity).to.equal(100);
      expect(unit.status).to.equal(Status.Sold);
    });

    it("Should revert if selling 0 quantity", async function () {
      await expect(
        pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(1, 0, ethers.ZeroHash)
      ).to.be.revertedWith("Invalid sale quantity");
    });

    it("Should revert if selling more than available quantity", async function () {
      await expect(
        pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(1, 101, ethers.ZeroHash)
      ).to.be.revertedWith("Invalid sale quantity");
    });

    it("Should prevent non-owners from selling units", async function () {
      await expect(
        pharmaTree.connect(unauthorized).sellQuantityWithSerialHash(1, 20, nextSerialHash())
      ).to.be.revertedWith("Not the current owner");
    });

    it("Should prevent selling an already sold unit", async function () {
      await pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(1, 100, ethers.ZeroHash);

      await expect(
        pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(1, 1, nextSerialHash())
      ).to.be.revertedWith("Unit is not active");
    });
  });

  describe("Security Hardening: RBAC, Revocation, Expiry & Recalls", function () {
    it("Should prevent a Handler without Dispenser role from selling", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.IndividualItem,
        "Item 1",
        1,
        nextSerialHash(),
        defaultExpiry
      );
      await pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address);
      await pharmaTree.connect(distributor).acceptTransfer(1);

      await expect(
        pharmaTree.connect(distributor).markAsSold(1)
      ).to.be.revertedWith("Caller is not an authorized dispenser");

      await expect(
        pharmaTree.connect(distributor).sellQuantityWithSerialHash(1, 1, ethers.ZeroHash)
      ).to.be.revertedWith("Caller is not an authorized dispenser");
    });

    it("Should allow admin to revoke roles and cut off compromised actors", async function () {
      await pharmaTree.connect(admin).removeHandler(distributor.address);
      expect(await pharmaTree.isHandler(distributor.address)).to.be.false;

      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.IndividualItem,
        "Item 2",
        1,
        nextSerialHash(),
        defaultExpiry
      );
      await expect(
        pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address)
      ).to.be.revertedWith("Receiver is not authorized");

      await pharmaTree.connect(admin).removeDispenser(pharmacy.address);
      expect(await pharmaTree.isDispenser(pharmacy.address)).to.be.false;
      await pharmaTree.connect(manufacturer).initiateTransfer(1, pharmacy.address);
      await pharmaTree.connect(pharmacy).acceptTransfer(1);

      await expect(
        pharmaTree.connect(pharmacy).markAsSold(1)
      ).to.be.revertedWith("Caller is not an authorized dispenser");

      const [, , , , , , qaUser] = await ethers.getSigners();
      await pharmaTree.connect(admin).addQA(qaUser.address);
      expect(await pharmaTree.isQA(qaUser.address)).to.be.true;
      await pharmaTree.connect(admin).removeQA(qaUser.address);
      expect(await pharmaTree.isQA(qaUser.address)).to.be.false;

      const dummyHash = ethers.keccak256(ethers.toUtf8Bytes("EVIDENCE-HASH"));
      await expect(
        pharmaTree.connect(qaUser).clearRejected(1, dummyHash)
      ).to.be.revertedWith("Caller is not authorized QA");
    });

    it("Should verify serial numbers against stored serialHash and prevent cloned QR codes", async function () {
      const rawSerial = "SN-2026-XYZ-998877";
      const sHash = ethers.keccak256(ethers.toUtf8Bytes(rawSerial));

      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Box,
        "Box with Secure Serial",
        10,
        sHash,
        defaultExpiry
      );

      const unit = await pharmaTree.getUnitDetails(1);
      expect(unit.serialHash).to.equal(sHash);

      expect(await pharmaTree.verifySerial(1, rawSerial)).to.be.true;
      expect(await pharmaTree.verifySerial(1, "WRONG-SERIAL-FORGED")).to.be.false;
    });

    it("Should enforce recall freeze and prevent dispensing recalled roots", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Batch,
        "Batch Under Investigation",
        50,
        nextSerialHash(),
        defaultExpiry
      );

      // Recall root
      await expect(pharmaTree.connect(manufacturer).recallRoot(1))
        .to.emit(pharmaTree, "RootRecalled")
        .withArgs(1, manufacturer.address);

      expect(await pharmaTree.recalledRoots(1)).to.be.true;

      // Sale must revert
      await expect(
        pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(1, 10, nextSerialHash())
      ).to.be.revertedWith("Batch is recalled");

      await expect(
        pharmaTree.connect(manufacturer).markAsSold(1)
      ).to.be.revertedWith("Batch is recalled");

      // Non-privileged cannot unrecall
      await expect(
        pharmaTree.connect(unauthorized).unrecallRoot(1)
      ).to.be.revertedWith("Not authorized to unrecall this batch");

      // Authorized manufacturer unrecalls after investigation
      await expect(pharmaTree.connect(manufacturer).unrecallRoot(1))
        .to.emit(pharmaTree, "RootUnrecalled")
        .withArgs(1, manufacturer.address);

      expect(await pharmaTree.recalledRoots(1)).to.be.false;

      // Sale succeeds once un-recalled
      await expect(pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(1, 10, nextSerialHash()))
        .to.emit(pharmaTree, "UnitSold");
    });

    it("Should restrict recall and unrecall strictly to root manufacturer, QA, or admin", async function () {
      const [, , , otherMfr] = await ethers.getSigners();
      await pharmaTree.connect(admin).addManufacturer(otherMfr.address);

      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Batch,
        "Root Batch Mfr 1",
        20,
        nextSerialHash(),
        defaultExpiry
      );

      // Other manufacturer cannot recall root #1
      await expect(
        pharmaTree.connect(otherMfr).recallRoot(1)
      ).to.be.revertedWith("Not authorized to recall this batch");

      // Original root manufacturer can recall
      await expect(pharmaTree.connect(manufacturer).recallRoot(1)).to.emit(pharmaTree, "RootRecalled");

      // QA can unrecall
      await expect(pharmaTree.connect(admin).unrecallRoot(1)).to.emit(pharmaTree, "RootUnrecalled");
    });

    it("Should permit returns only to root manufacturer or QA during recall and block downstream transfers", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Batch,
        "Recalled Batch Returns Test",
        30,
        nextSerialHash(),
        defaultExpiry
      );

      // Transfer to distributor before recall
      await pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address);
      await pharmaTree.connect(distributor).acceptTransfer(1);

      // Manufacturer recalls root
      await pharmaTree.connect(manufacturer).recallRoot(1);

      // Distributor tries to transfer downstream to pharmacy -> reverts
      await expect(
        pharmaTree.connect(distributor).initiateTransfer(1, pharmacy.address)
      ).to.be.revertedWith("Recalled units can only be returned to manufacturer or QA");

      // Distributor returns upstream to original manufacturer -> succeeds
      await expect(
        pharmaTree.connect(distributor).initiateTransfer(1, manufacturer.address)
      ).to.emit(pharmaTree, "TransferInitiated").withArgs(1, distributor.address, manufacturer.address);

      await pharmaTree.connect(manufacturer).acceptTransfer(1);
      const returnedUnit = await pharmaTree.getUnitDetails(1);
      expect(returnedUnit.currentOwner).to.equal(manufacturer.address);
    });

    it("Should prevent selling an expired unit", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const currentBlockTime = latestBlock ? latestBlock.timestamp : Math.floor(Date.now() / 1000);
      const quickExpiry = currentBlockTime + 100;

      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.IndividualItem,
        "Fast-Expiring Unit",
        1,
        nextSerialHash(),
        quickExpiry
      );

      // Warp time past expiry
      await ethers.provider.send("evm_increaseTime", [200]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        pharmaTree.connect(manufacturer).markAsSold(1)
      ).to.be.revertedWith("Unit is expired");

      await expect(
        pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(1, 1, ethers.ZeroHash)
      ).to.be.revertedWith("Unit is expired");
    });

    it("Should verify that legacy deleted functions no longer exist on contract", async function () {
      expect((pharmaTree as any).createChildUnits).to.be.undefined;
      expect((pharmaTree as any).sellQuantity).to.be.undefined;
    });

    it("Should correctly handle reassignCustody when owner is revoked", async function () {
      await pharmaTree.connect(manufacturer).createRootUnit(
        UnitLevel.Batch,
        "Custody Reassignment Batch",
        40,
        nextSerialHash(),
        defaultExpiry
      );

      await pharmaTree.connect(manufacturer).initiateTransfer(1, distributor.address);
      await pharmaTree.connect(distributor).acceptTransfer(1);

      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("COMPROMISED_CREDENTIALS_RECOVERY"));

      // 1. Revert if current owner has not been revoked
      await expect(
        pharmaTree.connect(admin).reassignCustody(1, pharmacy.address, reasonHash)
      ).to.be.revertedWith("Current owner has not been revoked");

      // 2. Revoke distributor
      await pharmaTree.connect(admin).removeHandler(distributor.address);

      // 3. Revert if caller is not admin or QA
      await expect(
        pharmaTree.connect(unauthorized).reassignCustody(1, pharmacy.address, reasonHash)
      ).to.be.revertedWith("Only Admin or QA can reassign");

      // 4. Revert if unit is sold
      // (Test sold guard separately or on sold unit)

      // 5. Successful reassignment by Admin
      await expect(
        pharmaTree.connect(admin).reassignCustody(1, pharmacy.address, reasonHash)
      )
        .to.emit(pharmaTree, "CustodyReassignmentInitiated")
        .withArgs(1, distributor.address, pharmacy.address, reasonHash);

      const pendingUnit = await pharmaTree.getUnitDetails(1);
      expect(pendingUnit.status).to.equal(Status.PendingTransfer);
      expect(pendingUnit.pendingReceiver).to.equal(pharmacy.address);

      // New custodian accepts custody
      await expect(
        pharmaTree.connect(pharmacy).acceptTransfer(1)
      ).to.emit(pharmaTree, "TransferCompleted").withArgs(1, distributor.address, pharmacy.address);

      const finalized = await pharmaTree.getUnitDetails(1);
      expect(finalized.currentOwner).to.equal(pharmacy.address);
      expect(finalized.status).to.equal(Status.Active);
    });
  });
});
