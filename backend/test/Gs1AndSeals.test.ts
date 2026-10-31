import { expect } from "chai";
import {
  calculateGtin14CheckDigit,
  isValidGtin14,
  formatGtin14,
  buildGs1DigitalLink,
  parseGs1DigitalLink,
  parseGs1ElementString,
  formatGs1ElementDataMatrixString,
  generateGs1DataMatrixSvg,
} from "../../frontend/src/lib/gs1";
import {
  generateCrockfordSecret,
  normalizeCrockfordSecret,
  normalizeSerial,
  generateSecureSerial,
  computeSealVerifier,
  registerUnitSeal,
  verifyUnitSeal,
  resetSealLock,
  upsertSealRecord,
} from "../../frontend/src/lib/sealVerifier";

describe("Plan D: GS1 Digital Link & Barcode Processing", function () {
  describe("GTIN-14 Modulo 10 Check Digit", function () {
    it("Should accurately calculate the Modulo 10 Luhn check digit", function () {
      // 0030012345678 -> 5
      expect(calculateGtin14CheckDigit("0030012345678")).to.equal(5);
      // 0001234560001 -> 2
      expect(calculateGtin14CheckDigit("0001234560001")).to.equal(2);
      // 0843700012345 -> 3
      expect(calculateGtin14CheckDigit("0843700012345")).to.equal(3);
    });

    it("Should validate correct GTIN-14 numbers and reject invalid check digits", function () {
      expect(isValidGtin14("00300123456785")).to.be.true;
      expect(isValidGtin14("00012345600012")).to.be.true;
      expect(isValidGtin14("08437000123453")).to.be.true;

      // Bad check digit
      expect(isValidGtin14("00300123456784")).to.be.false;
      expect(isValidGtin14("00012345600019")).to.be.false;
      // Wrong length
      expect(isValidGtin14("12345")).to.be.false;
    });

    it("Should format raw input into a valid padded GTIN-14", function () {
      const formatted = formatGtin14("30012345678");
      expect(formatted).to.have.lengthOf(14);
      expect(isValidGtin14(formatted)).to.be.true;
    });
  });

  describe("GS1 Digital Link URI Builder & Parser", function () {
    it("Should construct standard GS1 Digital Link URI conforming to spec", function () {
      const uri = buildGs1DigitalLink({
        gtin: "00300123456785",
        lot: "BATCH-89A",
        serial: "SN-90123",
        expiry: "271231",
      });

      // Lot (10) and Serial (21) in path; Expiry (17) in query string
      expect(uri).to.equal(
        "https://pharmatree.io/01/00300123456785/10/BATCH-89A/21/SN-90123?17=271231"
      );
    });

    it("Should parse standard GS1 Digital Link URI accurately", function () {
      const uri = "https://pharmatree.io/01/00300123456785/10/BATCH-89A/21/SN-90123?17=271231";
      const parsed = parseGs1DigitalLink(uri);

      expect(parsed).to.not.be.null;
      expect(parsed?.gtin).to.equal("00300123456785");
      expect(parsed?.lot).to.equal("BATCH-89A");
      expect(parsed?.serial).to.equal("SN-90123");
      expect(parsed?.expiry).to.equal("271231");
    });
  });

  describe("GS1 Element Strings & 2D DataMatrix", function () {
    it("Should parse raw element strings containing ASCII \\x1d group separators", function () {
      const rawString = "01003001234567851726123110LOT777\x1d21SN8888";
      const parsed = parseGs1ElementString(rawString);

      expect(parsed).to.not.be.null;
      expect(parsed?.gtin).to.equal("00300123456785");
      expect(parsed?.expiry).to.equal("261231");
      expect(parsed?.lot).to.equal("LOT777");
      expect(parsed?.serial).to.equal("SN8888");
    });

    it("Should parse bracketed human-readable AI element strings", function () {
      const bracketed = "(01)00300123456785(17)261231(10)LOT777\x1d(21)SN8888";
      const parsed = parseGs1ElementString(bracketed);

      expect(parsed).to.not.be.null;
      expect(parsed?.gtin).to.equal("00300123456785");
      expect(parsed?.expiry).to.equal("261231");
      expect(parsed?.lot).to.equal("LOT777");
      expect(parsed?.serial).to.equal("SN8888");
    });

    it("Should generate GS1 DataMatrix SVG element string", function () {
      const elementStr = formatGs1ElementDataMatrixString({
        gtin: "00300123456785",
        lot: "B123",
        serial: "S456",
        expiry: "281130",
      });
      const svg = generateGs1DataMatrixSvg(elementStr);

      expect(svg).to.be.a("string");
      expect(svg).to.include("<svg");
      expect(svg).to.include("</svg>");
    });
  });
});

