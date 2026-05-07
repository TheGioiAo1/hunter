/**
 * Unit tests for `searchThemeAssets` — the file-finder that powers the
 * theme editor's Ctrl+Shift+F panel.
 *
 * The other theme service helpers (getTheme, updateThemeAsset,
 * duplicateTheme, …) are exercised through scripts/smoke-phase7-pr4.ts
 * and the pre-existing asset-storage.test.ts / cloner.test.ts. This
 * file focuses on search ranking, mode flags, R2-sentinel safety, and
 * the extension filter — all pure in-memory behaviours that don't
 * benefit from a real DB.
 */

import { describe, it, expect } from 'vitest'
import { searchThemeAssets } from './service.js'

/**
 * Minimal Kysely facade. `searchThemeAssets` only calls
 * `selectFrom('theme_assets').select([...]).where('theme_id', '=', id)
 * .orderBy('key', 'asc').execute()` — so we stub exactly that chain.
 * No predicates beyond `theme_id =`; everything else is in-process.
 */
function fakeDb(rows: Array<{ theme_id: string; key: string; value: string | null }>) {
  const makeSelect = () => {
    let themeId: string | null = null
    const chain: any = {
      select: () => chain,
      where: (col: string, _op: string, val: unknown) => {
        if (col === 'theme_id') themeId = String(val)
        return chain
      },
      orderBy: () => chain,
      execute: async () =>
        rows.filter((r) => r.theme_id === themeId).map((r) => ({
          key: r.key,
          value: r.value,
        })),
    }
    return chain
  }
  return { selectFrom: (_t: string) => makeSelect() } as any
}

const THEME = 'theme-1'

function rows(
  entries: Array<[string, string | null]>,
): Array<{ theme_id: string; key: string; value: string | null }> {
  return entries.map(([key, value]) => ({ theme_id: THEME, key, value }))
}

