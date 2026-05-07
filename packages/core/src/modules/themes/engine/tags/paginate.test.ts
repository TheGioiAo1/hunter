/**
 * Gbox Platform — `{% paginate %}` tag tests
 *
 * Decision #1 Step 1.12. Cover:
 *
 *   1. Basic paginate block — slices an in-memory array, exposes
 *      `paginate.*` drop, rebinds the dotted path inside the body.
 *   2. Full-path rebind works at arbitrary depth (not just single-
 *      dotted). Original parent objects stay immutable.
 *   3. `paginate.parts[]` algorithm — window of 2 around current,
 *      always includes 1 and last, ellipses fill gaps.
 *   4. `buildPageUrl` helper — preserves query strings, strips old
 *      `page=`, appends fresh.
 *   5. Env-driven pagination input overrides the default (page=1,
 *      total=iterable.length).
 *   6. `previous` / `next` links obey edge cases (page 1 → no prev;
 *      last page → no next).
 *   7. `by` argument can be a Liquid expression, not just a literal.
 *   8. Parse errors — missing `by`, bad syntax, unclosed block.
 */

import { describe, it, expect } from 'vitest'
import { createLiquidEngine } from '../liquid.js'
import { StaticLoader } from '../static-loader.js'
import { MemoryI18nService } from '../../../i18n/index.js'
import type { TemplateLoader, LoadResult, LogicalPath } from '../loader.js'
import {
  buildPaginateParts,
  buildPageUrl,
  GBOX_PAGINATION_ENV_KEY,
  type GboxPaginationEnv,
  type PaginatePart,
} from './paginate.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class MemoryLoader implements TemplateLoader {
  readonly name = 'memory'
  constructor(private readonly files: Record<string, string>) {}
  async load(p: LogicalPath): Promise<string | null> {
    return this.files[p] ?? null
  }
  async loadWithMeta(p: LogicalPath): Promise<LoadResult | null> {
    const src = this.files[p]
    return src === undefined ? null : { source: src }
  }
  async exists(p: LogicalPath): Promise<boolean> {
    return p in this.files
  }
  async list(prefix = ''): Promise<LogicalPath[]> {
    return Object.keys(this.files).filter((k) => k.startsWith(prefix))
  }
}

function makeEngine(files: Record<string, string> = {}) {
  return createLiquidEngine({
    loader: new MemoryLoader(files),
    i18n: new MemoryI18nService(),
  })
}

function fakeItems(n: number): Array<{ id: number; title: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `item-${i + 1}`,
  }))
}

// ---------------------------------------------------------------------------
// buildPaginateParts — unit-level coverage of the parts algorithm
// ---------------------------------------------------------------------------

describe('buildPaginateParts', () => {
  it('returns an empty array for 0 or 1 total pages', () => {
    expect(buildPaginateParts(1, 0, '/x')).toEqual([])
    expect(buildPaginateParts(1, 1, '/x')).toEqual([])
  })

  it('emits plain link parts when totalPages is small (no ellipsis)', () => {
    // current = 2, total = 5 → window ±2 covers [1..4], plus 5
    const parts = buildPaginateParts(2, 5, '/col')
    expect(parts.map(summary)).toEqual([
      '1 link /col?page=1',
      '2 current',
      '3 link /col?page=3',
      '4 link /col?page=4',
      '5 link /col?page=5',
    ])
  })

  it('inserts an ellipsis when there is a gap after page 1', () => {
    // current = 7, total = 10, window ±2 → shown: 1, [5..9], 10
    // gap between 1 and 5 → ellipsis
    const parts = buildPaginateParts(7, 10, '/x')
    expect(parts.map(summary)).toEqual([
      '1 link /x?page=1',
      '… ellipsis',
      '5 link /x?page=5',
      '6 link /x?page=6',
      '7 current',
      '8 link /x?page=8',
      '9 link /x?page=9',
      '10 link /x?page=10',
    ])
  })

  it('inserts an ellipsis before the last page when the tail has a gap', () => {
    // current = 3, total = 10, window ±2 → shown: 1, [1..5], 10
    // gap between 5 and 10 → ellipsis
    const parts = buildPaginateParts(3, 10, '/x')
    expect(parts.map(summary)).toEqual([
      '1 link /x?page=1',
      '2 link /x?page=2',
      '3 current',
      '4 link /x?page=4',
      '5 link /x?page=5',
      '… ellipsis',
      '10 link /x?page=10',
    ])
  })

  it('inserts two ellipses when both head and tail have gaps', () => {
    // current = 15, total = 30, window ±2
    const parts = buildPaginateParts(15, 30, '/x')
    const titles = parts.map((p) => p.title)
    expect(titles).toEqual([
      '1',
      '…',
      '13',
      '14',
      '15',
      '16',
      '17',
      '…',
      '30',
    ])
    // Ellipsis parts are never links.
    for (const p of parts) {
      if (p.title === '…') expect(p.is_link).toBe(false)
    }
  })

  it('marks the current page with is_link=false and no url', () => {
    const parts = buildPaginateParts(3, 10, '/x')
    const current = parts.find((p) => p.title === '3')
    expect(current).toBeDefined()
    expect(current!.is_link).toBe(false)
    expect(current!.url).toBeUndefined()
  })
})

