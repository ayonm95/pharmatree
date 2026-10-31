import { describe, it, expect } from "vitest";
import { getClientIp, checkVendorDailyQuota } from "../src/lib/rateLimit";
import { hashClientIp, checkAndIncrementVendorQuotaDb } from "../src/lib/db";
import { NextRequest } from "next/server";

describe("Platform Security, IP Resolution & Vendor Quotas", () => {
  describe("Trusted Platform Header Resolution", () => {
    it("should prioritize x-vercel-forwarded-for over standard forwarded headers", () => {
      const req = new NextRequest("http://localhost:3000/api/pos/verify", {
        headers: {
          "x-vercel-forwarded-for": "198.51.100.55, 10.0.0.1",
          "x-forwarded-for": "203.0.113.1",
        },
      });
      expect(getClientIp(req)).toBe("198.51.100.55");
    });

    it("should prioritize x-real-ip if x-vercel-forwarded-for is missing", () => {
      const req = new NextRequest("http://localhost:3000/api/pos/verify", {
        headers: {
          "x-real-ip": "192.0.2.77",
          "x-forwarded-for": "10.0.0.2",
        },
      });
      expect(getClientIp(req)).toBe("192.0.2.77");
    });

    it("should correctly handle Cloudflare cf-connecting-ip", () => {
      const req = new NextRequest("http://localhost:3000/api/pos/verify", {
        headers: {
          "cf-connecting-ip": "198.51.100.99",
        },
      });
      expect(getClientIp(req)).toBe("198.51.100.99");
    });
  });

  describe("HMAC Server-Secret Client IP Hashing", () => {
    it("should produce consistent 32-character SHA-256 HMAC digests", () => {
      const ip = "203.0.113.195";
      const hash1 = hashClientIp(ip);
      const hash2 = hashClientIp(ip);
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(32);
    });

    it("should produce different digests for different IP addresses", () => {
      const hashA = hashClientIp("198.51.100.1");
      const hashB = hashClientIp("198.51.100.2");
      expect(hashA).not.toBe(hashB);
    });
  });

  describe("Vendor Daily Gasless Quota Management", () => {
    it("should permit transactions up to the daily threshold (50 tx/day)", async () => {
      const vendor = "0xe88a5608b536bcc9d557823234baca9a00f2540b";
      const quota = await checkVendorDailyQuota(vendor, 50);
      expect(quota.allowed).toBe(true);
      expect(quota.count).toBeGreaterThanOrEqual(1);
      expect(quota.remaining).toBeLessThanOrEqual(50);
    });

    it("should reject transactions and return allowed: false when quota is exceeded", async () => {
      const testVendor = "0x1111222233334444555566667777888899990000";
      // Cap at 3 for rapid test execution
      const r1 = await checkAndIncrementVendorQuotaDb(testVendor, 3);
      expect(r1.allowed).toBe(true);
      const r2 = await checkAndIncrementVendorQuotaDb(testVendor, 3);
      expect(r2.allowed).toBe(true);
      const r3 = await checkAndIncrementVendorQuotaDb(testVendor, 3);
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);

      // 4th request must be disallowed
      const r4 = await checkAndIncrementVendorQuotaDb(testVendor, 3);
      expect(r4.allowed).toBe(false);
      expect(r4.remaining).toBe(0);
    });
  });
});
