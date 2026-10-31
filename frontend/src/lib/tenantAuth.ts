import crypto from "crypto";
import {
  checkAndIncrementTenantQuotaDb,
  resetInMemoryTenantQuotas,
  consumeResetNonceDb,
  resetInMemoryResetNonces,
  getDurableTenantByApiKeyHash,
} from "./db";

export type TenantTier = "sandbox" | "starter" | "standard" | "enterprise";
export type TenantStatus = "active" | "suspended";

/**
 * Canonical Tier Quotas across the platform:
 * - Sandbox: 10 tx/day
 * - Starter / Standard: 100 tx/day
 * - Enterprise: 1000 tx/day
 */
export const TIER_QUOTAS: Record<string, number> = {
  sandbox: 10,
  starter: 100,
  standard: 100, // Alias for starter
  enterprise: 1000,
};

/**
 * Resolves the daily transaction quota for a tenant tier.
 * Unknown or undefined tiers fail closed by returning null.
 */
export function getQuotaForTier(tier: string | undefined | null): number | null {
  if (!tier || typeof tier !== "string") return null;
  const normalized = tier.toLowerCase().trim();
  if (normalized === "standard" || normalized === "starter") {
    return TIER_QUOTAS.starter;
  }
  if (normalized === "sandbox") {
    return TIER_QUOTAS.sandbox;
  }
  if (normalized === "enterprise") {
    return TIER_QUOTAS.enterprise;
  }
  return null; // Unknown tiers fail closed!
}

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
  dailyQuota: TIER_QUOTAS.sandbox,
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
      const isDemoEnabled =
        process.env.NODE_ENV === "test" ||
        process.env.DEMO_SANDBOX_ENABLED === "true" ||
        process.env.NEXT_PUBLIC_DEMO_SANDBOX_ENABLED === "true";

      const network = (process.env.NEXT_PUBLIC_NETWORK || process.env.CHAIN_NAME || "sepolia").toLowerCase();
      const isSepoliaOrLocal =
        process.env.NODE_ENV === "test" ||
        network.includes("sepolia") ||
        network.includes("localhost") ||
        network.includes("hardhat") ||
        network.includes("test");

      if (isDemoEnabled && isSepoliaOrLocal) {
        return {
          authenticated: true,
          tenant: DEFAULT_DEMO_SANDBOX_TENANT,
        };
      }
      return {
        authenticated: false,
        error: "MISSING_TENANT_KEY",
        message: "Public demo sandbox is disabled in this environment. An X-Tenant-Key is required.",
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
 * Resolve tenant from request headers asynchronously (with durable PostgreSQL lookup)
 * Supports `x-tenant-key` header and `authorization: Bearer <key>`
 */
export async function resolveTenantFromHeadersAsync(
  headers: Headers,
  options: { allowDemoFallback?: boolean } = { allowDemoFallback: true }
): Promise<TenantResolutionResult> {
  const syncResult = resolveTenantFromHeaders(headers, options);
  if (syncResult.authenticated || syncResult.error !== "INVALID_TENANT_KEY") {
    return syncResult;
  }

  // Attempt durable database lookup before concluding invalid
  let extractedKey: string | null = null;
  const headerKey = headers.get("x-tenant-key");
  if (headerKey && headerKey.trim()) extractedKey = headerKey.trim();
  if (!extractedKey) {
    const authHeader = headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) extractedKey = authHeader.substring(7).trim();
  }

  if (extractedKey) {
    const hash = hashApiKey(extractedKey);
    const durableTenant = await getDurableTenantByApiKeyHash(hash);
    if (durableTenant) {
      registerTenantInMemory(durableTenant);
      if (durableTenant.status === "suspended") {
        return {
          authenticated: false,
          error: "TENANT_SUSPENDED",
          message: `Tenant account '${durableTenant.name}' has been suspended. Please contact platform operations.`,
        };
      }
      return { authenticated: true, tenant: durableTenant };
    }
  }

  return syncResult;
}

/**
 * Checks and increments daily quota for a tenant.
 * When clientIp is provided (for demo sandbox), limits are partitioned per-IP.
 */
export async function checkTenantDailyQuota(
  tenantId: string,
  limit: number,
  clientIp?: string
): Promise<{ allowed: boolean; count: number; remaining: number }> {
  // Fail closed if limit is invalid or non-positive
  if (!limit || limit <= 0 || isNaN(limit)) {
    return { allowed: false, count: 0, remaining: 0 };
  }
  return checkAndIncrementTenantQuotaDb(tenantId, limit, clientIp);
}

/**
 * Atomically consumes a single-use administrative reset nonce to prevent signature replay attacks
 */
export async function consumeResetNonce(
  nonce: string,
  unitId: number
): Promise<{ success: boolean; error?: string }> {
  return consumeResetNonceDb(nonce, unitId);
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

export function resetResetNoncesMemory(): void {
  resetInMemoryResetNonces();
}
