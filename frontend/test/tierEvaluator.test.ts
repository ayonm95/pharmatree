import { describe, it, expect } from "vitest";
import { evaluateTiers, EvaluateTiersInput } from "../src/lib/tierEvaluator";

describe("5-Tier Anti-Counterfeiting Engine (tierEvaluator)", () => {
  const baseUnit: EvaluateTiersInput["unit"] = {
    parentId: "0",
    rootId: "1",
    level: 3,
    manufacturer: "0x65371f0ddFa0AD6e7655243cD2A2567328EA1537",
    currentOwner: "0x1589df48e9F04926E260Bf813c42dFb4a71893A3",
    pendingReceiver: "",
    status: 0,
    quantity: "30",
    metadata: "Amoxicillin 500mg, 30 capsules",
  };

  it("should verify active unit owned by current dispensary", () => {
    const result = evaluateTiers({
      unitId: 1,
      totalUnitsOnChain: BigInt(10),
      unit: baseUnit,
      vendorAddress: "0x1589df48e9F04926E260Bf813c42dFb4a71893A3",
    });

    expect(result.authentic).toBe(true);
    expect(result.tierFailed).toBeNull();
    expect(result.tiers.tier1_registered).toBe(true);
    expect(result.tiers.tier2_unsold).toBe(true);
    expect(result.tiers.tier3_custodyMatch).toBe(true);
    expect(result.tiers.tier4_integrity).toBe(true);
    expect(result.diversionDetected).toBe(false);
  });

  it("should treat incoming pending delivery to this pharmacy as legitimate in-transit custody", () => {
    const pendingUnit = {
      ...baseUnit,
      currentOwner: "0x65371f0ddFa0AD6e7655243cD2A2567328EA1537", // Manufacturer
      pendingReceiver: "0x1589df48e9F04926E260Bf813c42dFb4a71893A3", // Receiving Pharmacy
      status: 1, // PendingTransfer
    };

    const result = evaluateTiers({
      unitId: 1,
      totalUnitsOnChain: BigInt(10),
      unit: pendingUnit,
      vendorAddress: "0x1589df48e9F04926E260Bf813c42dFb4a71893A3",
    });

    expect(result.authentic).toBe(true);
    expect(result.tiers.tier3_custodyMatch).toBe(true);
    expect(result.diversionDetected).toBe(false);
    expect(result.message).toContain("Unit in transit: Dispatched and awaiting delivery acceptance");
  });

  it("should flag diversion when scanning competitor or foreign inventory", () => {
    const result = evaluateTiers({
      unitId: 1,
      totalUnitsOnChain: BigInt(10),
      unit: baseUnit,
      vendorAddress: "0x9999999999999999999999999999999999999999", // Unrelated vendor
    });

    expect(result.authentic).toBe(true);
    expect(result.tiers.tier3_custodyMatch).toBe(false);
    expect(result.diversionDetected).toBe(true);
  });

  it("should fail Tier 1 on unregistered unit ID exceeding total on-chain count", () => {
    const result = evaluateTiers({
      unitId: 9999,
      totalUnitsOnChain: BigInt(10),
      unit: null,
    });

    expect(result.authentic).toBe(false);
    expect(result.tierFailed).toBe(1);
    expect(result.reason).toBe("UNREGISTERED_ID");
    expect(result.tiers.tier1_registered).toBe(false);
  });

  it("should fail Tier 2 on already-sold replayed unit", () => {
    const soldUnit = {
      ...baseUnit,
      status: 2, // Sold
    };

    const result = evaluateTiers({
      unitId: 2,
      totalUnitsOnChain: BigInt(10),
      unit: soldUnit,
      vendorAddress: "0x1589df48e9F04926E260Bf813c42dFb4a71893A3",
    });

    expect(result.authentic).toBe(false);
    expect(result.tierFailed).toBe(2);
    expect(result.reason).toBe("ALREADY_SOLD_REPLAY");
    expect(result.tiers.tier2_unsold).toBe(false);
  });

  it("should fail Tier 4 on rejected contaminated shipment", () => {
    const rejectedUnit = {
      ...baseUnit,
      status: 3, // Rejected
    };

    const result = evaluateTiers({
      unitId: 3,
      totalUnitsOnChain: BigInt(10),
      unit: rejectedUnit,
      vendorAddress: "0x1589df48e9F04926E260Bf813c42dFb4a71893A3",
    });

    expect(result.authentic).toBe(false);
    expect(result.tierFailed).toBe(4);
    expect(result.reason).toBe("REJECTED_TRANSIT");
    expect(result.tiers.tier4_integrity).toBe(false);
  });

  it("should correctly handle Tier 5 tamper seal verification states", () => {
    const verifiedResult = evaluateTiers({
      unitId: 1,
      totalUnitsOnChain: BigInt(10),
      unit: baseUnit,
      sealRecord: { state: "VERIFIED", consumedAt: new Date().toISOString() },
    });
    expect(verifiedResult.tamperSealStatus).toBe("consumed");
    expect(verifiedResult.tiers.tier5_tamperValid).toBe(true);

    const lockedResult = evaluateTiers({
      unitId: 1,
      totalUnitsOnChain: BigInt(10),
      unit: baseUnit,
      sealRecord: { state: "LOCKED_REVIEW" },
    });
    expect(lockedResult.tamperSealStatus).toBe("locked");
    expect(lockedResult.tiers.tier5_tamperValid).toBe(false);
  });
});
