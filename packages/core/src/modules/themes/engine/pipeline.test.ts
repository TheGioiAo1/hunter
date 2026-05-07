/**
 * Gbox Platform — Render Pipeline tests
 *
 * Decision #1 Step 1.10. Covers:
 *
 *   1. normalizeTemplatePath — 4 input forms all land on the same
 *      logical path.
 *   2. resolveLayoutName — precedence: skipLayout > register.seen >
 *      defaultLayout fallback.
 *   3. buildContentForHeader — stylesheet + javascript wrapping +
 *      ordering + empty-case.
 *   4. renderPage:
 *        - Default layout ('theme') when template doesn't declare one
 *        - `{% layout 'alt' %}` overrides default
 *        - `{% layout none %}` skips layout
 *        - `skipLayout: true` overrides everything
 *        - Missing template → throws
 *        - Missing layout → throws
 *        - Environments (shop/customer/cart/request) visible in both
 *          page and layout
 *        - Page-level `{% assign %}` leaks into layout scope
 *        - Page with `{% section %}` that emits `{% stylesheet %}`
 *          → content_for_header contains hoisted CSS
 *        - Multiple sections accumulate into content_for_header
 *        - Form tag inside page sees csrfToken + formState
 *        - i18n t filter reads shop + locale from env in layout
 */

import { describe, it, expect } from 'vitest'
import { createLiquidEngine } from './liquid.js'
import {
  renderPage,
  normalizeTemplatePath,
  buildContentForHeader,
  resolveLayoutName,
} from './pipeline.js'
import type { LoadResult, LogicalPath, TemplateLoader } from './loader.js'
import { MemoryI18nService } from '../../i18n/index.js'

// ---------------------------------------------------------------------------
// In-memory loader (copy of pattern used in tag tests)
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
    i18n: new MemoryI18nService({
      shop_1: {
        en: { 'greeting.hello': 'Hello {{ name }}' },
        vi: { 'greeting.hello': 'Xin chào {{ name }}' },
      },
    }),
  })
}

// ---------------------------------------------------------------------------
// Unit helpers — normalizeTemplatePath, resolveLayoutName, buildContentForHeader
// ---------------------------------------------------------------------------

describe('normalizeTemplatePath', () => {
  it('accepts bare name → templates/<name>.liquid', () => {
    expect(normalizeTemplatePath('product')).toBe('templates/product.liquid')
  })
  it('accepts templates/<name>', () => {
    expect(normalizeTemplatePath('templates/product')).toBe(
      'templates/product.liquid',
    )
  })
  it('accepts templates/<name>.liquid as-is', () => {
    expect(normalizeTemplatePath('templates/product.liquid')).toBe(
      'templates/product.liquid',
    )
  })
  it('accepts nested paths', () => {
    expect(normalizeTemplatePath('customers/login')).toBe(
      'templates/customers/login.liquid',
    )
  })
  it('strips a leading slash', () => {
    expect(normalizeTemplatePath('/product')).toBe('templates/product.liquid')
  })
  it('throws on empty input', () => {
    expect(() => normalizeTemplatePath('')).toThrow(/template is required/)
  })
})

describe('resolveLayoutName', () => {
  it('defaults to theme when no register + no options', () => {
    expect(resolveLayoutName({}, {})).toBe('theme')
  })
  it('honors explicit defaultLayout', () => {
    expect(resolveLayoutName({}, { defaultLayout: 'custom' })).toBe('custom')
  })
  it('skipLayout overrides everything', () => {
    expect(
      resolveLayoutName(
        { seen: true, name: 'alt' },
        { skipLayout: true },
      ),
    ).toBeNull()
  })
  it('register.seen with name → use that name', () => {
    expect(resolveLayoutName({ seen: true, name: 'alt' }, {})).toBe('alt')
  })
  it('register.seen with name=null → no layout ({% layout none %})', () => {
    expect(resolveLayoutName({ seen: true, name: null }, {})).toBeNull()
  })
  it('register without seen → fallback to default', () => {
    expect(
      resolveLayoutName({ name: 'ghost' }, { defaultLayout: 'alt' }),
    ).toBe('alt')
  })
})

