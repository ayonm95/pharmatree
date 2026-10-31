import { NextRequest } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { checkAndIncrementVendorQuotaDb } from "./db";

interface RateLimitRecord {
  timestamps: number[];
}

// In-memory sliding-window store
const rateLimitStore = new Map<string, RateLimitRecord>();

// Periodic garbage collection every 2 minutes
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000;
let lastCleanup = Date.now();

function purgeExpiredRecords(now: number, maxWindowMs: number) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, record] of rateLimitStore.entries()) {
    record.timestamps = record.timestamps.filter((ts) => now - ts < maxWindowMs);
    if (record.timestamps.length === 0) {
      rateLimitStore.delete(key);
    }
  }
}

export interface RateLimitOptions {
  limit?: number;        // Max requests in window
  windowMs?: number;     // Window size in ms (default: 60s)
  prefix?: string;       // Route or category prefix
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset: number;         // Unix timestamp in seconds when oldest request expires
  retryAfter: number;    // Seconds to wait before retry
}

/**
 * Normalizes an IP address. IPv4 addresses are returned trimmed.
 * IPv6 addresses are bucketed into their /64 network CIDR prefix to prevent
 * attackers rotating through 2^64 host addresses within the same subnet to bypass rate limits.
 */
export function normalizeIp(rawIp: string): string {
  const ip = rawIp.trim();
  if (!ip.includes(":")) {
    return ip;
  }
  const cleanIp = ip.replace(/^\[|\](:\d+)?$/g, "");
  const parts = cleanIp.split("::");
  let segments: string[] = [];
  if (parts.length === 1) {
    segments = cleanIp.split(":");
  } else {
    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts[1] ? parts[1].split(":") : [];
    const missing = 8 - (left.length + right.length);
    const middle = Array(Math.max(0, missing)).fill("0");
    segments = [...left, ...middle, ...right];
  }
  const prefix64 = segments
    .slice(0, 4)
    .map((s) => s.padStart(4, "0").toLowerCase())
    .join(":");
  return `${prefix64}::/64`;
}

/**
 * Extracts a resilient client IP from standard Next.js and edge platform headers.
 * When TRUSTED_PROXY is configured, reads strictly that header to prevent header spoofing.
 * Otherwise, uses attested platform header fallback order.
 * All IPv6 addresses are bucketed into /64 network prefixes.
 */
export function getClientIp(req: NextRequest): string {
  const trustedProxy = process.env.TRUSTED_PROXY?.toLowerCase().trim();
  let rawIp: string | null = null;

  if (trustedProxy === "cloudflare" || trustedProxy === "cf-connecting-ip") {
    rawIp = req.headers.get("cf-connecting-ip");
  } else if (trustedProxy === "vercel" || trustedProxy === "x-vercel-forwarded-for") {
    rawIp = req.headers.get("x-vercel-forwarded-for");
  } else if (trustedProxy === "nginx" || trustedProxy === "x-real-ip") {
    rawIp = req.headers.get("x-real-ip");
  } else if (trustedProxy === "standard" || trustedProxy === "x-forwarded-for") {
    rawIp = req.headers.get("x-forwarded-for");
  } else {
    // Multi-tier fallback prioritizing platform headers
    rawIp =
      req.headers.get("x-vercel-forwarded-for") ||
      req.headers.get("x-real-ip") ||
      req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-forwarded-for");
  }

  const selected = rawIp ? rawIp.split(",")[0].trim() : "127.0.0.1";
  return normalizeIp(selected);
}

// Initialize Upstash Redis if environment credentials exist
const upstashRatelimitMap = new Map<string, any>();
const hasUpstash = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

/**
 * Evaluates rate limit using Upstash Redis (if configured) with fail-closed / fail-open semantics,
 * or falls back to in-memory sliding-window rate limiting.
 */
