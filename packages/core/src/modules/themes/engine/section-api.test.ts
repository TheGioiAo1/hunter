/**
 * Gbox Platform — Section Rendering API tests
 *
 * Decision #1 Step 1.13. Cover:
 *
 *   1. Single-section render from a JSON template (schema defaults
 *      resolved, `section.id` from JSON key, environments visible).
 *   2. Multi-section render preserves input id order + independent
 *      child contexts.
 *   3. Same type under different ids yields distinct `section.id`
 *      drops (no cross-talk).
 *   4. `.liquid` template fallback — id is the section filename,
 *      instance data comes from `sectionInstances` option.
 *   5. JSON priority over .liquid (JSON wins when both exist).
 *   6. Missing section id in JSON template → partial-success
 *      error entry, other sections still render.
 *   7. Missing section file in .liquid mode → partial-success
 *      error entry.
 *   8. Template missing entirely → throw SectionRenderingError
 *      with code=template_not_found.
 *   9. Empty sectionIds → throw SectionRenderingError with
 *      code=empty_section_ids.
 *  10. Too many sections → throw SectionRenderingError with
 *      code=too_many_sections.
 *  11. maxSections=0 disables the cap.
 *  12. Disabled JSON section returns empty string, not error.
 *  13. Paginate option threads into sections.
 *  14. Stylesheet from a section is captured into the meta register
 *      but NOT emitted as part of the response (no content_for_header).
 *  15. No layout is ever applied (even when JSON declares one).
 *  16. Envs (shop, customer, cart, request) are visible inside sections.
 *  17. Throwing section doesn't kill the batch.
 */

import { describe, it, expect } from 'vitest'
import { createLiquidEngine } from './liquid.js'
import { MemoryI18nService } from '../../i18n/index.js'
import type { LoadResult, LogicalPath, TemplateLoader } from './loader.js'
import {
  renderSections,
  SectionRenderingError,
  DEFAULT_MAX_SECTIONS,
} from './section-api.js'

// ---------------------------------------------------------------------------
// In-memory loader
// ---------------------------------------------------------------------------

class MemoryLoader implements TemplateLoader {
  readonly name = 'memory'
  constructor(public readonly files: Record<string, string> = {}) {}
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

function makeEngine(files: Record<string, string>) {
  return createLiquidEngine({
    loader: new MemoryLoader(files),
    i18n: new MemoryI18nService(),
  })
}

// ---------------------------------------------------------------------------
// 1 — Single section from JSON template
// ---------------------------------------------------------------------------

describe('renderSections — JSON template single section', () => {
  it('resolves schema defaults + JSON settings + section.id', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: {
          hero_top: { type: 'hero', settings: { heading: 'Welcome' } },
        },
        order: ['hero_top'],
      }),
      'sections/hero.liquid':
        '<h id="{{ section.id }}">{{ section.settings.heading }}</h>' +
        '{% schema %}{"settings":[{"type":"text","id":"heading","default":"default"}]}{% endschema %}',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['hero_top'],
    })
    expect(result.errors).toBeUndefined()
    expect(result.sections.hero_top).toBe('<h id="hero_top">Welcome</h>')
    expect(result.resolved.kind).toBe('json')
    expect(result.resolved.path).toBe('templates/index.json')
    expect(result.renderMs).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// 2 — Multiple sections, independent contexts
// ---------------------------------------------------------------------------

describe('renderSections — multiple sections', () => {
  it('renders each id independently and preserves input keys', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: {
          a: { type: 'one' },
          b: { type: 'two' },
          c: { type: 'three' },
        },
        order: ['a', 'b', 'c'],
      }),
      'sections/one.liquid': '<one>',
      'sections/two.liquid': '<two>',
      'sections/three.liquid': '<three>',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['c', 'a', 'b'],
    })
    expect(result.errors).toBeUndefined()
    expect(result.sections).toEqual({
      a: '<one>',
      b: '<two>',
      c: '<three>',
    })
  })

  it('gives each id a distinct section.id drop even when type is shared', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: {
          primary: { type: 'card', settings: { title: 'Left' } },
          secondary: { type: 'card', settings: { title: 'Right' } },
        },
        order: ['primary', 'secondary'],
      }),
      'sections/card.liquid':
        '[{{ section.id }}:{{ section.settings.title }}]' +
        '{% schema %}{"settings":[{"type":"text","id":"title"}]}{% endschema %}',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['primary', 'secondary'],
    })
    expect(result.sections.primary).toBe('[primary:Left]')
    expect(result.sections.secondary).toBe('[secondary:Right]')
  })
})

// ---------------------------------------------------------------------------
// 3 — Classic .liquid fallback
// ---------------------------------------------------------------------------

