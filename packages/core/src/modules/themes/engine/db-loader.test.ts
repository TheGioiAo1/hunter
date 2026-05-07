/**
 * Gbox Platform — DbLoader unit tests
 *
 * Decision #1 Step 1.6 — Tests the PostgreSQL-backed TemplateLoader
 * with a hand-rolled Kysely-shaped mock. Follows the same style as
 * `i18n/service.test.ts` so the mock pattern is consistent across
 * Decision #1 modules.
 *
 * What we test here:
 *   1. load()/loadWithMeta() issue one SELECT scoped to
 *      (theme_id, key)
 *   2. Cache: a second load() for the same key never re-queries
 *   3. In-flight dedup: two concurrent load()s share a single query
 *   4. Negative caching: a missing key caches as null and doesn't
 *      re-query on the second call
 *   5. NULL `value` column (binary asset) is treated as missing
 *   6. exists() reuses the cache correctly
 *   7. list() issues one SELECT with ORDER BY key
 *   8. list(prefix) adds a LIKE clause with metachar escaping
 *   9. Path traversal (`..`) is rejected before touching the DB
 *  10. invalidate(path) drops one entry; invalidate() drops all
 *  11. maxCacheSize evicts the oldest entry when the cap is reached
 *  12. cacheTtlMs expires entries after the TTL window
 *  13. Constructor guards (missing db, missing themeId)
 *
 * What we don't test here:
 *   - SQL string correctness — kysely's job
 *   - Real DB round-trip — that lives in the smoke test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DbLoader } from './db-loader.js'

const THEME_ID = '11111111-2222-3333-4444-555555555555'

// ---------------------------------------------------------------------------
// Kysely-shaped mock
// ---------------------------------------------------------------------------

interface MockState {
  /** Response for `.executeTakeFirst()` (load path). */
  takeFirstResult: { value: string | null; updated_at: string | Date | null } | undefined
  /** Response for `.execute()` (list path). */
  executeResult: Array<{ key: string }>
  /** Count of top-level `selectFrom('theme_assets')` calls. */
  selectCalls: number
  /**
   * Capture of every where clause observed during a single chain,
   * pushed as one object per chain build.
   */
  whereLog: Array<{ themeId?: string; key?: string; keyLike?: string }>
  /** Captured `.orderBy(col, dir)` for the list path. */
  orderBys: Array<{ col: string; dir: string }>
}

function createMockState(): MockState {
  return {
    takeFirstResult: undefined,
    executeResult: [],
    selectCalls: 0,
    whereLog: [],
    orderBys: [],
  }
}

function createMockDb(state: MockState) {
  function buildChain() {
    state.selectCalls++
    const captured: { themeId?: string; key?: string; keyLike?: string } = {}
    state.whereLog.push(captured)
    const chain: any = {
      select: vi.fn().mockReturnThis(),
      where: vi
        .fn()
        .mockImplementation((col: string, op: string, val: string) => {
          if (col === 'theme_id' && op === '=') captured.themeId = val
          if (col === 'key' && op === '=') captured.key = val
          if (col === 'key' && op === 'like') captured.keyLike = val
          return chain
        }),
      orderBy: vi.fn().mockImplementation((col: string, dir: string) => {
        state.orderBys.push({ col, dir })
        return chain
      }),
      executeTakeFirst: vi.fn().mockImplementation(async () => state.takeFirstResult),
      execute: vi.fn().mockImplementation(async () => state.executeResult),
    }
    return chain
  }

  return {
    selectFrom: vi.fn().mockImplementation((_table: string) => buildChain()),
  } as any
}

// ---------------------------------------------------------------------------
// Basic load + cache
// ---------------------------------------------------------------------------

