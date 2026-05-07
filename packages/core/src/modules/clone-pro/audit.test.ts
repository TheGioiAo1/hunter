/**
 * Phase 7 Step 7.6 — clone-pro audit log writer.
 *
 * Every clone job writes TWO rows to `audit_logs`:
 *   - `clone_pro.started` when POST /start creates the job row
 *   - `clone_pro.<terminal>` when the runner reaches succeeded /
 *     succeeded_partial / failed
 *
 * Those rows are the God Admin's single source of truth for "who
 * cloned what, when, and how did it end". `details` carries the
 * structured context (job_id, source_url, scope, duration_ms,
 * failed_stages) so auditors don't have to join through
 * storefront_clone_jobs to reconstruct the story.
 *
 * Write failures are swallowed — losing an audit row is strictly
 * preferable to failing an HTTP request or a BullMQ job because the
 * audit insert hit a transient lock. The loss is logged for
 * operators to notice.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { logCloneStarted, logCloneTerminal } from './audit.js'

// --- fake kysely -----------------------------------------------------
// Minimal insert recorder — captures (table, values) pairs for
// assertion. Real Kysely is heavy and out of scope for a unit test;
// the shape `db.insertInto(t).values(v).execute()` is what our code
// uses so we mirror only that path.

interface RecordedInsert {
  table: string
  values: Record<string, unknown>
}

function makeFakeDb() {
  const inserts: RecordedInsert[] = []
  const executeImpl = vi.fn().mockResolvedValue(undefined)
  const db = {
    insertInto: (table: string) => ({
      values: (values: Record<string, unknown>) => ({
        execute: () => {
          inserts.push({ table, values })
          return executeImpl()
        },
      }),
    }),
  }
  return { db, inserts, executeImpl }
}

function makeThrowingDb() {
  const executeImpl = vi
    .fn()
    .mockRejectedValue(new Error('audit_logs locked'))
  const db = {
    insertInto: () => ({
      values: () => ({
        execute: () => executeImpl(),
      }),
    }),
  }
  return { db, executeImpl }
}

describe('Phase 7.6 — logCloneStarted', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('inserts into audit_logs with action = "clone_pro.started"', async () => {
    const { db, inserts } = makeFakeDb()
    await logCloneStarted(db as any, {
      shopId: 'shop-1',
      userId: 'user-1',
      jobId: 'job-1',
      sourceUrl: 'https://example.com',
      canonicalDomain: 'example.com',
      scope: { products: true, collections: true },
    })
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.table).toBe('audit_logs')
    expect(inserts[0]!.values.action).toBe('clone_pro.started')
  })

  it('pins shop_id, user_id, resource_type, resource_id on the row', async () => {
    const { db, inserts } = makeFakeDb()
    await logCloneStarted(db as any, {
      shopId: 'shop-7',
      userId: 'user-42',
      jobId: 'job-xyz',
      sourceUrl: 'https://bibliobloom.com',
      scope: {},
    })
    const v = inserts[0]!.values
    expect(v.shop_id).toBe('shop-7')
    expect(v.user_id).toBe('user-42')
    expect(v.resource_type).toBe('storefront_clone_job')
    expect(v.resource_id).toBe('job-xyz')
  })

  it('encodes { job_id, source_url, canonical_domain, scope } into details JSON', async () => {
    const { db, inserts } = makeFakeDb()
    const scope = { products: true, blog: false, seo: true }
    await logCloneStarted(db as any, {
      shopId: 'shop-1',
      userId: 'user-1',
      jobId: 'job-abc',
      sourceUrl: 'https://src.example',
      canonicalDomain: 'src.example',
      scope,
    })
    const details = JSON.parse(String(inserts[0]!.values.details))
    expect(details).toMatchObject({
      job_id: 'job-abc',
      source_url: 'https://src.example',
      canonical_domain: 'src.example',
      scope,
    })
  })

  it('accepts missing userId + canonicalDomain and records null', async () => {
    const { db, inserts } = makeFakeDb()
    // Anonymous backfills / legacy enqueues don't have a user. URLs
    // that fail canonicalisation land with no domain either. Both
    // must NOT block the audit row — the action still records.
    await logCloneStarted(db as any, {
      shopId: 'shop-1',
      jobId: 'job-legacy',
      sourceUrl: 'https://example.com',
      scope: {},
    })
    const v = inserts[0]!.values
    expect(v.user_id).toBeNull()
    const details = JSON.parse(String(v.details))
    expect(details.canonical_domain).toBeNull()
  })

  it('records ip_address when provided', async () => {
    const { db, inserts } = makeFakeDb()
    await logCloneStarted(db as any, {
      shopId: 'shop-1',
      userId: 'user-1',
      jobId: 'job-1',
      sourceUrl: 'https://example.com',
      scope: {},
      ipAddress: '203.0.113.42',
    })
    expect(inserts[0]!.values.ip_address).toBe('203.0.113.42')
  })

  it('swallows insert errors — logs but does not throw', async () => {
    const { db, executeImpl } = makeThrowingDb()
    await expect(
      logCloneStarted(db as any, {
        shopId: 'shop-1',
        userId: 'user-1',
        jobId: 'job-1',
        sourceUrl: 'https://example.com',
        scope: {},
      }),
    ).resolves.toBeUndefined()
    expect(executeImpl).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalled()
  })
})

describe('Phase 7.6 — logCloneTerminal', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fires action = "clone_pro.succeeded" for clean success', async () => {
    const { db, inserts } = makeFakeDb()
    await logCloneTerminal(db as any, {
      shopId: 'shop-1',
      jobId: 'job-1',
      status: 'succeeded',
      durationMs: 42_000,
      productsImported: 120,
      pagesImported: 8,
    })
    expect(inserts[0]!.values.action).toBe('clone_pro.succeeded')
  })

  it('fires action = "clone_pro.succeeded_partial" when stages failed', async () => {
    const { db, inserts } = makeFakeDb()
    await logCloneTerminal(db as any, {
      shopId: 'shop-1',
      jobId: 'job-1',
      status: 'succeeded_partial',
      durationMs: 55_000,
      failedStages: ['seo_optimize', 'ingest_media'],
    })
    expect(inserts[0]!.values.action).toBe('clone_pro.succeeded_partial')
    const details = JSON.parse(String(inserts[0]!.values.details))
    expect(details.failed_stages).toEqual(['seo_optimize', 'ingest_media'])
  })

  it('fires action = "clone_pro.failed" on fatal terminal', async () => {
    const { db, inserts } = makeFakeDb()
    await logCloneTerminal(db as any, {
      shopId: 'shop-1',
      jobId: 'job-1',
      status: 'failed',
      durationMs: 12_000,
      errorMessage: 'crawl hard crash',
    })
    expect(inserts[0]!.values.action).toBe('clone_pro.failed')
    const details = JSON.parse(String(inserts[0]!.values.details))
    expect(details.error_message).toBe('crawl hard crash')
  })

  it('encodes { job_id, status, duration_ms, products_imported, pages_imported } into details', async () => {
    const { db, inserts } = makeFakeDb()
    await logCloneTerminal(db as any, {
      shopId: 'shop-1',
      jobId: 'job-abc',
      status: 'succeeded',
      durationMs: 60_000,
      productsImported: 200,
      pagesImported: 15,
    })
    const details = JSON.parse(String(inserts[0]!.values.details))
    expect(details).toMatchObject({
      job_id: 'job-abc',
      status: 'succeeded',
      duration_ms: 60_000,
      products_imported: 200,
      pages_imported: 15,
    })
  })

  it('resource_type + resource_id pinned to storefront_clone_job', async () => {
    const { db, inserts } = makeFakeDb()
    await logCloneTerminal(db as any, {
      shopId: 'shop-1',
      jobId: 'job-abc',
      status: 'succeeded',
    })
    expect(inserts[0]!.values.resource_type).toBe('storefront_clone_job')
    expect(inserts[0]!.values.resource_id).toBe('job-abc')
  })

  it('swallows insert errors — terminal audit loss never fails a job', async () => {
    const { db, executeImpl } = makeThrowingDb()
    await expect(
      logCloneTerminal(db as any, {
        shopId: 'shop-1',
        jobId: 'job-1',
        status: 'failed',
      }),
    ).resolves.toBeUndefined()
    expect(executeImpl).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalled()
  })

  it('omitted optional fields record null (not undefined)', async () => {
    const { db, inserts } = makeFakeDb()
    // God Admin query shouldn't have to distinguish "we didn't measure
    // this" from "the caller forgot to pass it". Store null for both.
    await logCloneTerminal(db as any, {
      shopId: 'shop-1',
      jobId: 'job-1',
      status: 'succeeded',
    })
    const details = JSON.parse(String(inserts[0]!.values.details))
    expect(details.duration_ms).toBeNull()
    expect(details.products_imported).toBeNull()
    expect(details.pages_imported).toBeNull()
    expect(details.failed_stages).toBeNull()
    expect(details.error_message).toBeNull()
  })
})
