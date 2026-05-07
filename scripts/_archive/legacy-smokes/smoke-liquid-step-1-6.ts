/**
 * Smoke test — Decision #1 Step 1.6 DbLoader end-to-end.
 *
 * Verifies the PostgreSQL-backed TemplateLoader against a lightweight
 * in-memory fake that speaks the subset of Kysely our DbLoader uses.
 * This exercises the same production code path (load/loadWithMeta/
 * exists/list/invalidate + LiquidJS `{% render %}`) that would run
 * against real Postgres, without needing a DB connection from the
 * Windows dev box (server 2 runs the real integration; see smoke
 * runbook).
 *
 * Assertions:
 *   1. load() returns the row's `value` column
 *   2. loadWithMeta() fills in updatedAt
 *   3. Missing row → null
 *   4. value=NULL row (binary asset in R2) → null
 *   5. Cache hit: second load() does not re-query
 *   6. exists() + list() work
 *   7. list(prefix) filters with LIKE escaping
 *   8. invalidate(path) forces a re-query
 *   9. Path traversal rejected
 *  10. LiquidJS `{% render %}` resolves snippets through DbLoader
 *  11. LiquidJS {% include %} works through DbLoader
 *  12. Two concurrent load()s for the same key dedup to one query
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-6.ts
 */

import {
  createLiquidEngine,
  DbLoader,
} from '../packages/core/src/modules/themes/engine/index.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/index.js'

// ---------------------------------------------------------------------------
// Fake Kysely — just enough to satisfy DbLoader
// ---------------------------------------------------------------------------

interface Row {
  theme_id: string
  key: string
  value: string | null
  updated_at: string
}

/** Track DB-query counts so assertions can verify caching. */
const counters = {
  selectFromCalls: 0,
  executeTakeFirstCalls: 0,
  executeCalls: 0,
}

function resetCounters() {
  counters.selectFromCalls = 0
  counters.executeTakeFirstCalls = 0
  counters.executeCalls = 0
}

