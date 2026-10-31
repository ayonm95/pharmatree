import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployPharmaTreeWithUnitsFixture,
  Status,
} from "./fixtures/pharmaTreeFixture";

describe("Atomic Verification & Concurrent Sell Race Conditions (Phase 4)", function () {
  it("Should atomically prevent race conditions when two checkout terminals attempt to sell the same unit", async function () {
    const fixture = await loadFixture(deployPharmaTreeWithUnitsFixture);
    const { pharmaTree, pharmacy, distributorUnitId } = fixture;

    // Transfer distributorUnitId (ID 2) to pharmacy so pharmacy owns it
    // Wait, in fixture:
    // activeUnitId: 1 (owned by manufacturer)
    // distributorUnitId: 2 (owned by distributor1)
    // Let's create a fresh unit directly owned by pharmacy
    // Or transfer an item to pharmacy
    const [admin, manufacturer, distributor1, , pharmacySigner, roguePharmacy] =
      await ethers.getSigners();

    // 1. Pharmacy creates a retail unit via manufacturer transfer
    await pharmaTree.connect(manufacturer).createRootUnit(
      4, // IndividualItem
      "Ciprofloxacin 500mg, 1 pack",
      1
    );
    const retailUnitId = 6;
    await pharmaTree.connect(manufacturer).initiateTransfer(retailUnitId, pharmacySigner.address);
    await pharmaTree.connect(pharmacySigner).acceptTransfer(retailUnitId);

    // Initial state: Active
    const beforeUnit = await pharmaTree.getUnitDetails(retailUnitId);
    expect(beforeUnit.status).to.equal(Status.Active);
    expect(beforeUnit.currentOwner).to.equal(pharmacySigner.address);

    // Disable automine to create a genuine concurrent mempool race
    await ethers.provider.send("evm_setAutomine", [false]);
    await ethers.provider.send("evm_setIntervalMining", [0]);

    try {
      const baseNonce = await ethers.provider.getTransactionCount(pharmacySigner.address);

      // Terminal A & Terminal B submit concurrent sell transactions to the mempool
      const txA = await pharmaTree.connect(pharmacySigner).sellQuantity(retailUnitId, 1, {
        nonce: baseNonce,
      });
      const txB = await pharmaTree.connect(pharmacySigner).sellQuantity(retailUnitId, 1, {
        nonce: baseNonce + 1,
      });

      // Mine the pending block with both transactions
      await ethers.provider.send("evm_mine", []);

      // Exactly one must succeed (status 1) and the concurrent one must revert on-chain (status 0)
      const receiptA = await txA.wait();
      expect(receiptA?.status).to.equal(1);

      // txB must fail in the mined block because unit was atomically marked Sold by txA
      let txBReverted = false;
      try {
        await txB.wait();
      } catch (err: any) {
        txBReverted = true;
        expect(err.receipt?.status).to.equal(0);
      }
      expect(txBReverted).to.be.true;

      // Status is confirmed Sold
      const finalUnit = await pharmaTree.getUnitDetails(retailUnitId);
      expect(finalUnit.status).to.equal(Status.Sold);
    } finally {
      // Re-enable automine for remaining tests
      await ethers.provider.send("evm_setAutomine", [true]);
    }

    // Rogue pharmacy (non-owner) attempting to sell reverts with "Not the current owner"
    await expect(
      pharmaTree.connect(roguePharmacy).sellQuantity(retailUnitId, 1)
    ).to.be.revertedWith("Not the current owner");
  });

  it("Should guarantee atomic quantity split and prevent double-spending in partial sales", async function () {
    const fixture = await loadFixture(deployPharmaTreeWithUnitsFixture);
    const { pharmaTree } = fixture;
    const [, manufacturer, , , pharmacySigner] = await ethers.getSigners();

    // Root batch of 10 units
    await pharmaTree.connect(manufacturer).createRootUnit(
      3, // Box
      "Azithromycin 250mg, 10 blisters",
      10
    );
    const boxId = 6;
    await pharmaTree.connect(manufacturer).initiateTransfer(boxId, pharmacySigner.address);
    await pharmaTree.connect(pharmacySigner).acceptTransfer(boxId);

    // Partial sale 1: sell 4 of 10 -> parent has 6 remaining, child has 4 sold
    const tx1 = await pharmaTree.connect(pharmacySigner).sellQuantity(boxId, 4);
    await tx1.wait();

    const parentAfter1 = await pharmaTree.getUnitDetails(boxId);
    expect(parentAfter1.quantity).to.equal(6);
    expect(parentAfter1.status).to.equal(Status.Active);

    // Partial sale 2: sell 6 of 6 -> parent is fully Sold
    const tx2 = await pharmaTree.connect(pharmacySigner).sellQuantity(boxId, 6);
    await tx2.wait();

    const parentAfter2 = await pharmaTree.getUnitDetails(boxId);
    expect(parentAfter2.quantity).to.equal(6);
    expect(parentAfter2.status).to.equal(Status.Sold);

    // Partial sale 3: attempting to sell again reverts because status is Sold
    await expect(
      pharmaTree.connect(pharmacySigner).sellQuantity(boxId, 1)
    ).to.be.revertedWith("Unit is not active");
  });
});