describe('buildContentForHeader', () => {
  it('returns empty string when no meta captured', () => {
    expect(buildContentForHeader({})).toBe('')
  })
  it('wraps stylesheet blocks in <style data-gbox-section>', () => {
    expect(buildContentForHeader({ stylesheet: ['.a{}'] })).toBe(
      '<style data-gbox-section>.a{}</style>',
    )
  })
  it('wraps javascript blocks in <script data-gbox-section>', () => {
    expect(buildContentForHeader({ javascript: ['alert(1)'] })).toBe(
      '<script data-gbox-section>alert(1)</script>',
    )
  })
  it('stylesheet comes before javascript', () => {
    const out = buildContentForHeader({
      stylesheet: ['.x{}'],
      javascript: ['y()'],
    })
    expect(out.indexOf('<style')).toBeLessThan(out.indexOf('<script'))
  })
  it('concatenates multiple blocks joined by newline', () => {
    const out = buildContentForHeader({
      stylesheet: ['.a{}', '.b{}'],
    })
    expect(out).toBe(
      '<style data-gbox-section>.a{}</style>\n<style data-gbox-section>.b{}</style>',
    )
  })
})

// ---------------------------------------------------------------------------
// End-to-end renderPage
// ---------------------------------------------------------------------------

describe('renderPage — basic layout chain', () => {
  const files = {
    'templates/product.liquid': '<h1>{{ product.title }}</h1>',
    'layout/theme.liquid':
      '<!DOCTYPE html><html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>',
  }

  it('wraps page in default theme layout', async () => {
    const engine = makeEngine(files)
    const { html, layoutUsed } = await renderPage(engine, {
      template: 'product',
      pageDrop: { product: { title: 'Widget' } },
    })
    expect(layoutUsed).toBe('theme')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<h1>Widget</h1>')
    expect(html).toContain('<head></head>')
  })

  it('exposes shop drop inside both page and layout', async () => {
    const engine = makeEngine({
      'templates/index.liquid': '[page shop={{ shop.name }}]',
      'layout/theme.liquid':
        '[layout shop={{ shop.name }}]{{ content_for_layout }}',
    })
    const { html } = await renderPage(engine, {
      template: 'index',
      shop: { name: 'Gbox' },
    })
    expect(html).toContain('[layout shop=Gbox]')
    expect(html).toContain('[page shop=Gbox]')
  })

  it('top-level assigns in page leak into layout scope', async () => {
    const engine = makeEngine({
      'templates/product.liquid':
        "{% assign page_title = 'Super Widget' %}body",
      'layout/theme.liquid': '<title>{{ page_title }}</title>',
    })
    const { html } = await renderPage(engine, { template: 'product' })
    expect(html).toContain('<title>Super Widget</title>')
  })
})

describe('renderPage — layout selection', () => {
  const files = {
    'templates/page.liquid': 'content',
    'templates/page-alt.liquid': "{% layout 'alt' %}content",
    'templates/page-none.liquid': '{% layout none %}content',
    'layout/theme.liquid': 'THEME[{{ content_for_layout }}]',
    'layout/alt.liquid': 'ALT[{{ content_for_layout }}]',
  }

  it('uses defaultLayout when no tag', async () => {
    const engine = makeEngine(files)
    const { html, layoutUsed } = await renderPage(engine, {
      template: 'page',
    })
    expect(layoutUsed).toBe('theme')
    expect(html).toBe('THEME[content]')
  })

  it("{% layout 'alt' %} selects alt.liquid", async () => {
    const engine = makeEngine(files)
    const { html, layoutUsed } = await renderPage(engine, {
      template: 'page-alt',
    })
    expect(layoutUsed).toBe('alt')
    expect(html).toBe('ALT[content]')
  })

  it('{% layout none %} skips layout', async () => {
    const engine = makeEngine(files)
    const { html, layoutUsed } = await renderPage(engine, {
      template: 'page-none',
    })
    expect(layoutUsed).toBeNull()
    expect(html).toBe('content')
  })

  it('skipLayout option overrides {% layout %} tag', async () => {
    const engine = makeEngine(files)
    const { html, layoutUsed } = await renderPage(engine, {
      template: 'page-alt',
      skipLayout: true,
    })
    expect(layoutUsed).toBeNull()
    expect(html).toBe('content')
  })

  it('defaultLayout option replaces the "theme" fallback', async () => {
    const engine = makeEngine(files)
    const { html, layoutUsed } = await renderPage(engine, {
      template: 'page',
      defaultLayout: 'alt',
    })
    expect(layoutUsed).toBe('alt')
    expect(html).toBe('ALT[content]')
  })
})

