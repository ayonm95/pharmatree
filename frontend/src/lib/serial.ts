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
 * Generates a pseudo-random Crockford serial (browser safe)
 */
export function generateClientSerial(length = 20): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    const rand = Math.floor(Math.random() * 32);
    result += CROCKFORD_ALPHABET[rand];
  }
  return result;
}
