/**
 * Gbox Platform — `{% schema %}`, `{% stylesheet %}`, `{% javascript %}`
 *
 * Decision #1 Step 1.7 — Shopify meta-block tags. Each of these is a
 * block tag whose body is NOT rendered as Liquid and NOT emitted to
 * the page output. Instead the raw body is captured as a literal
 * string and attached to the current render's metadata so the
 * render pipeline can extract it later (schema JSON, <style> injection,
 * <script> injection).
 *
 * Shopify reference:
 *
 *   - `{% schema %}` body is strict JSON. Used by the theme editor
 *     to generate section-settings UI and to validate. The section
 *     tag reads it at render time to populate `section.settings`.
 *     Only ONE schema block allowed per section file.
 *
 *   - `{% stylesheet %}` body is raw CSS. Shopify hoists it into a
 *     section-scoped <style> tag at the bottom of the <head>. For
 *     Step 1.7 we capture the content but don't emit it anywhere yet
 *     — Step 1.10 wires the asset pipeline into `{{ content_for_header }}`.
 *
 *   - `{% javascript %}` body is raw JS. Shopify wraps it in a
 *     section-scoped <script> tag loaded at the end of <body>. Same
 *     story: we capture, Step 1.10 wires.
 *
 * Implementation pattern (mirrored from LiquidJS's `RawTag`):
 *
 *   The tag constructor shifts tokens off `remainTokens` until it
 *   finds its matching end tag (`endschema`/`endstylesheet`/`endjavascript`).
 *   Each shifted token's original source text is concatenated to
 *   reconstruct the exact raw body.
 *
 *   This gives us raw-source capture WITHOUT a custom tokenizer mode
 *   — LiquidJS's tokenizer will tokenize the inner content as if it
 *   were Liquid (so `{{` and `{%` inside are parsed into tokens), but
 *   because we concatenate the raw `getText()` of each token, the
 *   output is byte-identical to the source.
 *
 *   GOTCHA: If a theme author writes `{% endschema %}` inside a
 *   JavaScript string literal inside `{% javascript %}`, the tokenizer
 *   will see it as a tag token and our shift loop will stop there.
 *   This is the same limitation stock LiquidJS `{% raw %}` has — the
 *   workaround is "don't write `{% endX %}` as a substring inside
 *   the body of X", which is a non-issue in practice.
 *
 * Metadata storage:
 *
 *   We stash the captured bodies on the ctx register under a single
 *   namespaced key (`gboxMeta`) with sub-fields for each block type.
 *   The single-key design sidesteps LiquidJS's `getRegister` auto-init
 *   behaviour (it returns `{}` for unset keys), which interacts
 *   awkwardly with per-key array state.
 *
 *   The render pipeline (Step 1.10) reads this register after render
 *   completes. We use ctx.setRegister/getRegister rather than template-
 *   level metadata because LiquidJS reuses parse trees across renders
 *   — the capture must be per-render, not per-parse.
 */

import {
  Tag,
  TypeGuards,
  type Liquid,
  type Context,
  type Emitter,
  type TagToken,
  type TopLevelToken,
} from 'liquidjs'
import { parseSchemaBody } from '../schema/parser.js'
import type { ParsedSchema } from '../schema/types.js'

/**
 * Single register key for all meta-block capture state. The render
 * pipeline reads `ctx.getRegister(GBOX_META_REGISTER_KEY)` and walks
 * the fields to extract schema JSON, CSS blocks, and JS blocks.
 */
export const GBOX_META_REGISTER_KEY = 'gboxMeta' as const

/**
 * Shape of the `gboxMeta` ctx register. All fields are optional; they
 * are populated lazily as the corresponding tags fire during render.
 */
export interface GboxMetaRegister {
  /** Latest `{% schema %}` body seen in this render (raw JSON string). */
  schema?: string
  /**
   * Parsed form of the latest `{% schema %}` body. Populated in tandem
   * with `schema` by the SchemaTag's render method so downstream code
   * can read a typed schema instead of re-parsing the JSON.
   */
  schemaParsed?: ParsedSchema
  /** All `{% stylesheet %}` bodies, in render order. */
  stylesheet?: string[]
  /** All `{% javascript %}` bodies, in render order. */
  javascript?: string[]
}

/**
 * Read (or lazily initialize) the meta-block register on a Context.
 * LiquidJS's `getRegister(key)` returns an auto-created `{}` when the
 * key is missing, which happens to be the correct empty shape for
 * `GboxMetaRegister` — every field is optional.
 */
function metaOf(ctx: Context): GboxMetaRegister {
  return ctx.getRegister(GBOX_META_REGISTER_KEY) as GboxMetaRegister
}

/**
 * Shared helper: consume tokens off `remainTokens` until we find the
 * matching end tag, then return the concatenated raw source.
 *
 * Mirrors LiquidJS's `RawTag` constructor.
 */
function captureRawUntil(
  tagToken: TagToken,
  remainTokens: TopLevelToken[],
  endTagName: string,
): string {
  const captured: TopLevelToken[] = []
  while (remainTokens.length > 0) {
    const tok = remainTokens.shift() as TopLevelToken
    if (TypeGuards.isTagToken(tok) && tok.name === endTagName) {
      return captured.map((t) => t.getText()).join('')
    }
    captured.push(tok)
  }
  throw new Error(
    `[gbox-engine] tag ${tagToken.getText()} not closed (expected {% ${endTagName} %})`,
  )
}

