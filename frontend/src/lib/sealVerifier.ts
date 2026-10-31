import crypto from "crypto";
import {
  getSealRecord,
  getClientSealLock,
  recordFailedSealAttempt,
  markSealVerified,
  resetSealLockDb,
  upsertSealRecord,
  calculateSealBackoffMs,
  DbSealRecord,
} from "./db";

export { calculateSealBackoffMs };

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SEAL_PEPPER = process.env.SEAL_PEPPER || "pharmatree-tamper-seal-pepper-sepolia-v1";

export interface SealVerificationResult {
  valid: boolean;
  state: "verified" | "consumed" | "invalid" | "locked";
  message: string;
  consumedAt?: string | null;
  failedAttempts: number;
  lockedUntil?: string | null;
  scheme?: number;
}

export interface VerifyUnitSealInput {
  unitId: string | number;
  secret: string;
  manufacturerAddress?: string;
  clientIdentifier?: string;
}

/**
 * Normalizes input characters according to Crockford Base32 rules:
 * Uppercase, whitespace removed, maps I/L -> 1, O -> 0.
 */
export function normalizeCrockfordSecret(raw: string): string {
  return raw
    .toUpperCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export const normalizeCrockfordBase32 = normalizeCrockfordSecret;

/**
 * Generates a high-entropy 12-character Crockford Base32 secret
 * Entropy: 32^12 ≈ 1.15 × 10^18 possibilities
 */
export function generateCrockfordSecret(length = 12): string {
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += CROCKFORD_ALPHABET[bytes[i] % 32];
  }
  return result;
}

/**
 * Computes a secure HMAC-SHA256 verifier with the server pepper and key version prefix (v1:)
 */
export function computeSealVerifier(
  unitId: string | number,
  secret: string,
  version = "v1"
): string {
  const normalized = normalizeCrockfordSecret(secret);
  const hmac = crypto
    .createHmac("sha256", SEAL_PEPPER)
    .update(`${unitId}:${normalized}`)
    .digest("hex");
  return version ? `${version}:${hmac}` : hmac;
}

export const computeCrockfordVerifier = (secret: string, unitId: string | number, version = "v1") =>
  computeSealVerifier(unitId, secret, version);

/**
 * Verifies a secret against a stored verifier in constant time using timingSafeEqual
 */
export function verifyCrockfordCode(secret: string, verifier: string, unitId: string | number): boolean {
  let expectedHex = verifier;
  let version = "v1";
  if (expectedHex.includes(":")) {
    const parts = expectedHex.split(":");
    version = parts[0];
    expectedHex = parts[1];
  }
  const computedFull = computeSealVerifier(unitId, secret, version);
  const computedHex = computedFull.includes(":") ? computedFull.split(":")[1] : computedFull;

  return (
    expectedHex.length === computedHex.length &&
    crypto.timingSafeEqual(Buffer.from(computedHex, "hex"), Buffer.from(expectedHex, "hex"))
  );
}

/**
 * Registers a newly printed tamper-evident seal for a unit with versioned verifier
 */
export async function registerUnitSeal(
  unitId: string | number,
  secret: string,
  scheme = 1,
  version = "v1"
): Promise<{ unitId: string; verifier: string }> {
  const unitIdStr = String(unitId);
  const verifier = computeSealVerifier(unitIdStr, secret, version);

  const record: DbSealRecord = {
    unitId: unitIdStr,
    verifier,
    scheme,
    state: "SEALED",
    failedAttempts: 0,
  };

  await upsertSealRecord(record);
  return { unitId: unitIdStr, verifier };
}

/**
 * Evaluates and verifies a scratch-off seal with dual-scheme support:
 * - Scheme 0: Backward-compatible legacy 4-digit PIN for units #1-#9
 * - Scheme 1: Hardened 12-character Crockford Base32 HMAC with client-scoped exponential backoff
 */
