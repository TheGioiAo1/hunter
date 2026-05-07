/**
 * Gbox Platform — JSON template types
 *
 * Decision #1 Step 1.12 — Shopify themes ship page templates in two
 * formats:
 *
 *   - `templates/<name>.liquid` — classic Liquid template (legacy)
 *   - `templates/<name>.json`   — structured JSON describing which
 *                                 sections to render, in what order,
 *                                 with what settings/blocks (modern)
 *
 * A JSON template body looks like this (from a real Dawn theme):
 *
 *   {
 *     "sections": {
 *       "main": {
 *         "type": "main-product",
 *         "settings": { "media_size": "medium" },
 *         "blocks": {
 *           "abc123": {
 *             "type": "description",
 *             "settings": { "description": "<p>Hi</p>" }
 *           }
 *         },
 *         "block_order": ["abc123"],
 *         "disabled": false
 *       },
 *       "related-products": {
 *         "type": "related-products",
 *         "settings": { "heading": "You may also like" }
 *       }
 *     },
 *     "order": ["main", "related-products"],
 *     "wrapper": "main",
 *     "layout": "theme"
 *   }
 *
 * Key modelling choices:
 *
 *   - `sections` is an OBJECT keyed by a theme-local id (e.g. "main",
 *     "related-products"). Two sections can share the same `type` under
 *     different ids — that's why the Liquid `section.id` drop must come
 *     from the JSON key, not the filename.
 *
 *   - `blocks` is ALSO an object keyed by block id (usually Shopify's
 *     32-char hex, but any string is valid). `block_order` determines
 *     the render order; any id in blocks not listed in block_order is
 *     omitted from the rendered output (matches Shopify).
 *
 *   - `order` is authoritative for section render order. A section
 *     defined in `sections` but missing from `order` is never rendered.
 *
 *   - `wrapper`, `layout`, and any other top-level fields are preserved
 *     verbatim on the parsed shape for forward-compat with the theme
 *     editor. The renderer only consumes the fields it knows about.
 */

// ---------------------------------------------------------------------------
// Raw JSON shapes
// ---------------------------------------------------------------------------

/**
 * Parsed form of one block entry inside `sections.<id>.blocks`. The
 * id is NOT stored on the block itself — it comes from the key in
 * the parent object. We add it during parse so the renderer can
 * iterate a flat array.
 */
export interface JsonBlockInstance {
  /** Block id (from the parent object key). */
  id: string
  /** Matches a `schema.blocks[].type` in the section schema. */
  type: string
  /** Raw setting overrides — merged against block schema defaults. */
  settings?: Record<string, unknown>
  /** Editor-supplied DOM attributes (Shopify adds `data-block-id`). */
  shopify_attributes?: string
  /** Pass-through for unknown editor fields. */
  [extra: string]: unknown
}

/**
 * Parsed form of one section entry inside `sections.<id>`. The id is
 * stored on the section as `sectionId` — not `id`, to avoid colliding
 * with user-visible section drop fields.
 */
export interface JsonSectionInstance {
  /** Theme-local section id (from the parent object key). */
  sectionId: string
  /** Section filename (without extension) — e.g. "main-product". */
  type: string
  /** Raw setting overrides. */
  settings?: Record<string, unknown>
  /**
   * Blocks as a flat array in render order. Constructed from the
   * raw `blocks` object + `block_order` during parse. Unknown block
   * ids in block_order are skipped; blocks missing from block_order
   * are omitted (matches Shopify).
   */
  blocks: JsonBlockInstance[]
  /** Section hidden from the page render. */
  disabled?: boolean
  /** Pass-through for unknown fields (custom_css, padding, etc.). */
  [extra: string]: unknown
}

/**
 * Fully-parsed JSON template — what the renderer consumes.
 */
export interface JsonTemplate {
  /**
   * Map of section id → parsed section instance. Order is
   * insertion-preserving (matches the original JSON object).
   */
  sections: Record<string, JsonSectionInstance>
  /**
   * Authoritative render order of sections. Every id in this array
   * must exist as a key in `sections`; the parser validates that.
   */
  order: string[]
  /**
   * Optional HTML wrapper tag name. When set, the renderer wraps the
   * concatenated section output in `<wrapper>...</wrapper>`. Common
   * values: "main", "section", "div". Preserved as-is even if the
   * renderer doesn't understand it.
   */
  wrapper?: string
  /**
   * Optional layout override. When set, this takes precedence over
   * the pipeline's `defaultLayout` option. `null` means no layout
   * wrap (matches Shopify's `"layout": false`).
   */
  layout?: string | null
  /** Forward-compat: every other top-level key from the JSON. */
  [extra: string]: unknown
}