describe('renderSections — .liquid template fallback', () => {
  it('treats the id as the section filename when no JSON template exists', async () => {
    const engine = makeEngine({
      'templates/page.liquid': 'UNUSED',
      'sections/header.liquid': 'HEADER-{{ section.settings.title }}' +
        '{% schema %}{"settings":[{"type":"text","id":"title","default":"def"}]}{% endschema %}',
    })
    const result = await renderSections(engine, {
      template: 'page',
      sectionIds: ['header'],
      sectionInstances: { header: { settings: { title: 'Custom' } } },
    })
    expect(result.errors).toBeUndefined()
    expect(result.resolved.kind).toBe('liquid')
    expect(result.sections.header).toBe('HEADER-Custom')
  })

  it('uses schema defaults when sectionInstances is omitted in .liquid mode', async () => {
    const engine = makeEngine({
      'templates/page.liquid': 'UNUSED',
      'sections/header.liquid': 'H-{{ section.settings.title }}' +
        '{% schema %}{"settings":[{"type":"text","id":"title","default":"default-title"}]}{% endschema %}',
    })
    const result = await renderSections(engine, {
      template: 'page',
      sectionIds: ['header'],
    })
    expect(result.sections.header).toBe('H-default-title')
  })
})

// ---------------------------------------------------------------------------
// 4 — JSON priority
// ---------------------------------------------------------------------------

describe('renderSections — JSON priority', () => {
  it('prefers templates/<name>.json over templates/<name>.liquid', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'hero' } },
        order: ['main'],
      }),
      'templates/index.liquid': 'NEVER',
      'sections/hero.liquid': '<hero>json</hero>',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['main'],
    })
    expect(result.resolved.kind).toBe('json')
    expect(result.sections.main).toBe('<hero>json</hero>')
  })
})

// ---------------------------------------------------------------------------
// 5 — Partial-success errors
// ---------------------------------------------------------------------------

describe('renderSections — partial-success errors', () => {
  it('captures an unknown JSON section id without killing the batch', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'hero' } },
        order: ['main'],
      }),
      'sections/hero.liquid': '<hero>',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['main', 'ghost'],
    })
    expect(result.sections.main).toBe('<hero>')
    expect(result.sections.ghost).toBeUndefined()
    expect(result.errors).toBeDefined()
    expect(result.errors!.ghost.code).toBe('section_not_found')
    expect(result.errors!.ghost.message).toMatch(/ghost/)
  })

  it('captures a missing section file in .liquid mode', async () => {
    const engine = makeEngine({
      'templates/page.liquid': 'UNUSED',
      'sections/header.liquid': 'HEAD',
    })
    const result = await renderSections(engine, {
      template: 'page',
      sectionIds: ['header', 'footer'],
    })
    expect(result.sections.header).toBe('HEAD')
    expect(result.errors).toBeDefined()
    expect(result.errors!.footer.code).toBe('section_not_found')
  })

  it('captures a render-time throw inside one section without killing the batch', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: {
          a: { type: 'good' },
          b: { type: 'broken' },
        },
        order: ['a', 'b'],
      }),
      'sections/good.liquid': 'OK',
      // `| noSuchFilter` throws at render time (strictFilters: true).
      'sections/broken.liquid': 'value={{ x | noSuchFilter }}',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['a', 'b'],
    })
    expect(result.sections.a).toBe('OK')
    expect(result.sections.b).toBeUndefined()
    expect(result.errors).toBeDefined()
    expect(result.errors!.b.code).toBe('section_render_failed')
  })

  it('only populates `errors` when at least one section fails', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'hero' } },
        order: ['main'],
      }),
      'sections/hero.liquid': 'HI',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['main'],
    })
    expect(result.errors).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6 — Whole-request errors (throw)
// ---------------------------------------------------------------------------

