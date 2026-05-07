/**
 * Gbox Platform — `{% schema %}` / `{% stylesheet %}` / `{% javascript %}` tests
 *
 * Decision #1 Step 1.7. Each meta-block tag:
 *   1. Captures its body as a raw string (no Liquid evaluation inside).
 *   2. Emits nothing to the rendered output.
 *   3. Stashes the body on the ctx register for the render pipeline
 *      (Step 1.10) to retrieve.
 *   4. Errors cleanly if the block is unclosed.
 */

import { describe, it, expect } from 'vitest'
import { Liquid, Context } from 'liquidjs'
import {
  registerMetaBlockTags,
  GBOX_META_REGISTER_KEY,
  type GboxMetaRegister,
} from './meta-blocks.js'

function makeLiquid(): Liquid {
  const liquid = new Liquid({
    strictFilters: true,
    strictVariables: false,
  })
  registerMetaBlockTags(liquid)
  return liquid
}

/**
 * Render a template and return both the output text and the final
 * gboxMeta register. We pass a fresh Context so we can peek at the
 * register values after the render — the stock `parseAndRender`
 * builds its own ctx and throws it away.
 */
async function renderAndPeek(
  liquid: Liquid,
  tpl: string,
): Promise<{ out: string; meta: GboxMetaRegister }> {
  const ctx = new Context({}, liquid.options)
  const templates = liquid.parse(tpl)
  const out = await liquid.render(templates, ctx)
  const meta = ctx.getRegister(GBOX_META_REGISTER_KEY) as GboxMetaRegister
  return { out, meta }
}

describe('{% schema %} tag', () => {
  it('captures a JSON body verbatim and emits nothing', async () => {
    const liquid = makeLiquid()
    const body = '{\n  "name": "Hero",\n  "settings": []\n}'
    const { out, meta } = await renderAndPeek(
      liquid,
      `before{% schema %}${body}{% endschema %}after`,
    )
    expect(out).toBe('beforeafter')
    expect(meta.schema).toBe(body)
  })

  it('does NOT evaluate Liquid expressions inside the body', async () => {
    // Inside a Shopify schema you might literally write `{{` as part
    // of a default value for a text field. The tag MUST preserve it.
    const liquid = makeLiquid()
    const body = '{ "default": "{{ product.title }}" }'
    const { out, meta } = await renderAndPeek(
      liquid,
      `{% schema %}${body}{% endschema %}`,
    )
    expect(out).toBe('')
    expect(meta.schema).toBe(body)
  })

  it('throws if the schema block is unclosed', async () => {
    const liquid = makeLiquid()
    expect(() =>
      liquid.parse('{% schema %}{ "name": "X" }'),
    ).toThrow(/not closed/)
  })
})

describe('{% stylesheet %} tag', () => {
  it('captures CSS body verbatim and emits nothing', async () => {
    const liquid = makeLiquid()
    const css = '.btn { color: red; }'
    const { out, meta } = await renderAndPeek(
      liquid,
      `{% stylesheet %}${css}{% endstylesheet %}`,
    )
    expect(out).toBe('')
    expect(meta.stylesheet).toEqual([css])
  })

  it('multiple stylesheet blocks accumulate in order', async () => {
    const liquid = makeLiquid()
    const a = '.a { }'
    const b = '.b { }'
    const { out, meta } = await renderAndPeek(
      liquid,
      `{% stylesheet %}${a}{% endstylesheet %}{% stylesheet %}${b}{% endstylesheet %}`,
    )
    expect(out).toBe('')
    expect(meta.stylesheet).toEqual([a, b])
  })

  it('unclosed stylesheet throws', async () => {
    const liquid = makeLiquid()
    expect(() => liquid.parse('{% stylesheet %}.x { }')).toThrow(/not closed/)
  })
})

