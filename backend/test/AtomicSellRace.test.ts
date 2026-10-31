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

    // Terminal A: executes first sale
    const tx1 = await pharmaTree.connect(pharmacySigner).sellQuantity(retailUnitId, 1);
    await tx1.wait();

    // Status is now Sold
    const midUnit = await pharmaTree.getUnitDetails(retailUnitId);
    expect(midUnit.status).to.equal(Status.Sold);

    // Terminal B: concurrent sale attempt on already sold unit
    // MUST REVERT ATOMICALLY with "Unit is not active"
    await expect(
      pharmaTree.connect(pharmacySigner).sellQuantity(retailUnitId, 1)
    ).to.be.revertedWith("Unit is not active");

    // Terminal C: markAsSold attempt also reverts atomically
    await expect(
      pharmaTree.connect(pharmacySigner).markAsSold(retailUnitId)
    ).to.be.revertedWith("Unit is not active");

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