describe("Plan E: Dual-Scheme Seal Hardening & Cooldown Lockout", function () {
  const testUnitId = "101";
  const mfrAddress = "0x6537c35F9DaCda5062Ff13AcA32A133333331537";

  it("Should normalize Crockford Base32 characters mapping confusing glyphs", function () {
    expect(normalizeCrockfordSecret("abc-12-xyz")).to.equal("ABC-12-XYZ");
    // Maps I and L to 1, O to 0
    expect(normalizeCrockfordSecret("ILo")).to.equal("110");
  });

  it("Should generate high-entropy 12-char Crockford secrets", function () {
    const secret = generateCrockfordSecret();
    expect(secret).to.have.lengthOf(12);
    // Only characters from Crockford Base32
    expect(secret).to.match(/^[0-9A-HJKMNP-TV-Z]{12}$/);
  });

  it("Should normalize serial numbers and generate 20-character secure serials", function () {
    expect(normalizeSerial("sn-2026-xyz-1234")).to.equal("SN2026XYZ1234");
    expect(normalizeSerial("  ABC 123 - DEF  ")).to.equal("ABC123DEF");

    const serial = generateSecureSerial();
    expect(serial).to.have.lengthOf(20);
    expect(serial).to.match(/^[0-9A-HJKMNP-TV-Z]{20}$/);
  });

  it("Should reject Scheme 0 legacy 4-digit PIN unless ALLOW_LEGACY_SEALS=true", async function () {
    const legacyUnitId = 9; // Unit #9 on Sepolia
    // Reset any previous state for test isolation
    await upsertSealRecord({
      unitId: String(legacyUnitId),
      verifier: "",
      scheme: 0,
      state: "SEALED",
      failedAttempts: 0,
      consumedAt: null,
    });
    await resetSealLock(legacyUnitId, mfrAddress, mfrAddress);

    // Rejected by default
    delete process.env.ALLOW_LEGACY_SEALS;
    const resDefault = await verifyUnitSeal({
      unitId: legacyUnitId,
      secret: "1537",
      manufacturerAddress: mfrAddress,
    });
    expect(resDefault.valid).to.be.false;
    expect(resDefault.state).to.equal("invalid");

    // Accepted only when explicitly enabled
    process.env.ALLOW_LEGACY_SEALS = "true";
    const resAllowed = await verifyUnitSeal({
      unitId: legacyUnitId,
      secret: "1537",
      manufacturerAddress: mfrAddress,
    });
    expect(resAllowed.valid).to.be.true;
    delete process.env.ALLOW_LEGACY_SEALS;
  });

  it("Should register and verify Scheme 1 Crockford Base32 HMAC secret", async function () {
    const unitId = "202";
    const secret = generateCrockfordSecret();

    // Register seal
    await registerUnitSeal(unitId, secret, 1);

    // Verify with correct secret
    const resPass = await verifyUnitSeal({
      unitId,
      secret,
      manufacturerAddress: mfrAddress,
    });

    expect(resPass.valid).to.be.true;
    expect(resPass.state).to.equal("verified");

    // Second scan should show CONSUMED / already verified
    const resSecond = await verifyUnitSeal({
      unitId,
      secret,
      manufacturerAddress: mfrAddress,
    });
    expect(resSecond.valid).to.be.true;
    expect(resSecond.state).to.equal("consumed");
    expect(resSecond.consumedAt).to.be.a("string");
  });

  it("Should trigger 24-hour cooldown lockout after 5 failed guesses (Anti-DoS)", async function () {
    const unitId = "303";
    const secret = "ABCDEFGHJKMN";
    await registerUnitSeal(unitId, secret, 1);

    // Fail 4 times
    for (let i = 0; i < 4; i++) {
      const res = await verifyUnitSeal({
        unitId,
        secret: "WRONGGUESS" + i,
        manufacturerAddress: mfrAddress,
      });
      expect(res.valid).to.be.false;
      expect(res.state).to.equal("invalid");
    }

    // 5th failure triggers lockout
    const resLocked = await verifyUnitSeal({
      unitId,
      secret: "WRONGGUESS5",
      manufacturerAddress: mfrAddress,
    });

    expect(resLocked.valid).to.be.false;
    expect(resLocked.state).to.equal("locked");
    expect(resLocked.lockedUntil).to.be.a("string");

    // Correct secret should now be rejected due to active cooldown lockout
    const resBlocked = await verifyUnitSeal({
      unitId,
      secret,
      manufacturerAddress: mfrAddress,
    });
    expect(resBlocked.valid).to.be.false;
    expect(resBlocked.state).to.equal("locked");

    // Authorized manufacturer reset restores accessibility
    const resetRes = await resetSealLock(unitId, mfrAddress, mfrAddress);
    expect(resetRes.success).to.be.true;

    // Now correct secret passes!
    const resRecovered = await verifyUnitSeal({
      unitId,
      secret,
      manufacturerAddress: mfrAddress,
    });
    expect(resRecovered.valid).to.be.true;
    expect(resRecovered.state).to.equal("verified");
  });

  it("Should isolate lockout to attacking client IP while legitimate pharmacy succeeds (Anti-DoS)", async function () {
    const unitId = "404";
    const secret = "J8K9MNP23456";
    const attackerClient = "ip_hash_attacker_192_168_1_50";
    const pharmacyClient = "ip_hash_pharmacy_10_0_0_1";

    await registerUnitSeal(unitId, secret, 1);

    // Attacker guesses wrong 5 times from their IP
    for (let i = 0; i < 5; i++) {
      const res = await verifyUnitSeal({
        unitId,
        secret: "BADGUESS" + i,
        manufacturerAddress: mfrAddress,
        clientIdentifier: attackerClient,
      });
      if (i === 4) {
        expect(res.valid).to.be.false;
        expect(res.state).to.equal("locked");
      }
    }

    // Attacker's IP is now locked out
    const attackerAttempt = await verifyUnitSeal({
      unitId,
      secret,
      manufacturerAddress: mfrAddress,
      clientIdentifier: attackerClient,
    });
    expect(attackerAttempt.valid).to.be.false;
    expect(attackerAttempt.state).to.equal("locked");

    // CRITICAL ANTI-DoS INVARIANT:
    // Legitimate pharmacy from their client IP scanning the same unit is NOT locked out!
    const pharmacyAttempt = await verifyUnitSeal({
      unitId,
      secret,
      manufacturerAddress: mfrAddress,
      clientIdentifier: pharmacyClient,
    });
    expect(pharmacyAttempt.valid).to.be.true;
    expect(pharmacyAttempt.state).to.equal("verified");
  });

  it("Should apply exponential backoff on repeated client failures", async function () {
    const unitId = "505";
    const secret = "TUVW23456789";
    const client = "ip_hash_client_backoff_test";
    await registerUnitSeal(unitId, secret, 1);

    // Attempt 1 & 2: invalid, not locked
    const a1 = await verifyUnitSeal({ unitId, secret: "W1", manufacturerAddress: mfrAddress, clientIdentifier: client });
    expect(a1.state).to.equal("invalid");
    const a2 = await verifyUnitSeal({ unitId, secret: "W2", manufacturerAddress: mfrAddress, clientIdentifier: client });
    expect(a2.state).to.equal("invalid");

    // Attempt 3: triggers 1-minute backoff
    const a3 = await verifyUnitSeal({ unitId, secret: "W3", manufacturerAddress: mfrAddress, clientIdentifier: client });
    expect(a3.state).to.equal("locked");
    expect(a3.lockedUntil).to.be.a("string");

    // Attempt 4: triggers 5-minute backoff
    const a4 = await verifyUnitSeal({ unitId, secret: "W4", manufacturerAddress: mfrAddress, clientIdentifier: client });
    expect(a4.state).to.equal("locked");

    // Attempt 5: triggers 1-hour backoff
    const a5 = await verifyUnitSeal({ unitId, secret: "W5", manufacturerAddress: mfrAddress, clientIdentifier: client });
    expect(a5.state).to.equal("locked");
  });

  it("Should support versioned HMAC verifiers (v1:) with constant-time equality", async function () {
    const unitId = "606";
    const secret = "HMACVER1TEST";
    const verifier = computeSealVerifier(unitId, secret, "v1");
    expect(verifier).to.match(/^v1:[a-f0-9]{64}$/);

    await registerUnitSeal(unitId, secret, 1, "v1");
    const res = await verifyUnitSeal({
      unitId,
      secret,
      manufacturerAddress: mfrAddress,
    });
    expect(res.valid).to.be.true;
    expect(res.state).to.equal("verified");
  });
});