describe('{% javascript %} tag', () => {
  it('captures JS body verbatim and emits nothing', async () => {
    const liquid = makeLiquid()
    const js = 'console.log("hi");'
    const { out, meta } = await renderAndPeek(
      liquid,
      `{% javascript %}${js}{% endjavascript %}`,
    )
    expect(out).toBe('')
    expect(meta.javascript).toEqual([js])
  })

  it('multiple javascript blocks accumulate in order', async () => {
    const liquid = makeLiquid()
    const a = 'window.a = 1;'
    const b = 'window.b = 2;'
    const { out, meta } = await renderAndPeek(
      liquid,
      `{% javascript %}${a}{% endjavascript %}{% javascript %}${b}{% endjavascript %}`,
    )
    expect(out).toBe('')
    expect(meta.javascript).toEqual([a, b])
  })

  it('unclosed javascript throws', async () => {
    const liquid = makeLiquid()
    expect(() => liquid.parse('{% javascript %}alert(1);')).toThrow(/not closed/)
  })
})

describe('{% schema %} — parse-time parsing (Step 1.11)', () => {
  it('invalid JSON throws at liquid.parse() time, not render time', () => {
    const liquid = makeLiquid()
    expect(() =>
      liquid.parse('{% schema %}{ not valid }{% endschema %}'),
    ).toThrow(/invalid JSON/)
  })

  it('non-object top-level JSON throws at parse time', () => {
    const liquid = makeLiquid()
    expect(() =>
      liquid.parse('{% schema %}[1,2,3]{% endschema %}'),
    ).toThrow(/must be a JSON object/)
  })

  it('duplicate setting ids throw at parse time', () => {
    const liquid = makeLiquid()
    expect(() =>
      liquid.parse(
        '{% schema %}{"settings":[{"type":"text","id":"h"},{"type":"text","id":"h"}]}{% endschema %}',
      ),
    ).toThrow(/duplicate id "h"/)
  })

  it('parsed schema populates meta.schemaParsed after render', async () => {
    const liquid = makeLiquid()
    const { meta } = await renderAndPeek(
      liquid,
      '{% schema %}{"name":"Hero","settings":[{"type":"text","id":"heading","default":"Hi"}]}{% endschema %}',
    )
    expect(meta.schemaParsed).toBeDefined()
    expect(meta.schemaParsed?.name).toBe('Hero')
    expect(meta.schemaParsed?.settings).toHaveLength(1)
    expect(meta.schemaParsed?.settings[0]).toMatchObject({
      type: 'text',
      id: 'heading',
      default: 'Hi',
    })
  })

  it('empty schema body still populates schemaParsed with an empty shape', async () => {
    const liquid = makeLiquid()
    const { meta } = await renderAndPeek(liquid, '{% schema %}{% endschema %}')
    expect(meta.schemaParsed).toBeDefined()
    expect(meta.schemaParsed?.settings).toEqual([])
    expect(meta.schemaParsed?.blocks).toEqual([])
  })
})

describe('meta blocks — interaction', () => {
  it('schema + stylesheet + javascript can coexist in one template', async () => {
    const liquid = makeLiquid()
    const tpl = [
      '<section>Hi</section>',
      '{% schema %}{ "name": "S" }{% endschema %}',
      '{% stylesheet %}.s { }{% endstylesheet %}',
      '{% javascript %}console.log(1);{% endjavascript %}',
    ].join('')
    const { out, meta } = await renderAndPeek(liquid, tpl)
    expect(out).toBe('<section>Hi</section>')
    expect(meta.schema).toBe('{ "name": "S" }')
    expect(meta.stylesheet).toEqual(['.s { }'])
    expect(meta.javascript).toEqual(['console.log(1);'])
  })

  it('fresh context starts with an empty (or auto-{}) meta register', async () => {
    // Sanity: if a template contains no meta blocks, the register is
    // either missing or auto-initialized to an empty object by
    // LiquidJS. Either way, reading it should not throw and should
    // expose no fields.
    const liquid = makeLiquid()
    const { meta } = await renderAndPeek(liquid, 'no meta blocks here')
    expect(meta.schema).toBeUndefined()
    expect(meta.stylesheet).toBeUndefined()
    expect(meta.javascript).toBeUndefined()
  })
})
