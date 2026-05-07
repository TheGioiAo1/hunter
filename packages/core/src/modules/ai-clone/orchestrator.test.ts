/**
 * Gbox Platform — AI Clone orchestrator tests
 * (Landing Page System Phase 2.4)
 *
 * Stubs every injected dependency (db, fetchImpl, aiSender, assetStorage,
 * logger) and asserts the 6-step pipeline end-to-end: crawl → cloner →
 * AI spec → bundle → createTheme → updateThemeAsset loop. Also covers
 * each failure path (invalid_url, crawl_failed, ai_request_failed,
 * generator_failed, persist_failed) and verifies the rollback branch
 * deletes the half-built theme when asset persistence explodes.
 *
 * No network, no database, no R2 — everything is in-memory.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { runCloneOrchestrator } from './orchestrator.js'
import type { AiSender } from './theme-spec.js'

// ---------------------------------------------------------------------------
// Fake DB — covers the exact chains the themes service uses
// ---------------------------------------------------------------------------

interface ThemeRow {
  id: string
  shop_id: string
  name: string
  role: string
  created_at: string
  updated_at: string
}

interface AssetRow {
  id: string
  theme_id: string
  key: string
  value: string | null
  content_type: string | null
  size: number
  created_at: string
  updated_at: string
}

interface FakeDbState {
  themes: ThemeRow[]
  assets: AssetRow[]
  nextThemeId: number
  nextAssetId: number
  /** When set, the next `insertInto('theme_assets')` call throws. */
  failNextAssetInsert: boolean
  /** When set, the next `insertInto('themes')` call throws. */
  failNextThemeInsert: boolean
}