describe('renderSections — whole-request errors', () => {
  it('throws when the template is missing entirely', async () => {
    const engine = makeEngine({})
    await expect(
      renderSections(engine, { template: 'ghost', sectionIds: ['x'] }),
    ).rejects.toThrow(SectionRenderingError)
    await expect(
      renderSections(engine, { template: 'ghost', sectionIds: ['x'] }),
    ).rejects.toMatchObject({ code: 'template_not_found' })
  })

  it('throws on empty sectionIds', async () => {
    const engine = makeEngine({
      'templates/index.liquid': 'x',
    })
    await expect(
      renderSections(engine, { template: 'index', sectionIds: [] }),
    ).rejects.toMatchObject({ code: 'empty_section_ids' })
  })

  it('throws when sectionIds exceeds the default cap (5)', async () => {
    const engine = makeEngine({
      'templates/index.liquid': 'x',
    })
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    await expect(
      renderSections(engine, { template: 'index', sectionIds: ids }),
    ).rejects.toMatchObject({ code: 'too_many_sections' })
  })

  it('maxSections=0 disables the cap', async () => {
    const engine = makeEngine({
      'templates/index.liquid': 'x',
      'sections/a.liquid': 'A',
      'sections/b.liquid': 'B',
      'sections/c.liquid': 'C',
      'sections/d.liquid': 'D',
      'sections/e.liquid': 'E',
      'sections/f.liquid': 'F',
      'sections/g.liquid': 'G',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      maxSections: 0,
    })
    expect(result.errors).toBeUndefined()
    expect(Object.keys(result.sections)).toHaveLength(7)
  })

  it('exports DEFAULT_MAX_SECTIONS = 5', () => {
    expect(DEFAULT_MAX_SECTIONS).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 7 — Disabled JSON section returns empty string
// ---------------------------------------------------------------------------

describe('renderSections — disabled sections', () => {
  it('returns empty string (not error) for a disabled JSON section', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: {
          hero: { type: 'hero', disabled: true },
          footer: { type: 'footer' },
        },
        order: ['hero', 'footer'],
      }),
      'sections/hero.liquid': 'HERO',
      'sections/footer.liquid': 'FOOTER',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['hero', 'footer'],
    })
    expect(result.errors).toBeUndefined()
    expect(result.sections.hero).toBe('')
    expect(result.sections.footer).toBe('FOOTER')
  })
})

// ---------------------------------------------------------------------------
// 8 — Envs are visible inside sections
// ---------------------------------------------------------------------------

describe('renderSections — env propagation', () => {
  it('exposes shop/customer/cart/request inside the section', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'hdr' } },
        order: ['main'],
      }),
      'sections/hdr.liquid':
        'shop={{ shop.name }}|cust={{ customer.first_name }}|items={{ cart.item_count }}|path={{ request.path }}',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['main'],
      shop: { name: 'Gbox' },
      customer: { first_name: 'Thai' },
      cart: { item_count: 3 },
      request: { path: '/products/x' },
    })
    expect(result.sections.main).toBe(
      'shop=Gbox|cust=Thai|items=3|path=/products/x',
    )
  })

  it('merges top-level locale into request.locale', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'loc' } },
        order: ['main'],
      }),
      'sections/loc.liquid': 'loc={{ request.locale }}',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['main'],
      locale: 'vi',
    })
    expect(result.sections.main).toBe('loc=vi')
  })
})

// ---------------------------------------------------------------------------
// 9 — Paginate option threads through
// ---------------------------------------------------------------------------

describe('renderSections — paginate wiring', () => {
  it('passes the paginate option into a section that uses {% paginate %}', async () => {
    const engine = makeEngine({
      'templates/collection.json': JSON.stringify({
        sections: { main: { type: 'listing', settings: { per_page: 2 } } },
        order: ['main'],
      }),
      'sections/listing.liquid':
        '{% paginate collection.products by section.settings.per_page %}' +
        '{% for p in collection.products %}{{ p.id }},{% endfor %}' +
        'cp={{ paginate.current_page }}' +
        '{% endpaginate %}' +
        '{% schema %}{"settings":[{"type":"number","id":"per_page","default":2}]}{% endschema %}',
    })
    const result = await renderSections(engine, {
      template: 'collection',
      sectionIds: ['main'],
      extraGlobals: {
        collection: {
          products: [
            { id: 1 },
            { id: 2 },
            { id: 3 },
            { id: 4 },
            { id: 5 },
          ],
        },
      },
      paginate: { 'collection.products': { page: 2 } },
    })
    // Page 2, per_page 2 → ids 3, 4
    expect(result.sections.main).toContain('3,4,')
    expect(result.sections.main).toContain('cp=2')
  })
})

// ---------------------------------------------------------------------------
// 10 — No layout, no content_for_header
// ---------------------------------------------------------------------------

describe('renderSections — never applies layout or hoists meta', () => {
  it('ignores the JSON layout field and never wraps in a layout file', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'hero' } },
        order: ['main'],
        layout: 'theme',
      }),
      'layout/theme.liquid': 'THEME[{{ content_for_layout }}]',
      'sections/hero.liquid': 'HI',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['main'],
    })
    expect(result.sections.main).toBe('HI')
    // The layout wrapper must not appear anywhere.
    expect(result.sections.main).not.toContain('THEME[')
  })

  it('does not inject content_for_header even when section has a {% stylesheet %}', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'carded' } },
        order: ['main'],
      }),
      'sections/carded.liquid':
        '<div>hi</div>' +
        '{% stylesheet %}.card { color: red; }{% endstylesheet %}',
    })
    const result = await renderSections(engine, {
      template: 'index',
      sectionIds: ['main'],
    })
    // Stylesheet body must not leak into the response. Only <div>hi</div>.
    expect(result.sections.main).toBe('<div>hi</div>')
    expect(result.sections.main).not.toContain('data-gbox-section')
    expect(result.sections.main).not.toContain('<style')
  })
})
