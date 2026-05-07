/**
 * Gbox Platform — `{% layout 'name' %}` tag (Shopify-flavored)
 *
 * Decision #1 Step 1.7 — Shopify's `{% layout %}` is NOT the same as
 * LiquidJS's built-in `{% layout %}` (which is a Django-style template-
 * inheritance feature using `{% block %}`). Shopify's version is much
 * simpler: it's a hint to the render pipeline saying "wrap the output
 * of THIS template with layout/<name>.liquid".
 *
 * Accepted syntax:
 *
 *   {% layout 'theme' %}   — wrap with layout/theme.liquid (default)
 *   {% layout "theme" %}   — double quotes also fine
 *   {% layout none %}      — render without a layout (bare-page mode)
 *
 * Rendering semantics:
 *
 *   The tag itself emits nothing. It stores the requested layout
 *   selection on the ctx register under `GBOX_LAYOUT_REGISTER_KEY` as
 *   a small wrapper object `{ name: string | null, seen: true }`.
 *   The render pipeline (Step 1.10) reads the wrapper after
 *   `parseAndRender` returns:
 *
 *     - `seen === false` (or register missing)  → default layout
 *     - `name === null`                         → skip layout
 *     - `name === 'theme'`                      → wrap with layout/theme.liquid
 *
 * Why a wrapper object instead of raw value?
 *
 *   LiquidJS's `getRegister(key)` has a built-in auto-init quirk:
 *     `this.registers[key] = this.registers[key] || {}`
 *   That means setting the register to `null` (or any falsy) gets
 *   clobbered on the next read. The wrapper object sidesteps the
 *   auto-init — the object itself is the register value, and we
 *   assign fields ON it. Field assignments survive the auto-init
 *   because the object identity doesn't change.
 *
 * Why replace LiquidJS's built-in LayoutTag?
 *
 *   The built-in tag does template inheritance (`{% block %} ... {% endblock %}`),
 *   which Shopify Liquid doesn't support. Leaving the built-in in
 *   place would make `{% layout 'theme' %}` try to PARSE layout/theme.liquid
 *   as a parent template and treat the rest of the current file as a
 *   single anonymous block — that's NOT what Shopify does and would
 *   break any theme that uses `{{ content_for_layout }}`. Replacing
 *   the tag is cleaner than hacking around the default.
 *
 * This tag intentionally does NOT load or render the layout file.
 * That's the render pipeline's job in Step 1.10. Keeping the tag
 * metadata-only keeps the parse phase cheap and testable.
 */

import { Tag, type Liquid, type Context, type Emitter, type TagToken, type TopLevelToken } from 'liquidjs'

/** Single ctx register key for the layout wrapper object. */
export const GBOX_LAYOUT_REGISTER_KEY = 'gboxLayout' as const

/**
 * Shape of the `gboxLayout` register. `seen` distinguishes "no tag
 * encountered" (register still auto-init blank) from "explicit tag
 * set this value".
 */
export interface GboxLayoutRegister {
  /** Layout file name, or `null` for `{% layout none %}`. */
  name?: string | null
  /** True once at least one `{% layout %}` tag has fired this render. */
  seen?: boolean
}

/**
 * Sentinel value of `name` when `{% layout none %}` was declared —
 * exported so downstream code can compare against it with a shared
 * constant instead of a bare `null` literal.
 */
export const GBOX_LAYOUT_NONE: null = null

/**
 * Read (or lazily initialize) the layout register on a Context.
 * Uses the same auto-init trick as the meta-blocks register: getRegister
 * returns `{}` for unset keys, which we then populate as fields.
 */
function layoutOf(ctx: Context): GboxLayoutRegister {
  return ctx.getRegister(GBOX_LAYOUT_REGISTER_KEY) as GboxLayoutRegister
}

export function registerLayoutTag(liquid: Liquid): void {
  class LayoutTag extends Tag {
    /** `null` = explicit `{% layout none %}`; string = layout file name. */
    private readonly layoutName: string | null

    constructor(token: TagToken, remainTokens: TopLevelToken[], liquidInstance: Liquid) {
      super(token, remainTokens, liquidInstance)

      const tok = this.tokenizer
      tok.skipBlank()

      // Peek at the argument. It can be either the bare word `none`
      // or a quoted string literal. We do NOT support variable layout
      // names — Shopify doesn't, and allowing them would let a drop
      // value cause a layout lookup at render time (slow + surprising).
      const value = tok.readValue()
      if (!value) {
        throw new Error(
          `[gbox-engine] {% layout %} requires an argument (a string literal or \`none\`), got: ${token.getText()}`,
        )
      }

      const text = value.getText().trim()
      if (text === 'none') {
        this.layoutName = null
      } else if (
        (text.startsWith("'") && text.endsWith("'")) ||
        (text.startsWith('"') && text.endsWith('"'))
      ) {
        this.layoutName = text.slice(1, -1)
        if (this.layoutName.length === 0) {
          throw new Error(
            `[gbox-engine] {% layout %} name cannot be empty: ${token.getText()}`,
          )
        }
      } else {
        throw new Error(
          `[gbox-engine] {% layout %} argument must be a string literal or \`none\`, got: ${text}`,
        )
      }

      // Trailing junk? Shopify's parser rejects it.
      tok.skipBlank()
      if (!tok.end()) {
        throw new Error(
          `[gbox-engine] {% layout %} takes exactly one argument: ${token.getText()}`,
        )
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    *render(ctx: Context, _emitter: Emitter): Generator<unknown, void, any> {
      // Mutate fields on the wrapper object — the object itself stays
      // the same reference, so LiquidJS's getRegister auto-init quirk
      // doesn't clobber our null/undefined/false field values.
      const reg = layoutOf(ctx)
      reg.name = this.layoutName
      reg.seen = true
      yield undefined
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  liquid.registerTag('layout', LayoutTag as any)
}
