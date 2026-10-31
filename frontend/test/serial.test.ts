import { describe, it, expect } from "vitest";
import {
  CROCKFORD_ALPHABET,
  normalizeSerial,
  generateClientSerial,
} from "../src/lib/serial";

describe("Serial Normalization & Generation (serial.ts)", () => {
  describe("normalizeSerial", () => {
    it("should strip dashes and whitespace", () => {
      expect(normalizeSerial("SN-2026-XYZ-1234")).toBe("SN2026XYZ1234");
      expect(normalizeSerial("  cd36-0dwj-zhax  ")).toBe("CD360DWJZHAX");
      expect(normalizeSerial("a b c - d e")).toBe("ABCDE");
    });

    it("should convert characters to uppercase", () => {
      expect(normalizeSerial("sggj9w55vg8htn8n0nmm")).toBe("SGGJ9W55VG8HTN8N0NMM");
    });

    it("should return empty string for empty, null, or undefined input", () => {
      expect(normalizeSerial("")).toBe("");
      expect(normalizeSerial(null as any)).toBe("");
      expect(normalizeSerial(undefined as any)).toBe("");
    });
  });

  describe("generateClientSerial (CSPRNG)", () => {
    it("should generate serial with default length 20", () => {
      const serial = generateClientSerial();
      expect(serial).toHaveLength(20);
    });

    it("should support custom lengths", () => {
      expect(generateClientSerial(12)).toHaveLength(12);
      expect(generateClientSerial(32)).toHaveLength(32);
    });

    it("should only contain valid Crockford Base32 characters", () => {
      const serial = generateClientSerial(100);
      for (const char of serial) {
        expect(CROCKFORD_ALPHABET.includes(char)).toBe(true);
      }
      // Crockford alphabet excludes confusing characters I, L, O, U
      expect(serial).not.toMatch(/[ILOU]/);
    });

    it("should generate cryptographically random, high-entropy unique serials across consecutive calls", () => {
      const set = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const serial = generateClientSerial(20);
        expect(set.has(serial)).toBe(false);
        set.add(serial);
      }
      expect(set.size).toBe(50);
    });
  });
});
