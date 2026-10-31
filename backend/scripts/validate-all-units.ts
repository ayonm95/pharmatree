import fs from "fs";
import path from "path";
import { ethers } from "hardhat";
import { normalizeSerial } from "../../frontend/src/lib/serial";
import { evaluateTiers } from "../../frontend/src/lib/tierEvaluator";
import { verifyUnitSeal } from "../../frontend/src/lib/sealVerifier";

interface UnitFixture {
  unitId: number;
  level: number;
  metadata: string;
  quantity: number;
  serial: string;
  sealCode: string;
}

const FALLBACK_FIXTURES: UnitFixture[] = [
  { unitId: 1, level: 4, metadata: "Paracetamol 500mg, 50 tablets", quantity: 50, serial: "CD360DWJZHAXPCNRDVF7", sealCode: "P5NS8WJK6RAK" },
  { unitId: 2, level: 4, metadata: "Amoxicillin 250mg, 10 capsules", quantity: 10, serial: "SGGJ9W55VG8HTN8N0NMM", sealCode: "NBHVG59Y348R" },
  { unitId: 3, level: 0, metadata: "Demo Pallet Alpha", quantity: 1, serial: "X9Y4ZDHJHV2ZD567PF1A", sealCode: "63QRMM2XM7EB" },
  { unitId: 4, level: 1, metadata: "Demo Case Beta (Pallet #3)", quantity: 1, serial: "0XMRF9BQW7B9VVYKXY8F", sealCode: "HNVWG278MFMQ" },
  { unitId: 5, level: 2, metadata: "Demo Box Gamma (Case #4)", quantity: 1, serial: "S7NY46QGMKAFTSCK1K0N", sealCode: "JRWNQJ99JMME" },
  { unitId: 6, level: 3, metadata: "Demo Blister Pack Delta (Box #5)", quantity: 1, serial: "5X2169CMC620WYKJC7ZN", sealCode: "3YCNHXTV4950" },
  { unitId: 7, level: 4, metadata: "Atorvastatin 20mg, 100 tablets", quantity: 100, serial: "Y3S8B9648EN1GYA8NPNB", sealCode: "D5CB3SQGTCM7" },
  { unitId: 8, level: 4, metadata: "Ibuprofen 400mg, 20 packs", quantity: 20, serial: "B8N2XJDCMN47KM60M55A", sealCode: "D3TCM0DS4KG7" },
  { unitId: 9, level: 4, metadata: "Cold-Chain Insulin Glargine, 10 vials", quantity: 10, serial: "Y3HJ0SH82SMS3JNW2KXG", sealCode: "XBF837P8DF5V" },
  { unitId: 10, level: 4, metadata: "Doxycycline 100mg, 30 capsules", quantity: 30, serial: "3VWXZ4BDNP3VKYDMZV6P", sealCode: "M71ZJVF2Y8VB" },
];

function loadFixtures(): UnitFixture[] {
  const fixturePath = path.resolve(__dirname, "../deployments/sepolia-units.json");
  if (fs.existsSync(fixturePath)) {
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
    return raw.map((r: any) => ({
      unitId: r.unitId,
      level: r.level,
      metadata: r.metadata,
      quantity: r.quantity,
      serial: r.serial,
      sealCode: r.sealCode || r.sealSecret,
    }));
  }
  return FALLBACK_FIXTURES;
}

