/**
 * Gbox Platform — Password Migration Audit Tests (Phase 7.4)
 *
 * Pure-function helpers for the bcrypt migration script. The script
 * itself shells out to Postgres + sends emails, but the
 * classification + summarisation logic lives here so it can be unit
 * tested without real users.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyPasswordHash,
  summarizePasswordFleet,
  pickLegacyForReset,
  type PasswordRow,
} from './password-migration.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(
  id: string,
  hash: string | null,
  lastLogin: string | null = null,
): PasswordRow {
  return {
    id,
    email: `${id}@gbox.co`,
    password_hash: hash,
    last_login_at: lastLogin ? new Date(lastLogin) : null,
  }
}

const NOW = new Date('2026-04-09T00:00:00.000Z')

// ---------------------------------------------------------------------------
// classifyPasswordHash
// ---------------------------------------------------------------------------

describe('classifyPasswordHash', () => {
  it('classifies a $2b$ bcrypt hash as bcrypt', () => {
    expect(
      classifyPasswordHash(
        '$2b$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV',
      ),
    ).toBe('bcrypt')
  })

  it('classifies a $2a$ bcrypt hash as bcrypt', () => {
    expect(
      classifyPasswordHash(
        '$2a$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV',
      ),
    ).toBe('bcrypt')
  })

  it('classifies a 64-char hex string as sha256', () => {
    const hex = 'a'.repeat(64)
    expect(classifyPasswordHash(hex)).toBe('sha256')
  })

  it('classifies an empty string as empty', () => {
    expect(classifyPasswordHash('')).toBe('empty')
  })

  it('classifies null as empty', () => {
    expect(classifyPasswordHash(null)).toBe('empty')
  })

  it('classifies anything else as unknown', () => {
    expect(classifyPasswordHash('not-a-hash')).toBe('unknown')
    expect(classifyPasswordHash('abc123')).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// summarizePasswordFleet
// ---------------------------------------------------------------------------

describe('summarizePasswordFleet', () => {
  it('returns zeroes for an empty fleet', () => {
    const summary = summarizePasswordFleet([])
    expect(summary).toEqual({
      total: 0,
      bcrypt: 0,
      sha256: 0,
      empty: 0,
      unknown: 0,
      percentMigrated: 100,
    })
  })

  it('counts each row into exactly one bucket', () => {
    const fleet = [
      row('u1', '$2b$12$' + 'a'.repeat(53)),
      row('u2', '$2b$12$' + 'b'.repeat(53)),
      row('u3', 'a'.repeat(64)), // sha256
      row('u4', 'c'.repeat(64)), // sha256
      row('u5', null), // empty
      row('u6', 'lol-not-a-hash'), // unknown
    ]
    const summary = summarizePasswordFleet(fleet)
    expect(summary.total).toBe(6)
    expect(summary.bcrypt).toBe(2)
    expect(summary.sha256).toBe(2)
    expect(summary.empty).toBe(1)
    expect(summary.unknown).toBe(1)
  })

  it('reports percentMigrated based on bcrypt vs total non-empty', () => {
    const fleet = [
      row('u1', '$2b$12$' + 'a'.repeat(53)), // bcrypt
      row('u2', '$2b$12$' + 'b'.repeat(53)), // bcrypt
      row('u3', '$2b$12$' + 'c'.repeat(53)), // bcrypt
      row('u4', 'a'.repeat(64)), // sha256
      row('u5', null), // empty — excluded
    ]
    const summary = summarizePasswordFleet(fleet)
    // 3 bcrypt out of 4 non-empty = 75%
    expect(summary.percentMigrated).toBe(75)
  })

  it('returns 100% when every non-empty hash is already bcrypt', () => {
    const fleet = [
      row('u1', '$2b$12$' + 'a'.repeat(53)),
      row('u2', null),
    ]
    const summary = summarizePasswordFleet(fleet)
    expect(summary.percentMigrated).toBe(100)
  })

  it('returns 0% when there are no bcrypt hashes', () => {
    const fleet = [
      row('u1', 'a'.repeat(64)),
      row('u2', 'b'.repeat(64)),
    ]
    const summary = summarizePasswordFleet(fleet)
    expect(summary.percentMigrated).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// pickLegacyForReset
// ---------------------------------------------------------------------------

describe('pickLegacyForReset', () => {
  it('returns only sha256 rows', () => {
    const fleet = [
      row('u1', '$2b$12$' + 'a'.repeat(53)),
      row('u2', 'a'.repeat(64)),
      row('u3', null),
      row('u4', 'b'.repeat(64)),
    ]
    const picked = pickLegacyForReset(fleet, { now: NOW })
    expect(picked.map((r) => r.id).sort()).toEqual(['u2', 'u4'])
  })

  it('respects an inactiveSinceDays cutoff (only stale users)', () => {
    const fleet = [
      // Active user — logged in last week, leave alone for lazy upgrade
      row('u1', 'a'.repeat(64), '2026-04-02T00:00:00Z'),
      // Stale user — hasn't logged in for 200 days
      row('u2', 'b'.repeat(64), '2025-09-21T00:00:00Z'),
      // Never logged in
      row('u3', 'c'.repeat(64), null),
    ]
    const picked = pickLegacyForReset(fleet, {
      now: NOW,
      inactiveSinceDays: 90,
    })
    // u1 is active → skip. u2 + u3 are stale or never-active → pick.
    expect(picked.map((r) => r.id).sort()).toEqual(['u2', 'u3'])
  })

  it('includes never-logged-in users by default (most at-risk)', () => {
    const fleet = [row('u1', 'a'.repeat(64), null)]
    const picked = pickLegacyForReset(fleet, {
      now: NOW,
      inactiveSinceDays: 30,
    })
    expect(picked).toHaveLength(1)
  })

  it('respects a maxBatchSize cap', () => {
    const fleet = Array.from({ length: 10 }, (_, i) =>
      row(`u${i}`, 'a'.repeat(64)),
    )
    const picked = pickLegacyForReset(fleet, { now: NOW, maxBatchSize: 3 })
    expect(picked).toHaveLength(3)
  })
})
