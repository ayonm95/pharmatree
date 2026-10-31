import crypto from "crypto";
import { checkAndIncrementTenantQuotaDb, resetInMemoryTenantQuotas } from "./db";

export type TenantTier = "sandbox" | "starter" | "enterprise";
export type TenantStatus = "active" | "suspended";

export interface TenantRecord {
  id: string;
  name: string;
  apiKeyHash: string; // SHA-256 hex string
  tier: TenantTier;
  dailyQuota: number;
  allowedVendors: string[]; // List of Ethereum addresses in lowercase or ["*"]
  status: TenantStatus;
}

export interface TenantResolutionResult {
  authenticated: boolean;
  tenant?: TenantRecord;
  error?: "MISSING_TENANT_KEY" | "INVALID_TENANT_KEY" | "TENANT_SUSPENDED";
  message?: string;
}

/**
 * Built-in Sandbox Tenant used for public testing on Vercel (pharmatree.vercel.app)
 */
export const DEFAULT_DEMO_SANDBOX_TENANT: TenantRecord = {
  id: "demo-public-sandbox",
  name: "Public Demonstration Sandbox",
  apiKeyHash: "demo_sandbox_unrestricted_hash",
  tier: "sandbox",
  dailyQuota: 10,
  allowedVendors: ["*"],
  status: "active",
};

// In-memory tenant registry (loaded from environment or runtime)
const inMemoryTenants: Record<string, TenantRecord> = {};

/**
 * Register a tenant in memory (useful for testing and static configuration)
 */
export function registerTenantInMemory(tenant: TenantRecord): void {
  inMemoryTenants[tenant.id] = {
    ...tenant,
    allowedVendors: tenant.allowedVendors.map((v) => v.toLowerCase().trim()),
  };
}

/**
 * Compute SHA-256 hash of an API key
 */
export function hashApiKey(apiKey: string): string {
  if (!apiKey || typeof apiKey !== "string") {
    return "";
  }
  return crypto.createHash("sha256").update(apiKey.trim()).digest("hex");
}

/**
 * Verify provided API key against a stored SHA-256 hash using constant-time comparison
 */
export function verifyApiKeyHash(providedKey: string, storedHash: string): boolean {
  if (!providedKey || !storedHash) return false;
  const computedHash = hashApiKey(providedKey);

  const bufA = Buffer.from(computedHash, "hex");
  const bufB = Buffer.from(storedHash, "hex");

  if (bufA.length !== bufB.length || bufA.length === 0) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Find tenant by matching API key hash
 */
function findTenantByApiKey(apiKey: string): TenantRecord | null {
  if (!apiKey) return null;
  const trimmedKey = apiKey.trim();

  // 1. Check in-memory registered tenants
  for (const tenant of Object.values(inMemoryTenants)) {
    if (verifyApiKeyHash(trimmedKey, tenant.apiKeyHash)) {
      return tenant;
    }
  }

  // 2. Check environment variable configuration if present (JSON formatted)
  if (process.env.PHARMA_TENANTS_CONFIG) {
    try {
      const configuredTenants: TenantRecord[] = JSON.parse(process.env.PHARMA_TENANTS_CONFIG);
      for (const t of configuredTenants) {
        if (verifyApiKeyHash(trimmedKey, t.apiKeyHash)) {
          return {
            ...t,
            allowedVendors: (t.allowedVendors || ["*"]).map((v) => v.toLowerCase().trim()),
          };
        }
      }
    } catch (e) {
      console.warn("[TenantAuth] Failed to parse PHARMA_TENANTS_CONFIG:", e);
    }
  }

  return null;
}

/**
 * Resolve tenant from request headers
 * Supports `x-tenant-key` header and `authorization: Bearer <key>`
 */
export function resolveTenantFromHeaders(
  headers: Headers,
  options: { allowDemoFallback?: boolean } = { allowDemoFallback: true }
): TenantResolutionResult {
  let extractedKey: string | null = null;

  // 1. Check X-Tenant-Key
  const headerKey = headers.get("x-tenant-key");
  if (headerKey && headerKey.trim()) {
    extractedKey = headerKey.trim();
  }

  // 2. Check Authorization Bearer
  if (!extractedKey) {
    const authHeader = headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      extractedKey = authHeader.substring(7).trim();
    }
  }

  // 3. If no key is provided
  if (!extractedKey) {
    if (options.allowDemoFallback) {
      return {
        authenticated: true,
        tenant: DEFAULT_DEMO_SANDBOX_TENANT,
      };
    }
    return {
      authenticated: false,
      error: "MISSING_TENANT_KEY",
      message: "An X-Tenant-Key or Bearer token is required to access privileged POS endpoints.",
    };
  }

  // 4. Validate provided key
  const tenant = findTenantByApiKey(extractedKey);
  if (!tenant) {
    return {
      authenticated: false,
      error: "INVALID_TENANT_KEY",
      message: "The provided X-Tenant-Key is unrecognized or invalid.",
    };
  }

  if (tenant.status === "suspended") {
    return {
      authenticated: false,
      error: "TENANT_SUSPENDED",
      message: `Tenant account '${tenant.name}' has been suspended. Please contact platform operations.`,
    };
  }

  return {
    authenticated: true,
    tenant,
  };
}

/**
 * Validates whether a vendor wallet is authorized to transact on behalf of a tenant
 */
export function isVendorAllowedForTenant(tenant: TenantRecord, vendorAddress: string): boolean {
  if (!vendorAddress) return false;
  const cleanVendor = vendorAddress.toLowerCase().trim();

  if (tenant.allowedVendors.includes("*")) {
    return true;
  }

  return tenant.allowedVendors.some((allowed) => allowed.toLowerCase() === cleanVendor);
}

/**
 * Checks and increments daily quota for a tenant
 */
export async function checkTenantDailyQuota(
  tenantId: string,
  limit: number
): Promise<{ allowed: boolean; count: number; remaining: number }> {
  return checkAndIncrementTenantQuotaDb(tenantId, limit);
}

/**
 * Reset memory state (useful for tests)
 */
export function resetTenantQuotaMemory(): void {
  resetInMemoryTenantQuotas();
  for (const k of Object.keys(inMemoryTenants)) {
    delete inMemoryTenants[k];
  }
}