describe('renderPage — error surfaces', () => {
  it('throws when template is missing', async () => {
    const engine = makeEngine({
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    await expect(
      renderPage(engine, { template: 'ghost' }),
    ).rejects.toThrow(/template not found: templates\/ghost\.\(json\|liquid\)/)
  })

  it('throws when the selected layout is missing', async () => {
    const engine = makeEngine({
      'templates/index.liquid': 'hi',
    })
    await expect(
      renderPage(engine, { template: 'index' }),
    ).rejects.toThrow(/layout not found: layout\/theme\.liquid/)
  })

  it('throws on missing custom layout declared in template', async () => {
    const engine = makeEngine({
      'templates/index.liquid': "{% layout 'ghost' %}hi",
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    await expect(
      renderPage(engine, { template: 'index' }),
    ).rejects.toThrow(/layout not found: layout\/ghost\.liquid/)
  })
})

describe('renderPage — content_for_header hoisting', () => {
  it('hoists section {% stylesheet %} + {% javascript %} into header', async () => {
    const engine = makeEngine({
      'templates/index.liquid': "{% section 'product' %}",
      'sections/product.liquid': [
        '<div class="product">p</div>',
        '{% stylesheet %}.product{color:red}{% endstylesheet %}',
        '{% javascript %}console.log("p");{% endjavascript %}',
      ].join('\n'),
      'layout/theme.liquid': '<head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body>',
    })
    const { html, meta } = await renderPage(engine, { template: 'index' })
    expect(html).toContain(
      '<style data-gbox-section>.product{color:red}</style>',
    )
    expect(html).toContain(
      '<script data-gbox-section>console.log("p");</script>',
    )
    expect(html).toContain('<div class="product">p</div>')
    expect(meta.stylesheet).toHaveLength(1)
    expect(meta.javascript).toHaveLength(1)
  })

  it('multiple sections accumulate in content_for_header', async () => {
    const engine = makeEngine({
      'templates/index.liquid': "{% section 'a' %}{% section 'b' %}",
      'sections/a.liquid':
        '<a>a</a>{% stylesheet %}.a{}{% endstylesheet %}',
      'sections/b.liquid':
        '<b>b</b>{% stylesheet %}.b{}{% endstylesheet %}',
      'layout/theme.liquid': '{{ content_for_header }}<main>{{ content_for_layout }}</main>',
    })
    const { html, meta } = await renderPage(engine, { template: 'index' })
    expect(meta.stylesheet).toEqual(['.a{}', '.b{}'])
    expect(html).toMatch(/\.a\{\}.*\.b\{\}/s)
    expect(html).toContain('<main><a>a</a><b>b</b></main>')
  })

  it('page with no section → content_for_header is empty', async () => {
    const engine = makeEngine({
      'templates/index.liquid': 'bare',
      'layout/theme.liquid': '[head:{{ content_for_header }}]{{ content_for_layout }}',
    })
    const { html } = await renderPage(engine, { template: 'index' })
    expect(html).toBe('[head:]bare')
  })
})

describe('renderPage — env propagation into form tag', () => {
  it('form inside page sees csrfToken from options', async () => {
    const engine = makeEngine({
      'templates/index.liquid':
        "{% form 'contact' %}{% endform %}",
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const { html } = await renderPage(engine, {
      template: 'index',
      csrfToken: 'abc123',
    })
    expect(html).toContain(
      '<input type="hidden" name="authenticity_token" value="abc123" />',
    )
  })

  it('form inside page sees formState errors', async () => {
    const engine = makeEngine({
      'templates/index.liquid': [
        "{% form 'contact' %}",
        '{% for e in form.errors %}[{{ e }}]{% endfor %}',
        '{% endform %}',
      ].join(''),
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const { html } = await renderPage(engine, {
      template: 'index',
      formState: { contact: { errors: ['email', 'body'] } },
    })
    expect(html).toContain('[email][body]')
  })
})

describe('renderPage — i18n via env', () => {
  it('t filter reads shop + locale from the pipeline', async () => {
    const engine = makeEngine({
      'templates/index.liquid':
        "{{ 'greeting.hello' | t: name: 'Thai' }}",
      'layout/theme.liquid': '[{{ content_for_layout }}]',
    })
    const en = await renderPage(engine, {
      template: 'index',
      shop: { id: 'shop_1', default_locale: 'en' },
      locale: 'en',
    })
    expect(en.html).toBe('[Hello Thai]')

    const vi = await renderPage(engine, {
      template: 'index',
      shop: { id: 'shop_1', default_locale: 'en' },
      locale: 'vi',
    })
    expect(vi.html).toBe('[Xin chào Thai]')
  })
})

describe('renderPage — result bundle', () => {
  it('returns meta, layoutUsed, and renderMs', async () => {
    const engine = makeEngine({
      'templates/index.liquid': 'hi',
      'layout/theme.liquid': '[{{ content_for_layout }}]',
    })
    const result = await renderPage(engine, { template: 'index' })
    expect(result.html).toBe('[hi]')
    expect(result.layoutUsed).toBe('theme')
    expect(result.meta).toEqual({})
    expect(typeof result.renderMs).toBe('number')
    expect(result.renderMs).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// Step 1.11 — sectionInstances option
// ---------------------------------------------------------------------------

describe('renderPage — sectionInstances option (Step 1.11)', () => {
  it('threads overrides into section.settings via the section tag', async () => {
    const engine = makeEngine({
      'templates/index.liquid': "{% section 'hero' %}",
      'layout/theme.liquid': '[{{ content_for_layout }}]',
      'sections/hero.liquid':
        '<h1>{{ section.settings.heading }}</h1>' +
        '{% schema %}{"settings":[{"type":"text","id":"heading","default":"Default"}]}{% endschema %}',
    })
    const result = await renderPage(engine, {
      template: 'index',
      sectionInstances: {
        hero: { settings: { heading: 'From pipeline' } },
      },
    })
    expect(result.html).toBe('[<h1>From pipeline</h1>]')
  })

  it('threads block data into section.blocks', async () => {
    const engine = makeEngine({
      'templates/index.liquid': "{% section 'carousel' %}",
      'layout/theme.liquid': '[{{ content_for_layout }}]',
      'sections/carousel.liquid':
        '{% for block in section.blocks %}<s id="{{ block.id }}">{{ block.settings.title }}</s>{% endfor %}' +
        '{% schema %}{"blocks":[{"type":"slide","settings":[' +
        '{"type":"text","id":"title","default":"T"}]}]}{% endschema %}',
    })
    const result = await renderPage(engine, {
      template: 'index',
      sectionInstances: {
        carousel: {
          blocks: [
            { type: 'slide', id: 's1', settings: { title: 'Alpha' } },
            { type: 'slide', id: 's2', settings: { title: 'Beta' } },
          ],
        },
      },
    })
    expect(result.html).toBe(
      '[<s id="s1">Alpha</s><s id="s2">Beta</s>]',
    )
  })

  it('omitted sectionInstances → sections use pure schema defaults', async () => {
    const engine = makeEngine({
      'templates/index.liquid': "{% section 'hero' %}",
      'layout/theme.liquid': '[{{ content_for_layout }}]',
      'sections/hero.liquid':
        '<h1>{{ section.settings.heading }}</h1>' +
        '{% schema %}{"settings":[{"type":"text","id":"heading","default":"Default"}]}{% endschema %}',
    })
    const result = await renderPage(engine, { template: 'index' })
    expect(result.html).toBe('[<h1>Default</h1>]')
  })

  it('section without a matching instance uses defaults', async () => {
    const engine = makeEngine({
      'templates/index.liquid': "{% section 'hero' %}",
      'layout/theme.liquid': '[{{ content_for_layout }}]',
      'sections/hero.liquid':
        '<h1>{{ section.settings.heading }}</h1>' +
        '{% schema %}{"settings":[{"type":"text","id":"heading","default":"Default"}]}{% endschema %}',
    })
    // Pass instances for a DIFFERENT section — hero should still default.
    const result = await renderPage(engine, {
      template: 'index',
      sectionInstances: { unrelated: { settings: { x: 'y' } } },
    })
    expect(result.html).toBe('[<h1>Default</h1>]')
  })

  it('instance data does not leak between different section names', async () => {
    const engine = makeEngine({
      'templates/index.liquid':
        "{% section 'a' %}|{% section 'b' %}",
      'layout/theme.liquid': '{{ content_for_layout }}',
      'sections/a.liquid':
        'a={{ section.settings.value }}' +
        '{% schema %}{"settings":[{"type":"text","id":"value","default":"default-a"}]}{% endschema %}',
      'sections/b.liquid':
        'b={{ section.settings.value }}' +
        '{% schema %}{"settings":[{"type":"text","id":"value","default":"default-b"}]}{% endschema %}',
    })
    const result = await renderPage(engine, {
      template: 'index',
      sectionInstances: {
        a: { settings: { value: 'only-a' } },
      },
    })
    // a uses override, b uses default
    expect(result.html).toBe('a=only-a|b=default-b')
  })
})

// ---------------------------------------------------------------------------
// Step 1.12 — JSON templates
// ---------------------------------------------------------------------------

describe('renderPage — JSON template resolution (Step 1.12)', () => {
  it('prefers templates/<name>.json over templates/<name>.liquid', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'hero' } },
        order: ['main'],
      }),
      'templates/index.liquid': 'SHOULD-NOT-RUN',
      'sections/hero.liquid': '<hero>JSON</hero>',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const result = await renderPage(engine, { template: 'index' })
    expect(result.html).toBe('<hero>JSON</hero>')
  })

  it('falls back to .liquid when .json is absent', async () => {
    const engine = makeEngine({
      'templates/page.liquid': 'classic-page',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const result = await renderPage(engine, { template: 'page' })
    expect(result.html).toBe('classic-page')
  })

  it('honors order[] and renders sections through the schema resolver', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: {
          h: {
            type: 'header',
            settings: { title: 'Welcome' },
          },
          b: { type: 'body' },
        },
        order: ['h', 'b'],
      }),
      'sections/header.liquid':
        '<h>{{ section.settings.title }}</h>' +
        '{% schema %}{"settings":[{"type":"text","id":"title","default":"default-h"}]}{% endschema %}',
      'sections/body.liquid': '<body>x</body>',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const result = await renderPage(engine, { template: 'index' })
    expect(result.html).toBe('<h>Welcome</h><body>x</body>')
  })

  it('applies the JSON-declared wrapper', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'x' } },
        order: ['main'],
        wrapper: 'main',
      }),
      'sections/x.liquid': 'hi',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const result = await renderPage(engine, { template: 'index' })
    expect(result.html).toBe('<main>hi</main>')
  })

  it('applies a JSON-declared layout override (string)', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'x' } },
        order: ['main'],
        layout: 'alt',
      }),
      'sections/x.liquid': 'body',
      'layout/theme.liquid': 'THEME[{{ content_for_layout }}]',
      'layout/alt.liquid': 'ALT[{{ content_for_layout }}]',
    })
    const result = await renderPage(engine, { template: 'index' })
    expect(result.layoutUsed).toBe('alt')
    expect(result.html).toBe('ALT[body]')
  })

  it('applies `layout: false` from the JSON to skip the layout', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'x' } },
        order: ['main'],
        layout: false,
      }),
      'sections/x.liquid': 'raw',
      'layout/theme.liquid': 'THEME[{{ content_for_layout }}]',
    })
    const result = await renderPage(engine, { template: 'index' })
    expect(result.layoutUsed).toBeNull()
    expect(result.html).toBe('raw')
  })

  it('caller skipLayout overrides the JSON layout field', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'x' } },
        order: ['main'],
        layout: 'alt',
      }),
      'sections/x.liquid': 'raw',
      'layout/alt.liquid': 'ALT[{{ content_for_layout }}]',
    })
    const result = await renderPage(engine, {
      template: 'index',
      skipLayout: true,
    })
    expect(result.layoutUsed).toBeNull()
    expect(result.html).toBe('raw')
  })

  it('captures section stylesheet from JSON template into content_for_header', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'carded' } },
        order: ['main'],
      }),
      'sections/carded.liquid':
        '<div class="card">hi</div>' +
        '{% stylesheet %}.card { color: red; }{% endstylesheet %}',
      'layout/theme.liquid':
        '<head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body>',
    })
    const result = await renderPage(engine, { template: 'index' })
    expect(result.html).toContain('<style data-gbox-section>.card { color: red; }</style>')
    expect(result.html).toContain('<body><div class="card">hi</div></body>')
  })
})

