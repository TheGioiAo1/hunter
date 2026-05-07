/**
 * Gbox Platform — JSON template renderer
 *
 * Decision #1 Step 1.12 — Render a parsed `JsonTemplate` into HTML
 * by iterating `order[]` and dispatching each section through
 * `renderSectionInstance`. This is the JSON-template counterpart to
 * `liquid.parse()` + `liquid.render()` for classic Liquid templates.
 *
 * What it does, in order:
 *
 *   1. For each section id in `template.order`:
 *        a. Look up the parsed section in `template.sections[id]`.
 *        b. Skip if `disabled === true`.
 *        c. Convert the JSON shape into a schema-resolver-friendly
 *           `SectionInstance` — settings pass straight through, and
 *           `blocks[]` becomes a flat array of `SectionBlockInstance`
 *           entries (the JSON format nests blocks as an object keyed
 *           by id; the renderer already flattened to an ordered
 *           array during parse).
 *        d. Call `renderSectionInstance(liquid, loader, id, type,
 *           instance, ctx)` to emit the HTML.
 *   2. Concatenate all section outputs in order (no separator —
 *      sections control their own whitespace).
 *   3. Wrap in `<wrapper>...</wrapper>` if the template specifies one.
 *
 * Note on layout handling:
 *
 *   JSON templates can declare `layout: "alt"` or `layout: false`.
 *   This renderer does NOT apply the layout itself — that's the
 *   pipeline's job (it already handles layouts uniformly for both
 *   Liquid and JSON templates). The renderer just emits the body
 *   string; the pipeline reads `template.layout` AFTER rendering
 *   and wires it into the layout register before deciding the final
 *   layout name.
 *
 * Note on registers:
 *
 *   Each section is rendered through `renderSectionInstance`, which
 *   spawns a child context that shares the parent's `registers` map.
 *   This means `{% schema %}` / `{% stylesheet %}` / `{% javascript %}`
 *   captures from each section accumulate on the same `gboxMeta`
 *   register — the pipeline's `content_for_header` hoist works
 *   unchanged.
 */

import type { Context } from 'liquidjs'
import type { LiquidEngine } from '../liquid.js'
import { renderSectionInstance } from '../tags/section.js'
import type {
  SectionInstance,
  SectionBlockInstance,
} from '../schema/types.js'
import type { JsonBlockInstance, JsonTemplate } from './types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a parsed JSON template into an HTML string.
 *
 * @param engine   The shared LiquidEngine (loader + liquid + builders).
 * @param template The parsed JSON template from `parseJsonTemplate`.
 * @param ctx      The outer render context from `renderPage`. Its
 *                 environments/registers are shared with every section.
 */
export async function renderJsonTemplate(
  engine: LiquidEngine,
  template: JsonTemplate,
  ctx: Context,
): Promise<string> {
  const parts: string[] = []

  for (const sectionId of template.order) {
    const jsonSection = template.sections[sectionId]
    // Parser already validated order[] ids against sections, so this
    // shouldn't happen — but defensive check for forward-compat with
    // unparsed template shapes.
    if (!jsonSection) continue
    // Shopify hides disabled sections from render.
    if (jsonSection.disabled === true) continue

    const instance: SectionInstance = {
      settings: jsonSection.settings,
      blocks: jsonSection.blocks.map(jsonBlockToInstance),
    }

    const html = await renderSectionInstance(
      engine.liquid,
      engine.loader,
      sectionId,
      jsonSection.type,
      instance,
      ctx,
    )
    parts.push(html)
  }

  const body = parts.join('')

  // Wrap in the JSON-declared wrapper tag if any. Shopify escapes
  // nothing here — the wrapper is trusted theme config.
  if (template.wrapper) {
    return `<${template.wrapper}>${body}</${template.wrapper}>`
  }
  return body
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Convert a parsed JSON block into the schema-resolver's
 * `SectionBlockInstance` shape. The two shapes are almost identical,
 * but the JSON parser adds a mandatory `id` field (from the parent
 * object key) and we want it preserved on the resolver input so
 * `resolveSectionBlocks` uses it instead of generating a
 * `<type>-<index>` fallback.
 */
function jsonBlockToInstance(blk: JsonBlockInstance): SectionBlockInstance {
  return {
    ...blk,
    type: blk.type,
    settings: blk.settings,
  }
}
