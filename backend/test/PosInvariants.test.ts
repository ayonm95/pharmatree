import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployPharmaTreeFixture,
  deployPharmaTreeWithUnitsFixture,
  UnitLevel,
  Status,
} from "./fixtures/pharmaTreeFixture";
import { evaluateTiers } from "../../frontend/src/lib/tierEvaluator";

describe("PharmaTree POS & Supply Chain Invariants", function () {
  const defaultExpiry = Math.floor(Date.now() / 1000) + 730 * 86400; // 2 years future
  let serialCounter = 1000;

  function nextSerialHash(prefix = "POS-SN"): string {
    return ethers.keccak256(ethers.toUtf8Bytes(`${prefix}-${serialCounter++}-${Date.now()}`));
  }

  function getSerialHashes(count: number, prefix = "POS-CHILD"): string[] {
    const hashes: string[] = [];
    for (let i = 0; i < count; i++) {
      hashes.push(nextSerialHash(prefix));
    }
    return hashes;
  }

  describe("Invariant 1: Monotonic Unit Registration & Global Counter", function () {
    it("Should monotonically assign sequential unit IDs starting from 1", async function () {
      const { pharmaTree, manufacturer } = await loadFixture(deployPharmaTreeFixture);

      expect(await pharmaTree.unitCounter()).to.equal(0);

      await pharmaTree
        .connect(manufacturer)
        .createRootUnit(UnitLevel.Batch, "Batch #1", 100, nextSerialHash(), defaultExpiry);
      expect(await pharmaTree.unitCounter()).to.equal(1);

      await pharmaTree
        .connect(manufacturer)
        .createRootUnit(UnitLevel.Batch, "Batch #2", 200, nextSerialHash(), defaultExpiry);
      expect(await pharmaTree.unitCounter()).to.equal(2);

      const u1 = await pharmaTree.getUnitDetails(1);
      const u2 = await pharmaTree.getUnitDetails(2);
      expect(u1.quantity).to.equal(100);
      expect(u2.quantity).to.equal(200);
    });
  });

  describe("Invariant 2: Hierarchy Ordering & Packing Invariants", function () {
    it("Should strictly enforce parent level > child level", async function () {
      const { pharmaTree, manufacturer, unauthorized } = await loadFixture(deployPharmaTreeFixture);

      await pharmaTree
        .connect(manufacturer)
        .createRootUnit(UnitLevel.Container, "Container Root", 1, nextSerialHash(), defaultExpiry);

      // Level 0 (Container) -> Level 3 (Box) valid
      await expect(
        pharmaTree
          .connect(manufacturer)
          .createChildUnitsBatch(1, UnitLevel.Box, "Box 1", getSerialHashes(2, "BOX"))
      ).to.not.be.reverted;

      // Cannot pack Level 0 (Container) under Level 3 (Box)
      await expect(
        pharmaTree
          .connect(manufacturer)
          .createChildUnitsBatch(2, UnitLevel.Container, "Invalid Container", getSerialHashes(1))
      ).to.be.revertedWith("Child level must be strictly lower in hierarchy");

      // Non-owner cannot pack children
      await expect(
        pharmaTree
          .connect(unauthorized)
          .createChildUnitsBatch(1, UnitLevel.IndividualItem, "Pills", getSerialHashes(5))
      ).to.be.revertedWith("Must own the parent to pack children");
    });
  });

  describe("Invariant 3: Partial Transfer Quantity Conservation (ΣQ)", function () {
    it("Should conserve quantity exactly across partial custody transfers", async function () {
      const { pharmaTree, manufacturer, distributor1 } = await loadFixture(deployPharmaTreeFixture);

      const initialQuantity = 500n;
      const transferQuantity = 175n;

      await pharmaTree
        .connect(manufacturer)
        .createRootUnit(UnitLevel.Batch, "Batch Vaccines", initialQuantity, nextSerialHash(), defaultExpiry);
      const parentBefore = await pharmaTree.getUnitDetails(1);
      expect(parentBefore.quantity).to.equal(initialQuantity);

      // Split 175 units
      await pharmaTree.connect(manufacturer).initiatePartialTransfer(1, distributor1.address, transferQuantity);

      const parentAfter = await pharmaTree.getUnitDetails(1);
      const childSplit = await pharmaTree.getUnitDetails(2);

      // Invariant: Q_parent_after + Q_child == Q_initial
      expect(parentAfter.quantity + childSplit.quantity).to.equal(initialQuantity);
      expect(parentAfter.quantity).to.equal(325n);
      expect(childSplit.quantity).to.equal(175n);
      expect(childSplit.status).to.equal(Status.PendingTransfer);

      // Complete transfer
      await pharmaTree.connect(distributor1).acceptTransfer(2);
      const childAccepted = await pharmaTree.getUnitDetails(2);
      expect(childAccepted.currentOwner).to.equal(distributor1.address);
      expect(childAccepted.status).to.equal(Status.Active);
      expect(parentAfter.quantity + childAccepted.quantity).to.equal(initialQuantity);
    });
  });

  describe("Invariant 4: Sales Quantity Conservation (ΣQ)", function () {
    it("Should conserve quantity across partial retail sales", async function () {
      const { pharmaTree, manufacturer } = await loadFixture(deployPharmaTreeFixture);

      const initialStock = 120n;
      const soldQuantity = 45n;

      await pharmaTree
        .connect(manufacturer)
        .createRootUnit(UnitLevel.Batch, "Antibiotics 500mg", initialStock, nextSerialHash(), defaultExpiry);

      await pharmaTree
        .connect(manufacturer)
        .sellQuantityWithSerialHash(1, soldQuantity, nextSerialHash("SOLD-CHILD"));

      const remainingUnit = await pharmaTree.getUnitDetails(1);
      const soldChild = await pharmaTree.getUnitDetails(2);

      // Invariant: Q_remaining + Q_sold == Q_initial
      expect(remainingUnit.quantity + soldChild.quantity).to.equal(initialStock);
      expect(remainingUnit.quantity).to.equal(75n);
      expect(remainingUnit.status).to.equal(Status.Active);
      expect(soldChild.quantity).to.equal(45n);
      expect(soldChild.status).to.equal(Status.Sold);
    });

    it("Should mark parent fully Sold when selling entire remaining quantity", async function () {
      const { pharmaTree, manufacturer } = await loadFixture(deployPharmaTreeFixture);

      await pharmaTree
        .connect(manufacturer)
        .createRootUnit(UnitLevel.Batch, "Inhaler Box", 10, nextSerialHash(), defaultExpiry);
      await pharmaTree
        .connect(manufacturer)
        .sellQuantityWithSerialHash(1, 10, ethers.ZeroHash);

      const unit = await pharmaTree.getUnitDetails(1);
      expect(unit.quantity).to.equal(10);
      expect(unit.status).to.equal(Status.Sold);
      expect(await pharmaTree.unitCounter()).to.equal(1); // No new unit minted on 100% sale
    });
  });

  describe("Invariant 5: Zero Double-Spend / Replay Resistance", function () {
    it("Should prevent any transfer or sale of an already sold unit", async function () {
      const { pharmaTree, soldUnitId, pharmacy, distributor1 } = await loadFixture(
        deployPharmaTreeWithUnitsFixture
      );

      const soldUnit = await pharmaTree.getUnitDetails(soldUnitId);
      expect(soldUnit.status).to.equal(Status.Sold);

      // Cannot sell again
      await expect(
        pharmaTree.connect(pharmacy).sellQuantityWithSerialHash(soldUnitId, 1, ethers.ZeroHash)
      ).to.be.revertedWith("Unit is not active");

      // Cannot initiate transfer
      await expect(
        pharmaTree.connect(pharmacy).initiateTransfer(soldUnitId, distributor1.address)
      ).to.be.revertedWith("Unit not active");
    });
  });

  describe("Invariant 6: Transit Rejection & Quarantine Isolation", function () {
    it("Should isolate rejected units from transfer or dispensing until reclaimed", async function () {
      const { pharmaTree, rejectedUnitId, manufacturer, distributor1, pharmacy, admin } =
        await loadFixture(deployPharmaTreeWithUnitsFixture);

      const rejectedUnit = await pharmaTree.getUnitDetails(rejectedUnitId);
      expect(rejectedUnit.status).to.equal(Status.Rejected);
      expect(rejectedUnit.currentOwner).to.equal(manufacturer.address);

      // Distributor cannot accept after rejecting
      await expect(
        pharmaTree.connect(distributor1).acceptTransfer(rejectedUnitId)
      ).to.be.revertedWith("No transfer pending");

      // Cannot sell rejected unit
      await expect(
        pharmaTree.connect(manufacturer).sellQuantityWithSerialHash(rejectedUnitId, 5, ethers.ZeroHash)
      ).to.be.revertedWith("Unit is not active");

      // Cannot transfer rejected unit
      await expect(
        pharmaTree.connect(manufacturer).initiateTransfer(rejectedUnitId, pharmacy.address)
      ).to.be.revertedWith("Unit not active");

      // Sender cannot self-unreject
      const dummyEvidence = ethers.keccak256(ethers.toUtf8Bytes("QA-INSPECTION-PASS-REMEDY"));
      await expect(
        pharmaTree.connect(manufacturer).clearRejected(rejectedUnitId, dummyEvidence)
      ).to.be.revertedWith("Caller is not authorized QA");

      // QA clears rejected unit with verifiable audit evidence hash
      await pharmaTree.connect(admin).clearRejected(rejectedUnitId, dummyEvidence);
      const reclaimed = await pharmaTree.getUnitDetails(rejectedUnitId);
      expect(reclaimed.status).to.equal(Status.Active);
    });
  });

  describe("Invariant 7: Two-Party Transfer Handshake Atomicity", function () {
    it("Should guarantee ownership never shifts without receiver acceptance", async function () {
      const { pharmaTree, pendingTransferUnitId, manufacturer, pharmacy, unauthorized } =
        await loadFixture(deployPharmaTreeWithUnitsFixture);

      const pendingUnit = await pharmaTree.getUnitDetails(pendingTransferUnitId);
      expect(pendingUnit.status).to.equal(Status.PendingTransfer);
      expect(pendingUnit.currentOwner).to.equal(manufacturer.address);
      expect(pendingUnit.pendingReceiver).to.equal(pharmacy.address);

      // Receiver cannot sell before accepting
      await expect(
        pharmaTree.connect(pharmacy).sellQuantityWithSerialHash(pendingTransferUnitId, 1, ethers.ZeroHash)
      ).to.be.revertedWith("Not the current owner");

      // Unauthorized third party cannot accept
      await expect(
        pharmaTree.connect(unauthorized).acceptTransfer(pendingTransferUnitId)
      ).to.be.revertedWith("You are not the pending receiver");

      // Sender cancels transfer
      await pharmaTree.connect(manufacturer).cancelTransfer(pendingTransferUnitId);
      const cancelled = await pharmaTree.getUnitDetails(pendingTransferUnitId);
      expect(cancelled.status).to.equal(Status.Active);
      expect(cancelled.pendingReceiver).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Invariant 8: Randomized Property Test (ΣQ Global Mass Conservation)", function () {
    it("Should strictly conserve ΣQ across 35 randomized supply-chain operations", async function () {
      const { pharmaTree, admin, manufacturer, distributor1, distributor2, pharmacy } =
        await loadFixture(deployPharmaTreeFixture);

      // Grant dispenser role to distributors as well so random sales can proceed
      await pharmaTree.connect(admin).addDispenser(distributor1.address);
      await pharmaTree.connect(admin).addDispenser(distributor2.address);

      // 1. Setup 3 initial root batches
      const initialLots = [100n, 250n, 400n];
      const initialTotal = initialLots.reduce((acc, q) => acc + q, 0n);

      for (let i = 0; i < initialLots.length; i++) {
        await pharmaTree
          .connect(manufacturer)
          .createRootUnit(
            UnitLevel.Batch,
            `Initial Batch #${i + 1}`,
            initialLots[i],
            nextSerialHash(`ROOT-${i}`),
            defaultExpiry
          );
      }

      // Helper to sum quantities of all units on-chain
      async function computeTotalInventoryOnChain(): Promise<bigint> {
        const totalUnits = Number(await pharmaTree.unitCounter());
        let sum = 0n;
        for (let id = 1; id <= totalUnits; id++) {
          const u = await pharmaTree.getUnitDetails(id);
          sum += u.quantity;
        }
        return sum;
      }

      expect(await computeTotalInventoryOnChain()).to.equal(initialTotal);

      // Pseudo-random deterministic sequence generator
      let seed = 42;
      function randomInt(min: number, max: number): number {
        seed = (seed * 9301 + 49297) % 233280;
        const rnd = seed / 233280;
        return Math.floor(min + rnd * (max - min + 1));
      }

      // 35 randomized actions
      for (let step = 0; step < 35; step++) {
        const totalUnits = Number(await pharmaTree.unitCounter());
        const targetId = randomInt(1, totalUnits);
        const unit = await pharmaTree.getUnitDetails(targetId);

        // Pick signer matching unit.currentOwner
        let ownerSigner: any = null;
        if (unit.currentOwner.toLowerCase() === manufacturer.address.toLowerCase()) {
          ownerSigner = manufacturer;
        } else if (unit.currentOwner.toLowerCase() === distributor1.address.toLowerCase()) {
          ownerSigner = distributor1;
        } else if (unit.currentOwner.toLowerCase() === distributor2.address.toLowerCase()) {
          ownerSigner = distributor2;
        } else if (unit.currentOwner.toLowerCase() === pharmacy.address.toLowerCase()) {
          ownerSigner = pharmacy;
        }

        const actionType = randomInt(1, 6);

        try {
          if (unit.status === Number(Status.Active) && ownerSigner) {
            if (actionType === 1 && unit.quantity > 5n) {
              // Partial Transfer
              const splitQty = BigInt(randomInt(1, Number(unit.quantity) - 1));
              const nextReceiver =
                ownerSigner.address === manufacturer.address
                  ? distributor1.address
                  : ownerSigner.address === distributor1.address
                  ? distributor2.address
                  : pharmacy.address;
              await pharmaTree.connect(ownerSigner).initiatePartialTransfer(targetId, nextReceiver, splitQty);
            } else if (actionType === 2 && unit.quantity > 5n) {
              // Partial Sale
              const sellQty = BigInt(randomInt(1, Number(unit.quantity) - 1));
              const childHash = nextSerialHash(`fuzz-child-${step}-${targetId}`);
              await pharmaTree.connect(ownerSigner).sellQuantityWithSerialHash(targetId, sellQty, childHash);
            } else if (actionType === 3) {
              // Full Sale
              await pharmaTree.connect(ownerSigner).sellQuantityWithSerialHash(targetId, unit.quantity, ethers.ZeroHash);
            } else if (actionType === 4) {
              // Full Transfer
              const nextReceiver =
                ownerSigner.address === manufacturer.address
                  ? distributor1.address
                  : pharmacy.address;
              await pharmaTree.connect(ownerSigner).initiateTransfer(targetId, nextReceiver);
            }
          } else if (unit.status === Number(Status.PendingTransfer)) {
            // Pending receiver accepts or rejects
            let receiverSigner: any = null;
            if (unit.pendingReceiver.toLowerCase() === distributor1.address.toLowerCase()) {
              receiverSigner = distributor1;
            } else if (unit.pendingReceiver.toLowerCase() === distributor2.address.toLowerCase()) {
              receiverSigner = distributor2;
            } else if (unit.pendingReceiver.toLowerCase() === pharmacy.address.toLowerCase()) {
              receiverSigner = pharmacy;
            }

            if (receiverSigner) {
              if (actionType % 2 === 0) {
                await pharmaTree.connect(receiverSigner).acceptTransfer(targetId);
              } else {
                await pharmaTree.connect(receiverSigner).rejectTransfer(targetId);
              }
            }
          } else if (unit.status === Number(Status.Rejected)) {
            // Authorized QA clears rejection with evidence hash
            const evidence = ethers.keccak256(ethers.toUtf8Bytes(`qa-audit-${targetId}-${step}`));
            await pharmaTree.connect(admin).clearRejected(targetId, evidence);
          }
        } catch {
          // Expected business logic guards in random execution
        }

        // Assert invariant at EVERY step
        const currentSum = await computeTotalInventoryOnChain();
        expect(currentSum).to.equal(
          initialTotal,
          `Quantity conservation violated at step ${step}! Expected ${initialTotal}, got ${currentSum}`
        );
      }
    });
  });

  describe("Tier Evaluation Logic Integration", function () {
    it("Should accurately verify an active genuine unit", async function () {
      const { pharmaTree, activeUnitId, manufacturer } = await loadFixture(
        deployPharmaTreeWithUnitsFixture
      );

      const totalUnits = await pharmaTree.unitCounter();
      const unit = await pharmaTree.getUnitDetails(activeUnitId);

      const result = evaluateTiers({
        unitId: activeUnitId,
        totalUnitsOnChain: totalUnits,
        unit: {
          parentId: unit.parentId.toString(),
          rootId: unit.rootId.toString(),
          level: Number(unit.level),
          manufacturer: unit.manufacturer,
          currentOwner: unit.currentOwner,
          pendingReceiver: unit.pendingReceiver,
          status: Number(unit.status),
          quantity: unit.quantity.toString(),
          metadata: unit.metadata,
        },
        vendorAddress: manufacturer.address,
      });

      expect(result.authentic).to.be.true;
      expect(result.tierFailed).to.be.null;
      expect(result.tiers.tier1_registered).to.be.true;
      expect(result.tiers.tier2_unsold).to.be.true;
      expect(result.tiers.tier3_custodyMatch).to.be.true;
      expect(result.tiers.tier4_integrity).to.be.true;
      expect(result.diversionDetected).to.be.false;
    });

    it("Should detect Replay / Double-Spend on sold unit (Tier 2 failure)", async function () {
      const { pharmaTree, soldUnitId } = await loadFixture(deployPharmaTreeWithUnitsFixture);

      const totalUnits = await pharmaTree.unitCounter();
      const unit = await pharmaTree.getUnitDetails(soldUnitId);

      const result = evaluateTiers({
        unitId: soldUnitId,
        totalUnitsOnChain: totalUnits,
        unit: {
          parentId: unit.parentId.toString(),
          rootId: unit.rootId.toString(),
          level: Number(unit.level),
          manufacturer: unit.manufacturer,
          currentOwner: unit.currentOwner,
          pendingReceiver: unit.pendingReceiver,
          status: Number(unit.status),
          quantity: unit.quantity.toString(),
          metadata: unit.metadata,
        },
      });

      expect(result.authentic).to.be.false;
      expect(result.tierFailed).to.equal(2);
      expect(result.reason).to.equal("ALREADY_SOLD_REPLAY");
      expect(result.tiers.tier2_unsold).to.be.false;
    });

    it("Should detect Diversion when scanning competitor or foreign inventory (Tier 3)", async function () {
      const { pharmaTree, distributorUnitId, pharmacy } = await loadFixture(
        deployPharmaTreeWithUnitsFixture
      );

      const totalUnits = await pharmaTree.unitCounter();
      const unit = await pharmaTree.getUnitDetails(distributorUnitId);

      const result = evaluateTiers({
        unitId: distributorUnitId,
        totalUnitsOnChain: totalUnits,
        unit: {
          parentId: unit.parentId.toString(),
          rootId: unit.rootId.toString(),
          level: Number(unit.level),
          manufacturer: unit.manufacturer,
          currentOwner: unit.currentOwner,
          pendingReceiver: unit.pendingReceiver,
          status: Number(unit.status),
          quantity: unit.quantity.toString(),
          metadata: unit.metadata,
        },
        vendorAddress: pharmacy.address, // Scanned by pharmacy, but owned by distributor!
      });

      expect(result.authentic).to.be.true;
      expect(result.diversionDetected).to.be.true;
      expect(result.tiers.tier3_custodyMatch).to.be.false;
    });

    it("Should detect Transit Rejection / Contamination (Tier 4 failure)", async function () {
      const { pharmaTree, rejectedUnitId } = await loadFixture(deployPharmaTreeWithUnitsFixture);

      const totalUnits = await pharmaTree.unitCounter();
      const unit = await pharmaTree.getUnitDetails(rejectedUnitId);

      const result = evaluateTiers({
        unitId: rejectedUnitId,
        totalUnitsOnChain: totalUnits,
        unit: {
          parentId: unit.parentId.toString(),
          rootId: unit.rootId.toString(),
          level: Number(unit.level),
          manufacturer: unit.manufacturer,
          currentOwner: unit.currentOwner,
          pendingReceiver: unit.pendingReceiver,
          status: Number(unit.status),
          quantity: unit.quantity.toString(),
          metadata: unit.metadata,
        },
      });

      expect(result.authentic).to.be.false;
      expect(result.tierFailed).to.equal(4);
      expect(result.reason).to.equal("REJECTED_TRANSIT");
      expect(result.tiers.tier4_integrity).to.be.false;
    });

    it("Should reject counterfeit unregistered unit IDs (Tier 1 failure)", async function () {
      const { pharmaTree } = await loadFixture(deployPharmaTreeWithUnitsFixture);

      const totalUnits = await pharmaTree.unitCounter();
      const fakeUnitId = 9999;

      const result = evaluateTiers({
        unitId: fakeUnitId,
        totalUnitsOnChain: totalUnits,
        unit: null,
      });

      expect(result.authentic).to.be.false;
      expect(result.tierFailed).to.equal(1);
      expect(result.reason).to.equal("UNREGISTERED_ID");
    });

    it("Should handle scratch-off seal validation states (Tier 5)", async function () {
      const { pharmaTree, activeUnitId, manufacturer } = await loadFixture(
        deployPharmaTreeWithUnitsFixture
      );

      const totalUnits = await pharmaTree.unitCounter();
      const unit = await pharmaTree.getUnitDetails(activeUnitId);
      const unitDetails = {
        parentId: unit.parentId.toString(),
        rootId: unit.rootId.toString(),
        level: Number(unit.level),
        manufacturer: unit.manufacturer,
        currentOwner: unit.currentOwner,
        pendingReceiver: unit.pendingReceiver,
        status: Number(unit.status),
        quantity: unit.quantity.toString(),
        metadata: unit.metadata,
      };

      // 1. Scheme 0 legacy PIN rejected by default (Anti-Tamper Hardening)
      const correctLegacyPin = manufacturer.address.slice(-4).toLowerCase();
      const resDefaultLegacy = evaluateTiers({
        unitId: activeUnitId,
        totalUnitsOnChain: totalUnits,
        unit: unitDetails,
        scratchSecret: correctLegacyPin,
      });
      expect(resDefaultLegacy.tamperSealStatus).to.equal("invalid");

      // 2. Incorrect PIN
      const resFail = evaluateTiers({
        unitId: activeUnitId,
        totalUnitsOnChain: totalUnits,
        unit: unitDetails,
        scratchSecret: "0000",
      });
      expect(resFail.tamperSealStatus).to.equal("invalid");

      // 3. Consumed seal
      const resConsumed = evaluateTiers({
        unitId: activeUnitId,
        totalUnitsOnChain: totalUnits,
        unit: unitDetails,
        sealRecord: { state: "VERIFIED", consumedAt: new Date().toISOString() },
      });
      expect(resConsumed.tamperSealStatus).to.equal("consumed");

      // 4. Locked review seal
      const resLocked = evaluateTiers({
        unitId: activeUnitId,
        totalUnitsOnChain: totalUnits,
        unit: unitDetails,
        sealRecord: { state: "LOCKED_REVIEW" },
      });
      expect(resLocked.tamperSealStatus).to.equal("locked");
    });
  });
});