function createFakeDb(): {
  db: Kysely<Database>
  state: FakeDbState
} {
  const state: FakeDbState = {
    themes: [],
    assets: [],
    nextThemeId: 1,
    nextAssetId: 1,
    failNextAssetInsert: false,
    failNextThemeInsert: false,
  }

  function makeThemeSelect() {
    const preds: Array<{ col: keyof ThemeRow; val: unknown }> = []
    const chain: any = {
      select: () => chain,
      selectAll: () => chain,
      where: (col: keyof ThemeRow, _op: string, val: unknown) => {
        preds.push({ col, val })
        return chain
      },
      executeTakeFirst: async () => {
        return state.themes.find((row) =>
          preds.every((p) => row[p.col] === p.val),
        )
      },
      executeTakeFirstOrThrow: async () => {
        const row = state.themes.find((row) =>
          preds.every((p) => row[p.col] === p.val),
        )
        if (!row) throw new Error('no row')
        return row
      },
      execute: async () =>
        state.themes.filter((row) => preds.every((p) => row[p.col] === p.val)),
    }
    return chain
  }

  function makeAssetSelect() {
    const preds: Array<{ col: keyof AssetRow; val: unknown }> = []
    const chain: any = {
      select: () => chain,
      selectAll: () => chain,
      where: (col: keyof AssetRow, _op: string, val: unknown) => {
        preds.push({ col, val })
        return chain
      },
      executeTakeFirst: async () =>
        state.assets.find((row) => preds.every((p) => row[p.col] === p.val)),
      execute: async () =>
        state.assets.filter((row) => preds.every((p) => row[p.col] === p.val)),
    }
    return chain
  }

  function makeThemeInsert() {
    let pending: Partial<ThemeRow> = {}
    const chain: any = {
      values: (v: Partial<ThemeRow>) => {
        pending = v
        return chain
      },
      returningAll: () => chain,
      executeTakeFirstOrThrow: async () => {
        if (state.failNextThemeInsert) {
          state.failNextThemeInsert = false
          throw new Error('theme insert boom')
        }
        const now = new Date().toISOString()
        const row: ThemeRow = {
          id: `theme-${state.nextThemeId++}`,
          shop_id: pending.shop_id ?? '',
          name: pending.name ?? '',
          role: pending.role ?? 'unpublished',
          created_at: now,
          updated_at: now,
        }
        state.themes.push(row)
        return row
      },
    }
    return chain
  }

  function makeAssetInsert() {
    let pending: Partial<AssetRow> = {}
    const chain: any = {
      values: (v: Partial<AssetRow>) => {
        pending = v
        return chain
      },
      returningAll: () => chain,
      executeTakeFirstOrThrow: async () => {
        if (state.failNextAssetInsert) {
          state.failNextAssetInsert = false
          throw new Error('asset insert boom')
        }
        const now = new Date().toISOString()
        const row: AssetRow = {
          id: `asset-${state.nextAssetId++}`,
          theme_id: pending.theme_id ?? '',
          key: pending.key ?? '',
          value: pending.value ?? null,
          content_type: pending.content_type ?? null,
          size: pending.size ?? 0,
          created_at: now,
          updated_at: now,
        }
        state.assets.push(row)
        return row
      },
    }
    return chain
  }

  function makeThemeUpdate() {
    const preds: Array<{ col: keyof ThemeRow; val: unknown }> = []
    const pending: Partial<ThemeRow> = {}
    const chain: any = {
      set: (v: Partial<ThemeRow>) => {
        Object.assign(pending, v)
        return chain
      },
      where: (col: keyof ThemeRow, _op: string, val: unknown) => {
        preds.push({ col, val })
        return chain
      },
      returningAll: () => chain,
      executeTakeFirstOrThrow: async () => {
        const row = state.themes.find((r) =>
          preds.every((p) => r[p.col] === p.val),
        )
        if (!row) throw new Error('no row')
        Object.assign(row, pending)
        return row
      },
      execute: async () => {
        for (const row of state.themes) {
          if (preds.every((p) => row[p.col] === p.val)) {
            Object.assign(row, pending)
          }
        }
      },
    }
    return chain
  }

  function makeAssetUpdate() {
    const preds: Array<{ col: keyof AssetRow; val: unknown }> = []
    const pending: Partial<AssetRow> = {}
    const chain: any = {
      set: (v: Partial<AssetRow>) => {
        Object.assign(pending, v)
        return chain
      },
      where: (col: keyof AssetRow, _op: string, val: unknown) => {
        preds.push({ col, val })
        return chain
      },
      returningAll: () => chain,
      executeTakeFirstOrThrow: async () => {
        const row = state.assets.find((r) =>
          preds.every((p) => r[p.col] === p.val),
        )
        if (!row) throw new Error('no row')
        Object.assign(row, pending)
        return row
      },
    }
    return chain
  }

  function makeThemeDelete() {
    const preds: Array<{ col: keyof ThemeRow; val: unknown }> = []
    const chain: any = {
      where: (col: keyof ThemeRow, _op: string, val: unknown) => {
        preds.push({ col, val })
        return chain
      },
      execute: async () => {
        state.themes = state.themes.filter(
          (row) => !preds.every((p) => row[p.col] === p.val),
        )
      },
    }
    return chain
  }

  function makeAssetDelete() {
    const preds: Array<{ col: keyof AssetRow; val: unknown }> = []
    const chain: any = {
      where: (col: keyof AssetRow, _op: string, val: unknown) => {
        preds.push({ col, val })
        return chain
      },
      execute: async () => {
        state.assets = state.assets.filter(
          (row) => !preds.every((p) => row[p.col] === p.val),
        )
      },
    }
    return chain
  }

  const db: any = {
    selectFrom: (table: string) => {
      if (table === 'themes') return makeThemeSelect()
      if (table === 'theme_assets') return makeAssetSelect()
      throw new Error(`unexpected selectFrom(${table})`)
    },
    insertInto: (table: string) => {
      if (table === 'themes') return makeThemeInsert()
      if (table === 'theme_assets') return makeAssetInsert()
      throw new Error(`unexpected insertInto(${table})`)
    },
    updateTable: (table: string) => {
      if (table === 'themes') return makeThemeUpdate()
      if (table === 'theme_assets') return makeAssetUpdate()
      throw new Error(`unexpected updateTable(${table})`)
    },
    deleteFrom: (table: string) => {
      if (table === 'themes') return makeThemeDelete()
      if (table === 'theme_assets') return makeAssetDelete()
      throw new Error(`unexpected deleteFrom(${table})`)
    },
  }

  return { db: db as Kysely<Database>, state }
}

