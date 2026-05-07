/**
 * Phase 2 Admin Polish §2.3 — background-export unit tests.
 *
 * These tests exercise the Redis-backed tracking meta layer and the
 * on-disk prune sweeper. They deliberately avoid `processAuditExportJob`
 * (which needs a real Kysely instance + DB rows) because the synchronous
 * `?export=csv` path in `export.ts` already has coverage for the
 * fetch+csv conversion.
 *
 * Strategy:
 *   - Fake `getRedis` with a tiny in-memory implementation supporting
 *     get/set/zAdd/zRange/zRem/expire. Good enough for round-trip
 *     checks without spinning up ioredis-mock.
 *   - Fake `auditExportQueue` so `enqueueAuditExport` doesn't try to
 *     open a real BullMQ queue on module load.
 *   - For the file-prune test, point `GBOX_AUDIT_EXPORT_DIR` at a
 *     freshly-created os.tmpdir subfolder and use `utimes` to backdate
 *     the mtime of one fixture file beyond the 72h cutoff.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readdir, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// In-memory Redis stub
// ---------------------------------------------------------------------------

interface SortedEntry {
  score: number
  value: string
}

class FakeRedis {
  strings = new Map<string, string>()
  zsets = new Map<string, SortedEntry[]>()

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null
  }

  async set(key: string, value: string, _opts?: { EX?: number }): Promise<'OK'> {
    this.strings.set(key, value)
    return 'OK'
  }

  async del(key: string): Promise<number> {
    const existed = this.strings.delete(key)
    return existed ? 1 : 0
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1
  }

  async zAdd(key: string, entry: SortedEntry): Promise<number> {
    const arr = this.zsets.get(key) ?? []
    const filtered = arr.filter((e) => e.value !== entry.value)
    filtered.push(entry)
    filtered.sort((a, b) => a.score - b.score)
    this.zsets.set(key, filtered)
    return 1
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    opts?: { REV?: boolean },
  ): Promise<string[]> {
    const arr = this.zsets.get(key) ?? []
    const ordered = opts?.REV ? [...arr].reverse() : arr
    const end = stop === -1 ? ordered.length - 1 : stop
    return ordered.slice(start, end + 1).map((e) => e.value)
  }

  async zRem(key: string, members: string[]): Promise<number> {
    const arr = this.zsets.get(key) ?? []
    const kept = arr.filter((e) => !members.includes(e.value))
    this.zsets.set(key, kept)
    return arr.length - kept.length
  }
}

const fakeRedis = new FakeRedis()

// ---------------------------------------------------------------------------
// Mocks — MUST be declared before the module-under-test import
// ---------------------------------------------------------------------------

vi.mock('../cache/redis.js', () => ({
  getRedis: vi.fn(async () => fakeRedis),
}))

const queueAdd = vi.fn(async (_name: string, _data: unknown, _opts: unknown) => ({
  id: 'fake-job-id',
}))

vi.mock('../queue/queues.js', () => ({
  auditExportQueue: () => ({ add: queueAdd }),
}))

// ---------------------------------------------------------------------------
// Module under test (picks up the mocked getRedis + auditExportQueue)
// ---------------------------------------------------------------------------

import {
  enqueueAuditExport,
  getAuditExportMeta,
  listAuditExportsForUser,
  pruneExpiredAuditExports,
  getAuditExportDir,
  AUDIT_EXPORT_TTL_SECONDS,
  AUDIT_EXPORT_HARD_CAP,
} from './background-export.js'

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  fakeRedis.strings.clear()
  fakeRedis.zsets.clear()
  queueAdd.mockClear()
})

// ---------------------------------------------------------------------------
// enqueueAuditExport round-trip
// ---------------------------------------------------------------------------

describe('enqueueAuditExport', () => {
  it('writes tracking meta + user-index entry and adds a BullMQ job', async () => {
    const id = await enqueueAuditExport({
      actor_user_id: 'usr_123',
      actor_email: 'god@gbox.co',
      filters: { action: 'login' },
      row_limit: 5_000,
    })

    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    const meta = await getAuditExportMeta(id)
    expect(meta).not.toBeNull()
    expect(meta!.status).toBe('queued')
    expect(meta!.actor_user_id).toBe('usr_123')
    expect(meta!.actor_email).toBe('god@gbox.co')
    expect(meta!.filters.action).toBe('login')
    expect(meta!.row_limit).toBe(5_000)
    expect(meta!.row_count).toBeNull()
    expect(meta!.file_size_bytes).toBeNull()
    expect(meta!.error).toBeNull()
    expect(meta!.finished_at).toBeNull()
    expect(typeof meta!.created_at).toBe('string')

    expect(queueAdd).toHaveBeenCalledTimes(1)
    const [jobName, jobData, jobOpts] = queueAdd.mock.calls[0]
    expect(jobName).toBe(`audit-export:${id}`)
    expect((jobData as { export_id: string }).export_id).toBe(id)
    expect((jobOpts as { attempts: number }).attempts).toBe(1)
  })

  it('clamps row_limit to AUDIT_EXPORT_HARD_CAP', async () => {
    const id = await enqueueAuditExport({
      actor_user_id: 'usr_over',
      actor_email: null,
      filters: {},
      row_limit: 9_999_999,
    })
    const meta = await getAuditExportMeta(id)
    expect(meta!.row_limit).toBe(AUDIT_EXPORT_HARD_CAP)
  })

  it('applies AUDIT_EXPORT_HARD_CAP when row_limit is omitted', async () => {
    const id = await enqueueAuditExport({
      actor_user_id: 'usr_default',
      actor_email: null,
      filters: {},
    })
    const meta = await getAuditExportMeta(id)
    expect(meta!.row_limit).toBe(AUDIT_EXPORT_HARD_CAP)
  })

  it('clamps non-positive row_limit up to 1', async () => {
    const id = await enqueueAuditExport({
      actor_user_id: 'usr_zero',
      actor_email: null,
      filters: {},
      row_limit: 0,
    })
    const meta = await getAuditExportMeta(id)
    expect(meta!.row_limit).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// getAuditExportMeta UUID gate
// ---------------------------------------------------------------------------

describe('getAuditExportMeta', () => {
  it('returns null for malformed ids without touching Redis', async () => {
    expect(await getAuditExportMeta('not-a-uuid')).toBeNull()
    expect(await getAuditExportMeta('../../etc/passwd')).toBeNull()
    expect(await getAuditExportMeta('')).toBeNull()
  })

  it('returns null for unknown UUIDs', async () => {
    expect(
      await getAuditExportMeta('00000000-0000-0000-0000-000000000000'),
    ).toBeNull()
  })

  it('returns null when the stored payload is not JSON', async () => {
    const id = '11111111-1111-1111-1111-111111111111'
    fakeRedis.strings.set(`gbox:audit_export:${id}`, 'not-json')
    expect(await getAuditExportMeta(id)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listAuditExportsForUser ordering + tombstone cleanup
// ---------------------------------------------------------------------------

describe('listAuditExportsForUser', () => {
  it('returns exports newest-first', async () => {
    // Enqueue three in ascending time order. The sorted-set score is
    // now-relative so we need a tiny delay to distinguish scores.
    const id1 = await enqueueAuditExport({
      actor_user_id: 'usr_seq',
      actor_email: null,
      filters: {},
    })
    await new Promise((r) => setTimeout(r, 2))
    const id2 = await enqueueAuditExport({
      actor_user_id: 'usr_seq',
      actor_email: null,
      filters: {},
    })
    await new Promise((r) => setTimeout(r, 2))
    const id3 = await enqueueAuditExport({
      actor_user_id: 'usr_seq',
      actor_email: null,
      filters: {},
    })

    const list = await listAuditExportsForUser('usr_seq', 10)
    expect(list.map((m) => m.id)).toEqual([id3, id2, id1])
  })

  it('drops tombstone entries whose meta has TTL\'d out', async () => {
    const id1 = await enqueueAuditExport({
      actor_user_id: 'usr_tomb',
      actor_email: null,
      filters: {},
    })
    await new Promise((r) => setTimeout(r, 2))
    const id2 = await enqueueAuditExport({
      actor_user_id: 'usr_tomb',
      actor_email: null,
      filters: {},
    })

    // Delete id1's meta to simulate a 72h TTL expiry while the sorted
    // set lags behind.
    fakeRedis.strings.delete(`gbox:audit_export:${id1}`)

    const list = await listAuditExportsForUser('usr_tomb', 10)
    expect(list.map((m) => m.id)).toEqual([id2])

    // And the sorted-set tombstone should have been cleaned up too.
    const key = `gbox:audit_exports:user:usr_tomb`
    expect(fakeRedis.zsets.get(key)!.map((e) => e.value)).toEqual([id2])
  })

  it('returns empty array for a user with no exports', async () => {
    expect(await listAuditExportsForUser('usr_nobody', 10)).toEqual([])
  })

  it('honours the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await enqueueAuditExport({
        actor_user_id: 'usr_limit',
        actor_email: null,
        filters: {},
      })
      await new Promise((r) => setTimeout(r, 1))
    }
    const list = await listAuditExportsForUser('usr_limit', 3)
    expect(list).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// pruneExpiredAuditExports — disk sweeper
// ---------------------------------------------------------------------------

describe('pruneExpiredAuditExports', () => {
  let dir: string
  const origEnv = process.env.GBOX_AUDIT_EXPORT_DIR

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gbox-audit-export-test-'))
    process.env.GBOX_AUDIT_EXPORT_DIR = dir
  })

  afterEach(async () => {
    if (origEnv === undefined) delete process.env.GBOX_AUDIT_EXPORT_DIR
    else process.env.GBOX_AUDIT_EXPORT_DIR = origEnv
    await rm(dir, { recursive: true, force: true })
  })

  it('returns zeros when the dir does not exist yet (ENOENT)', async () => {
    await rm(dir, { recursive: true, force: true })
    const out = await pruneExpiredAuditExports()
    expect(out).toEqual({ files_deleted: 0, bytes_reclaimed: 0 })
  })

  it('deletes CSV files older than the TTL and leaves fresh files alone', async () => {
    const oldFile = join(dir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.csv')
    const freshFile = join(dir, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.csv')
    const noiseFile = join(dir, 'not-a-csv.txt')

    await writeFile(oldFile, 'header\nrow1\nrow2\n', 'utf8')
    await writeFile(freshFile, 'header\nrow1\n', 'utf8')
    await writeFile(noiseFile, 'ignore me', 'utf8')

    // Backdate the old file to ~73h ago.
    const past = new Date(Date.now() - (AUDIT_EXPORT_TTL_SECONDS + 3600) * 1000)
    await utimes(oldFile, past, past)

    const out = await pruneExpiredAuditExports()

    expect(out.files_deleted).toBe(1)
    expect(out.bytes_reclaimed).toBeGreaterThan(0)

    const remaining = (await readdir(dir)).sort()
    expect(remaining).toEqual(['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.csv', 'not-a-csv.txt'])
  })

  it('ignores non-.csv files even when stale', async () => {
    const staleTxt = join(dir, 'old.txt')
    await writeFile(staleTxt, 'noise', 'utf8')
    const past = new Date(Date.now() - (AUDIT_EXPORT_TTL_SECONDS + 3600) * 1000)
    await utimes(staleTxt, past, past)

    const out = await pruneExpiredAuditExports()
    expect(out.files_deleted).toBe(0)
    expect((await readdir(dir))).toContain('old.txt')
  })
})

// ---------------------------------------------------------------------------
// getAuditExportDir — env override
// ---------------------------------------------------------------------------

describe('getAuditExportDir', () => {
  const orig = process.env.GBOX_AUDIT_EXPORT_DIR
  afterEach(() => {
    if (orig === undefined) delete process.env.GBOX_AUDIT_EXPORT_DIR
    else process.env.GBOX_AUDIT_EXPORT_DIR = orig
  })

  it('honours GBOX_AUDIT_EXPORT_DIR when absolute', () => {
    const abs =
      process.platform === 'win32' ? 'C:\\gbox-test-abs' : '/tmp/gbox-test-abs'
    process.env.GBOX_AUDIT_EXPORT_DIR = abs
    expect(getAuditExportDir()).toBe(abs)
  })

  it('resolves GBOX_AUDIT_EXPORT_DIR when relative', () => {
    process.env.GBOX_AUDIT_EXPORT_DIR = 'relative-export-dir'
    const out = getAuditExportDir()
    // `resolve` always returns an absolute path.
    expect(out.endsWith('relative-export-dir')).toBe(true)
  })
})
