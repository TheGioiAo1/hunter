/**
 * Gbox Platform — Backup Inventory Tests (Phase 6.2)
 *
 * Validates `listBackups` parses snapshot filenames produced by
 * `scripts/ops/backup-postgres.sh`, sorts them newest-first, and
 * computes the human-readable status fields the god-admin UI uses.
 */

import { describe, it, expect } from 'vitest'
import {
  parseBackupFilename,
  summariseBackups,
  pickStaleBackups,
  type BackupEntry,
} from './backups.js'

describe('parseBackupFilename', () => {
  it('parses a well-formed snapshot filename', () => {
    const parsed = parseBackupFilename(
      'gbox-gbox_platform-20260409T023000Z.sql.gz',
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.database).toBe('gbox_platform')
    expect(parsed!.takenAt.toISOString()).toBe('2026-04-09T02:30:00.000Z')
  })

  it('parses a snapshot for a non-default database name', () => {
    const parsed = parseBackupFilename('gbox-gbox_test-20260101T000000Z.sql.gz')
    expect(parsed).not.toBeNull()
    expect(parsed!.database).toBe('gbox_test')
  })

  it('returns null for the latest symlink (it has no timestamp)', () => {
    expect(parseBackupFilename('gbox-gbox_platform-latest.sql.gz')).toBeNull()
  })

  it('returns null for an unrelated file', () => {
    expect(parseBackupFilename('random.txt')).toBeNull()
    expect(parseBackupFilename('gbox-platform.sql')).toBeNull()
  })

  it('rejects malformed timestamps', () => {
    expect(
      parseBackupFilename('gbox-gbox_platform-20260101.sql.gz'),
    ).toBeNull()
    expect(
      parseBackupFilename('gbox-gbox_platform-not-a-date.sql.gz'),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Helpers used by the summary functions below
// ---------------------------------------------------------------------------

function makeEntry(iso: string, sizeBytes = 1_000_000): BackupEntry {
  return {
    filename: `gbox-gbox_platform-${iso.replace(/[-:]/g, '').replace('.000', '')}.sql.gz`,
    database: 'gbox_platform',
    takenAt: new Date(iso),
    sizeBytes,
  }
}

describe('summariseBackups', () => {
  it('returns an empty summary when no backups exist', () => {
    const summary = summariseBackups([], { now: new Date('2026-04-09') })
    expect(summary.count).toBe(0)
    expect(summary.latest).toBeNull()
    expect(summary.totalBytes).toBe(0)
    expect(summary.hoursSinceLatest).toBeNull()
  })

  it('picks the freshest snapshot regardless of input order', () => {
    const backups = [
      makeEntry('2026-04-07T02:30:00.000Z'),
      makeEntry('2026-04-09T02:30:00.000Z'), // freshest
      makeEntry('2026-04-08T02:30:00.000Z'),
    ]
    const summary = summariseBackups(backups, {
      now: new Date('2026-04-09T03:30:00.000Z'),
    })
    expect(summary.count).toBe(3)
    expect(summary.latest?.takenAt.toISOString()).toBe(
      '2026-04-09T02:30:00.000Z',
    )
    expect(summary.hoursSinceLatest).toBe(1)
  })

  it('sums totalBytes across all snapshots', () => {
    const backups = [
      makeEntry('2026-04-07T02:30:00.000Z', 1_000_000),
      makeEntry('2026-04-08T02:30:00.000Z', 2_500_000),
      makeEntry('2026-04-09T02:30:00.000Z', 1_500_000),
    ]
    const summary = summariseBackups(backups, {
      now: new Date('2026-04-09T03:30:00.000Z'),
    })
    expect(summary.totalBytes).toBe(5_000_000)
  })

  it('marks healthy when latest is within freshnessHours', () => {
    const backups = [makeEntry('2026-04-09T00:00:00.000Z')]
    const summary = summariseBackups(backups, {
      now: new Date('2026-04-09T05:00:00.000Z'),
      freshnessHours: 24,
    })
    expect(summary.status).toBe('healthy')
  })

  it('marks stale when the freshest backup is older than freshnessHours', () => {
    const backups = [makeEntry('2026-04-07T00:00:00.000Z')]
    const summary = summariseBackups(backups, {
      now: new Date('2026-04-09T05:00:00.000Z'),
      freshnessHours: 24,
    })
    expect(summary.status).toBe('stale')
  })

  it('marks missing when there are no backups', () => {
    const summary = summariseBackups([], {
      now: new Date('2026-04-09T05:00:00.000Z'),
    })
    expect(summary.status).toBe('missing')
  })
})

describe('pickStaleBackups', () => {
  it('returns backups older than retainDays', () => {
    const now = new Date('2026-04-09T00:00:00.000Z')
    const backups = [
      makeEntry('2026-03-01T02:30:00.000Z'), // ~39 days old → stale
      makeEntry('2026-04-08T02:30:00.000Z'), // 22h old → keep
      makeEntry('2026-03-15T02:30:00.000Z'), // ~25 days old → stale
    ]
    const stale = pickStaleBackups(backups, { now, retainDays: 14 })
    expect(stale).toHaveLength(2)
    expect(stale.map((b) => b.takenAt.toISOString())).toEqual([
      '2026-03-01T02:30:00.000Z',
      '2026-03-15T02:30:00.000Z',
    ])
  })

  it('treats retainDays=0 as "everything is stale"', () => {
    const backups = [
      makeEntry('2026-04-09T00:00:00.000Z'),
      makeEntry('2026-04-08T02:30:00.000Z'),
    ]
    const stale = pickStaleBackups(backups, {
      now: new Date('2026-04-09T01:00:00.000Z'),
      retainDays: 0,
    })
    expect(stale).toHaveLength(2)
  })
})
