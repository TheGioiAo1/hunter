/**
 * Gbox Platform — `{% layout %}` tag tests
 *
 * Decision #1 Step 1.7. Covers:
 *   1. `{% layout 'theme' %}` sets name='theme', seen=true.
 *   2. `{% layout "theme" %}` double quotes work.
 *   3. `{% layout none %}` sets name=null, seen=true.
 *   4. No tag → register has no `seen` field (pipeline defaults to 'theme').
 *   5. Duplicate tags → last one wins.
 *   6. The tag emits no output.
 *   7. Parse errors: missing arg, empty string, variable name, extra junk.
 *   8. LiquidJS built-in LayoutTag is replaced (no `{% block %}` inheritance).
 */

import { describe, it, expect } from 'vitest'
import { Liquid, Context } from 'liquidjs'
import {
  registerLayoutTag,
  GBOX_LAYOUT_REGISTER_KEY,
  GBOX_LAYOUT_NONE,
  type GboxLayoutRegister,
} from './layout.js'

function makeLiquid(): Liquid {
  const liquid = new Liquid({
    strictFilters: true,
    strictVariables: false,
  })
  registerLayoutTag(liquid)
  return liquid
}

async function renderAndPeek(
  liquid: Liquid,
  tpl: string,
): Promise<{ out: string; reg: GboxLayoutRegister }> {
  const ctx = new Context({}, liquid.options)
  const templates = liquid.parse(tpl)
  const out = await liquid.render(templates, ctx)
  const reg = ctx.getRegister(GBOX_LAYOUT_REGISTER_KEY) as GboxLayoutRegister
  return { out, reg }
}

describe('{% layout %} tag', () => {
  it("sets name='theme' and seen=true for {% layout 'theme' %}", async () => {
    const liquid = makeLiquid()
    const { out, reg } = await renderAndPeek(liquid, "{% layout 'theme' %}body")
    expect(out).toBe('body')
    expect(reg.name).toBe('theme')
    expect(reg.seen).toBe(true)
  })

  it('accepts double-quoted names', async () => {
    const liquid = makeLiquid()
    const { reg } = await renderAndPeek(liquid, '{% layout "checkout" %}')
    expect(reg.name).toBe('checkout')
    expect(reg.seen).toBe(true)
  })

  it('sets name=null (GBOX_LAYOUT_NONE) for {% layout none %}', async () => {
    const liquid = makeLiquid()
    const { out, reg } = await renderAndPeek(liquid, '{% layout none %}hello')
    expect(out).toBe('hello')
    expect(reg.name).toBe(GBOX_LAYOUT_NONE)
    expect(reg.seen).toBe(true)
  })

  it('no tag → register has no seen flag (pipeline defaults to "theme")', async () => {
    const liquid = makeLiquid()
    const { reg } = await renderAndPeek(liquid, 'bare body')
    expect(reg.seen).toBeUndefined()
    expect(reg.name).toBeUndefined()
  })

  it('last layout wins when declared twice', async () => {
    const liquid = makeLiquid()
    const { reg } = await renderAndPeek(
      liquid,
      "{% layout 'theme' %}{% layout 'checkout' %}",
    )
    expect(reg.name).toBe('checkout')
    expect(reg.seen).toBe(true)
  })

  it('last layout wins: theme then none → none', async () => {
    const liquid = makeLiquid()
    const { reg } = await renderAndPeek(
      liquid,
      "{% layout 'theme' %}{% layout none %}",
    )
    expect(reg.name).toBeNull()
    expect(reg.seen).toBe(true)
  })

  it('emits no output at render time', async () => {
    const liquid = makeLiquid()
    const { out } = await renderAndPeek(
      liquid,
      "before{% layout 'theme' %}after",
    )
    expect(out).toBe('beforeafter')
  })

  it('throws if argument is missing', async () => {
    const liquid = makeLiquid()
    expect(() => liquid.parse('{% layout %}')).toThrow(/requires an argument/)
  })

  it('throws on empty string name', async () => {
    const liquid = makeLiquid()
    expect(() => liquid.parse("{% layout '' %}")).toThrow(/cannot be empty/)
  })

  it('throws on variable-style name (Shopify forbids dynamic layouts)', async () => {
    const liquid = makeLiquid()
    expect(() => liquid.parse('{% layout foo %}')).toThrow(
      /string literal or `none`/,
    )
  })

  it('throws on extra args after the name', async () => {
    const liquid = makeLiquid()
    expect(() => liquid.parse("{% layout 'theme' extra %}")).toThrow(
      /exactly one argument/,
    )
  })

  it('replaces the stock LiquidJS LayoutTag (no template inheritance)', async () => {
    // LiquidJS's default LayoutTag treats content after the tag as an
    // implicit `{% block %}` and tries to load the layout file from
    // the FS. Our override stores metadata only. If the stock tag were
    // still active, this would throw (no FS configured, file not
    // found). With our tag, it succeeds and emits the body unchanged.
    const liquid = makeLiquid()
    const out = await liquid.parseAndRender(
      "{% layout 'missing-on-purpose' %}<p>raw body</p>",
    )
    expect(out).toBe('<p>raw body</p>')
  })
})
