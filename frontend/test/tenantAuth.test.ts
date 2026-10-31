import { describe, it, expect, beforeEach } from "vitest";
import {
  hashApiKey,
  verifyApiKeyHash,
  resolveTenantFromHeaders,
  isVendorAllowedForTenant,
  checkTenantDailyQuota,
  resetTenantQuotaMemory,
  registerTenantInMemory,
  TenantRecord,
} from "../src/lib/tenantAuth";

describe("Tenant Authentication & Authorization System (TDD)", () => {
  beforeEach(() => {
    resetTenantQuotaMemory();
  });

  describe("API Key Hashing & Constant-Time Verification", () => {
    it("should compute SHA-256 hash of API key", () => {
      const key = "pt_live_enterprise_pharmacy_secret_12345";
      const hash1 = hashApiKey(key);
      const hash2 = hashApiKey(key);

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // 256-bit hex
      expect(hash1).not.toBe(key);
    });

    it("should verify valid API key hash with timing-safe comparison", () => {
      const key = "pt_live_city_hospital_abc987";
      const hash = hashApiKey(key);

      expect(verifyApiKeyHash(key, hash)).toBe(true);
      expect(verifyApiKeyHash("pt_live_city_hospital_wrong", hash)).toBe(false);
      expect(verifyApiKeyHash("", hash)).toBe(false);
    });
  });

  describe("Tenant Resolution from Request Headers", () => {
    it("should resolve default Demo Sandbox tenant when header is missing in demo/staging mode", () => {
      const headers = new Headers(); // No X-Tenant-Key
      const result = resolveTenantFromHeaders(headers, { allowDemoFallback: true });

      expect(result.authenticated).toBe(true);
      expect(result.tenant?.id).toBe("demo-public-sandbox");
      expect(result.tenant?.tier).toBe("sandbox");
      expect(result.tenant?.dailyQuota).toBe(10);
    });

    it("should reject missing header when demo fallback is disabled (strict enterprise mode)", () => {
      const headers = new Headers();
      const result = resolveTenantFromHeaders(headers, { allowDemoFallback: false });

      expect(result.authenticated).toBe(false);
      expect(result.error).toBe("MISSING_TENANT_KEY");
      expect(result.tenant).toBeUndefined();
    });

    it("should resolve an enterprise tenant with valid X-Tenant-Key", () => {
      const testKey = "pt_live_mercy_general_rx_8829";
      const testHash = hashApiKey(testKey);

      registerTenantInMemory({
        id: "tenant-mercy-general",
        name: "Mercy General Hospital Pharmacy",
        apiKeyHash: testHash,
        tier: "enterprise",
        dailyQuota: 500,
        allowedVendors: ["0xe88a5608b536bcc9d557823234baca9a00f2540b"],
        status: "active",
      });

      const headers = new Headers({
        "x-tenant-key": testKey,
      });

      const result = resolveTenantFromHeaders(headers);
      expect(result.authenticated).toBe(true);
      expect(result.tenant?.id).toBe("tenant-mercy-general");
      expect(result.tenant?.tier).toBe("enterprise");
      expect(result.tenant?.dailyQuota).toBe(500);
    });

    it("should resolve Bearer token in Authorization header", () => {
      const testKey = "pt_live_st_jude_rx_3321";
      const testHash = hashApiKey(testKey);

      registerTenantInMemory({
        id: "tenant-st-jude",
        name: "St Jude Medical Center",
        apiKeyHash: testHash,
        tier: "enterprise",
        dailyQuota: 250,
        allowedVendors: ["*"],
        status: "active",
      });

      const headers = new Headers({
        authorization: `Bearer ${testKey}`,
      });

      const result = resolveTenantFromHeaders(headers);
      expect(result.authenticated).toBe(true);
      expect(result.tenant?.id).toBe("tenant-st-jude");
    });

    it("should reject invalid or tampered API keys", () => {
      const headers = new Headers({
        "x-tenant-key": "pt_live_forged_key_00000000",
      });

      const result = resolveTenantFromHeaders(headers);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe("INVALID_TENANT_KEY");
    });

    it("should reject suspended tenants", () => {
      const testKey = "pt_live_suspended_rx_0000";
      const testHash = hashApiKey(testKey);

      registerTenantInMemory({
        id: "tenant-suspended-rx",
        name: "Suspended Pharmacy Network",
        apiKeyHash: testHash,
        tier: "enterprise",
        dailyQuota: 100,
        allowedVendors: ["*"],
        status: "suspended",
      });

      const headers = new Headers({
        "x-tenant-key": testKey,
      });

      const result = resolveTenantFromHeaders(headers);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe("TENANT_SUSPENDED");
    });
  });

  describe("Vendor Whitelist Authorization", () => {
    it("should allow any vendor when tenant has wildcard permission (*)", () => {
      const tenant: TenantRecord = {
        id: "tenant-wildcard",
        name: "Wildcard Tenant",
        apiKeyHash: "hash",
        tier: "enterprise",
        dailyQuota: 100,
        allowedVendors: ["*"],
        status: "active",
      };

      expect(isVendorAllowedForTenant(tenant, "0xe88a5608b536bcc9d557823234baca9a00f2540b")).toBe(true);
      expect(isVendorAllowedForTenant(tenant, "0x1111111111111111111111111111111111111111")).toBe(true);
    });

    it("should only allow whitelisted vendor addresses for specific tenants", () => {
      const authorizedVendor = "0xe88a5608b536bcc9d557823234baca9a00f2540b";
      const unauthorizedVendor = "0x2222222222222222222222222222222222222222";

      const tenant: TenantRecord = {
        id: "tenant-restricted",
        name: "Restricted Clinic",
        apiKeyHash: "hash",
        tier: "enterprise",
        dailyQuota: 50,
        allowedVendors: [authorizedVendor],
        status: "active",
      };

      expect(isVendorAllowedForTenant(tenant, authorizedVendor)).toBe(true);
      expect(isVendorAllowedForTenant(tenant, unauthorizedVendor)).toBe(false);
    });
  });

  describe("Tenant Daily Quota & Throttling", () => {
    it("should enforce daily quota limits and decrement remaining quota", async () => {
      const tenantId = "tenant-quota-test";
      const limit = 3;

      const q1 = await checkTenantDailyQuota(tenantId, limit);
      expect(q1.allowed).toBe(true);
      expect(q1.count).toBe(1);
      expect(q1.remaining).toBe(2);

      const q2 = await checkTenantDailyQuota(tenantId, limit);
      expect(q2.allowed).toBe(true);
      expect(q2.count).toBe(2);
      expect(q2.remaining).toBe(1);

      const q3 = await checkTenantDailyQuota(tenantId, limit);
      expect(q3.allowed).toBe(true);
      expect(q3.count).toBe(3);
      expect(q3.remaining).toBe(0);

      const q4 = await checkTenantDailyQuota(tenantId, limit);
      expect(q4.allowed).toBe(false);
      expect(q4.count).toBe(4);
      expect(q4.remaining).toBe(0);
    });
  });
});
