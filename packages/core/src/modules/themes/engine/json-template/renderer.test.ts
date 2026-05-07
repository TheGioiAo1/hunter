/**
 * Gbox Platform — JSON template renderer tests
 *
 * Decision #1 Step 1.12. Cover:
 *
 *   1. Order is honored — sections render in the `order[]` sequence.
 *   2. Disabled sections are skipped.
 *   3. A section can reference a type that appears twice under
 *      different ids — section.id comes from the JSON key, not the
 *      filename.
 *   4. settings / blocks from the JSON flow into section.settings /
 *      section.blocks exactly like the `{% section %}` tag path.
 *   5. Missing section files render the Shopify placeholder comment.
 *   6. The `wrapper` tag wraps the concatenated body.
 *   7. Empty `order[]` yields an empty body (no wrapper when there's
 *      nothing to wrap — TODO spot check).
 */

import { describe, it, expect } from 'vitest'
import { Context } from 'liquidjs'
import { createLiquidEngine } from '../liquid.js'
import { MemoryI18nService } from '../../../i18n/index.js'
import type { TemplateLoader, LoadResult, LogicalPath } from '../loader.js'
import { parseJsonTemplate } from './parser.js'
import { renderJsonTemplate } from './renderer.js'

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

function makeCtx(engine: ReturnType<typeof makeEngine>, top: Record<string, unknown> = {}) {
  return new Context(top, engine.liquid.options)
}

describe('renderJsonTemplate', () => {
  it('renders sections in the order[] sequence', async () => {
    const engine = makeEngine({
      'sections/a.liquid': '<a>',
      'sections/b.liquid': '<b>',
      'sections/c.liquid': '<c>',
    })
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: {
          first: { type: 'a' },
          second: { type: 'b' },
          third: { type: 'c' },
        },
        // Scramble the order to prove it's authoritative.
        order: ['third', 'first', 'second'],
      }),
    )
    const html = await renderJsonTemplate(engine, tpl, makeCtx(engine))
    expect(html).toBe('<c><a><b>')
  })

  it('skips sections marked disabled', async () => {
    const engine = makeEngine({
      'sections/a.liquid': '<a>',
      'sections/b.liquid': '<b>',
    })
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: {
          first: { type: 'a', disabled: true },
          second: { type: 'b' },
        },
        order: ['first', 'second'],
      }),
    )
    const html = await renderJsonTemplate(engine, tpl, makeCtx(engine))
    expect(html).toBe('<b>')
  })

  it('renders two sections of the same type under different ids', async () => {
    const engine = makeEngine({
      'sections/image-text.liquid': '[{{ section.id }}]',
    })
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: {
          main_hero: { type: 'image-text' },
          secondary: { type: 'image-text' },
        },
        order: ['main_hero', 'secondary'],
      }),
    )
    const html = await renderJsonTemplate(engine, tpl, makeCtx(engine))
    // section.id for each invocation should match the JSON key.
    expect(html).toBe('[main_hero][secondary]')
  })

  it('threads JSON settings into section.settings via the schema resolver', async () => {
    const engine = makeEngine({
      'sections/hero.liquid':
        `{% schema %}{"name":"Hero","settings":[{"id":"heading","type":"text","default":"default-h"}]}{% endschema %}<h>{{ section.settings.heading }}</h>`,
    })
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: {
          main: { type: 'hero', settings: { heading: 'override-h' } },
        },
        order: ['main'],
      }),
    )
    const html = await renderJsonTemplate(engine, tpl, makeCtx(engine))
    expect(html).toContain('<h>override-h</h>')
  })

  it('threads JSON blocks into section.blocks in block_order', async () => {
    const engine = makeEngine({
      'sections/carousel.liquid':
        `{% schema %}{"name":"C","blocks":[{"type":"slide","settings":[{"id":"title","type":"text"}]}]}{% endschema %}{% for b in section.blocks %}[{{ b.settings.title }}]{% endfor %}`,
    })
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: {
          main: {
            type: 'carousel',
            blocks: {
              a: { type: 'slide', settings: { title: 'Alpha' } },
              b: { type: 'slide', settings: { title: 'Beta' } },
            },
            block_order: ['b', 'a'],
          },
        },
        order: ['main'],
      }),
    )
    const html = await renderJsonTemplate(engine, tpl, makeCtx(engine))
    expect(html).toContain('[Beta][Alpha]')
  })

  it('falls back to a Shopify placeholder comment on missing section files', async () => {
    const engine = makeEngine({})
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: { main: { type: 'not-there' } },
        order: ['main'],
      }),
    )
    const html = await renderJsonTemplate(engine, tpl, makeCtx(engine))
    expect(html).toBe("<!-- Liquid error: section 'not-there' not found -->")
  })

  it('wraps the concatenated body in the declared wrapper tag', async () => {
    const engine = makeEngine({
      'sections/a.liquid': 'A',
      'sections/b.liquid': 'B',
    })
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: {
          one: { type: 'a' },
          two: { type: 'b' },
        },
        order: ['one', 'two'],
        wrapper: 'main',
      }),
    )
    const html = await renderJsonTemplate(engine, tpl, makeCtx(engine))
    expect(html).toBe('<main>AB</main>')
  })

  it('sees parent environments (shop, customer, etc.) inside sections', async () => {
    const engine = makeEngine({
      'sections/a.liquid': 'name={{ shop.name }}',
    })
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: { main: { type: 'a' } },
        order: ['main'],
      }),
    )
    const ctx = makeCtx(engine)
    // `environments` is typed as a generic Drop bag — cast to a record
    // for the test setter so we can drop a fake `shop` global into scope.
    ;(ctx.environments as unknown as Record<string, unknown>).shop = {
      name: 'Gbox',
    }
    const html = await renderJsonTemplate(engine, tpl, ctx)
    expect(html).toContain('name=Gbox')
  })

  it('silently skips order[] ids that point at absent section entries', async () => {
    // Parser would normally throw on this, but we construct the
    // template object by hand to exercise the renderer's defensive
    // check (future-proof for templates mutated by the editor).
    const engine = makeEngine({ 'sections/a.liquid': 'A' })
    const tpl = {
      sections: { main: { sectionId: 'main', type: 'a', blocks: [] } },
      order: ['main', 'ghost'],
    } as ReturnType<typeof parseJsonTemplate>
    const html = await renderJsonTemplate(engine, tpl, makeCtx(engine))
    expect(html).toBe('A')
  })
})