// ---------------------------------------------------------------------------
// Step 1.12 — paginate option wiring
// ---------------------------------------------------------------------------

describe('renderPage — paginate option (Step 1.12)', () => {
  it('threads paginate input from the option into the {% paginate %} tag', async () => {
    const engine = makeEngine({
      'templates/list.liquid':
        '{% paginate items by 2 %}' +
        '{% for i in items %}{{ i.id }},{% endfor %}' +
        'cp={{ paginate.current_page }}' +
        '{% endpaginate %}',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const result = await renderPage(engine, {
      template: 'list',
      extraGlobals: {
        items: [
          { id: 1 },
          { id: 2 },
          { id: 3 },
          { id: 4 },
          { id: 5 },
        ],
      },
      paginate: { items: { page: 2 } },
    })
    // page 2 size 2 → items 3, 4
    expect(result.html).toContain('3,4,')
    expect(result.html).toContain('cp=2')
  })

  it('uses defaults (page=1, total=array.length) when paginate option is absent', async () => {
    const engine = makeEngine({
      'templates/list.liquid':
        '{% paginate items by 2 %}' +
        '{% for i in items %}{{ i.id }},{% endfor %}' +
        'pages={{ paginate.pages }}' +
        '{% endpaginate %}',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const result = await renderPage(engine, {
      template: 'list',
      extraGlobals: { items: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    })
    // Defaults: page 1 → items 1, 2; pages=ceil(3/2)=2
    expect(result.html).toContain('1,2,')
    expect(result.html).toContain('pages=2')
  })

  it('exposes the paginate drop to the body inside a JSON template section', async () => {
    const engine = makeEngine({
      'templates/collection.json': JSON.stringify({
        sections: { main: { type: 'listing' } },
        order: ['main'],
      }),
      'sections/listing.liquid':
        '{% paginate items by 3 %}' +
        '{% for i in items %}{{ i }}|{% endfor %}' +
        'cp={{ paginate.current_page }}' +
        '{% endpaginate %}',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const result = await renderPage(engine, {
      template: 'collection',
      extraGlobals: { items: [1, 2, 3, 4, 5, 6, 7] },
      paginate: { items: { page: 2 } },
    })
    // page 2 size 3 → 4|5|6|
    expect(result.html).toContain('4|5|6|')
    expect(result.html).toContain('cp=2')
  })
})

// ---------------------------------------------------------------------------
// Step 1.15 — themeSettings + schemaLocaleDict
// ---------------------------------------------------------------------------

describe('renderPage — themeSettings + schemaLocaleDict (Step 1.15)', () => {
  it('exposes themeSettings as the {{ settings.* }} drop', async () => {
    const engine = makeEngine({
      'templates/index.liquid':
        'primary={{ settings.primary }} tagline={{ settings.tagline }}',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const result = await renderPage(engine, {
      template: 'index',
      themeSettings: { primary: '#abc', tagline: 'Welcome' },
    })
    expect(result.html).toContain('primary=#abc')
    expect(result.html).toContain('tagline=Welcome')
  })

  it('settings drop is visible inside sections', async () => {
    const engine = makeEngine({
      'templates/index.liquid': "{% section 'banner' %}",
      'sections/banner.liquid': 'banner-color={{ settings.primary }}',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const result = await renderPage(engine, {
      template: 'index',
      themeSettings: { primary: '#zzz' },
    })
    expect(result.html).toContain('banner-color=#zzz')
  })

  it('extraGlobals.settings wins over themeSettings (caller override)', async () => {
    const engine = makeEngine({
      'templates/index.liquid': '{{ settings.value }}',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const result = await renderPage(engine, {
      template: 'index',
      themeSettings: { value: 'from-theme' },
      extraGlobals: { settings: { value: 'from-extra' } },
    })
    expect(result.html).toContain('from-extra')
    expect(result.html).not.toContain('from-theme')
  })

  it('resolves t: refs inside section schema labels via the section drop', async () => {
    // The section drop only exposes `id`, `settings`, `blocks`, and
    // `blocks_count` — the resolved labels live in `settings_schema`
    // metadata that templates rarely render directly. We assert the
    // resolution happened by reading section.settings.text, which
    // takes its DEFAULT value from the schema's `default` field.
    // The schema below uses a static default; the t: pass walks the
    // schema and rewrites any t: strings (here, `label`) but leaves
    // the actual value path untouched. So we instead use the
    // section.settings.label_proxy field which IS rewritten.
    //
    // Easier path: assert directly via a helper test that calls
    // `resolveSchemaTranslations` on a parsed schema and rebuilds
    // the drop. We do that in resolveSchemaTranslations tests
    // already; here we verify the env-key plumbing actually fires
    // by snooping on a schema field that templates can read via
    // the `inspect` filter? — none such exists.
    //
    // Pragmatic approach: drop a t: ref into the `default` value
    // for a setting. The walker rewrites any `t:` string regardless
    // of the field name, including default values. So
    // `default: 't:my.label'` becomes `default: 'My Label'` after
    // resolution, and `section.settings.foo` then exposes the
    // resolved string.
    const engine = makeEngine({
      'templates/index.liquid': "{% section 'hero' %}",
      'sections/hero.liquid':
        '{% schema %}{"name":"Hero","settings":[' +
        '{"type":"text","id":"heading","default":"t:hero.heading"}' +
        ']}{% endschema %}' +
        'heading={{ section.settings.heading }}',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const result = await renderPage(engine, {
      template: 'index',
      schemaLocaleDict: { 'hero.heading': 'Welcome aboard' },
    })
    expect(result.html).toContain('heading=Welcome aboard')
  })

  it('renders raw t: keys when no schemaLocaleDict is supplied', async () => {
    const engine = makeEngine({
      'templates/index.liquid': "{% section 'hero' %}",
      'sections/hero.liquid':
        '{% schema %}{"name":"Hero","settings":[' +
        '{"type":"text","id":"heading","default":"t:hero.heading"}' +
        ']}{% endschema %}' +
        'heading={{ section.settings.heading }}',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    // No dict at all → raw t: prefix passes straight through (because
    // applySchemaTranslations is a no-op when the env key is absent).
    const result = await renderPage(engine, {
      template: 'index',
    })
    expect(result.html).toContain('heading=t:hero.heading')
  })

  it('schemaLocaleDict also flows into JSON template sections', async () => {
    const engine = makeEngine({
      'templates/index.json': JSON.stringify({
        sections: { main: { type: 'hero', settings: {} } },
        order: ['main'],
      }),
      'sections/hero.liquid':
        '{% schema %}{"name":"Hero","settings":[' +
        '{"type":"text","id":"heading","default":"t:hero.heading"}' +
        ']}{% endschema %}' +
        'heading={{ section.settings.heading }}',
      'layout/theme.liquid': '{{ content_for_layout }}',
    })
    const result = await renderPage(engine, {
      template: 'index',
      schemaLocaleDict: { 'hero.heading': 'Localized!' },
    })
    expect(result.html).toContain('heading=Localized!')
  })
})
