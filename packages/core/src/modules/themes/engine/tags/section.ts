/**
 * Gbox Platform — `{% section %}` tag
 *
 * Decision #1 Step 1.7 — Shopify-compatible `{% section 'name' %}`.
 *
 * Shopify semantics (from the theme docs):
 *
 *   - `{% section 'header' %}` loads `sections/header.liquid` and
 *     renders it in-place.
 *   - The rendered section gets a `section` object drop injected into
 *     its scope, exposing `section.id`, `section.settings`, and
 *     `section.blocks`. Settings/blocks come from a `{% schema %}`
 *     JSON block inside the section file — Step 1.11 will parse those;
 *     for now we inject a placeholder shape (`{}`, `[]`) so templates
 *     that reference `section.settings.foo` render empty instead of
 *     throwing.
 *   - The parent scope's globals (`shop`, `customer`, `cart`, etc.)
 *     are visible inside the section. We achieve this with
 *     `ctx.spawn()`, which inherits the parent scope chain but gives
 *     us a fresh top frame to drop `section` into without polluting
 *     the caller.
 *   - Section tag expects a STRING LITERAL (single or double quoted)
 *     — Shopify does not allow dynamic section names. The schema docs
 *     are explicit: sections are static inclusions. We enforce that
 *     here by calling `tokenizer.readValue()` and requiring the
 *     returned token to be a quoted string.
 *
 * Loading + parsing strategy:
 *
 *   We call `loader.load('sections/<name>.liquid')` directly rather
 *   than going through LiquidJS's partial-lookup machinery. Two
 *   reasons:
 *
 *     1. LiquidJS's `_parsePartialFile` searches the `partials` array
 *        (`['snippets']` in our engine), so it can't reach `sections/`
 *        without polluting the render-tag namespace.
 *     2. Direct loader access gives us one unambiguous code path that
 *        mirrors the production flow (DbLoader → raw source → parse).
 *
 *   We do NOT cache parsed section templates here. The DbLoader
 *   caches the source string already, and LiquidJS re-parsing a ~100
 *   line section is <1ms. The render pipeline (Step 1.10) will layer
 *   a parse-tree cache on top once it owns the render lifecycle.
 *
 * Missing sections:
 *
 *   If the file doesn't exist we emit the Shopify "Liquid error"
 *   placeholder comment instead of throwing. This matches Shopify's
 *   production behaviour — a missing section never crashes the whole
 *   page render, it just renders as a visible HTML comment so the
 *   developer can spot it in devtools. Step 1.14 (rate-limited error
 *   logging) will forward these to Sentry.
 */

import { Tag, type Liquid, type Context, type Emitter, type TagToken, type TopLevelToken } from 'liquidjs'
import type { TemplateLoader } from '../loader.js'
import { findParsedSchema } from './meta-blocks.js'
import { emptySchema } from '../schema/parser.js'
import { resolveSectionDrop } from '../schema/resolver.js'
import type { ParsedSchema, SectionInstance } from '../schema/types.js'
import {
  resolveSchemaTranslations,
  type ThemeLocaleDict,
} from '../theme-config/theme-locale.js'

/**
 * Key used to stash section instance data on `ctx.environments`. The
 * render pipeline (`renderPage`) writes a `{ sectionName → instance }`
 * map here; the section tag reads it at render time to build
 * `section.settings` / `section.blocks`.
 *
 * Prefixed with `__gbox` + sentinel to make it clear this is engine
 * private state, not a field themes should read. The tag never leaks
 * it into the section scope.
 */
export const GBOX_SECTION_INSTANCES_ENV_KEY = '__gboxSectionInstances' as const

/** Shape of the env value under the key above. */
export type GboxSectionInstancesEnv = Record<string, SectionInstance>

/**
 * Key used to stash the schema-translation dictionary on
 * `ctx.environments`. The render pipeline writes this per-render
 * based on the active locale; the section tag reads it at render
 * time and feeds it to `resolveSchemaTranslations` so any
 * `"label": "t:foo.bar"` references inside the section schema +
 * block schemas get resolved to the right localized string before
 * we build the `section.settings` drop.
 *
 * Decision #1 Step 1.15 — schema strings live in their OWN dict
 * (separate from the I18nService storefront strings) so a typo in
 * a schema key never silently resolves against the storefront
 * dictionary or vice versa.
 *
 * When the env key is absent (no locale wired, or no
 * `<locale>.schema.json` on disk), the section tag skips the
 * resolve pass entirely — the schema renders verbatim, including
 * any `t:foo.bar` strings in their raw form.
 */
export const GBOX_SCHEMA_LOCALE_DICT_ENV_KEY =
  '__gboxSchemaLocaleDict' as const

/** Shape of the env value under the key above. */
export type GboxSchemaLocaleDictEnv = ThemeLocaleDict

/**
 * Read the schema-translation dictionary from `ctx.environments`
 * and apply it to a parsed schema. Returns the same reference
 * unchanged when the env key is absent or empty (no allocations).
 *
 * Internal helper shared by `renderSectionInstance` and the
 * `{% section %}` tag — both paths run schemas through the same
 * resolver so theme editors see consistent labels regardless of
 * which renderer (`.json` template vs `{% section %}`) emitted
 * a given section.
 */
