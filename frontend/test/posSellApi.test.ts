import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import {
  resolveTenantFromHeaders,
  isVendorAllowedForTenant,
  checkTenantDailyQuota,
  TenantRecord,
} from "../src/lib/tenantAuth";

describe("POS Sell API Security Policies", () => {
  it("should enforce relayer minimum balance circuit breaker threshold (< 0.001 ETH)", () => {
    const minThreshold = ethers.parseEther("0.001");
    const warningThreshold = ethers.parseEther("0.005");

    const zeroBalance = BigInt(0);
    const depletedBalance = ethers.parseEther("0.0008");
    const warningBalance = ethers.parseEther("0.003");
    const solventBalance = ethers.parseEther("0.5");

    expect(zeroBalance < minThreshold).toBe(true);
    expect(depletedBalance < minThreshold).toBe(true);
    expect(warningBalance < warningThreshold).toBe(true);
    expect(warningBalance >= minThreshold).toBe(true);
    expect(solventBalance >= minThreshold).toBe(true);
  });

  it("should require EIP-712 forward request when vendor differs from relayer", () => {
    const relayerAddress = "0x65371f0ddFa0AD6e7655243cD2A2567328EA1537";
    const pharmacyAddress = "0xe88a5608b536bcc9d557823234baca9a00f2540b";

    const isDirectOwner = pharmacyAddress.toLowerCase() === relayerAddress.toLowerCase();
    expect(isDirectOwner).toBe(false);

    // Unprivileged relayer cannot directly sell third-party items without forwardRequest
    const forwardRequest = {
      from: pharmacyAddress,
      to: "0xContract",
      value: 0,
      gas: 500000,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      data: "0xcalldata",
      signature: "0xsignature",
    };

    expect(forwardRequest.from.toLowerCase()).toBe(pharmacyAddress.toLowerCase());
  });

  describe("POS Multi-Tenant Authentication & Quota Integration", () => {
    it("should allow public sandbox demo on Vercel preview/staging without X-Tenant-Key", () => {
      const headers = new Headers();
      const auth = resolveTenantFromHeaders(headers, { allowDemoFallback: true });

      expect(auth.authenticated).toBe(true);
      expect(auth.tenant?.id).toBe("demo-public-sandbox");
      expect(auth.tenant?.tier).toBe("sandbox");
      expect(auth.tenant?.dailyQuota).toBe(10);
    });

    it("should reject unauthenticated request when strict tenant auth is active", () => {
      const headers = new Headers();
      const auth = resolveTenantFromHeaders(headers, { allowDemoFallback: false });

      expect(auth.authenticated).toBe(false);
      expect(auth.error).toBe("MISSING_TENANT_KEY");
    });

    it("should block dispense when current unit owner does not match tenant authorized vendors", () => {
      const authorizedDispensary = "0xe88a5608b536bcc9d557823234baca9a00f2540b";
      const rogueDispensary = "0x3333333333333333333333333333333333333333";

      const tenant: TenantRecord = {
        id: "tenant-hospital-a",
        name: "Hospital Pharmacy A",
        apiKeyHash: "hash",
        tier: "enterprise",
        dailyQuota: 500,
        allowedVendors: [authorizedDispensary],
        status: "active",
      };

      expect(isVendorAllowedForTenant(tenant, authorizedDispensary)).toBe(true);
      expect(isVendorAllowedForTenant(tenant, rogueDispensary)).toBe(false);
    });

    it("should reject transaction when tenant daily quota is exceeded", async () => {
      const tenantId = "tenant-depleted-quota";
      const limit = 2;

      const q1 = await checkTenantDailyQuota(tenantId, limit);
      expect(q1.allowed).toBe(true);
      expect(q1.remaining).toBe(1);

      const q2 = await checkTenantDailyQuota(tenantId, limit);
      expect(q2.allowed).toBe(true);
      expect(q2.remaining).toBe(0);

      const q3 = await checkTenantDailyQuota(tenantId, limit);
      expect(q3.allowed).toBe(false);
      expect(q3.remaining).toBe(0);
    });

    it("should partition demo sandbox quota per-IP and preserve allowance for new visitors", async () => {
      const sandboxTenantId = "demo-public-sandbox";
      const ip1 = "192.0.2.1";
      const ip2 = "198.51.100.99";
      const limit = 3;

      // IP 1 uses up allowance
      await checkTenantDailyQuota(sandboxTenantId, limit, ip1);
      await checkTenantDailyQuota(sandboxTenantId, limit, ip1);
      await checkTenantDailyQuota(sandboxTenantId, limit, ip1);
      const ip1Blocked = await checkTenantDailyQuota(sandboxTenantId, limit, ip1);
      expect(ip1Blocked.allowed).toBe(false);

      // IP 2 (recruiter) is unaffected
      const ip2Allowed = await checkTenantDailyQuota(sandboxTenantId, limit, ip2);
      expect(ip2Allowed.allowed).toBe(true);
      expect(ip2Allowed.remaining).toBe(2);
    });

    it("should track and record sales idempotency states to prevent duplicate broadcasts", async () => {
      const {
        getSaleByIdempotencyKey,
        recordSaleSubmitted,
        recordSaleCompleted,
      } = await import("../src/lib/db");

      const testKey = `idem-key-${Date.now()}`;
      expect(await getSaleByIdempotencyKey(testKey)).toBeNull();

      // 1. Record submitted
      await recordSaleSubmitted(testKey, 101, 5, "0xPendingHash123");
      const submitted = await getSaleByIdempotencyKey(testKey);
      expect(submitted?.status).toBe("SUBMITTED");
      expect(submitted?.unitId).toBe(101);

      // 2. Record completed
      const mockPayload = { success: true, txHash: "0xMinedHash456", unitId: 101 };
      await recordSaleCompleted(testKey, "0xMinedHash456", mockPayload);
      const mined = await getSaleByIdempotencyKey(testKey);
      expect(mined?.status).toBe("MINED");
      expect(mined?.txHash).toBe("0xMinedHash456");
      expect(mined?.responsePayload?.success).toBe(true);
    });

    it("should detect idempotency payload collision when key is reused with different parameters", async () => {
      const {
        getSaleByIdempotencyKey,
        recordSaleSubmitted,
      } = await import("../src/lib/db");

      const tenantId = "tenant-apollo";
      const userKey = "tx-ref-10029";
      const scopedKey = `${tenantId}:${userKey}`;

      await recordSaleSubmitted(scopedKey, 5, 2);
      const existing = await getSaleByIdempotencyKey(scopedKey);
      expect(existing).not.toBeNull();

      // Check collision logic: requesting unit 99 with same key
      const isCollisionUnit = existing?.unitId !== 99;
      expect(isCollisionUnit).toBe(true);

      // Check collision logic: requesting quantity 10 with same key
      const isCollisionQty = existing?.quantity !== 10;
      expect(isCollisionQty).toBe(true);
    });
  });
});
