/**
 * Smoke test — Decision #1 Step 1.11 schema parsing + section settings
 *
 * End-to-end test for the full schema resolution pipeline:
 *
 *   {% schema %} JSON → parseSchemaBody → ParsedSchema
 *                     → resolveSectionDrop(schema, instance)
 *                     → section.settings + section.blocks drop
 *                     → Liquid render
 *
 * Asserts (12):
 *
 *   1. Parse-time JSON error throws with source path
 *   2. Section with no instance renders all schema defaults
 *   3. sectionInstances override wins over schema default
 *   4. Explicit null override is preserved (not → default)
 *   5. Explicit false override is preserved (not → default)
 *   6. section.blocks iterates with resolved block.settings
 *   7. Block id falls back to <type>-<index> when missing
 *   8. header/paragraph separators don't leak into section.settings
 *   9. Unknown block type passes settings through unchanged
 *  10. Checkbox default false renders correctly in {% if %}
 *  11. Fully realistic hero section with 5 setting types + 3 blocks
 *  12. Parse-time duplicate-id error throws at parseAndRender
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-11.ts
 */

import {
  createLiquidEngine,
  renderPage,
  type LoadResult,
  type LogicalPath,
  type TemplateLoader,
} from '../packages/core/src/modules/themes/engine/index.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/index.js'

// ---------------------------------------------------------------------------
// In-memory loader
// ---------------------------------------------------------------------------

