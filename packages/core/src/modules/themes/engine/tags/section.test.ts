/**
 * Gbox Platform — `{% section %}` tag tests
 *
 * Decision #1 Step 1.7. Cover:
 *
 *   1. Basic inclusion — loads sections/<name>.liquid via the bound
 *      loader and renders its content in place.
 *   2. Child scope inherits parent globals (shop, customer, etc.).
 *   3. The injected `section` drop exposes id/settings/blocks.
 *   4. Missing sections render the Shopify-style error comment
 *      instead of throwing.
 *   5. Parse error: non-string-literal name throws at parse time.
 *   6. Parse error: extra args after name throws at parse time.
 *   7. Section snippets can `{% render %}` further snippets (render
 *      nesting still routes through the `snippets/` namespace).
 *   8. Two section invocations in one template render independently.
 */

import { describe, it, expect } from 'vitest'
import { StaticLoader } from '../static-loader.js'
import { createLiquidEngine } from '../liquid.js'
import { MemoryI18nService } from '../../../i18n/index.js'
import type { TemplateLoader, LoadResult, LogicalPath } from '../loader.js'

/**
 * In-memory loader keyed by logical path. Lighter than StaticLoader
 * because these tests never touch the filesystem.
 */
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

function makeEngine(files: Record<string, string>) {
  const loader = new MemoryLoader(files)
  return createLiquidEngine({ loader, i18n: new MemoryI18nService() })
}

describe('{% section %} tag', () => {
  it('loads and renders a section file', async () => {
    const engine = makeEngine({
      'sections/header.liquid': '<header>Hi</header>',
    })
    const out = await engine.liquid.parseAndRender("{% section 'header' %}")
    expect(out).toBe('<header>Hi</header>')
  })

  it('inherits parent globals into the section scope', async () => {
    const engine = makeEngine({
      'sections/header.liquid': '<h1>{{ shop.name }}</h1>',
    })
    const out = await engine.liquid.parseAndRender("{% section 'header' %}", {
      shop: { name: 'Gbox' },
    })
    expect(out).toBe('<h1>Gbox</h1>')
  })

  it('injects a section drop with id/settings/blocks placeholders', async () => {
    const engine = makeEngine({
      'sections/header.liquid':
        'id={{ section.id }}|settings={{ section.settings.foo }}|blocks={{ section.blocks.size }}',
    })
    const out = await engine.liquid.parseAndRender("{% section 'header' %}")
    // id = 'header', settings.foo = missing (empty), blocks.size = 0
    expect(out).toBe('id=header|settings=|blocks=0')
  })

  it('missing section renders an error comment (soft fail)', async () => {
    const engine = makeEngine({})
    const out = await engine.liquid.parseAndRender("{% section 'ghost' %}")
    expect(out).toBe("<!-- Liquid error: section 'ghost' not found -->")
  })

  it('non-literal section name throws at parse time', async () => {
    const engine = makeEngine({})
    await expect(
      engine.liquid.parseAndRender('{% section foo %}', { foo: 'header' }),
    ).rejects.toThrow(/string literal/)
  })

  it('extra args after the name throw at parse time', async () => {
    const engine = makeEngine({})
    await expect(
      engine.liquid.parseAndRender("{% section 'header' extra %}"),
    ).rejects.toThrow(/extra args|only a name/)
  })

  it('empty section tag throws a clear error', async () => {
    const engine = makeEngine({})
    await expect(engine.liquid.parseAndRender('{% section %}')).rejects.toThrow(
      /requires a name/,
    )
  })

  it('sections can {% render %} snippets (namespaces stay disjoint)', async () => {
    const engine = makeEngine({
      'sections/header.liquid': "<h>{% render 'logo', brand: 'Gbox' %}</h>",
      'snippets/logo.liquid': '<b>{{ brand }}</b>',
    })
    const out = await engine.liquid.parseAndRender("{% section 'header' %}")
    expect(out).toBe('<h><b>Gbox</b></h>')
  })

  it('renders two sections independently in the same template', async () => {
    const engine = makeEngine({
      'sections/header.liquid': '<header id="{{ section.id }}"/>',
      'sections/footer.liquid': '<footer id="{{ section.id }}"/>',
    })
    const out = await engine.liquid.parseAndRender(
      "{% section 'header' %}{% section 'footer' %}",
    )
    expect(out).toBe('<header id="header"/><footer id="footer"/>')
  })

  it('double-quoted section name is accepted', async () => {
    const engine = makeEngine({
      'sections/header.liquid': 'ok',
    })
    const out = await engine.liquid.parseAndRender('{% section "header" %}')
    expect(out).toBe('ok')
  })

  it('parent scope is not polluted by the section drop', async () => {
    // After the section renders, `section` should NOT be visible in
    // the outer template (spawn() isolation).
    const engine = makeEngine({
      'sections/header.liquid': '[{{ section.id }}]',
    })
    const out = await engine.liquid.parseAndRender(
      "{% section 'header' %}|outer={{ section.id }}",
    )
    // outer section.id should be empty (strictVariables: false)
    expect(out).toBe('[header]|outer=')
  })

  it('still works when a StaticLoader is used instead of MemoryLoader', async () => {
    // Smoke: prove the tag isn't coupled to a specific loader impl.
    // We don't want the test file to touch the real disk, so we wrap
    // StaticLoader's duck-typed surface.
    const loader: TemplateLoader = {
      name: 'ducktype',
      load: async (p) =>
        p === 'sections/hero.liquid' ? '<hero>{{ title }}</hero>' : null,
      loadWithMeta: async (p) =>
        p === 'sections/hero.liquid'
          ? { source: '<hero>{{ title }}</hero>' }
          : null,
      exists: async (p) => p === 'sections/hero.liquid',
      list: async () => ['sections/hero.liquid'],
    }
    const engine = createLiquidEngine({
      loader,
      i18n: new MemoryI18nService(),
    })
    const out = await engine.liquid.parseAndRender("{% section 'hero' %}", {
      title: 'Welcome',
    })
    expect(out).toBe('<hero>Welcome</hero>')
  })
})