function applySchemaTranslations(
  parsedSchema: ParsedSchema,
  ctx: Context,
): ParsedSchema {
  const dict = (ctx.environments as Record<string, unknown>)[
    GBOX_SCHEMA_LOCALE_DICT_ENV_KEY
  ] as GboxSchemaLocaleDictEnv | undefined
  if (!dict) return parsedSchema
  // Cheap structural sharing — the walker only allocates new nodes
  // for subtrees that actually contained `t:` references, so an
  // already-localized schema is a no-op.
  return resolveSchemaTranslations(parsedSchema, dict)
}

// ---------------------------------------------------------------------------
// Direct section render (Step 1.12 — for JSON template renderer)
// ---------------------------------------------------------------------------

/**
 * Render one section file into a string, with a caller-supplied
 * instance data blob, bypassing the `{% section %}` tag's env lookup.
 *
 * This is the entry point the JSON template renderer uses to emit
 * each section in a `templates/*.json`. It exists because:
 *
 *   1. JSON templates can declare two sections of the same `type`
 *      under different theme-local ids (e.g. `sections.main.type
 *      === sections.secondary.type === 'image-text'`). The Step
 *      1.11 `{% section 'name' %}` tag looks up instance data by
 *      filename, which collapses both ids onto the same entry —
 *      we need id-keyed dispatch instead.
 *
 *   2. The JSON template already has the instance object in hand
 *      (from parseJsonTemplate); routing it through the env-based
 *      lookup would be a round-trip for no benefit.
 *
 *   3. The JSON template controls `section.id` via the sections
 *      object key, NOT the filename. This helper accepts both so
 *      `section.id` matches the JSON key in the rendered output.
 *
 * Scope semantics match the `{% section %}` tag exactly:
 *
 *   - Child context is spawned from `parentCtx` (inherits scope
 *     chain but gets a fresh top frame so the `section` drop
 *     doesn't leak back into the caller).
 *   - `environments` map is shared by reference so `shop`,
 *     `customer`, `cart`, `request`, `csrf_token`, etc. remain
 *     visible inside the section.
 *   - `registers` map is shared by reference so `{% schema %}`,
 *     `{% stylesheet %}`, `{% javascript %}`, and `{% layout %}`
 *     captures made inside the section flow back to the outer
 *     render pipeline.
 *
 * @param liquid    The LiquidJS instance (from the engine bundle)
 * @param loader    The template loader (from the engine bundle)
 * @param sectionId The theme-local id that becomes `section.id`
 * @param type      The section filename (without extension)
 * @param instance  Settings / blocks overrides — from the JSON template
 * @param parentCtx The outer context (preserves environments/registers)
 */
export async function renderSectionInstance(
  liquid: Liquid,
  loader: TemplateLoader,
  sectionId: string,
  type: string,
  instance: SectionInstance | undefined,
  parentCtx: Context,
): Promise<string> {
  const filepath = `sections/${type}.liquid`
  const src = await loader.load(filepath)
  if (src === null) {
    // Shopify-style soft fail: render a visible HTML comment so
    // the rest of the JSON template still renders.
    return `<!-- Liquid error: section '${type}' not found -->`
  }

  const templates = liquid.parse(src, filepath)
  const rawSchema = findParsedSchema(templates) ?? emptySchema()
  // Decision #1 Step 1.15 — resolve `t:foo.bar` references in the
  // section + block schemas BEFORE building the drop, so labels +
  // helper text rendered in the editor (and any `{{ section.settings.* }}`
  // expressions that pass through resolved labels) speak the visitor's
  // language. The dict comes from `ctx.environments` and may be absent
  // for tests / no-locale setups, in which case this is a no-op.
  const parsedSchema = applySchemaTranslations(rawSchema, parentCtx)
  const sectionDrop = resolveSectionDrop(sectionId, parsedSchema, instance)

  const childCtx = parentCtx.spawn()
  childCtx.environments = parentCtx.environments
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(childCtx as any).registers = (parentCtx as any).registers
  childCtx.push({ section: sectionDrop })

  return liquid.render(templates, childCtx)
}

/**
 * Register the `{% section 'name' %}` tag on the given Liquid instance.
 * The loader closure is used so each engine gets its own section tag
 * bound to its own template source (per-theme isolation).
 */
