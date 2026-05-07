/**
 * Gbox Platform — Rate Limiting Module
 *
 * Hybrid rate limiter for auth endpoints.
 * Per IRON RULE #1: Rate limiting on ALL auth endpoints (5 attempts/minute).
 *
 * Storage strategy:
 *   - If REDIS_URL is set, uses Redis (shared across processes/replicas).
 *   - Otherwise, falls back to in-memory Map (single-process only).
 */

import { getRedis } from '../cache/redis.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining attempts in the current window */
  remaining: number;
  /** Seconds until the limit resets (only set when blocked) */
  retryAfter?: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
  lockedUntil?: number;
}

// ---------------------------------------------------------------------------
// In-memory fallback state
// ---------------------------------------------------------------------------

const attempts = new Map<string, RateLimitEntry>();

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
// Lockout after 5 attempts/minute. Kept short (5 min) so legitimate users
// who fat-finger a password don't have to sit out a quarter of an hour —
// brute-force is still throttled to 60 tries/hour per IP which is the
// relevant protection Iron Rule 1 really cares about.
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Redis availability check
// ---------------------------------------------------------------------------

let _redisAvailable: boolean | null = null;

async function isRedisAvailable(): Promise<boolean> {
  if (_redisAvailable !== null) return _redisAvailable;
  if (!process.env.REDIS_URL) {
    _redisAvailable = false;
    return false;
  }
  try {
    const redis = await getRedis();
    _redisAvailable = redis.isReady;
    return _redisAvailable;
  } catch {
    _redisAvailable = false;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Redis-backed implementation
// ---------------------------------------------------------------------------

const REDIS_PREFIX = 'ratelimit:';

async function checkRateLimitRedis(
  key: string,
  maxAttempts: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const redis = await getRedis();
  const redisKey = `${REDIS_PREFIX}${key}`;
  const lockKey = `${REDIS_PREFIX}lock:${key}`;

  // Check if currently locked out
  const lockTtl = await redis.ttl(lockKey);
  if (lockTtl > 0) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: lockTtl,
    };
  }

  // Increment the counter
  const count = await redis.incr(redisKey);

  // Set TTL on first request in window
  if (count === 1) {
    await redis.pExpire(redisKey, windowMs);
  }

  // Over the limit — lock for 15 minutes
  if (count > maxAttempts) {
    const lockDurationSec = Math.ceil(LOCKOUT_DURATION_MS / 1000);
    await redis.set(lockKey, '1', { EX: lockDurationSec });
    return {
      allowed: false,
      remaining: 0,
      retryAfter: lockDurationSec,
    };
  }

  return {
    allowed: true,
    remaining: maxAttempts - count,
  };
}

async function resetRateLimitRedis(key: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(`${REDIS_PREFIX}${key}`);
  await redis.del(`${REDIS_PREFIX}lock:${key}`);
}

async function getRateLimitStateRedis(key: string): Promise<RateLimitResult> {
  const redis = await getRedis();
  const redisKey = `${REDIS_PREFIX}${key}`;
  const lockKey = `${REDIS_PREFIX}lock:${key}`;

  const lockTtl = await redis.ttl(lockKey);
  if (lockTtl > 0) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: lockTtl,
    };
  }

  const countStr = await redis.get(redisKey);
  const count = countStr ? parseInt(countStr, 10) : 0;

  return {
    allowed: count < DEFAULT_MAX_ATTEMPTS,
    remaining: Math.max(0, DEFAULT_MAX_ATTEMPTS - count),
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

function checkRateLimitMemory(
  key: string,
  maxAttempts: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const entry = attempts.get(key);

  // Check if currently locked out
  if (entry?.lockedUntil && entry.lockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((entry.lockedUntil - now) / 1000),
    };
  }

  // Reset if window has expired
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxAttempts - 1 };
  }

  // Over the limit — lock for 15 minutes
  if (entry.count >= maxAttempts) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil(LOCKOUT_DURATION_MS / 1000),
    };
  }

  // Under the limit — increment
  entry.count++;
  return { allowed: true, remaining: maxAttempts - entry.count };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check and record an attempt against the rate limiter.
 *
 * @param key       Unique key (e.g. `login:192.168.1.1` or `login:user@email.com`)
 * @param maxAttempts  Max requests within the window (default: 5)
 * @param windowMs     Window duration in ms (default: 60 000)
 */
export async function checkRateLimit(
  key: string,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  windowMs: number = DEFAULT_WINDOW_MS
): Promise<RateLimitResult> {
  try {
    if (await isRedisAvailable()) {
      return await checkRateLimitRedis(key, maxAttempts, windowMs);
    }
  } catch {
    // Redis error — fall through to in-memory
  }
  return checkRateLimitMemory(key, maxAttempts, windowMs);
}

/**
 * Reset the rate limit for a key (e.g. after successful login).
 */
export async function resetRateLimit(key: string): Promise<void> {
  try {
    if (await isRedisAvailable()) {
      await resetRateLimitRedis(key);
      return;
    }
  } catch {
    // Redis error — fall through to in-memory
  }
  attempts.delete(key);
}

/**
 * Get current state for a key without recording an attempt.
 */
export async function getRateLimitState(key: string): Promise<RateLimitResult> {
  try {
    if (await isRedisAvailable()) {
      return await getRateLimitStateRedis(key);
    }
  } catch {
    // Redis error — fall through to in-memory
  }

  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry) {
    return { allowed: true, remaining: DEFAULT_MAX_ATTEMPTS };
  }

  if (entry.lockedUntil && entry.lockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((entry.lockedUntil - now) / 1000),
    };
  }

  if (entry.resetAt < now) {
    return { allowed: true, remaining: DEFAULT_MAX_ATTEMPTS };
  }

  return {
    allowed: entry.count < DEFAULT_MAX_ATTEMPTS,
    remaining: Math.max(0, DEFAULT_MAX_ATTEMPTS - entry.count),
  };
}

// ---------------------------------------------------------------------------
// Periodic cleanup of stale in-memory entries (every 60 seconds)
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts.entries()) {
    if (
      entry.resetAt < now &&
      (!entry.lockedUntil || entry.lockedUntil < now)
    ) {
      attempts.delete(key);
    }
  }
}, 60_000).unref();
