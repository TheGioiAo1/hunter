/**
 * Clone Pro v7 — buildV7Deps wiring tests.
 *
 * Sprint 5 follow-up. Validates that `buildV7Deps(db)` overrides the
 * three v6 slots that v7 needs to behave differently:
 *
 *   1. `runPersisters` — uses `productsPersisterV7` for the products
 *      bucket (OVERWRITE semantics) instead of v6's `productsPersister`
 *      (which preserves edited rows).
 *   2. `autoPublish` — uses `runStage11V7` (deploy theme.zip + flip
 *      `theme_loader_version=v2`) instead of v6's `runStage11` (just
 *      sets `storefront_clone_jobs.status='published'`).
 *   3. (Task B) `tracker` — wires a `CloneProCostTracker` instance so
 *      Stage 14 + Stage 16 can `addClaude(model, in, out)` and abort the
 *      job before the per-job cap is breached.
 *
 * Each test mocks the underlying SQL execution so we don't hit Postgres,
 * captures the call sequence, and asserts that the v7-specific helper
 * was invoked.
 */

import { describe, it, expect, vi } from 'vitest'

// Stub the heavy chromium import — v6 deps imports `playwright` for
// Stage 3 headless render. We don't exercise Stage 3 in deps wiring
// tests; stubbing keeps the import graph loadable on machines without
// the optional `playwright` package installed.
vi.mock('playwright', () => ({
  chromium: { launch: vi.fn() },
}))

import { buildV7Deps } from './deps.js'
import type { ProductDTO } from '../v6/scrapers/types.js'

// ---------------------------------------------------------------------------
// Fake DB that records every executeQuery + insertInto + updateTable +
// selectFrom call. The v7 products persister wraps every call in
// `withSerializable(db, fn)` which uses kysely's transaction API; our
// fake routes the trx callback through the same chain.
// ---------------------------------------------------------------------------
interface Trace {
  kind: 'sql' | 'select' | 'insert' | 'update'
  sql?: string
  table?: string
  values?: unknown
}

function makeTracingDb(): { db: any; trace: Trace[] } {
  const trace: Trace[] = []
  const trx: any = {
    selectFrom: (table: string) => {
      const chain: any = {
        where: () => chain,
        select: () => chain,
        executeTakeFirst: async () => undefined,
        execute: async () => [],
      }
      trace.push({ kind: 'select', table })
      return chain
    },
    insertInto: (table: string) => ({
      values: (vals: any) => {
        trace.push({ kind: 'insert', table, values: vals })
        return {
          execute: async () => undefined,
          returningAll: () => ({
            execute: async () => [{ id: `id-${trace.length}` }],
          }),
        }
      },
    }),
    updateTable: () => ({
      set: () => ({ where: () => ({ execute: async () => undefined }) }),
    }),
    executeQuery: async (compiled: any) => {
      trace.push({ kind: 'sql', sql: String(compiled?.sql ?? '') })
      return { rows: [{ deleted: 0, archived: 0 }] }
    },
    getExecutor: () => fakeExecutor,
  }
  const fakeExecutor = {
    executeQuery: async (compiled: any) => {
      trace.push({ kind: 'sql', sql: String(compiled?.sql ?? '') })
      return { rows: [{ deleted: 0, archived: 0 }] }
    },
    transformQuery: (q: any) => q,
    compileQuery: (node: any) => ({
      sql: 'SELECT * FROM clone_pro_overwrite_products($1::uuid)',
      parameters: [node?.parameters?.[0] ?? null],
      query: node,
    }),
    adapter: { supportsReturning: () => true },
  }
  const db: any = {
    transaction: () => ({
      setIsolationLevel: () => ({
        execute: async (fn: (t: any) => Promise<unknown>) => fn(trx),
      }),
    }),
    selectFrom: trx.selectFrom,
    insertInto: trx.insertInto,
    updateTable: trx.updateTable,
    executeQuery: trx.executeQuery,
    getExecutor: () => fakeExecutor,
  }
  return { db, trace }
}

function dto(slug: string): ProductDTO {
  return {
    sourceUrl: `https://x/${slug}`,
    sourceHandle: slug,
    title: slug,
    bodyHtml: `<p>${slug}</p>`,
    vendor: null,
    productType: null,
    tags: [],
    variants: [],
    options: [],
    images: [],
  } as any
}

// ---------------------------------------------------------------------------
// Tracing DB tailored for autoPublish wiring tests. Records every
// shop_settings UPSERT (the flip path) so we can assert on the call
// site directly. Returns minimal shop row so the inner v6 publish
// branch passes its `shop?.domain` guard.
// ---------------------------------------------------------------------------
function makeShopAutoPublishDb(): { db: any; ops: Trace[] } {
  const ops: Trace[] = []
  const db: any = {
    selectFrom: (table: string) => {
      // v6 runStage11 reads shops.domain to decide whether to publish.
      const chain: any = {
        where: () => chain,
        select: () => chain,
        executeTakeFirst: async () => ({ domain: 'example.com' }),
        execute: async () => [],
      }
      ops.push({ kind: 'select', table })
      return chain
    },
    insertInto: (table: string) => ({
      values: (vals: any) => {
        ops.push({ kind: 'insert', table, values: vals })
        return {
          onConflict: () => ({ execute: async () => undefined }),
          execute: async () => undefined,
          returningAll: () => ({
            execute: async () => [{ id: `id-${ops.length}` }],
          }),
        }
      },
    }),
    updateTable: (table: string) => ({
      set: (vals: any) => {
        ops.push({ kind: 'update', table, values: vals })
        // Production code chains multiple `.where()` calls (e.g. shop_id +
        // clone_job_id + source filters). Return a self-referential chain so
        // any number of `.where()` calls before `.execute()` resolves.
        const chain: any = {
          where: () => chain,
          execute: async () => undefined,
        }
        return chain
      },
    }),
    transaction: () => ({
      setIsolationLevel: () => ({
        execute: async (fn: (t: any) => Promise<unknown>) => fn(db),
      }),
    }),
  }
  return { db, ops }
}