class MemoryLoader implements TemplateLoader {
  readonly name = 'memory-theme'
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

// ---------------------------------------------------------------------------
// Mini Shopify-style theme
// ---------------------------------------------------------------------------

const files: Record<string, string> = {
  // ----- Layout -----------------------------------------------------------
  'layout/theme.liquid': '[{{ content_for_layout }}]',

  // ----- Simple templates -------------------------------------------------
  'templates/hero-page.liquid': "{% section 'hero' %}",
  'templates/carousel-page.liquid': "{% section 'carousel' %}",
  'templates/broken-page.liquid': "{% section 'broken' %}",
  'templates/dup-page.liquid': "{% section 'dup' %}",
  'templates/realistic-page.liquid': "{% section 'realistic-hero' %}",
  'templates/header-sep-page.liquid': "{% section 'has-header' %}",
  'templates/cb-page.liquid': "{% section 'cb' %}",
  'templates/unknown-block-page.liquid': "{% section 'unknown-blocks' %}",

  // ----- Sections ---------------------------------------------------------
  'sections/hero.liquid': [
    '<h1>{{ section.settings.heading }}</h1>',
    '<p style="color:{{ section.settings.color }}">{{ section.settings.body }}</p>',
    // `!= blank` is Shopify idiom for "not nil and not empty string".
    // `announcement` has no default → falls back to '' → skipped.
    '{% if section.settings.announcement != blank %}<b>ann={{ section.settings.announcement }}</b>{% endif %}',
    '{% schema %}',
    JSON.stringify({
      name: 'Hero',
      settings: [
        { type: 'text', id: 'heading', default: 'Default Heading' },
        { type: 'textarea', id: 'body', default: 'Default body' },
        { type: 'color', id: 'color', default: '#000000' },
        { type: 'text', id: 'announcement' },
      ],
    }),
    '{% endschema %}',
  ].join('\n'),

  'sections/carousel.liquid': [
    '<div class="carousel" data-count="{{ section.blocks.size }}">',
    '{% for block in section.blocks %}',
    '<figure id="{{ block.id }}" class="slide">',
    '<h3>{{ block.settings.title }}</h3>',
    '<a href="{{ block.settings.url }}">go</a>',
    '</figure>',
    '{% endfor %}',
    '</div>',
    '{% schema %}',
    JSON.stringify({
      name: 'Carousel',
      blocks: [
        {
          type: 'slide',
          settings: [
            { type: 'text', id: 'title', default: 'Untitled' },
            { type: 'url', id: 'url', default: '/' },
          ],
        },
      ],
    }),
    '{% endschema %}',
  ].join('\n'),

  'sections/broken.liquid': [
    'ok',
    '{% schema %}',
    '{ this is not valid json }',
    '{% endschema %}',
  ].join('\n'),

  'sections/dup.liquid': [
    'ok',
    '{% schema %}',
    JSON.stringify({
      settings: [
        { type: 'text', id: 'h', default: 'A' },
        { type: 'text', id: 'h', default: 'B' },
      ],
    }),
    '{% endschema %}',
  ].join('\n'),

  'sections/realistic-hero.liquid': [
    '<section class="hero" style="background:{{ section.settings.bg }}">',
    '<h1>{{ section.settings.heading }}</h1>',
    '<p>{{ section.settings.subheading }}</p>',
    '{% if section.settings.show_cta %}',
    '<a class="btn" href="{{ section.settings.cta_url }}">{{ section.settings.cta_label }}</a>',
    '{% endif %}',
    '<ul class="features">',
    '{% for block in section.blocks %}',
    '<li data-type="{{ block.type }}" id="{{ block.id }}">{{ block.settings.label }}</li>',
    '{% endfor %}',
    '</ul>',
    '<p class="meta">{{ section.blocks_count }} features</p>',
    '</section>',
    '{% schema %}',
    JSON.stringify({
      name: 'Realistic Hero',
      settings: [
        { type: 'text', id: 'heading', default: 'Default Heading' },
        { type: 'textarea', id: 'subheading', default: 'Default sub' },
        { type: 'color', id: 'bg', default: '#ffffff' },
        { type: 'checkbox', id: 'show_cta', default: true },
        { type: 'text', id: 'cta_label', default: 'Learn more' },
        { type: 'url', id: 'cta_url', default: '/about' },
      ],
      blocks: [
        {
          type: 'feature',
          name: 'Feature',
          settings: [{ type: 'text', id: 'label', default: 'Feature' }],
        },
      ],
    }),
    '{% endschema %}',
  ].join('\n'),

  'sections/has-header.liquid': [
    'keys=',
    '{% for pair in section.settings %}{{ pair[0] }},{% endfor %}',
    '{% schema %}',
    JSON.stringify({
      settings: [
        { type: 'header', content: 'General' },
        { type: 'text', id: 'one', default: 'A' },
        { type: 'paragraph', content: 'help' },
        { type: 'text', id: 'two', default: 'B' },
      ],
    }),
    '{% endschema %}',
  ].join('\n'),

  'sections/cb.liquid': [
    '{% if section.settings.enabled %}ON{% else %}OFF{% endif %}',
    '{% schema %}',
    JSON.stringify({
      settings: [{ type: 'checkbox', id: 'enabled', default: true }],
    }),
    '{% endschema %}',
  ].join('\n'),

  'sections/unknown-blocks.liquid': [
    '{% for block in section.blocks %}',
    '<i>{{ block.type }}:{{ block.settings.val }}</i>',
    '{% endfor %}',
    '{% schema %}',
    JSON.stringify({ blocks: [] }),
    '{% endschema %}',
  ].join('\n'),
}

function makeEngine() {
  return createLiquidEngine({
    loader: new MemoryLoader(files),
    i18n: new MemoryI18nService(),
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const engine = makeEngine()

  // ----- (1) Parse-time JSON error throws with source path ---------------
  {
    let threw = false
    try {
      await renderPage(engine, { template: 'broken-page' })
    } catch (err) {
      threw = true
      const msg = (err as Error).message
      if (!msg.includes('invalid JSON')) throw new Error(`(1) wrong msg: ${msg}`)
      if (!msg.includes('sections/broken.liquid'))
        throw new Error(`(1) no source path: ${msg}`)
    }
    if (!threw) throw new Error('(1) broken schema should throw')
    console.log('PASS (1) invalid schema JSON throws with source path')
  }

  // ----- (2) Pure defaults (no sectionInstances) --------------------------
  {
    const { html } = await renderPage(engine, { template: 'hero-page' })
    if (!html.includes('<h1>Default Heading</h1>'))
      throw new Error(`(2) heading default missing: ${html}`)
    if (!html.includes('Default body'))
      throw new Error(`(2) body default missing: ${html}`)
    if (!html.includes('color:#000000'))
      throw new Error(`(2) color default missing: ${html}`)
    // announcement has no default → null → the {% if != null %} guard
    // means no <b> tag.
    if (html.includes('<b>ann=')) throw new Error(`(2) announcement leaked`)
    console.log('PASS (2) section uses schema defaults when no instance given')
  }

  // ----- (3) Instance overrides win ---------------------------------------
  {
    const { html } = await renderPage(engine, {
      template: 'hero-page',
      sectionInstances: {
        hero: {
          settings: {
            heading: 'Big Sale',
            body: 'Everything 50% off',
            color: '#ff0000',
          },
        },
      },
    })
    if (!html.includes('<h1>Big Sale</h1>'))
      throw new Error(`(3) heading override missing`)
    if (!html.includes('Everything 50% off'))
      throw new Error(`(3) body override missing`)
    if (!html.includes('color:#ff0000'))
      throw new Error(`(3) color override missing`)
    console.log('PASS (3) sectionInstances overrides schema defaults')
  }

  // ----- (4) Explicit null is preserved -----------------------------------
  {
    // Instance sets heading → null explicitly. Expect heading to
    // render as empty (not as the schema default).
    const { html } = await renderPage(engine, {
      template: 'hero-page',
      sectionInstances: {
        hero: { settings: { heading: null } },
      },
    })
    if (!html.includes('<h1></h1>'))
      throw new Error(`(4) null override not preserved: ${html}`)
    console.log('PASS (4) explicit null override preserved')
  }

  // ----- (5) Explicit false is preserved ----------------------------------
  {
    const { html } = await renderPage(engine, {
      template: 'cb-page',
      sectionInstances: {
        cb: { settings: { enabled: false } },
      },
    })
    if (!html.includes('OFF'))
      throw new Error(`(5) false override not preserved: ${html}`)
    console.log('PASS (5) explicit false override preserved')
  }

  // ----- (6) section.blocks iteration + resolved block.settings -----------
  {
    const { html } = await renderPage(engine, {
      template: 'carousel-page',
      sectionInstances: {
        carousel: {
          blocks: [
            {
              type: 'slide',
              id: 'alpha',
              settings: { title: 'Alpha', url: '/alpha' },
            },
            {
              type: 'slide',
              id: 'beta',
              settings: { title: 'Beta' }, // url defaults
            },
          ],
        },
      },
    })
    if (!html.includes('data-count="2"'))
      throw new Error(`(6) block count wrong: ${html}`)
    if (!html.includes('<figure id="alpha" class="slide">'))
      throw new Error(`(6) alpha id missing`)
    if (!html.includes('<h3>Alpha</h3>'))
      throw new Error(`(6) alpha title missing`)
    if (!html.includes('href="/alpha"'))
      throw new Error(`(6) alpha url missing`)
    if (!html.includes('<h3>Beta</h3>'))
      throw new Error(`(6) beta title missing`)
    if (!html.includes('href="/"')) throw new Error(`(6) beta url default missing`)
    console.log('PASS (6) section.blocks iterates + block.settings resolved')
  }

  // ----- (7) Block id fallback <type>-<index> -----------------------------
  {
    const { html } = await renderPage(engine, {
      template: 'carousel-page',
      sectionInstances: {
        carousel: {
          blocks: [
            { type: 'slide', settings: { title: 'One' } },
            { type: 'slide', settings: { title: 'Two' } },
          ],
        },
      },
    })
    if (!html.includes('id="slide-0"'))
      throw new Error(`(7) block id fallback missing for index 0`)
    if (!html.includes('id="slide-1"'))
      throw new Error(`(7) block id fallback missing for index 1`)
    console.log('PASS (7) block id falls back to <type>-<index>')
  }

  // ----- (8) header/paragraph separators don't leak ----------------------
  {
    const { html } = await renderPage(engine, { template: 'header-sep-page' })
    // Expect only `one,two,` — not `header,...,paragraph,...`.
    // Section file has newlines so we just check for the substring.
    if (!html.includes('one,two,'))
      throw new Error(`(8) expected one,two, missing: ${html}`)
    if (html.includes('General') || html.includes('help'))
      throw new Error(`(8) separator content leaked: ${html}`)
    console.log('PASS (8) header/paragraph separators filtered from drop')
  }

  // ----- (9) Unknown block type passes settings unchanged ----------------
  {
    const { html } = await renderPage(engine, {
      template: 'unknown-block-page',
      sectionInstances: {
        'unknown-blocks': {
          blocks: [{ type: 'mystery', id: 'm1', settings: { val: 'X' } }],
        },
      },
    })
    if (!html.includes('<i>mystery:X</i>'))
      throw new Error(`(9) unknown block pass-through broken: ${html}`)
    console.log('PASS (9) unknown block type passes settings through')
  }

  // ----- (10) Checkbox default true renders {% if %} ON ------------------
  {
    const { html } = await renderPage(engine, { template: 'cb-page' })
    if (!html.includes('ON'))
      throw new Error(`(10) checkbox default true not honored: ${html}`)
    console.log('PASS (10) checkbox default true honored in {% if %}')
  }

  // ----- (11) Fully realistic hero with mixed overrides ------------------
  {
    const { html, renderMs } = await renderPage(engine, {
      template: 'realistic-page',
      sectionInstances: {
        'realistic-hero': {
          settings: {
            heading: 'Launch Week',
            subheading: 'Five days, five drops.',
            show_cta: true,
            cta_label: 'Shop now',
            cta_url: '/collections/launch-week',
            // bg intentionally omitted → default #ffffff
          },
          blocks: [
            { type: 'feature', id: 'f1', settings: { label: 'Free shipping' } },
            { type: 'feature', id: 'f2', settings: { label: '30-day returns' } },
            { type: 'feature', id: 'f3', settings: { label: '24/7 support' } },
          ],
        },
      },
    })
    if (!html.includes('<h1>Launch Week</h1>'))
      throw new Error(`(11) heading wrong`)
    if (!html.includes('<p>Five days, five drops.</p>'))
      throw new Error(`(11) subheading wrong`)
    if (!html.includes('background:#ffffff'))
      throw new Error(`(11) bg default missing`)
    if (!html.includes('<a class="btn" href="/collections/launch-week">Shop now</a>'))
      throw new Error(`(11) CTA anchor wrong`)
    if (!html.includes('<li data-type="feature" id="f1">Free shipping</li>'))
      throw new Error(`(11) feature 1 wrong`)
    if (!html.includes('<li data-type="feature" id="f2">30-day returns</li>'))
      throw new Error(`(11) feature 2 wrong`)
    if (!html.includes('<li data-type="feature" id="f3">24/7 support</li>'))
      throw new Error(`(11) feature 3 wrong`)
    if (!html.includes('<p class="meta">3 features</p>'))
      throw new Error(`(11) blocks_count wrong`)
    if (renderMs < 0 || renderMs > 5000)
      throw new Error(`(11) renderMs suspect: ${renderMs}`)
    console.log(
      `PASS (11) realistic hero full render (${renderMs}ms, ${html.length} bytes)`,
    )
  }

  // ----- (12) Parse-time duplicate-id error ------------------------------
  {
    let threw = false
    try {
      await renderPage(engine, { template: 'dup-page' })
    } catch (err) {
      threw = true
      const msg = (err as Error).message
      if (!msg.includes('duplicate id "h"'))
        throw new Error(`(12) wrong msg: ${msg}`)
    }
    if (!threw) throw new Error('(12) duplicate ids should throw')
    console.log('PASS (12) duplicate setting id throws at parse time')
  }

  console.log('\nALL PASSED — Step 1.11 schema + section settings is the real deal')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