describe('DbLoader — load + cache', () => {
  let state: MockState
  let loader: DbLoader

  beforeEach(() => {
    state = createMockState()
    state.takeFirstResult = {
      value: '<h1>Hello</h1>',
      updated_at: '2026-04-08T00:00:00.000Z',
    }
    loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })
  })

  it('load() returns the `value` column', async () => {
    const src = await loader.load('snippets/hero.liquid')
    expect(src).toBe('<h1>Hello</h1>')
  })

  it('load() scopes the query to (theme_id, key)', async () => {
    await loader.load('snippets/hero.liquid')
    expect(state.selectCalls).toBe(1)
    expect(state.whereLog[0]).toEqual({
      themeId: THEME_ID,
      key: 'snippets/hero.liquid',
    })
  })

  it('loadWithMeta() includes the updated_at timestamp', async () => {
    const r = await loader.loadWithMeta('snippets/hero.liquid')
    expect(r).toEqual({
      source: '<h1>Hello</h1>',
      updatedAt: '2026-04-08T00:00:00.000Z',
    })
  })

  it('loadWithMeta() coerces a Date updated_at to ISO string', async () => {
    state.takeFirstResult = {
      value: 'x',
      updated_at: new Date('2026-04-08T12:34:56.000Z'),
    }
    const r = await loader.loadWithMeta('sections/header.liquid')
    expect(r?.updatedAt).toBe('2026-04-08T12:34:56.000Z')
  })

  it('second load() for the same key hits cache (no re-query)', async () => {
    await loader.load('snippets/hero.liquid')
    await loader.load('snippets/hero.liquid')
    await loader.load('snippets/hero.liquid')
    expect(state.selectCalls).toBe(1)
  })

  it('different keys each issue their own query', async () => {
    await loader.load('snippets/a.liquid')
    await loader.load('snippets/b.liquid')
    expect(state.selectCalls).toBe(2)
  })

  it('_cacheSize reflects the cache population', async () => {
    expect(loader._cacheSize()).toBe(0)
    await loader.load('snippets/a.liquid')
    expect(loader._cacheSize()).toBe(1)
    await loader.load('snippets/b.liquid')
    expect(loader._cacheSize()).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// In-flight dedup
// ---------------------------------------------------------------------------

describe('DbLoader — in-flight dedup', () => {
  it('concurrent load()s for the same key share one query', async () => {
    let selectCalls = 0
    let resolveFetch!: (v: any) => void
    const db: any = {
      selectFrom: vi.fn().mockImplementation(() => {
        selectCalls++
        const chain: any = {}
        chain.select = vi.fn().mockReturnValue(chain)
        chain.where = vi.fn().mockReturnValue(chain)
        chain.executeTakeFirst = vi
          .fn()
          .mockImplementation(() => new Promise((res) => (resolveFetch = res)))
        return chain
      }),
    }
    const loader = new DbLoader(db, { themeId: THEME_ID })

    const p1 = loader.load('snippets/a.liquid')
    const p2 = loader.load('snippets/a.liquid')
    const p3 = loader.load('snippets/a.liquid')

    // Give the microtask queue a tick so fetchFromDb() has started.
    await new Promise((r) => setTimeout(r, 0))

    // Resolve the single in-flight query.
    resolveFetch({ value: 'ONE', updated_at: '2026-01-01' })

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).toBe('ONE')
    expect(r2).toBe('ONE')
    expect(r3).toBe('ONE')
    expect(selectCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Negative caching
// ---------------------------------------------------------------------------

describe('DbLoader — negative caching', () => {
  it('missing row caches as null and second call does not re-query', async () => {
    const state = createMockState()
    state.takeFirstResult = undefined // row not found
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })

    expect(await loader.load('snippets/ghost.liquid')).toBeNull()
    expect(await loader.load('snippets/ghost.liquid')).toBeNull()
    expect(state.selectCalls).toBe(1)
  })

  it('value=null row (binary asset in R2) is treated as missing', async () => {
    const state = createMockState()
    state.takeFirstResult = { value: null, updated_at: '2026-04-08' }
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })

    expect(await loader.load('assets/theme.css')).toBeNull()
    expect(await loader.loadWithMeta('assets/theme.css')).toBeNull()
    // Second call hits the negative cache.
    expect(state.selectCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// exists()
// ---------------------------------------------------------------------------

describe('DbLoader — exists()', () => {
  it('returns true for a present row', async () => {
    const state = createMockState()
    state.takeFirstResult = { value: '<x/>', updated_at: '2026-04-08' }
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })
    expect(await loader.exists('snippets/hero.liquid')).toBe(true)
  })

  it('returns false for a missing row', async () => {
    const state = createMockState()
    state.takeFirstResult = undefined
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })
    expect(await loader.exists('snippets/ghost.liquid')).toBe(false)
  })

  it('subsequent load() for the same key hits cache', async () => {
    const state = createMockState()
    state.takeFirstResult = { value: 'cached', updated_at: '2026-04-08' }
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })

    await loader.exists('snippets/hero.liquid')
    const src = await loader.load('snippets/hero.liquid')
    expect(src).toBe('cached')
    expect(state.selectCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe('DbLoader — list()', () => {
  it('returns every key sorted', async () => {
    const state = createMockState()
    state.executeResult = [
      { key: 'layout/theme.liquid' },
      { key: 'sections/footer.liquid' },
      { key: 'sections/header.liquid' },
      { key: 'snippets/card.liquid' },
    ]
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })
    const list = await loader.list()
    expect(list).toEqual([
      'layout/theme.liquid',
      'sections/footer.liquid',
      'sections/header.liquid',
      'snippets/card.liquid',
    ])
    expect(state.selectCalls).toBe(1)
    expect(state.whereLog[0]).toEqual({ themeId: THEME_ID })
    expect(state.orderBys).toEqual([{ col: 'key', dir: 'asc' }])
  })

  it('list(prefix) adds a LIKE clause', async () => {
    const state = createMockState()
    state.executeResult = [
      { key: 'snippets/card.liquid' },
      { key: 'snippets/hero.liquid' },
    ]
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })
    const list = await loader.list('snippets/')
    expect(list).toEqual(['snippets/card.liquid', 'snippets/hero.liquid'])
    expect(state.whereLog[0].keyLike).toBe('snippets/%')
  })

  it('list(prefix) escapes LIKE metacharacters', async () => {
    const state = createMockState()
    state.executeResult = []
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })
    await loader.list('hero_%_banner')
    // Underscores and percents get backslash-escaped.
    expect(state.whereLog[0].keyLike).toBe('hero\\_\\%\\_banner%')
  })
})

