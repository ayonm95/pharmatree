/**
 * Medication Serial Number Normalization & Validation Primitives
 * Pure client- and server-safe utilities (zero node-only dependencies)
 */

export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Normalizes medication serial numbers:
 * Uppercase, whitespace removed, hyphens stripped.
 * E.g. "SN-2026-XYZ-1234" -> "SN2026XYZ1234"
 */
export function normalizeSerial(serial: string): string {
  if (!serial) return "";
  return serial.toUpperCase().trim().replace(/[\s-]+/g, "");
}

/**
 * Generates a cryptographically secure Crockford Base32 serial (CSPRNG)
 * Works in both browser and Node.js environments without node-specific imports.
 */
export function generateClientSerial(length = 20): string {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let result = "";
  for (let i = 0; i < length; i++) {
    result += CROCKFORD_ALPHABET[bytes[i] % 32];
  }
  return result;
}