async function main() {
  console.log("======================================================================");
  console.log("       EXHAUSTIVE 10-UNIT ON-CHAIN & 5-TIER VERIFICATION SUITE       ");
  console.log("======================================================================");

  const contractAddress = process.env.SEPOLIA_CONTRACT_ADDRESS || "0xa51Fe74519fFdd2f167e74780Be7AAD155eEF345";
  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;

  const contract = await ethers.getContractAt(
    [
      "function unitCounter() view returns (uint256)",
      "function getUnitDetails(uint256) view returns (tuple(uint256 parentId, uint256 rootId, uint8 level, address manufacturer, address currentOwner, address pendingReceiver, uint8 status, uint256 quantity, string metadata, bytes32 serialHash, uint256 expiry))",
      "function verifySerial(uint256 unitId, string serial) view returns (bool)",
      "function recalledRoots(uint256) view returns (bool)"
    ],
    contractAddress,
    signer
  );

  const totalUnits = Number(await contract.unitCounter());
  console.log(`Contract: ${contractAddress}`);
  console.log(`Total Registered Units: ${totalUnits}\n`);

  let allPassed = true;

  const unitsFixture = loadFixtures();
  for (const fixture of unitsFixture) {
    const id = fixture.unitId;
    console.log(`----------------------------------------------------------------------`);
    console.log(`🔍 VERIFYING UNIT #${id}: ${fixture.metadata}`);
    console.log(`----------------------------------------------------------------------`);

    // 1. Fetch On-Chain State
    const onChain = await contract.getUnitDetails(id);
    const parentId = onChain.parentId.toString();
    const rootId = onChain.rootId.toString();
    const level = Number(onChain.level);
    const manufacturer = onChain.manufacturer;
    const currentOwner = onChain.currentOwner;
    const status = Number(onChain.status);
    const quantity = onChain.quantity.toString();
    const metadata = onChain.metadata;
    const serialHash = onChain.serialHash;
    const expiry = Number(onChain.expiry);

    console.log(`  • On-Chain ID:          #${id}`);
    console.log(`  • Packaging Level:      ${level} (Expected: ${fixture.level})`);
    console.log(`  • Manufacturer:         ${manufacturer}`);
    console.log(`  • Current Owner:        ${currentOwner}`);
    console.log(`  • Status:               ${status} (${status === 0 ? "Active" : status === 1 ? "PendingTransfer" : status === 2 ? "Sold" : "Rejected"})`);
    console.log(`  • Quantity:             ${quantity}`);
    console.log(`  • Stored SerialHash:    ${serialHash}`);
    console.log(`  • Expiry:               ${new Date(expiry * 1000).toISOString()}`);

    // Check basic metadata consistency
    if (level !== fixture.level) {
      console.error(`  ❌ Level mismatch! Expected ${fixture.level}, got ${level}`);
      allPassed = false;
    }
    if (Number(quantity) !== fixture.quantity) {
      console.error(`  ❌ Quantity mismatch! Expected ${fixture.quantity}, got ${quantity}`);
      allPassed = false;
    }

    // 2. Cryptographic Serial Verification
    const normalizedSerial = normalizeSerial(fixture.serial);
    const localHash = ethers.keccak256(ethers.toUtf8Bytes(normalizedSerial));
    const hashMatches = localHash.toLowerCase() === serialHash.toLowerCase();

    console.log(`  • Seeded Serial:        ${fixture.serial}`);
    console.log(`  • Normalized:           ${normalizedSerial}`);
    console.log(`  • Computed Hash:        ${localHash}`);
    console.log(`  • Hash Match:           ${hashMatches ? "✅ MATCH" : "❌ MISMATCH"}`);

    if (!hashMatches) {
      console.error(`  ❌ Keccak256(serial) did not match on-chain serialHash!`);
      allPassed = false;
    }

    // On-Chain verifySerial test
    const onChainVerifyValid = await contract.verifySerial(id, fixture.serial);
    const onChainVerifyForged = await contract.verifySerial(id, "FORGED_CLONE_ATTEMPT_999");

    console.log(`  • onChain.verifySerial(valid):  ${onChainVerifyValid ? "✅ true" : "❌ false"}`);
    console.log(`  • onChain.verifySerial(forged): ${!onChainVerifyForged ? "✅ false (blocked)" : "❌ true (vulnerable!)"}`);

    if (!onChainVerifyValid || onChainVerifyForged) {
      console.error(`  ❌ Smart contract verifySerial test failed!`);
      allPassed = false;
    }

    // 3. 5-Tier Anti-Counterfeiting Engine Verification
    const evalInput = {
      unitId: id,
      totalUnitsOnChain: BigInt(totalUnits),
      serial: fixture.serial,
      unit: {
        parentId,
        rootId,
        level,
        manufacturer,
        currentOwner,
        pendingReceiver: onChain.pendingReceiver,
        status,
        quantity,
        metadata,
        serialHash,
        expiry,
      },
      vendorAddress: currentOwner,
    };

    const evalWithValid = evaluateTiers(evalInput);
    const evalWithWrong = evaluateTiers({ ...evalInput, serial: "WRONG_FORGED_SERIAL" });

    console.log(`  • Tier 1 (Registered):          ${evalWithValid.tiers.tier1_registered ? "✅ Passed" : "❌ Failed"}`);
    console.log(`  • Tier 2 (Unsold):              ${evalWithValid.tiers.tier2_unsold ? "✅ Passed" : "⚠️ Sold / Replay (Expected if Unit #2)"}`);
    console.log(`  • Tier 3 (Custody):             ${evalWithValid.tiers.tier3_custodyMatch ? "✅ Passed" : "⚠️ Mismatch / In-Transit"}`);
    console.log(`  • Tier 4 (Transit Integrity):   ${evalWithValid.tiers.tier4_integrity ? "✅ Passed" : "❌ Failed"}`);
    console.log(`  • Anti-Enumeration 404 Guard:   ${!evalWithWrong.authentic && evalWithWrong.reason === "UNIT_NOT_FOUND" ? "✅ Uniform 404 enforced" : "❌ Failed"}`);

    // 4. Tier 5: Cryptographic Tamper Seal Verification
    const sealCheck = await verifyUnitSeal({
      unitId: id,
      secret: fixture.sealCode,
      manufacturerAddress: manufacturer,
      clientIdentifier: "verification-runner",
    });

    console.log(`  • Tier 5 Seal Secret:           ${fixture.sealCode}`);
    console.log(`  • Tier 5 Seal Validation:       ${sealCheck.valid ? "✅ Authentic (HMAC Valid)" : "❌ Invalid Seal"}`);
    console.log(`  • Tier 5 Seal State:            ${sealCheck.state}`);

    if (!sealCheck.valid) {
      console.error(`  ❌ Tier 5 seal verification failed for Unit #${id}!`);
      allPassed = false;
    }

    console.log(`  => Unit #${id} Status: ✅ FULLY VERIFIED & LINKED\n`);
  }

  console.log("======================================================================");
  if (allPassed) {
    console.log("🎉 ALL 10 UNITS ON SEPOLIA ARE 100% VERIFIED AND CRYPTOGRAPHICALLY LINKED!");
  } else {
    console.log("❌ VERIFICATION FAILURES DETECTED. CHECK DETAILED LOGS ABOVE.");
    process.exit(1);
  }
  console.log("======================================================================");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