// ---------------------------------------------------------------------------
// Path traversal defense
// ---------------------------------------------------------------------------

describe('DbLoader — path traversal', () => {
  it('rejects `..` segment before querying the DB', async () => {
    const state = createMockState()
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })
    await expect(
      loader.load('../../etc/passwd'),
    ).rejects.toThrow(/path traversal/i)
    expect(state.selectCalls).toBe(0)
  })

  it('rejects `.` current-dir segment', async () => {
    const state = createMockState()
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })
    await expect(loader.load('snippets/./hero.liquid')).rejects.toThrow(
      /path traversal/i,
    )
    expect(state.selectCalls).toBe(0)
  })

  it('rejects empty path', async () => {
    const state = createMockState()
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })
    await expect(loader.load('')).rejects.toThrow(/must not be empty/i)
  })

  it('normalizes backslashes before querying', async () => {
    const state = createMockState()
    state.takeFirstResult = { value: 'ok', updated_at: '2026-04-08' }
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })
    await loader.load('snippets\\hero.liquid')
    expect(state.whereLog[0].key).toBe('snippets/hero.liquid')
  })
})

// ---------------------------------------------------------------------------
// invalidate()
// ---------------------------------------------------------------------------

describe('DbLoader — invalidate()', () => {
  it('invalidate(path) drops one entry; next load re-queries', async () => {
    const state = createMockState()
    state.takeFirstResult = { value: 'v1', updated_at: '2026-04-08' }
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })

    await loader.load('snippets/a.liquid')
    expect(state.selectCalls).toBe(1)

    loader.invalidate('snippets/a.liquid')
    await loader.load('snippets/a.liquid')
    expect(state.selectCalls).toBe(2)
  })

  it('invalidate() with no arg drops everything', async () => {
    const state = createMockState()
    state.takeFirstResult = { value: 'v1', updated_at: '2026-04-08' }
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })

    await loader.load('snippets/a.liquid')
    await loader.load('snippets/b.liquid')
    expect(loader._cacheSize()).toBe(2)

    loader.invalidate()
    expect(loader._cacheSize()).toBe(0)

    await loader.load('snippets/a.liquid')
    expect(state.selectCalls).toBe(3) // a, b, a-again
  })
})