function makeFakeDb(rows: Row[]) {
  return {
    selectFrom(_table: string) {
      counters.selectFromCalls++

      const state = {
        themeId: undefined as string | undefined,
        keyEq: undefined as string | undefined,
        keyLike: undefined as string | undefined,
      }

      const chain: any = {
        select: (_cols: any) => chain,
        where(col: string, op: string, val: string) {
          if (col === 'theme_id' && op === '=') state.themeId = val
          if (col === 'key' && op === '=') state.keyEq = val
          if (col === 'key' && op === 'like') state.keyLike = val
          return chain
        },
        orderBy(_col: string, _dir: string) {
          return chain
        },
        async executeTakeFirst() {
          counters.executeTakeFirstCalls++
          const row = rows.find(
            (r) => r.theme_id === state.themeId && r.key === state.keyEq,
          )
          if (!row) return undefined
          return { value: row.value, updated_at: row.updated_at }
        },
        async execute() {
          counters.executeCalls++
          let filtered = rows.filter((r) => r.theme_id === state.themeId)
          if (state.keyLike) {
            // Convert LIKE pattern to regex. DbLoader only uses `prefix%`
            // with `\` escapes on `%` and `_` in the literal part.
            const literal = state.keyLike
              .replace(/%$/, '')
              .replace(/\\([\\%_])/g, '$1')
            filtered = filtered.filter((r) => r.key.startsWith(literal))
          }
          filtered.sort((a, b) => a.key.localeCompare(b.key))
          return filtered.map((r) => ({ key: r.key }))
        },
      }
      return chain
    },
  } as any
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const THEME_ID = '11111111-2222-3333-4444-555555555555'

const fixture: Row[] = [
  {
    theme_id: THEME_ID,
    key: 'layout/theme.liquid',
    value:
      '<!doctype html><html><body>{% section "header" %}{{ content_for_layout }}</body></html>',
    updated_at: '2026-04-09T00:00:00.000Z',
  },
  {
    theme_id: THEME_ID,
    key: 'sections/header.liquid',
    value: '<header>{% render "logo", name: "Gbox" %}</header>',
    updated_at: '2026-04-09T00:00:00.000Z',
  },
  {
    theme_id: THEME_ID,
    key: 'snippets/logo.liquid',
    value: '<span class="logo">{{ name | upcase }}</span>',
    updated_at: '2026-04-09T00:00:00.000Z',
  },
  {
    theme_id: THEME_ID,
    key: 'snippets/hero.liquid',
    value: '<h1>{{ title }}</h1>',
    updated_at: '2026-04-09T00:00:00.000Z',
  },
  {
    theme_id: THEME_ID,
    key: 'snippets/breadcrumbs.liquid',
    value: '<nav>Home › {{ page }}</nav>',
    updated_at: '2026-04-09T00:00:00.000Z',
  },
  // Binary asset — `value` is NULL because the blob lives in R2.
  {
    theme_id: THEME_ID,
    key: 'assets/theme.css',
    value: null,
    updated_at: '2026-04-09T00:00:00.000Z',
  },
]

async function main() {
  // ----- (1) load() returns the value column -----
  resetCounters()
  const db = makeFakeDb(fixture)
  const loader = new DbLoader(db, { themeId: THEME_ID })

  const hero = await loader.load('snippets/hero.liquid')
  if (hero !== '<h1>{{ title }}</h1>') throw new Error(`(1) ${hero}`)
  console.log('PASS (1) load() returns value column:', hero)

  // ----- (2) loadWithMeta() includes updatedAt -----
  const meta = await loader.loadWithMeta('snippets/logo.liquid')
  if (!meta || meta.updatedAt !== '2026-04-09T00:00:00.000Z') {
    throw new Error(`(2) ${JSON.stringify(meta)}`)
  }
  console.log('PASS (2) loadWithMeta() includes updatedAt:', meta.updatedAt)

  // ----- (3) Missing row → null -----
  const missing = await loader.load('snippets/ghost.liquid')
  if (missing !== null) throw new Error(`(3) ${missing}`)
  console.log('PASS (3) missing row → null')

  // ----- (4) value=NULL row → null -----
  const binary = await loader.load('assets/theme.css')
  if (binary !== null) throw new Error(`(4) ${binary}`)
  console.log('PASS (4) value=NULL row → null (R2 spillover path)')

  // ----- (5) Cache hit: second load() doesn't re-query -----
  resetCounters()
  await loader.load('snippets/hero.liquid') // already cached from (1)
  if (counters.executeTakeFirstCalls !== 0) {
    throw new Error(
      `(5) expected 0 re-queries, got ${counters.executeTakeFirstCalls}`,
    )
  }
  console.log('PASS (5) cache hit — no re-query')

  // ----- (6) exists() -----
  if (!(await loader.exists('snippets/logo.liquid'))) {
    throw new Error('(6) exists(logo) should be true')
  }
  if (await loader.exists('snippets/ghost.liquid')) {
    throw new Error('(6) exists(ghost) should be false')
  }
  console.log('PASS (6) exists()')

  // ----- (7) list(prefix) with LIKE escape -----
  const all = await loader.list()
  if (all.length !== 6 || all[0] !== 'assets/theme.css') {
    throw new Error(`(7a) ${JSON.stringify(all)}`)
  }
  const snippets = await loader.list('snippets/')
  if (
    snippets.length !== 3 ||
    snippets[0] !== 'snippets/breadcrumbs.liquid' ||
    snippets[2] !== 'snippets/logo.liquid'
  ) {
    throw new Error(`(7b) ${JSON.stringify(snippets)}`)
  }
  console.log('PASS (7) list() + list(prefix):', snippets.length, 'snippets')

  // ----- (8) invalidate() forces re-query -----
  resetCounters()
  await loader.load('snippets/hero.liquid') // cached
  if (counters.executeTakeFirstCalls !== 0) {
    throw new Error('(8a) should be cached')
  }
  loader.invalidate('snippets/hero.liquid')
  await loader.load('snippets/hero.liquid')
  if (counters.executeTakeFirstCalls !== 1) {
    throw new Error(
      `(8b) expected 1 re-query after invalidate, got ${counters.executeTakeFirstCalls}`,
    )
  }
  console.log('PASS (8) invalidate() forces re-query')

  // ----- (9) Path traversal rejected -----
  let threw = false
  try {
    await loader.load('../../etc/passwd')
  } catch {
    threw = true
  }
  if (!threw) throw new Error('(9) path traversal should throw')
  console.log('PASS (9) path traversal rejected')

  // ----- (10) LiquidJS {% render %} via DbLoader -----
  const engine = createLiquidEngine({ loader, i18n: new MemoryI18nService() })
  const rendered = await engine.liquid.parseAndRender(
    '{% render "logo", name: "gbox" %}',
  )
  if (rendered !== '<span class="logo">GBOX</span>') {
    throw new Error(`(10) ${rendered}`)
  }
  console.log('PASS (10) {% render %} via DbLoader:', rendered)

  // ----- (11) {% include %} via DbLoader -----
  const included = await engine.liquid.parseAndRender(
    '{% include "breadcrumbs" %}',
    { page: 'Products' },
  )
  if (!included.includes('Home › Products')) {
    throw new Error(`(11) ${included}`)
  }
  console.log('PASS (11) {% include %} via DbLoader:', included)

  // ----- (12) Concurrent load() dedup -----
  const freshLoader = new DbLoader(makeFakeDb(fixture), { themeId: THEME_ID })
  resetCounters()
  const concurrent = await Promise.all([
    freshLoader.load('snippets/hero.liquid'),
    freshLoader.load('snippets/hero.liquid'),
    freshLoader.load('snippets/hero.liquid'),
    freshLoader.load('snippets/hero.liquid'),
  ])
  if (concurrent.some((v) => v !== '<h1>{{ title }}</h1>')) {
    throw new Error(`(12) ${JSON.stringify(concurrent)}`)
  }
  // All four should have shared one query.
  if (counters.executeTakeFirstCalls !== 1) {
    throw new Error(
      `(12) expected 1 query via dedup, got ${counters.executeTakeFirstCalls}`,
    )
  }
  console.log('PASS (12) concurrent load() dedup to one query')

  console.log('\nALL PASSED — Step 1.6 DbLoader correctly wired')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