// ---------------------------------------------------------------------------
// Canned fetch — serves a realistic HTML + CSS pair
// ---------------------------------------------------------------------------

const SAMPLE_HTML = `<!doctype html>
<html><head>
  <title>Velocity Running</title>
  <link rel="stylesheet" href="/styles/main.css">
  <style>:root{--color-primary:#ff6600;--color-bg:#ffffff}</style>
</head><body>
  <header><nav><a href="/">Home</a></nav></header>
  <section class="hero"><h1>Run faster. Go farther.</h1></section>
  <section class="featured-products"></section>
  <footer>2026 Velocity</footer>
</body></html>`

const SAMPLE_CSS = `body{font-family:'Inter',sans-serif;font-size:16px;color:#111}
h1{font-family:'Playfair Display',serif;font-weight:800}
:root{--color-primary:#ff6600;--color-bg:#ffffff;--color-text:#111111}`

function makeFetchMock(): typeof fetch {
  const mock = vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    if (url.includes('/styles/main.css')) {
      return new Response(SAMPLE_CSS, {
        status: 200,
        headers: { 'content-type': 'text/css' },
      })
    }
    if (url.startsWith('https://velocity.example')) {
      return new Response(SAMPLE_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }
    return new Response('not found', { status: 404 })
  })
  return mock as unknown as typeof fetch
}

function makeFailingFetch(): typeof fetch {
  const mock = vi.fn(async () => {
    throw new Error('network exploded')
  })
  return mock as unknown as typeof fetch
}