// ---------------------------------------------------------------------------
// maxCacheSize eviction
// ---------------------------------------------------------------------------

describe('DbLoader — maxCacheSize', () => {
  it('drops the oldest entry when the cap is reached', async () => {
    const state = createMockState()
    state.takeFirstResult = { value: 'x', updated_at: '2026-04-08' }
    const loader = new DbLoader(createMockDb(state), {
      themeId: THEME_ID,
      maxCacheSize: 2,
    })

    await loader.load('snippets/a.liquid')
    await loader.load('snippets/b.liquid')
    expect(loader._cacheSize()).toBe(2)

    await loader.load('snippets/c.liquid')
    expect(loader._cacheSize()).toBe(2) // one was evicted

    // `a` was the oldest; it's gone and a re-load re-queries.
    expect(loader._peekCache('snippets/a.liquid')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// cacheTtlMs expiry
// ---------------------------------------------------------------------------

describe('DbLoader — cacheTtlMs', () => {
  it('entries expire and re-query after the TTL window', async () => {
    vi.useFakeTimers()
    try {
      const state = createMockState()
      state.takeFirstResult = { value: 'v1', updated_at: '2026-04-08' }
      const loader = new DbLoader(createMockDb(state), {
        themeId: THEME_ID,
        cacheTtlMs: 100,
      })

      await loader.load('snippets/a.liquid')
      expect(state.selectCalls).toBe(1)

      // Within TTL — cache hit.
      vi.advanceTimersByTime(50)
      await loader.load('snippets/a.liquid')
      expect(state.selectCalls).toBe(1)

      // Past TTL — cache miss.
      vi.advanceTimersByTime(100)
      await loader.load('snippets/a.liquid')
      expect(state.selectCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Constructor guards
// ---------------------------------------------------------------------------

describe('DbLoader — constructor', () => {
  it('rejects missing db', () => {
    expect(() => new DbLoader(null as any, { themeId: THEME_ID })).toThrow(
      /db is required/,
    )
  })

  it('rejects missing themeId', () => {
    const state = createMockState()
    expect(() => new DbLoader(createMockDb(state), { themeId: '' } as any)).toThrow(
      /themeId is required/,
    )
  })

  it('default name is `db:<first 8 of themeId>`', () => {
    const state = createMockState()
    const loader = new DbLoader(createMockDb(state), { themeId: THEME_ID })
    expect(loader.name).toBe('db:11111111')
  })

  it('custom label overrides the default name', () => {
    const state = createMockState()
    const loader = new DbLoader(createMockDb(state), {
      themeId: THEME_ID,
      label: 'main-theme',
    })
    expect(loader.name).toBe('main-theme')
  })
})

// ---------------------------------------------------------------------------
// End-to-end: DbLoader → LiquidJS engine
// ---------------------------------------------------------------------------

describe('DbLoader — LiquidJS engine integration', () => {
  it('createLiquidEngine renders a template served by DbLoader', async () => {
    const { createLiquidEngine } = await import('./liquid.js')
    const { MemoryI18nService } = await import('../../i18n/index.js')

    // Mock serves different templates depending on the `key` value.
    const templates: Record<string, string> = {
      'snippets/hero.liquid': '<h1>{{ title | upcase }}</h1>',
    }
    const db: any = {
      selectFrom: vi.fn().mockImplementation(() => {
        let currentKey = ''
        const chain: any = {}
        chain.select = vi.fn().mockReturnValue(chain)
        chain.where = vi
          .fn()
          .mockImplementation((col: string, _op: string, val: string) => {
            if (col === 'key') currentKey = val
            return chain
          })
        chain.orderBy = vi.fn().mockReturnValue(chain)
        chain.executeTakeFirst = vi.fn().mockImplementation(async () => {
          const src = templates[currentKey]
          return src
            ? { value: src, updated_at: '2026-04-09T00:00:00.000Z' }
            : undefined
        })
        chain.execute = vi.fn().mockResolvedValue([])
        return chain
      }),
    }

    const loader = new DbLoader(db, { themeId: THEME_ID })
    const engine = createLiquidEngine({ loader, i18n: new MemoryI18nService() })

    const html = await engine.liquid.parseAndRender(
      `{% render 'hero', title: 'hello' %}`,
    )
    expect(html).toBe('<h1>HELLO</h1>')
  })
})

// ---------------------------------------------------------------------------
// R2 sentinel resolution (Step 1.16)
// ---------------------------------------------------------------------------

describe('DbLoader — R2 sentinel resolution', () => {
  it('resolves r2://... values via the wired ObjectStore', async () => {
    const { MemoryStore } = await import('../../storage/memory-store.js')
    const store = new MemoryStore()
    await store.put('themes/theme-aaa/assets/big.css', 'body{color:red;}')

    const state = createMockState()
    state.takeFirstResult = {
      value: 'r2://themes/theme-aaa/assets/big.css',
      updated_at: '2026-04-09T00:00:00.000Z',
    }

    const loader = new DbLoader(createMockDb(state), {
      themeId: 'theme-aaa',
      objectStore: store,
    })

    const src = await loader.load('assets/big.css')
    expect(src).toBe('body{color:red;}')
  })

  it('caches the resolved R2 body so a second load is one fetch', async () => {
    const { MemoryStore } = await import('../../storage/memory-store.js')
    const store = new MemoryStore()
    await store.put('themes/theme-aaa/foo.css', 'one')
    let storeGets = 0
    const wrapped: any = {
      ...store,
      name: 'memory',
      get: async (k: string) => {
        storeGets++
        return store.get(k)
      },
    }

    const state = createMockState()
    state.takeFirstResult = {
      value: 'r2://themes/theme-aaa/foo.css',
      updated_at: '2026-04-09T00:00:00.000Z',
    }

    const loader = new DbLoader(createMockDb(state), {
      themeId: 'theme-aaa',
      objectStore: wrapped,
    })

    await loader.load('foo.css')
    await loader.load('foo.css')
    await loader.load('foo.css')
    expect(state.selectCalls).toBe(1)
    expect(storeGets).toBe(1)
  })

  it('treats r2:// as missing when no ObjectStore is wired', async () => {
    const state = createMockState()
    state.takeFirstResult = {
      value: 'r2://themes/theme-aaa/foo.css',
      updated_at: '2026-04-09T00:00:00.000Z',
    }
    const loader = new DbLoader(createMockDb(state), { themeId: 'theme-aaa' })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const src = await loader.load('foo.css')
    expect(src).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('treats r2:// as missing when the blob is gone (orphaned ref)', async () => {
    const { MemoryStore } = await import('../../storage/memory-store.js')
    const store = new MemoryStore() // empty — no put()

    const state = createMockState()
    state.takeFirstResult = {
      value: 'r2://themes/theme-aaa/missing.css',
      updated_at: '2026-04-09T00:00:00.000Z',
    }
    const loader = new DbLoader(createMockDb(state), {
      themeId: 'theme-aaa',
      objectStore: store,
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const src = await loader.load('missing.css')
    expect(src).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('inline values are unaffected by the R2 path', async () => {
    const state = createMockState()
    state.takeFirstResult = {
      value: '<h1>plain inline</h1>',
      updated_at: '2026-04-09T00:00:00.000Z',
    }
    const loader = new DbLoader(createMockDb(state), { themeId: 'theme-aaa' })
    const src = await loader.load('snippets/hero.liquid')
    expect(src).toBe('<h1>plain inline</h1>')
  })
})