describe('searchThemeAssets', () => {
  it('returns [] for empty / whitespace-only q', async () => {
    const db = fakeDb(rows([['layout/theme.liquid', 'body']]))
    expect(await searchThemeAssets(db, THEME, '')).toEqual([])
    expect(await searchThemeAssets(db, THEME, '   ')).toEqual([])
  })

  it('finds by filename substring (case-insensitive)', async () => {
    // Keep the body free of the needle so matchType is filename-only.
    const db = fakeDb(
      rows([
        ['templates/product.liquid', '<h1>{{ title }}</h1>'],
        ['templates/collection.liquid', '<h1>{{ title }}</h1>'],
        ['snippets/header.liquid', ''],
      ]),
    )
    const hits = await searchThemeAssets(db, THEME, 'PRODUCT')
    expect(hits.map((h) => h.key)).toEqual(['templates/product.liquid'])
    expect(hits[0]!.matchType).toBe('filename')
  })

  it('finds by body content and surfaces a snippet + line number', async () => {
    const body = ['<header>', '  {{ shop.name }}', '  <!-- footer marker -->', '</header>'].join(
      '\n',
    )
    const db = fakeDb(
      rows([
        ['sections/header.liquid', body],
        ['sections/product.liquid', '<h1>Other</h1>'],
      ]),
    )
    const hits = await searchThemeAssets(db, THEME, 'footer marker')
    expect(hits.length).toBe(1)
    expect(hits[0]!.key).toBe('sections/header.liquid')
    expect(hits[0]!.matchType).toBe('content')
    expect(hits[0]!.lineNumber).toBe(3)
    expect(hits[0]!.snippet).toBe('<!-- footer marker -->')
  })

  it('reports matchType=both when key AND body match', async () => {
    const db = fakeDb(
      rows([
        ['templates/product.liquid', 'includes product listing'],
      ]),
    )
    const hits = await searchThemeAssets(db, THEME, 'product')
    expect(hits.length).toBe(1)
    expect(hits[0]!.matchType).toBe('both')
  })

  it('ranks exact key match > prefix > contains > content-only', async () => {
    const db = fakeDb(
      rows([
        ['product', 'nothing here'], // exact match wins
        ['product.liquid', 'nothing here'], // prefix
        ['templates/product.liquid', 'nothing here'], // contains
        ['layout/theme.liquid', 'all about product'], // content-only
      ]),
    )
    const hits = await searchThemeAssets(db, THEME, 'product')
    expect(hits.map((h) => h.key)).toEqual([
      'product',
      'product.liquid',
      'templates/product.liquid',
      'layout/theme.liquid',
    ])
  })

  it('respects mode=filename (skips body scan entirely)', async () => {
    const db = fakeDb(
      rows([
        ['layout/theme.liquid', 'mentions needle deep in the body'],
        ['needle.json', '{}'],
      ]),
    )
    const hits = await searchThemeAssets(db, THEME, 'needle', { mode: 'filename' })
    expect(hits.map((h) => h.key)).toEqual(['needle.json'])
  })

  it('respects mode=content (skips filename-only matches)', async () => {
    const db = fakeDb(
      rows([
        ['needle.json', '{}'], // filename match, no body
        ['layout/theme.liquid', 'contains needle in body'], // body match
      ]),
    )
    const hits = await searchThemeAssets(db, THEME, 'needle', { mode: 'content' })
    expect(hits.map((h) => h.key)).toEqual(['layout/theme.liquid'])
  })

  it('skips R2-sentinel rows for body scan (large assets not re-fetched)', async () => {
    const db = fakeDb(
      rows([
        ['assets/hero.png', 'r2://themes/abc/assets/hero.png'], // sentinel
      ]),
    )

    // Content-only mode: R2 row must be skipped → empty result.
    expect(
      await searchThemeAssets(db, THEME, 'themes', { mode: 'content' }),
    ).toEqual([])

    // Filename mode: the key still matches.
    const filenameHits = await searchThemeAssets(db, THEME, 'hero', {
      mode: 'filename',
    })
    expect(filenameHits.map((h) => h.key)).toEqual(['assets/hero.png'])
    expect(filenameHits[0]!.snippet).toBeNull()
  })

  it('applies extension filter (with or without leading dot)', async () => {
    const db = fakeDb(
      rows([
        ['templates/product.liquid', 'x'],
        ['templates/product.json', 'x'],
        ['assets/style.css', 'x'],
      ]),
    )

    const liquid = await searchThemeAssets(db, THEME, 'product', {
      ext: '.liquid',
    })
    expect(liquid.map((h) => h.key)).toEqual(['templates/product.liquid'])

    const noDot = await searchThemeAssets(db, THEME, 'product', {
      ext: 'json',
    })
    expect(noDot.map((h) => h.key)).toEqual(['templates/product.json'])
  })

  it('respects the limit option', async () => {
    const many = Array.from({ length: 20 }, (_, i) => [
      `templates/product-${String(i).padStart(2, '0')}.liquid`,
      '',
    ]) as Array<[string, string]>
    const db = fakeDb(rows(many))

    const hits = await searchThemeAssets(db, THEME, 'product', { limit: 5 })
    expect(hits.length).toBe(5)
    // Should be the first 5 alphabetically after the rank sort.
    expect(hits.map((h) => h.key)).toEqual([
      'templates/product-00.liquid',
      'templates/product-01.liquid',
      'templates/product-02.liquid',
      'templates/product-03.liquid',
      'templates/product-04.liquid',
    ])
  })

  it('clamps limit to [1, 200] so a hostile client can not request unlimited', async () => {
    const db = fakeDb(rows([['templates/a.liquid', '']]))
    // Absurdly large limit: clamped, still returns 1 match.
    const big = await searchThemeAssets(db, THEME, 'a', { limit: 100000 })
    expect(big.length).toBe(1)
    // Zero / negative: clamped up to at least 1.
    const zero = await searchThemeAssets(db, THEME, 'a', { limit: 0 })
    expect(zero.length).toBe(1)
  })

  it('is theme-scoped (rows from other themes are invisible)', async () => {
    const db = fakeDb([
      { theme_id: 'theme-1', key: 'mine.liquid', value: '' },
      { theme_id: 'theme-2', key: 'theirs.liquid', value: '' },
    ])
    const hits = await searchThemeAssets(db, 'theme-1', 'liquid')
    expect(hits.map((h) => h.key)).toEqual(['mine.liquid'])
  })

  it('handles multi-line snippet extraction cleanly (trims + clips to 200 chars)', async () => {
    const longLine = `  ${'x '.repeat(300)}needle${' y'.repeat(300)}  `
    const body = `line one\n${longLine}\nline three`
    const db = fakeDb(rows([['a.liquid', body]]))
    const hits = await searchThemeAssets(db, THEME, 'needle')
    expect(hits.length).toBe(1)
    expect(hits[0]!.lineNumber).toBe(2)
    expect(hits[0]!.snippet!.length).toBeLessThanOrEqual(200)
    // Trimmed — no leading whitespace even though the input line had it.
    expect(hits[0]!.snippet!.startsWith(' ')).toBe(false)
  })
})