export function registerSectionTag(liquid: Liquid, loader: TemplateLoader): void {
  class SectionTag extends Tag {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly sectionName: string

    constructor(token: TagToken, remainTokens: TopLevelToken[], liquidInstance: Liquid) {
      super(token, remainTokens, liquidInstance)

      // The tokenizer starts at the character after the tag name. We
      // read a single value token and require it to be a quoted string.
      const tok = this.tokenizer
      tok.skipBlank()
      const value = tok.readValue()
      if (!value) {
        throw new Error(
          `[gbox-engine] {% section %} requires a name, got: ${token.getText()}`,
        )
      }
      const text = value.getText().trim()
      const isSingle = text.startsWith("'") && text.endsWith("'")
      const isDouble = text.startsWith('"') && text.endsWith('"')
      if (!isSingle && !isDouble) {
        throw new Error(
          `[gbox-engine] {% section %} name must be a string literal, got: ${text}`,
        )
      }
      this.sectionName = text.slice(1, -1)

      // Trailing junk check — Shopify's parser is strict here.
      tok.skipBlank()
      if (!tok.end()) {
        throw new Error(
          `[gbox-engine] {% section %} takes only a name, extra args: ${token.getText()}`,
        )
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    *render(ctx: Context, emitter: Emitter): Generator<unknown, void, any> {
      const filepath = `sections/${this.sectionName}.liquid`

      // Load source from the bound loader. `yield` lets LiquidJS'
      // async renderer await the promise.
      const src: string | null = yield loader.load(filepath)
      if (src === null) {
        // Shopify-style soft failure: render a visible comment instead
        // of throwing. Merchants can grep for "Liquid error" in prod
        // to catch missing sections without a full page blow-up.
        emitter.write(
          `<!-- Liquid error: section '${this.sectionName}' not found -->`,
        )
        return
      }

      // Parse the section source. We intentionally do NOT use
      // `_parsePartialFile` — it searches `partials`, which is scoped
      // to `snippets/`. Direct parse keeps section/snippet namespaces
      // disjoint.
      //
      // This parse also runs the SchemaTag constructor if the section
      // has a `{% schema %}` block, which parses + validates the JSON
      // at parse time. LiquidJS caches the parse tree internally (via
      // its template cache), so subsequent renders of the same
      // section file skip the parse + JSON parse.
      const templates = this.liquid.parse(src, filepath)

      // ---- Step 1.11: resolve section.settings + section.blocks -----
      // Walk the parse tree for a SchemaTag and read its pre-parsed
      // schema. Fall back to an empty schema so `section.settings`
      // is always a real object (never undefined) in the section body.
      const rawSchema = findParsedSchema(templates) ?? emptySchema()

      // Step 1.15 — apply the per-locale schema translation pass
      // (`t:foo.bar` → localized string) BEFORE feeding the schema to
      // the resolver. The dict lives on `ctx.environments` under
      // `__gboxSchemaLocaleDict`; absent dict → no-op.
      const parsedSchema = applySchemaTranslations(rawSchema, ctx)

      // Read any caller-supplied instance data from the environments
      // map the render pipeline planted there. Shape:
      //   ctx.environments.__gboxSectionInstances = {
      //     'header': { settings: {...}, blocks: [...] },
      //     ...
      //   }
      // Keyed by SECTION NAME (the argument to `{% section 'X' %}`),
      // not by a dynamic id — sections are static inclusions, so the
      // filename uniquely identifies an instance per render.
      const envInstances = (ctx.environments as Record<string, unknown>)[
        GBOX_SECTION_INSTANCES_ENV_KEY
      ] as GboxSectionInstancesEnv | undefined
      const instance = envInstances?.[this.sectionName]

      // Build the resolved drop: { id, settings, blocks, blocks_count }.
      // Defaults come from the schema; overrides from the instance;
      // type-specific fallbacks fill anything neither source supplied.
      const sectionDrop = resolveSectionDrop(
        this.sectionName,
        parsedSchema,
        instance,
      )

      // Shopify section semantics: globals (shop, cart, customer, ...)
      // are visible inside the section, but the parent template's
      // LOCAL scope (for-loop variables, `assign`-created locals, etc.)
      // is NOT. We achieve this by spawning a fresh ctx (which drops
      // `ctx.scopes`) and then copying the parent's `environments`
      // by reference (which is where `parseAndRender(tpl, scope)`
      // puts top-level globals).
      const childCtx = ctx.spawn()
      childCtx.environments = ctx.environments

      // CRITICAL: share the `registers` map with the parent context.
      // Registers are where `{% schema %}`, `{% stylesheet %}`,
      // `{% javascript %}`, and `{% layout %}` tags stash their
      // metadata. If we leave the child with its own registers
      // object, those captures never make it back to the outer
      // render — the caller reads the parent's registers after
      // `parseAndRender` returns and would see nothing.
      //
      // `registers` is declared `private` in LiquidJS's .d.ts but
      // exists at runtime. We cast through `any` to assign by
      // reference — there's no public API for this.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(childCtx as any).registers = (ctx as any).registers

      // Push a dedicated top-of-stack frame for the `section` drop so
      // it lives in the section's scope only — never leaking back into
      // the parent (because we never pop into the parent's ctx).
      //
      // The drop carries id, settings (merged from schema defaults +
      // instance overrides), and blocks (resolved against block
      // schemas). See schema/resolver.ts for the merge algorithm.
      childCtx.push({
        section: sectionDrop,
      })

      yield this.liquid.renderer.renderTemplates(templates, childCtx, emitter)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  liquid.registerTag('section', SectionTag as any)
}
