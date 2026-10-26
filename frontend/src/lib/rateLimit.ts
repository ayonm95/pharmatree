import { NextRequest } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

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
 * Extracts a resilient client IP from standard Next.js headers
 */
export function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return (
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    "127.0.0.1"
  );
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
 * Sanitizes generic user input to prevent XSS, HTML injection, and control characters
 */
export function sanitizeInputString(raw: unknown, maxLength = 256): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[<>'"&]/g, (char) => {
      switch (char) {
        case "<": return "&lt;";
        case ">": return "&gt;";
        case "'": return "&#39;";
        case '"': return "&quot;";
        case "&": return "&amp;";
        default: return char;
      }
    })
    .replace(/[\x00-\x1F\x7F]/g, "") // Strip control characters
    .trim()
    .slice(0, maxLength);
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
