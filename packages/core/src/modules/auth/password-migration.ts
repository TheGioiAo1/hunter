/**
 * Gbox Platform — Password Migration Audit (Phase 7.4)
 *
 * Iron Rule #1 says "ALL passwords hashed with bcrypt (NOT SHA-256)
 * — migrate existing SHA-256 to bcrypt". The lazy upgrade path is
 * already wired in `./password.ts`: every successful login on a
 * legacy hash re-hashes with bcrypt before returning. That handles
 * the active users for free.
 *
 * The problem: dormant users with legacy hashes never get upgraded.
 * This module is the fleet-wide auditor that:
 *
 *   1. Surveys every users row and classifies the hash format.
 *   2. Reports the migration % so we can graph progress over time.
 *   3. Picks the dormant + legacy rows that need a forced password
 *      reset (i.e. an emailed magic link to set a new password).
 *
 * Pure functions only — the script in `scripts/ops/audit-password-
 * hashes.ts` handles the SQL + email send. Keeping the rules here
 * means they're unit-tested and shared between the audit script,
 * the god-admin "Password Hash Migration" dashboard card, and any
 * future cron that wants to do automated reset waves.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PasswordRow {
  id: string
  email: string
  password_hash: string | null
  /** Last successful login timestamp, or null if never logged in. */
  last_login_at: Date | null
}

export type PasswordHashKind =
  | 'bcrypt' // current canonical format
  | 'sha256' // legacy — needs migration
  | 'empty' // null / blank — passkey-only or new account
  | 'unknown' // anything else (corrupted, mid-migration, …)

export interface PasswordFleetSummary {
  total: number
  bcrypt: number
  sha256: number
  empty: number
  unknown: number
  /** bcrypt / (bcrypt + sha256 + unknown) × 100, rounded. 100 if no rows. */
  percentMigrated: number
}

export interface PickLegacyOptions {
  /** Defaults to `new Date()`. */
  now?: Date
  /**
   * Only pick rows whose `last_login_at` is older than this many
   * days. Active users (logged in recently) are left alone — the
   * lazy-upgrade path will handle them on next login. Defaults to
   * 0 (no inactivity filter, picks every legacy row).
   */
  inactiveSinceDays?: number
  /** Cap the result set so a single batch can be paced. */
  maxBatchSize?: number
}

// ---------------------------------------------------------------------------
// classifyPasswordHash
// ---------------------------------------------------------------------------

const BCRYPT_PREFIX_RE = /^\$2[aby]\$/
// SHA-256 hex digest = exactly 64 lowercase hex characters.
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

export function classifyPasswordHash(hash: string | null): PasswordHashKind {
  if (hash === null || hash === '') return 'empty'
  if (BCRYPT_PREFIX_RE.test(hash)) return 'bcrypt'
  if (SHA256_HEX_RE.test(hash)) return 'sha256'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// summarizePasswordFleet
// ---------------------------------------------------------------------------

export function summarizePasswordFleet(
  rows: PasswordRow[],
): PasswordFleetSummary {
  const summary: PasswordFleetSummary = {
    total: rows.length,
    bcrypt: 0,
    sha256: 0,
    empty: 0,
    unknown: 0,
    percentMigrated: 100,
  }

  for (const row of rows) {
    const kind = classifyPasswordHash(row.password_hash)
    summary[kind]++
  }

  // Migration % is bcrypt / (everything that has SOME hash). Empty
  // rows (passkey-only / never-set) are excluded from the
  // denominator — they don't have a SHA-256 to migrate FROM.
  const denominator = summary.bcrypt + summary.sha256 + summary.unknown
  if (denominator === 0) {
    summary.percentMigrated = 100
  } else {
    summary.percentMigrated = Math.round((summary.bcrypt / denominator) * 100)
  }

  return summary
}

// ---------------------------------------------------------------------------
// pickLegacyForReset
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000

/**
 * Returns the subset of rows that should receive a forced password
 * reset email. The selection rules:
 *
 *   1. The row must currently be SHA-256 (not bcrypt, not empty,
 *      not unknown).
 *   2. If `inactiveSinceDays` is set, the row's `last_login_at`
 *      must be older than `now - inactiveSinceDays` (or null).
 *   3. The result is capped at `maxBatchSize` rows so we can pace
 *      the email send + audit log writes.
 *
 * The order is preserved from the input — callers that want
 * priority ordering should sort the input first.
 */
export function pickLegacyForReset(
  rows: PasswordRow[],
  opts: PickLegacyOptions = {},
): PasswordRow[] {
  const now = opts.now ?? new Date()
  const inactiveCutoffMs =
    opts.inactiveSinceDays !== undefined && opts.inactiveSinceDays > 0
      ? now.getTime() - opts.inactiveSinceDays * MS_PER_DAY
      : null

  const picked: PasswordRow[] = []
  for (const row of rows) {
    if (classifyPasswordHash(row.password_hash) !== 'sha256') continue

    if (inactiveCutoffMs !== null) {
      // Never-logged-in users count as "fully inactive" — they're
      // the highest risk, since their hash has been sitting unused.
      if (row.last_login_at !== null) {
        if (row.last_login_at.getTime() >= inactiveCutoffMs) {
          continue
        }
      }
    }

    picked.push(row)
    if (opts.maxBatchSize !== undefined && picked.length >= opts.maxBatchSize) {
      break
    }
  }

  return picked
}