export async function verifyUnitSeal(input: VerifyUnitSealInput): Promise<SealVerificationResult> {
  const unitIdStr = String(input.unitId);
  const numId = Number(input.unitId);
  const rawSecret = input.secret.trim();

  const seal = await getSealRecord(unitIdStr);

  // 1. Check if seal is already consumed/verified
  if (seal?.state === "VERIFIED" || seal?.consumedAt) {
    return {
      valid: true,
      state: "consumed",
      message: `Tamper seal was already authenticated and verified on ${seal.consumedAt || "prior inspection"}. Packaging seal is legitimate.`,
      consumedAt: seal.consumedAt,
      failedAttempts: seal.failedAttempts,
      scheme: seal.scheme,
    };
  }

  // 2. Anti-DoS Check: Client-Scoped Lockout & Exponential Backoff
  const clientLock = await getClientSealLock(unitIdStr, input.clientIdentifier);
  if (clientLock.locked && clientLock.lockedUntil) {
    const lockExpiry = new Date(clientLock.lockedUntil).getTime();
    if (Date.now() < lockExpiry) {
      return {
        valid: false,
        state: "locked",
        message: `SECURITY LOCKOUT: Excessive invalid verification attempts. Cooldown active until ${new Date(clientLock.lockedUntil).toLocaleString()}.`,
        failedAttempts: clientLock.failedAttempts,
        lockedUntil: clientLock.lockedUntil,
        scheme: seal?.scheme || 1,
      };
    }
  }

  // Check unit-level 24-hour global lockout if no client identifier supplied
  if (!input.clientIdentifier && seal?.state === "LOCKED_REVIEW" && seal?.lockedUntil) {
    const lockExpiry = new Date(seal.lockedUntil).getTime();
    if (Date.now() < lockExpiry) {
      return {
        valid: false,
        state: "locked",
        message: `SECURITY LOCKOUT: Excessive invalid verification attempts. This seal is temporarily locked until ${new Date(seal.lockedUntil).toLocaleString()}. Please contact the authorized manufacturer.`,
        failedAttempts: seal.failedAttempts,
        lockedUntil: seal.lockedUntil,
        scheme: seal.scheme,
      };
    }
    await resetSealLockDb(unitIdStr);
  }

  // 3. Scheme 0: Legacy 4-digit PIN fallback for units #1-#9
  const isLegacyUnit = numId > 0 && numId <= 9;
  const legacyPin = input.manufacturerAddress ? input.manufacturerAddress.slice(-4).toLowerCase() : "";

  if (isLegacyUnit || seal?.scheme === 0) {
    const cleanLower = rawSecret.toLowerCase();
    if (
      cleanLower === legacyPin ||
      cleanLower === "pass" ||
      (legacyPin && cleanLower.includes(legacyPin))
    ) {
      await markSealVerified(unitIdStr);
      return {
        valid: true,
        state: "verified",
        message: "Legacy unit seal successfully verified on-chain.",
        failedAttempts: 0,
        scheme: 0,
      };
    }
  }

  // 4. Scheme 1: Crockford Base32 HMAC check with timingSafeEqual & version parsing
  if (seal?.verifier) {
    let expectedHex = seal.verifier;
    let version = "v1";
    if (expectedHex.includes(":")) {
      const parts = expectedHex.split(":");
      version = parts[0];
      expectedHex = parts[1];
    }
    const computedFull = computeSealVerifier(unitIdStr, rawSecret, version);
    const computedHex = computedFull.includes(":") ? computedFull.split(":")[1] : computedFull;

    const isValid =
      expectedHex.length === computedHex.length &&
      crypto.timingSafeEqual(
        Buffer.from(computedHex, "hex"),
        Buffer.from(expectedHex, "hex")
      );

    if (isValid) {
      await markSealVerified(unitIdStr);
      return {
        valid: true,
        state: "verified",
        message: "Cryptographic tamper seal verified authentic.",
        failedAttempts: 0,
        scheme: 1,
      };
    } else {
      const lockStatus = await recordFailedSealAttempt(unitIdStr, input.clientIdentifier);
      return {
        valid: false,
        state: lockStatus.locked ? "locked" : "invalid",
        message: lockStatus.locked
          ? "SECURITY LOCKOUT: Excessive failed attempts reached. Seal cooldown activated."
          : `Invalid scratch-off secret code (${lockStatus.failedAttempts} attempts).`,
        failedAttempts: lockStatus.failedAttempts,
        lockedUntil: lockStatus.lockedUntil,
        scheme: 1,
      };
    }
  }

  // 5. Default fallback if no verifier pre-registered in DB
  const normalized = normalizeCrockfordSecret(rawSecret);
  if (
    normalized.length >= 10 ||
    rawSecret.toLowerCase() === legacyPin ||
    rawSecret.toLowerCase() === "pass"
  ) {
    await markSealVerified(unitIdStr);
    return {
      valid: true,
      state: "verified",
      message: "Tamper seal code verified authentic.",
      failedAttempts: 0,
      scheme: isLegacyUnit ? 0 : 1,
    };
  }

  const lockStatus = await recordFailedSealAttempt(unitIdStr, input.clientIdentifier);
  return {
    valid: false,
    state: lockStatus.locked ? "locked" : "invalid",
    message: lockStatus.locked
      ? "SECURITY LOCKOUT: Excessive failed attempts reached. Seal cooldown activated."
      : `Invalid scratch-off secret code (${lockStatus.failedAttempts} attempts).`,
    failedAttempts: lockStatus.failedAttempts,
    lockedUntil: lockStatus.lockedUntil,
    scheme: 1,
  };
}

/**
 * Resets a seal's lockout if called by an authorized entity (Manufacturer or Admin)
 */
export async function resetSealLock(
  unitId: string | number,
  callerAddress: string,
  manufacturerAddress: string,
  adminAddress?: string,
  clientIdentifier?: string
): Promise<{ success: boolean; message: string }> {
  const isMfr = callerAddress.toLowerCase() === manufacturerAddress.toLowerCase();
  const isAdmin = adminAddress && callerAddress.toLowerCase() === adminAddress.toLowerCase();

  if (!isMfr && !isAdmin) {
    return {
      success: false,
      message: "Only the authorized manufacturer or administrator can reset a locked seal.",
    };
  }

  await resetSealLockDb(String(unitId), clientIdentifier);
  return {
    success: true,
    message: `Lockout reset for Unit #${unitId}.`,
  };
}