/**
 * Register `{% schema %}...{% endschema %}`, `{% stylesheet %}...{% endstylesheet %}`,
 * and `{% javascript %}...{% endjavascript %}` on the Liquid instance.
 */
export function registerMetaBlockTags(liquid: Liquid): void {
  class SchemaTag extends Tag {
    private readonly body: string
    /**
     * Parsed form of the schema body. Populated at parse time (in the
     * constructor) so that:
     *
     *   1. JSON errors throw during `liquid.parse(...)` instead of
     *      during render — a bad schema is a deploy-time bug, and
     *      failing fast is easier to debug than a half-rendered page.
     *   2. The section tag can read the parsed schema WITHOUT running
     *      the render pass first. Step 1.11's section tag walks the
     *      parse tree looking for a SchemaTag instance and reads
     *      this field directly to build `section.settings` before
     *      rendering the section body.
     *   3. No per-render JSON re-parse cost. LiquidJS reuses the
     *      parse tree across renders, so this field is effectively
     *      parsed-once-cached-forever per template file.
     *
     * Exposed as `public readonly` (not private) because the section
     * tag needs to read it from a different module. It's NOT on the
     * meta register because the register is per-context and we want
     * the parsed result to travel WITH the parse tree.
     */
    public readonly parsedSchema: ParsedSchema

    constructor(token: TagToken, remainTokens: TopLevelToken[], liquidInstance: Liquid) {
      super(token, remainTokens, liquidInstance)
      this.body = captureRawUntil(token, remainTokens, 'endschema')
      // Parse at construction time. If the JSON is invalid, this
      // throws SchemaParseError — the caller sees it as a failed
      // `liquid.parse()` and knows exactly which file has the bad
      // schema. We pass the template file path (if any) so the error
      // message is actionable.
      this.parsedSchema = parseSchemaBody(this.body, token.file)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    *render(ctx: Context, _emitter: Emitter): Generator<unknown, void, any> {
      // Only one schema per section is allowed by Shopify. If a second
      // one fires we keep the latest — Step 1.11's section tag walks
      // the parse tree and only honours the first schema, so this
      // render-time overwrite is only visible to meta consumers.
      const meta = metaOf(ctx)
      meta.schema = this.body
      meta.schemaParsed = this.parsedSchema
      yield undefined
    }
  }

  class StylesheetTag extends Tag {
    private readonly body: string

    constructor(token: TagToken, remainTokens: TopLevelToken[], liquidInstance: Liquid) {
      super(token, remainTokens, liquidInstance)
      this.body = captureRawUntil(token, remainTokens, 'endstylesheet')
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    *render(ctx: Context, _emitter: Emitter): Generator<unknown, void, any> {
      const meta = metaOf(ctx)
      ;(meta.stylesheet ??= []).push(this.body)
      yield undefined
    }
  }

  class JavascriptTag extends Tag {
    private readonly body: string

    constructor(token: TagToken, remainTokens: TopLevelToken[], liquidInstance: Liquid) {
      super(token, remainTokens, liquidInstance)
      this.body = captureRawUntil(token, remainTokens, 'endjavascript')
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    *render(ctx: Context, _emitter: Emitter): Generator<unknown, void, any> {
      const meta = metaOf(ctx)
      ;(meta.javascript ??= []).push(this.body)
      yield undefined
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  liquid.registerTag('schema', SchemaTag as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  liquid.registerTag('stylesheet', StylesheetTag as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  liquid.registerTag('javascript', JavascriptTag as any)
}

// ---------------------------------------------------------------------------
// Helpers for the section tag (Step 1.11)
// ---------------------------------------------------------------------------

/**
 * Walk a LiquidJS parse tree and return the first `{% schema %}` tag's
 * `parsedSchema` field, or `undefined` if the tree has no schema.
 *
 * The section tag (Step 1.11) calls this right after parsing a section
 * file so it can build `section.settings` BEFORE rendering the section
 * body. Pulling the parsed schema directly from the parse tree avoids
 * two-pass rendering (render-once-to-capture, render-again-with-drop).
 *
 * We check both `t.name === 'schema'` AND the presence of a
 * `parsedSchema` field to survive future LiquidJS internals changes —
 * any tag instance that walks like a duck (has the field) works.
 *
 * We walk the TOP LEVEL only because Shopify's convention is that
 * `{% schema %}` lives at the root of a section file, never nested
 * inside `{% if %}` / `{% for %}` / etc. Shopify's parser enforces
 * this too; we're just being pragmatic.
 */
export function findParsedSchema(
  templates: readonly unknown[],
): ParsedSchema | undefined {
  for (const tpl of templates) {
    if (!tpl || typeof tpl !== 'object') continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asAny = tpl as any
    if (asAny.name === 'schema' && asAny.parsedSchema) {
      return asAny.parsedSchema as ParsedSchema
    }
  }
  return undefined
}