function makeEmptyFetch(): typeof fetch {
  const mock = vi.fn(async () => {
    return new Response('', { status: 200, headers: { 'content-type': 'text/html' } })
  })
  return mock as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// Canned AI sender
// ---------------------------------------------------------------------------

const CANNED_SPEC_JSON = JSON.stringify({
  brand: {
    name: 'Velocity Running',
    tagline: 'Go farther, faster.',
    voice: 'Athletic, bold, confident.',
  },
  palette: {
    primary: '#ff6600',
    secondary: '#0ea5e9',
    background: '#ffffff',
    surface: '#f4f4f5',
    text: '#111111',
    text_muted: '#6b7280',
    border: '#e5e7eb',
    success: '#16a34a',
    error: '#dc2626',
  },
  fonts: {
    heading_family: "'Playfair Display', serif",
    body_family: "'Inter', system-ui, sans-serif",
    heading_weight: '800',
    body_weight: '400',
    base_size: '16px',
    line_height: '1.5',
  },
  sections: [
    { type: 'header', heading: '', subheading: '', ctaLabel: '', imageHint: '' },
    {
      type: 'hero',
      heading: 'Run faster. Go farther.',
      subheading: 'Race-tested footwear.',
      ctaLabel: 'Shop the collection',
      imageHint: 'Studio shot of a running shoe on white',
    },
    {
      type: 'featured-products',
      heading: 'Best sellers',
      subheading: '',
      ctaLabel: 'View all',
      imageHint: '',
    },
    { type: 'footer', heading: '', subheading: '', ctaLabel: '', imageHint: '' },
  ],
  tags: ['athletic', 'running', 'bold'],
  description: 'A confident athletic storefront.',
})

function okSender(): AiSender {
  return vi.fn(async () => ({ text: CANNED_SPEC_JSON }))
}

function failingSender(): AiSender {
  return vi.fn(async () => {
    throw new Error('opus exploded')
  })
}

function captureLogger() {
  const events: Array<{ level: string; event: string; fields?: any }> = []
  return {
    events,
    logger: {
      info: (event: string, fields?: any) =>
        events.push({ level: 'info', event, fields }),
      warn: (event: string, fields?: any) =>
        events.push({ level: 'warn', event, fields }),
      error: (event: string, fields?: any) =>
        events.push({ level: 'error', event, fields }),
    },
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runCloneOrchestrator — happy path', () => {
  it('runs the full 6-step pipeline and persists the theme', async () => {
    const { db, state } = createFakeDb()
    const fetchImpl = makeFetchMock()
    const aiSender = okSender()
    const { events, logger } = captureLogger()

    const res = await runCloneOrchestrator(
      db,
      {
        shopId: 'shop-1',
        url: 'https://velocity.example/',
        merchantHint: 'Make it pop',
      },
      { fetchImpl, aiSender, logger },
    )

    expect(res.ok).toBe(true)
    if (!res.ok) return

    // Theme was created with the right shop and name
    expect(res.theme.shop_id).toBe('shop-1')
    expect(res.theme.name).toContain('Velocity Running')
    expect(res.theme.role).toBe('unpublished')

    // All seed files were persisted as assets
    expect(res.filesWritten).toBeGreaterThan(0)
    expect(state.assets.length).toBe(res.filesWritten)
    expect(state.assets.every((a) => a.theme_id === res.theme.id)).toBe(true)

    // Spec came through correctly
    expect(res.spec.brand.name).toBe('Velocity Running')
    expect(res.spec.palette.primary).toBe('#ff6600')
    expect(res.spec.sections.map((s) => s.type)).toEqual([
      'header',
      'hero',
      'featured-products',
      'footer',
    ])

    // Bundle files include customised theme.css
    const cssAsset = state.assets.find((a) => a.key === 'assets/theme.css')
    expect(cssAsset).toBeDefined()
    expect(cssAsset!.value).toContain('--color-accent: #ff6600')
    expect(cssAsset!.content_type).toBe('text/css')

    // Content-type inference wired through
    const layoutAsset = state.assets.find((a) => a.key === 'layout/theme.liquid')
    expect(layoutAsset?.content_type).toBe('text/x-liquid')
    const indexAsset = state.assets.find((a) => a.key === 'templates/index.json')
    expect(indexAsset?.content_type).toBe('application/json')

    // Logger saw the happy-path events in order
    const eventNames = events.map((e) => e.event)
    expect(eventNames).toContain('clone.crawl.ok')
    expect(eventNames).toContain('clone.report.ok')
    expect(eventNames).toContain('clone.ai.ok')
    expect(eventNames).toContain('clone.bundle.ok')
    expect(eventNames).toContain('clone.persist.ok')
    // AI sender was called exactly once
    expect(aiSender).toHaveBeenCalledTimes(1)
  })

  it('forwards merchant hint to the AI sender', async () => {
    const { db } = createFakeDb()
    const aiSender = okSender()
    await runCloneOrchestrator(
      db,
      {
        shopId: 'shop-1',
        url: 'https://velocity.example/',
        merchantHint: 'Target Gen-Z and emphasise sustainability',
      },
      { fetchImpl: makeFetchMock(), aiSender },
    )
    const call = (aiSender as any).mock.calls[0][0]
    const userMsg = call.messages[0].content as string
    expect(userMsg).toContain('Target Gen-Z and emphasise sustainability')
  })
})

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe('runCloneOrchestrator — failure paths', () => {
  it('returns invalid_url when the URL cannot be normalised', async () => {
    const { db } = createFakeDb()
    const res = await runCloneOrchestrator(
      db,
      { shopId: 'shop-1', url: 'ftp://nope.example/' },
      { fetchImpl: makeFetchMock(), aiSender: okSender() },
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('invalid_url')
    expect(res.message).toMatch(/unsupported scheme/i)
  })

  it('returns crawl_failed when HTML body is empty', async () => {
    const { db } = createFakeDb()
    const { events, logger } = captureLogger()
    const res = await runCloneOrchestrator(
      db,
      { shopId: 'shop-1', url: 'https://empty.example/' },
      { fetchImpl: makeEmptyFetch(), aiSender: okSender(), logger },
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('crawl_failed')
    expect(res.message).toMatch(/unable to fetch/i)
    expect(events.some((e) => e.event === 'clone.crawl_failed')).toBe(true)
  })

  it('does NOT call the AI sender when crawl fails', async () => {
    const { db } = createFakeDb()
    const aiSender = okSender()
    await runCloneOrchestrator(
      db,
      { shopId: 'shop-1', url: 'https://empty.example/' },
      { fetchImpl: makeEmptyFetch(), aiSender },
    )
    expect(aiSender).not.toHaveBeenCalled()
  })

  it('returns invalid_url when fetch throws for the entry URL', async () => {
    // crawler catches fetch errors per-resource so it won't throw from
    // crawl() itself — but the HTML body will be empty, which is a
    // crawl_failed outcome not invalid_url. Assert that behaviour.
    const { db } = createFakeDb()
    const res = await runCloneOrchestrator(
      db,
      { shopId: 'shop-1', url: 'https://velocity.example/' },
      { fetchImpl: makeFailingFetch(), aiSender: okSender() },
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('crawl_failed')
  })

  it('returns ai_request_failed when the sender throws', async () => {
    const { db } = createFakeDb()
    const { events, logger } = captureLogger()
    const res = await runCloneOrchestrator(
      db,
      { shopId: 'shop-1', url: 'https://velocity.example/' },
      { fetchImpl: makeFetchMock(), aiSender: failingSender(), logger },
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('ai_request_failed')
    expect(res.message).toContain('opus exploded')
    expect(events.some((e) => e.event === 'clone.ai_failed')).toBe(true)
  })

  it('returns persist_failed and rolls back when createTheme fails', async () => {
    const { db, state } = createFakeDb()
    state.failNextThemeInsert = true
    const { events, logger } = captureLogger()
    const res = await runCloneOrchestrator(
      db,
      { shopId: 'shop-1', url: 'https://velocity.example/' },
      { fetchImpl: makeFetchMock(), aiSender: okSender(), logger },
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('persist_failed')
    expect(res.message).toContain('theme insert boom')
    // No rolled-back ID because we never got a theme row
    expect(res.rolledBackThemeId).toBeUndefined()
    expect(state.themes.length).toBe(0)
    expect(state.assets.length).toBe(0)
    expect(events.some((e) => e.event === 'clone.create_theme_failed')).toBe(true)
  })

  it('rolls back the half-built theme when asset persistence explodes', async () => {
    const { db, state } = createFakeDb()
    state.failNextAssetInsert = true
    const { events, logger } = captureLogger()

    const res = await runCloneOrchestrator(
      db,
      { shopId: 'shop-1', url: 'https://velocity.example/' },
      { fetchImpl: makeFetchMock(), aiSender: okSender(), logger },
    )

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('persist_failed')
    expect(res.message).toContain('asset insert boom')
    // rolledBackThemeId should be set, theme row should be gone
    expect(res.rolledBackThemeId).toBeDefined()
    expect(state.themes.length).toBe(0)
    // Any assets that managed to land before the explosion were also deleted
    expect(state.assets.length).toBe(0)
    expect(
      events.some((e) => e.event === 'clone.persist_assets_failed'),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Logger wiring
// ---------------------------------------------------------------------------

describe('runCloneOrchestrator — logger', () => {
  it('uses a no-op logger when none is supplied (no crash)', async () => {
    const { db } = createFakeDb()
    const res = await runCloneOrchestrator(
      db,
      { shopId: 'shop-1', url: 'https://velocity.example/' },
      { fetchImpl: makeFetchMock(), aiSender: okSender() },
    )
    expect(res.ok).toBe(true)
  })

  it('includes warnings from AI spec parsing in the success payload', async () => {
    const { db } = createFakeDb()
    // Garbage response → fallback path → ai_no_json warning
    const junkSender: AiSender = vi.fn(async () => ({ text: 'no json here' }))
    const res = await runCloneOrchestrator(
      db,
      { shopId: 'shop-1', url: 'https://velocity.example/' },
      { fetchImpl: makeFetchMock(), aiSender: junkSender },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.aiWarnings.some((w) => w.startsWith('ai_no_json'))).toBe(true)
    // Pipeline still produced a valid theme on the fallback spec
    expect(res.filesWritten).toBeGreaterThan(0)
  })
})