// ---------------------------------------------------------------------------
// Task A: runPersisters routes the products bucket through productsPersisterV7
// ---------------------------------------------------------------------------
describe('buildV7Deps — products persister wiring (Task A)', () => {
  it('runPersisters invokes clone_pro_overwrite_products SQL before any product INSERT', async () => {
    const { db, trace } = makeTracingDb()
    const deps = buildV7Deps(db)

    await deps.runPersisters({
      shopId: 'shop-aaa',
      jobId: 'job-aaa',
      dtos: {
        products: [dto('p1'), dto('p2')],
        collections: [],
        pages: [],
        blogPosts: [],
        menus: [],
        themeTokens: null,
        themeFiles: [],
        urlRedirects: [],
        genericMedia: [],
      },
    })

    const overwriteIdx = trace.findIndex((e) =>
      /clone_pro_overwrite_products/i.test(e.sql ?? ''),
    )
    const firstProductInsertIdx = trace.findIndex(
      (e) => e.kind === 'insert' && e.table === 'products',
    )

    expect(overwriteIdx).toBeGreaterThan(-1)
    expect(firstProductInsertIdx).toBeGreaterThan(-1)
    expect(overwriteIdx).toBeLessThan(firstProductInsertIdx)
  })

  it('runPersisters skips OVERWRITE when no products in DTOs (empty bucket)', async () => {
    const { db, trace } = makeTracingDb()
    const deps = buildV7Deps(db)

    await deps.runPersisters({
      shopId: 'shop-bbb',
      jobId: 'job-bbb',
      dtos: {
        products: [],
        collections: [],
        pages: [],
        blogPosts: [],
        menus: [],
        themeTokens: null,
        themeFiles: [],
        urlRedirects: [],
        genericMedia: [],
      },
    })

    // No products means no v7 persister run → no OVERWRITE call.
    const overwriteCalls = trace.filter((e) =>
      /clone_pro_overwrite_products/i.test(e.sql ?? ''),
    )
    expect(overwriteCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Task C: autoPublish routes through runStage11V7 (deploy + flip loader)
// ---------------------------------------------------------------------------
describe('buildV7Deps — autoPublish wiring (Task C)', () => {
  it('invokes deployTheme + UPSERT shop_settings(theme_loader_version=v2) when themeZipS3KeyResolver returns a key', async () => {
    const { db, ops } = makeShopAutoPublishDb()
    const deployTheme = vi.fn().mockResolvedValue(undefined)

    const deps = buildV7Deps(db, {
      themeZipS3KeyResolver: () => 'themes/shop-1/v1.zip',
      deployTheme,
    })

    const r = await deps.autoPublish({
      jobId: 'job-c1',
      shopId: 'shop-1',
      gradeLetter: 'B',
    })

    expect(r.published).toBe(true)
    expect(deployTheme).toHaveBeenCalledTimes(1)
    expect(deployTheme).toHaveBeenCalledWith({
      shopId: 'shop-1',
      themeZipS3Key: 'themes/shop-1/v1.zip',
    })

    // The flip is an UPSERT into shop_settings. Capture the value to
    // verify we wrote 'v2' (storefront DbLoader v2 hot-path key).
    const flipOp = ops.find(
      (o) =>
        o.kind === 'insert' &&
        o.table === 'shop_settings' &&
        ((o.values as any)?.key === 'theme_loader_version'),
    )
    expect(flipOp).toBeDefined()
    expect(JSON.parse((flipOp!.values as any).value)).toBe('v2')
  })

  it('skips deployTheme + flip when themeZipS3KeyResolver returns null (Stage 15 not yet run)', async () => {
    const { db, ops } = makeShopAutoPublishDb()
    const deployTheme = vi.fn().mockResolvedValue(undefined)

    const deps = buildV7Deps(db, {
      themeZipS3KeyResolver: () => null,
      deployTheme,
    })

    const r = await deps.autoPublish({
      jobId: 'job-c2',
      shopId: 'shop-2',
      gradeLetter: 'A',
    })

    expect(r.published).toBe(true)
    expect(deployTheme).not.toHaveBeenCalled()
    const flipOp = ops.find(
      (o) =>
        o.kind === 'insert' &&
        o.table === 'shop_settings' &&
        ((o.values as any)?.key === 'theme_loader_version'),
    )
    expect(flipOp).toBeUndefined()
  })

  it('skips deployTheme + flip when v6 publish itself was skipped (grade F)', async () => {
    const { db, ops } = makeShopAutoPublishDb()
    const deployTheme = vi.fn().mockResolvedValue(undefined)

    const deps = buildV7Deps(db, {
      themeZipS3KeyResolver: () => 'themes/shop-3/v1.zip',
      deployTheme,
    })

    const r = await deps.autoPublish({
      jobId: 'job-c3',
      shopId: 'shop-3',
      gradeLetter: 'F',
    })

    expect(r.published).toBe(false)
    expect(r.reason).toBe('grade_F')
    expect(deployTheme).not.toHaveBeenCalled()
    const flipOp = ops.find(
      (o) =>
        o.kind === 'insert' &&
        o.table === 'shop_settings' &&
        ((o.values as any)?.key === 'theme_loader_version'),
    )
    expect(flipOp).toBeUndefined()
  })
})