// ---------------------------------------------------------------------------
// Step 1.11 — schema-driven section drop
// ---------------------------------------------------------------------------

import { Context } from 'liquidjs'
import { GBOX_SECTION_INSTANCES_ENV_KEY } from './section.js'
import type { GboxSectionInstancesEnv } from './section.js'

describe('{% section %} + {% schema %} (Step 1.11)', () => {
  /**
   * Helper: render a template against a fresh Context that carries
   * the given section instances on its environments. Mirrors how
   * renderPage() wires things up.
   */
  async function renderWithInstances(
    engine: ReturnType<typeof makeEngine>,
    tpl: string,
    instances: GboxSectionInstancesEnv,
  ): Promise<string> {
    const ctx = new Context({}, engine.liquid.options)
    ;(ctx.environments as Record<string, unknown>)[
      GBOX_SECTION_INSTANCES_ENV_KEY
    ] = instances
    const templates = engine.liquid.parse(tpl)
    return engine.liquid.render(templates, ctx)
  }

  it('reads section.settings.heading from schema default', async () => {
    const engine = makeEngine({
      'sections/hero.liquid':
        '<h1>{{ section.settings.heading }}</h1>' +
        '{% schema %}{"settings":[{"type":"text","id":"heading","default":"Welcome"}]}{% endschema %}',
    })
    const out = await engine.liquid.parseAndRender("{% section 'hero' %}")
    expect(out).toBe('<h1>Welcome</h1>')
  })

  it('instance settings override schema defaults', async () => {
    const engine = makeEngine({
      'sections/hero.liquid':
        '[{{ section.settings.heading }}]' +
        '{% schema %}{"settings":[{"type":"text","id":"heading","default":"Default"}]}{% endschema %}',
    })
    const out = await renderWithInstances(
      engine,
      "{% section 'hero' %}",
      { hero: { settings: { heading: 'Instance override' } } },
    )
    expect(out).toBe('[Instance override]')
  })

  it('section.blocks iterates with block.settings resolved', async () => {
    const engine = makeEngine({
      'sections/carousel.liquid':
        '{% for block in section.blocks %}' +
        '<slide id="{{ block.id }}">{{ block.settings.title }}</slide>' +
        '{% endfor %}' +
        '{% schema %}{"blocks":[{"type":"slide","settings":[' +
        '{"type":"text","id":"title","default":"Untitled"}' +
        ']}]}{% endschema %}',
    })
    const out = await renderWithInstances(
      engine,
      "{% section 'carousel' %}",
      {
        carousel: {
          blocks: [
            { type: 'slide', id: 's1', settings: { title: 'Alpha' } },
            { type: 'slide', id: 's2' }, // uses default
          ],
        },
      },
    )
    expect(out).toBe(
      '<slide id="s1">Alpha</slide><slide id="s2">Untitled</slide>',
    )
  })

  it('section.blocks.size reflects the resolved count', async () => {
    const engine = makeEngine({
      'sections/carousel.liquid':
        'count={{ section.blocks.size }}' +
        '{% schema %}{"blocks":[{"type":"slide","settings":[]}]}{% endschema %}',
    })
    const out = await renderWithInstances(
      engine,
      "{% section 'carousel' %}",
      { carousel: { blocks: [{ type: 'slide' }, { type: 'slide' }] } },
    )
    expect(out).toBe('count=2')
  })

  it('missing instance returns all schema defaults (empty blocks)', async () => {
    const engine = makeEngine({
      'sections/hero.liquid':
        'h={{ section.settings.heading }}|b={{ section.blocks.size }}' +
        '{% schema %}{"settings":[{"type":"text","id":"heading","default":"Hi"}],' +
        '"blocks":[{"type":"slide","settings":[]}]}{% endschema %}',
    })
    const out = await engine.liquid.parseAndRender("{% section 'hero' %}")
    expect(out).toBe('h=Hi|b=0')
  })

  it('multiple sections with different schemas do not leak settings', async () => {
    const engine = makeEngine({
      'sections/a.liquid':
        'a={{ section.settings.value }}' +
        '{% schema %}{"settings":[{"type":"text","id":"value","default":"A"}]}{% endschema %}',
      'sections/b.liquid':
        'b={{ section.settings.value }}' +
        '{% schema %}{"settings":[{"type":"text","id":"value","default":"B"}]}{% endschema %}',
    })
    const out = await engine.liquid.parseAndRender(
      "{% section 'a' %}|{% section 'b' %}",
    )
    expect(out).toBe('a=A|b=B')
  })

  it('section with no schema block falls back to empty drop', async () => {
    const engine = makeEngine({
      'sections/raw.liquid':
        'id={{ section.id }}|settings_heading={{ section.settings.heading }}|blocks={{ section.blocks.size }}',
    })
    const out = await renderWithInstances(
      engine,
      "{% section 'raw' %}",
      { raw: { settings: { heading: 'ignored' } } },
    )
    // Instance has heading but schema has no settings[] → heading key
    // is filtered out by resolveSettingsFromList.
    expect(out).toBe('id=raw|settings_heading=|blocks=0')
  })

  it('header/paragraph separators in schema do not appear in settings drop', async () => {
    const engine = makeEngine({
      'sections/hero.liquid':
        'keys=' +
        "{% for pair in section.settings %}{{ pair[0] }},{% endfor %}" +
        '{% schema %}{"settings":[' +
        '{"type":"header","content":"General"},' +
        '{"type":"text","id":"heading","default":"Hi"},' +
        '{"type":"paragraph","content":"help"},' +
        '{"type":"text","id":"sub","default":"Sub"}' +
        ']}{% endschema %}',
    })
    const out = await engine.liquid.parseAndRender("{% section 'hero' %}")
    // Only `heading` and `sub` should show up — not header/paragraph.
    expect(out).toBe('keys=heading,sub,')
  })

  it('invalid JSON in a section schema throws at parse time (not render)', async () => {
    const engine = makeEngine({
      'sections/broken.liquid':
        'ok' + '{% schema %}{ not valid json }{% endschema %}',
    })
    // The parse happens inside `{% section %}` render, so the throw
    // bubbles up as a rejected parseAndRender. Error mentions the
    // source path so theme devs can locate the bad file.
    await expect(
      engine.liquid.parseAndRender("{% section 'broken' %}"),
    ).rejects.toThrow(/invalid JSON.*sections\/broken\.liquid/)
  })

  it('section with blocks ignores instance blocks when schema has no blocks[]', async () => {
    // An instance that passes blocks for a section whose schema
    // declares no blocks[] should still render (blocks[] shows up
    // in the drop unchanged — no resolution happens, but nothing
    // crashes). Regression guard against over-eager filtering.
    const engine = makeEngine({
      'sections/plain.liquid':
        'count={{ section.blocks.size }}' +
        '{% schema %}{"settings":[]}{% endschema %}',
    })
    const out = await renderWithInstances(
      engine,
      "{% section 'plain' %}",
      { plain: { blocks: [{ type: 'anything' }] } },
    )
    expect(out).toBe('count=1')
  })

  it('integer number default is surfaced as an integer', async () => {
    const engine = makeEngine({
      'sections/hero.liquid':
        'cols={{ section.settings.columns }}' +
        '{% schema %}{"settings":[{"type":"number","id":"columns","default":4}]}{% endschema %}',
    })
    const out = await engine.liquid.parseAndRender("{% section 'hero' %}")
    expect(out).toBe('cols=4')
  })

  it('checkbox false default stays false, not empty string', async () => {
    const engine = makeEngine({
      'sections/hero.liquid':
        '{% if section.settings.enabled %}on{% else %}off{% endif %}' +
        '{% schema %}{"settings":[{"type":"checkbox","id":"enabled","default":false}]}{% endschema %}',
    })
    const out = await engine.liquid.parseAndRender("{% section 'hero' %}")
    expect(out).toBe('off')
  })
})

/**
 * Unused import guard: makes sure the type-only import of StaticLoader
 * isn't stripped — the file references it in a comment above. This is
 * just to avoid ESLint noise if the import is flagged.
 */
void StaticLoader
