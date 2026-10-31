import { describe, it, expect, beforeEach } from "vitest";
import {
  normalizeCrockfordBase32,
  generateCrockfordSecret,
  computeCrockfordVerifier,
  verifyCrockfordCode,
  calculateSealBackoffMs,
  verifyUnitSeal,
  resetSealLock,
  registerUnitSeal,
} from "../src/lib/sealVerifier";
import { getClientSealLock, resetSealLockDb } from "../src/lib/db";

describe("Seal Verifier & Anti-DoS Logic", () => {
  beforeEach(async () => {
    await resetSealLockDb("101");
    await resetSealLockDb("102");
  });

  describe("Crockford Base32 Normalization & Secret Generation", () => {
    it("should normalize ambiguous characters (I/i/l/L -> 1, O/o -> 0)", () => {
      expect(normalizeCrockfordBase32("ilo-ILO")).toBe("110-110");
      expect(normalizeCrockfordBase32("ab-cd-ef")).toBe("AB-CD-EF");
      expect(normalizeCrockfordBase32("  7w x9  ")).toBe("7WX9");
    });

    it("should generate 12-character high-entropy Crockford secrets", () => {
      const secret = generateCrockfordSecret();
      expect(secret.length).toBe(12);
      expect(normalizeCrockfordBase32(secret)).toBe(secret);
    });

    it("should generate versioned HMAC verifiers with v1: prefix", () => {
      const secret = "J8K9MNP23456";
      const verifier = computeCrockfordVerifier(secret, "101");
      expect(verifier.startsWith("v1:")).toBe(true);
      expect(verifier.length).toBe(67); // 'v1:' (3 chars) + 64-char SHA256 hex digest
    });

    it("should verify correct codes using constant-time timingSafeEqual", () => {
      const secret = "J8K9MNP23456";
      const verifier = computeCrockfordVerifier(secret, "101");
      expect(verifyCrockfordCode("J8K9MNP23456", verifier, "101")).toBe(true);
      expect(verifyCrockfordCode("j8k9mnp23456", verifier, "101")).toBe(true); // Case-insensitive
      expect(verifyCrockfordCode("WRONGCODE123", verifier, "101")).toBe(false);
      expect(verifyCrockfordCode("J8K9MNP23456", verifier, "999")).toBe(false); // Unit ID bound
    });
  });

  describe("Exponential Backoff Timing", () => {
    it("should enforce correct backoff delays based on failure count", () => {
      expect(calculateSealBackoffMs(0)).toBe(0);
      expect(calculateSealBackoffMs(1)).toBe(0);
      expect(calculateSealBackoffMs(2)).toBe(0);
      expect(calculateSealBackoffMs(3)).toBe(60 * 1000); // 1 minute
      expect(calculateSealBackoffMs(4)).toBe(5 * 60 * 1000); // 5 minutes
      expect(calculateSealBackoffMs(5)).toBe(60 * 60 * 1000); // 1 hour
      expect(calculateSealBackoffMs(10)).toBe(60 * 60 * 1000); // 1 hour
    });
  });

  describe("Client Isolation & Anti-DoS Protection", () => {
    it("should isolate lockout to the attacker IP while legitimate client verifies successfully", async () => {
      const unitId = "101";
      const secret = "A1B2C3D4E5F6";
      await registerUnitSeal(unitId, secret);

      const attackerIp = "198.51.100.1";
      const legitimateIp = "203.0.113.42";

      // Attacker attempts 5 wrong guesses
      for (let i = 0; i < 5; i++) {
        const res = await verifyUnitSeal({
          unitId,
          secret: "BADGUESS0000",
          clientIdentifier: attackerIp,
        });
        expect(res.valid).toBe(false);
      }

      // Attacker is now locked out
      const attackerLock = await getClientSealLock(unitId, attackerIp);
      expect(attackerLock.locked).toBe(true);

      const attackerLockedRes = await verifyUnitSeal({
        unitId,
        secret,
        clientIdentifier: attackerIp,
      });
      expect(attackerLockedRes.state).toBe("locked");
      expect(attackerLockedRes.valid).toBe(false);

      // Legitimate dispensary on different IP is NOT locked out and succeeds
      const legitRes = await verifyUnitSeal({
        unitId,
        secret,
        clientIdentifier: legitimateIp,
      });
      expect(legitRes.valid).toBe(true);
      expect(legitRes.state).toBe("verified");
    });

    it("should allow authorized manufacturer or admin to reset lockout", async () => {
      const unitId = "102";
      const secret = "X7Y8Z9W01234";
      await registerUnitSeal(unitId, secret);

      const attackerIp = "192.0.2.99";
      for (let i = 0; i < 4; i++) {
        await verifyUnitSeal({
          unitId,
          secret: "WRONG",
          clientIdentifier: attackerIp,
        });
      }

      // Unauthorized party cannot reset
      const badReset = await resetSealLock(
        unitId,
        "0x000000000000000000000000000000000000dEaD",
        "0x65371f0ddFa0AD6e7655243cD2A2567328EA1537",
        "0x65371f0ddFa0AD6e7655243cD2A2567328EA1537"
      );
      expect(badReset.success).toBe(false);

      // Authorized manufacturer successfully resets
      const goodReset = await resetSealLock(
        unitId,
        "0x65371f0ddFa0AD6e7655243cD2A2567328EA1537",
        "0x65371f0ddFa0AD6e7655243cD2A2567328EA1537"
      );
      expect(goodReset.success).toBe(true);

      // Lockout is cleared
      const lockAfter = await getClientSealLock(unitId, attackerIp);
      expect(lockAfter.locked).toBe(false);
    });
  });
});
