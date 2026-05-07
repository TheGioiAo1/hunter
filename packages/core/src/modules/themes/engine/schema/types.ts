/**
 * Gbox Platform — Section schema types
 *
 * Decision #1 Step 1.11 — The Shopify `{% schema %}` block is strict
 * JSON describing:
 *
 *   - `name`         — human label (editor UI only)
 *   - `tag`          — optional HTML wrapper tag the theme editor injects
 *   - `class`        — optional extra class on the wrapper
 *   - `settings`     — user-editable fields, with types + defaults
 *   - `blocks`       — repeatable child schemas (carousel slides, etc.)
 *   - `presets`      — theme editor insert-time defaults (render-time IGNORED)
 *   - `max_blocks`   — hard cap on blocks[]
 *   - `limit`        — max instances of this section on a page
 *   - `enabled_on` / `disabled_on` — template scope filter
 *   - `default`      — JSON template defaults (render-time IGNORED)
 *   - `locales`      — inline translations (render-time IGNORED; i18n file wins)
 *
 * Render-time the engine only cares about `settings` and `blocks`;
 * everything else belongs to the theme editor (Step 2.x). We still
 * type the optional fields so `ParsedSchema` round-trips losslessly
 * — Step 1.13's section-rendering API re-serializes the schema back
 * to JSON for the editor.
 *
 * Why a dedicated types file (not inlined in parser.ts)?
 *
 *   - The resolver, tag layer, pipeline, and future theme editor
 *     (Step 2.x) all consume these types. A single source of truth
 *     keeps them in sync.
 *   - Type-only imports get tree-shaken; consumers that only need
 *     `ParsedSchema` don't pay for the parser code.
 *
 * Non-goals:
 *   - Validating setting values against editor UI constraints
 *     (e.g. `type: 'range'` min/max bounds). Shopify does this in the
 *     editor, not at render. We keep resolved values as-is.
 *   - Modelling every Shopify setting type exactly (fonts, markets,
 *     etc.). We accept the strings and pass values through; the
 *     resolver only special-cases the few types that have a sensible
 *     default when `default` is omitted.
 */

// ---------------------------------------------------------------------------
// Setting types
// ---------------------------------------------------------------------------

/**
 * All Shopify setting types we currently recognize. Anything not in
 * this list is still accepted (forwards-compat with new Shopify
 * types), but the resolver won't know how to produce a default value
 * for it.
 */
export type SchemaSettingType =
  // Value-bearing types — the resolver produces a drop entry for each
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'html'
  | 'inline_richtext'
  | 'number'
  | 'range'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'color'
  | 'color_background'
  | 'color_scheme'
  | 'color_scheme_group'
  | 'font_picker'
  | 'url'
  | 'image_picker'
  | 'video'
  | 'video_url'
  | 'product'
  | 'product_list'
  | 'collection'
  | 'collection_list'
  | 'blog'
  | 'page'
  | 'link_list'
  | 'article'
  | 'liquid'
  | 'text_alignment'
  | 'metaobject'
  | 'metaobject_list'
  // Editor-only separators — skipped from the resolved drop
  | 'header'
  | 'paragraph'

/**
 * The non-value types — these are layout separators in the theme
 * editor and never produce a field in `section.settings`. The
 * resolver filters them out.
 */
export const NON_VALUE_SETTING_TYPES: ReadonlySet<SchemaSettingType> =
  new Set(['header', 'paragraph'])

/**
 * Fallback default for a given setting type, used when the schema
 * entry omits a `default` key AND the instance has no override.
 * Shopify itself is inconsistent here (some fields are `null`, some
 * `""`), so we pick the value that's most useful in Liquid:
 *   - text-ish → empty string (so `{{ x | append: '!' }}` works)
 *   - numeric  → 0
 *   - bool     → false
 *   - picker   → null (so `{% if section.settings.image %}` works)
 */