export async function checkRateLimitAsync(
  req: NextRequest,
  options: RateLimitOptions = {}
): Promise<RateLimitResult> {
  const limit = options.limit ?? 60;
  const prefix = options.prefix ?? "api";
  const ip = getClientIp(req);

  if (hasUpstash) {
    try {
      let limiter = upstashRatelimitMap.get(prefix);
      if (!limiter) {
        const redis = Redis.fromEnv();
        limiter = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(limit, "60 s"),
          prefix: `pharma:${prefix}`,
        });
        upstashRatelimitMap.set(prefix, limiter);
      }

      const res = await limiter.limit(ip);
      const resetSeconds = Math.ceil(res.reset / 1000);
      const retryAfter = Math.max(1, Math.ceil((res.reset - Date.now()) / 1000));

      return {
        allowed: res.success,
        limit,
        remaining: res.remaining,
        reset: resetSeconds,
        retryAfter: res.success ? 0 : retryAfter,
      };
    } catch (err) {
      console.warn(`[RateLimit] Upstash error on ${prefix}:`, err);
      // Fail closed on state-changing POS sell, fail open on read-only queries
      if (prefix === "pos-sell") {
        return {
          allowed: false,
          limit,
          remaining: 0,
          reset: Math.ceil(Date.now() / 1000) + 60,
          retryAfter: 60,
        };
      }
      return {
        allowed: true,
        limit,
        remaining: 1,
        reset: Math.ceil(Date.now() / 1000) + 60,
        retryAfter: 0,
      };
    }
  }

  // Fallback to in-memory sliding window
  return checkRateLimit(req, options);
}

/**
 * Synchronous in-memory sliding-window rate limit evaluator
 */
export function checkRateLimit(
  req: NextRequest,
  options: RateLimitOptions = {}
): RateLimitResult {
  const limit = options.limit ?? 60;
  const windowMs = options.windowMs ?? 60 * 1000;
  const prefix = options.prefix ?? "api";

  const ip = getClientIp(req);
  const key = `${prefix}:${ip}`;
  const now = Date.now();

  purgeExpiredRecords(now, windowMs);

  let record = rateLimitStore.get(key);
  if (!record) {
    record = { timestamps: [] };
    rateLimitStore.set(key, record);
  }

  // Filter timestamps outside current rolling window
  record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);

  const resetTimeMs = record.timestamps.length > 0
    ? record.timestamps[0] + windowMs
    : now + windowMs;
  const resetSeconds = Math.ceil(resetTimeMs / 1000);
  const retryAfter = Math.max(1, Math.ceil((resetTimeMs - now) / 1000));

  if (record.timestamps.length >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      reset: resetSeconds,
      retryAfter,
    };
  }

  // Record this request
  record.timestamps.push(now);

  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - record.timestamps.length),
    reset: resetSeconds,
    retryAfter: 0,
  };
}

/**
 * Formats rate limit result into standard response headers
 */
export function getRateLimitHeaders(res: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(res.limit),
    "X-RateLimit-Remaining": String(res.remaining),
    "X-RateLimit-Reset": String(res.reset),
  };
  if (!res.allowed) {
    headers["Retry-After"] = String(res.retryAfter);
  }
  return headers;
}

/**
 * Sanitizes user input string: strips non-printable ASCII control characters, trims whitespace, and limits length.
 * Does not entity-encode characters to avoid corrupting cryptographic tokens, hashes, and secrets.
 */
export function sanitizeInputString(raw: unknown, maxLength = 256): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\x00-\x1F\x7F]/g, "") // Strip control characters
    .trim()
    .slice(0, maxLength);
}

// Durable vendor quotas are managed via Postgres in lib/db.ts
/**
 * Checks and increments the daily transaction/gas quota for an authenticated vendor wallet
 * Default limit: 50 dispensing transactions per 24-hour UTC day
 */
export async function checkVendorDailyQuota(
  vendorAddress: string,
  limit = 50
): Promise<{ allowed: boolean; count: number; remaining: number }> {
  const cleanVendor = vendorAddress.toLowerCase();
  const dayKey = `vendor-daily:${cleanVendor}:${new Date().toISOString().slice(0, 10)}`;

  if (hasUpstash) {
    try {
      const redis = Redis.fromEnv();
      const count = await redis.incr(dayKey);
      if (count === 1) {
        await redis.expire(dayKey, 86400); // 24 hours
      }
      return {
        allowed: count <= limit,
        count,
        remaining: Math.max(0, limit - count),
      };
    } catch (err) {
      console.warn("[RateLimit] Upstash quota error, falling back to database/in-memory:", err);
    }
  }

  // Fallback to durable Postgres database (with in-memory fallback)
  return checkAndIncrementVendorQuotaDb(cleanVendor, limit);
}

/**
 * Validates Ethereum addresses
 */
export function isValidEthAddress(address: unknown): address is string {
  if (typeof address !== "string") return false;
  return /^0x[0-9a-fA-F]{40}$/.test(address.trim());
}

/**
 * Safely parses and bounds a positive integer
 */
export function parseSafePositiveInt(raw: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num <= 0 || num > max) {
    return null;
  }
  return num;
}