function summary(p: PaginatePart): string {
  if (!p.is_link) {
    return p.title === '…' ? '… ellipsis' : `${p.title} current`
  }
  return `${p.title} link ${p.url}`
}

// ---------------------------------------------------------------------------
// buildPageUrl — URL math
// ---------------------------------------------------------------------------

describe('buildPageUrl', () => {
  it('appends ?page=N to a plain path', () => {
    expect(buildPageUrl('/collections/all', 2)).toBe('/collections/all?page=2')
  })

  it('preserves existing query params when adding page', () => {
    expect(buildPageUrl('/blog?tag=news', 3)).toBe('/blog?tag=news&page=3')
  })

  it('replaces an existing page= entry', () => {
    expect(buildPageUrl('/x?page=5', 2)).toBe('/x?page=2')
  })

  it('replaces page= while preserving other params', () => {
    expect(buildPageUrl('/x?a=1&page=5&b=2', 7)).toBe('/x?a=1&b=2&page=7')
  })

  it('handles empty base path', () => {
    expect(buildPageUrl('', 4)).toBe('?page=4')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — tag running inside Liquid
// ---------------------------------------------------------------------------

describe('{% paginate %} tag — rendering', () => {
  it('slices the iterable and exposes paginate.current_page', async () => {
    const engine = makeEngine()
    const tpl = `{% paginate items by 3 %}[{% for i in items %}{{ i.title }},{% endfor %}]cp={{ paginate.current_page }} pages={{ paginate.pages }}{% endpaginate %}`
    const out = await engine.liquid.parseAndRender(tpl, { items: fakeItems(7) })
    // page 1, size 3, items 1..3
    expect(out).toContain('[item-1,item-2,item-3,]')
    expect(out).toContain('cp=1')
    expect(out).toContain('pages=3')
  })

  it('reads current page + total from the env key', async () => {
    const engine = makeEngine()
    const tpl = `{% paginate items by 2 %}{% for i in items %}{{ i.id }},{% endfor %}cp={{ paginate.current_page }} off={{ paginate.current_offset }}{% endpaginate %}`
    // Supply page=2 via env — iterable has 5 items, size 2 → page 2 yields items 3, 4.
    const paginationEnv: GboxPaginationEnv = { items: { page: 2 } }
    const out = await engine.liquid.parseAndRender(tpl, {
      items: fakeItems(5),
      [GBOX_PAGINATION_ENV_KEY]: paginationEnv,
    })
    expect(out).toContain('3,4,')
    expect(out).toContain('cp=2')
    expect(out).toContain('off=2')
  })

  it('rebinds a single-segment dotted path for the body scope', async () => {
    const engine = makeEngine()
    const tpl = `{% paginate products by 2 %}{% for p in products %}{{ p.id }},{% endfor %}{% endpaginate %}`
    const out = await engine.liquid.parseAndRender(tpl, {
      products: fakeItems(5),
    })
    expect(out).toBe('1,2,')
  })

  it('rebinds a dotted path without mutating the original parent', async () => {
    const engine = makeEngine()
    const tpl = `{% paginate collection.products by 2 %}IN:{% for p in collection.products %}{{ p.id }},{% endfor %}{% endpaginate %}OUT:{% for p in collection.products %}{{ p.id }},{% endfor %}`
    const scope = { collection: { products: fakeItems(5), title: 'Shirts' } }
    const out = await engine.liquid.parseAndRender(tpl, scope)
    expect(out).toContain('IN:1,2,')
    expect(out).toContain('OUT:1,2,3,4,5,')
    // The scope passed in must not have been mutated.
    expect(scope.collection.products).toHaveLength(5)
  })

  it('rebinds a deep dotted path (foo.bar.baz) at arbitrary depth', async () => {
    const engine = makeEngine()
    const tpl = `{% paginate shop.collection.products by 2 %}{% for p in shop.collection.products %}{{ p.id }},{% endfor %}|title={{ shop.collection.title }}|name={{ shop.name }}{% endpaginate %}`
    const scope = {
      shop: {
        name: 'Gbox',
        collection: { title: 'All', products: fakeItems(5) },
      },
    }
    const out = await engine.liquid.parseAndRender(tpl, scope)
    expect(out).toContain('1,2,')
    // Intermediate fields remain reachable after rebind.
    expect(out).toContain('title=All')
    expect(out).toContain('name=Gbox')
    // Original scope is pristine.
    expect(scope.shop.collection.products).toHaveLength(5)
  })

  it('exposes previous=null on page 1', async () => {
    const engine = makeEngine()
    const tpl = `{% paginate items by 2 %}prev={{ paginate.previous.title | default: 'none' }}{% endpaginate %}`
    const out = await engine.liquid.parseAndRender(tpl, { items: fakeItems(5) })
    expect(out).toContain('prev=none')
  })

  it('exposes next=null on the last page', async () => {
    const engine = makeEngine()
    const tpl = `{% paginate items by 2 %}next={{ paginate.next.title | default: 'none' }}{% endpaginate %}`
    // 5 items, size 2 → 3 pages. Set current = 3 via env.
    const paginationEnv: GboxPaginationEnv = { items: { page: 3 } }
    const out = await engine.liquid.parseAndRender(tpl, {
      items: fakeItems(5),
      [GBOX_PAGINATION_ENV_KEY]: paginationEnv,
    })
    expect(out).toContain('next=none')
  })

  it('evaluates a Liquid expression for the `by` argument', async () => {
    const engine = makeEngine()
    const tpl = `{% paginate items by section.settings.per_page %}{% for i in items %}{{ i.id }},{% endfor %}{% endpaginate %}`
    const out = await engine.liquid.parseAndRender(tpl, {
      items: fakeItems(5),
      section: { settings: { per_page: 2 } },
    })
    expect(out).toBe('1,2,')
  })

  it('clamps out-of-range current page to the last valid page', async () => {
    const engine = makeEngine()
    const tpl = `{% paginate items by 2 %}cp={{ paginate.current_page }}{% endpaginate %}`
    // 5 items / size 2 → 3 pages; input asks for page 99.
    const paginationEnv: GboxPaginationEnv = { items: { page: 99 } }
    const out = await engine.liquid.parseAndRender(tpl, {
      items: fakeItems(5),
      [GBOX_PAGINATION_ENV_KEY]: paginationEnv,
    })
    expect(out).toContain('cp=3')
  })

  it('treats a non-array iterable as empty and renders a 1-page drop', async () => {
    const engine = makeEngine()
    const tpl = `{% paginate ghost by 5 %}pages={{ paginate.pages }} items={{ paginate.items }}{% endpaginate %}`
    const out = await engine.liquid.parseAndRender(tpl)
    expect(out).toContain('pages=1')
    expect(out).toContain('items=0')
  })

  it('honors a caller-supplied total larger than the iterable length', async () => {
    const engine = makeEngine()
    const tpl = `{% paginate items by 10 %}pages={{ paginate.pages }} items={{ paginate.items }}{% endpaginate %}`
    // iterable is one pre-sliced page (10 items) but the real total is 93.
    const paginationEnv: GboxPaginationEnv = { items: { page: 1, total: 93 } }
    const out = await engine.liquid.parseAndRender(tpl, {
      items: fakeItems(10),
      [GBOX_PAGINATION_ENV_KEY]: paginationEnv,
    })
    expect(out).toContain('pages=10')
    expect(out).toContain('items=93')
  })
})

// ---------------------------------------------------------------------------
// Parse-time errors
// ---------------------------------------------------------------------------

describe('{% paginate %} tag — parse errors', () => {
  it('throws when the tag is missing `by <size>`', async () => {
    const engine = makeEngine()
    await expect(engine.liquid.parseAndRender(`{% paginate items %}x{% endpaginate %}`))
      .rejects.toThrow(/paginate/i)
  })

  it('throws when the block has no {% endpaginate %}', async () => {
    const engine = makeEngine()
    await expect(engine.liquid.parseAndRender(`{% paginate items by 5 %}x`))
      .rejects.toThrow(/paginate/i)
  })
})

// Keep import used so ts doesn't prune it when we only reference it in a type assertion.
void StaticLoader