export function typeFallbackDefault(type: string): unknown {
  switch (type) {
    case 'text':
    case 'textarea':
    case 'richtext':
    case 'inline_richtext':
    case 'html':
    case 'url':
    case 'liquid':
    case 'color':
    case 'color_background':
    case 'color_scheme':
    case 'font_picker':
    case 'text_alignment':
    case 'video_url':
      return ''
    case 'number':
    case 'range':
      return 0
    case 'checkbox':
      return false
    case 'radio':
    case 'select':
      return null
    case 'image_picker':
    case 'video':
    case 'product':
    case 'collection':
    case 'blog':
    case 'page':
    case 'link_list':
    case 'article':
    case 'metaobject':
      return null
    case 'product_list':
    case 'collection_list':
    case 'metaobject_list':
      return []
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Raw schema item shapes
// ---------------------------------------------------------------------------

/**
 * A single setting entry inside `schema.settings[]`. We store the
 * parsed result exactly as it appeared in the JSON plus a narrowed
 * `type` field — unknown types survive as strings so new Shopify
 * setting types don't crash older engines.
 */
export interface SchemaSetting {
  /** Setting type (e.g. 'text', 'color', 'range'). */
  type: SchemaSettingType | string
  /** Stable key used as `section.settings.<id>`. Required for value types. */
  id?: string
  /** Editor label (ignored at render time). */
  label?: string
  /** Editor helper text (ignored at render time). */
  info?: string
  /**
   * Default value when the instance doesn't override. Type depends on
   * `type`. `null` is a legitimate default for picker fields.
   */
  default?: unknown
  /** Placeholder text for text-ish fields (editor UI only). */
  placeholder?: unknown
  /** `select` / `radio` options. */
  options?: Array<{ value: string; label?: string }>
  /** Range bounds. */
  min?: number
  max?: number
  step?: number
  unit?: string
  /** Pass-through for fields we don't model explicitly. */
  [extra: string]: unknown
}

/**
 * A block schema — same shape as a section but nested under
 * `schema.blocks[]`. Blocks themselves contain their own `settings[]`.
 */
export interface SchemaBlock {
  /** Machine type, used by the JSON template's block.type. */
  type: string
  /** Editor label. */
  name?: string
  /** Hard cap for this block type. */
  limit?: number
  /** Block-level settings (same shape as section settings). */
  settings?: SchemaSetting[]
  [extra: string]: unknown
}

/**
 * Fully-parsed schema body. All fields are optional because Shopify
 * accepts `{% schema %}{}{% endschema %}` as a valid empty schema.
 */
export interface ParsedSchema {
  name?: string
  tag?: string
  class?: string
  settings: SchemaSetting[]
  blocks: SchemaBlock[]
  presets?: unknown[]
  default?: unknown
  max_blocks?: number
  limit?: number
  enabled_on?: { templates?: string[]; groups?: string[] }
  disabled_on?: { templates?: string[]; groups?: string[] }
  locales?: Record<string, Record<string, string>>
  /** Everything else from the raw JSON, preserved for the editor. */
  [extra: string]: unknown
}

// ---------------------------------------------------------------------------
// Instance shapes (what the JSON template / caller passes at render)
// ---------------------------------------------------------------------------

/**
 * A single block instance from a JSON template. Shopify's JSON
 * template shape puts these in `sections.<id>.blocks.<block_id>`.
 */
export interface SectionBlockInstance {
  type: string
  settings?: Record<string, unknown>
  [extra: string]: unknown
}

/**
 * One section instance's render-time override data. Keyed by section
 * name (filename without extension) when passed through the pipeline,
 * or embedded in a JSON template for Step 1.12. Settings and blocks
 * are both optional so partial overrides work.
 */
export interface SectionInstance {
  /** Override values for section settings. */
  settings?: Record<string, unknown>
  /** Explicit block instances; ordered, each with its own settings. */
  blocks?: SectionBlockInstance[]
  /** Explicit block order for named blocks (unused — blocks[] is ordered). */
  block_order?: string[]
  /** Allow callers to pass arbitrary extra drop fields. */
  [extra: string]: unknown
}

// ---------------------------------------------------------------------------
// Resolved drop shapes (what Liquid sees as `section.*`)
// ---------------------------------------------------------------------------

/**
 * Resolved section.blocks[] entry. `id` is the theme-unique block id,
 * `type` matches a `schema.blocks[].type`, and `settings` is the
 * fully-merged defaults + overrides drop.
 */
export interface ResolvedBlock {
  id: string
  type: string
  settings: Record<string, unknown>
  shopify_attributes?: string
}

/**
 * The `section` drop injected into a section's render scope by the
 * `{% section %}` tag. Matches Shopify's section object field-for-field:
 * `section.id`, `section.settings.*`, `section.blocks[]`,
 * `section.blocks.size`.
 *
 * (Array `.size` is a LiquidJS builtin — no special handling needed.)
 */
export interface SectionDrop {
  id: string
  settings: Record<string, unknown>
  blocks: ResolvedBlock[]
  /** Shopify alias for blocks.length accessible via `section.blocks_count`. */
  blocks_count: number
}
