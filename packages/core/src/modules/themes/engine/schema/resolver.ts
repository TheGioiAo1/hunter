/**
 * Gbox Platform — Section schema resolver
 *
 * Decision #1 Step 1.11 — Merge a parsed schema (from `parseSchemaBody`)
 * with an optional render-time instance (from a JSON template or the
 * pipeline's `sectionInstances` option) to produce the `section` drop
 * Shopify themes read as `section.settings.*` and `section.blocks[]`.
 *
 * Precedence (highest → lowest) for a given setting id:
 *   1. instance.settings[id]  — JSON template / caller override
 *   2. schemaSetting.default  — schema default
 *   3. typeFallbackDefault(type) — built-in fallback for that type
 *
 * Block resolution:
 *
 *   - If the instance supplies `blocks[]`, each entry is resolved
 *     against the matching `schema.blocks[].settings[]` (or, if the
 *     type isn't in the schema, the instance settings are passed
 *     through unchanged — forwards-compat).
 *   - If the instance has no blocks, we return an empty array.
 *     Shopify sections with blocks but no presets can legitimately
 *     render empty when no template has populated them, so we mimic
 *     that behaviour instead of inventing default blocks.
 *
 * Block ids:
 *
 *   Shopify generates 32-char hex ids for editor-created blocks.
 *   We don't want to depend on the theme editor at render time, so
 *   we accept whatever `id` the instance provides, and fall back to
 *   a deterministic `<type>-<index>` when missing. Template authors
 *   using `{% for block in section.blocks %}` only read `block.id`
 *   for DOM attributes, so determinism is enough.
 *
 * No mutation:
 *
 *   The resolver never touches the input schema or instance — both
 *   are treated as read-only. The output is a fresh `SectionDrop`
 *   that callers can safely push into a Liquid scope without worrying
 *   about cross-render state leaks.
 */

import {
  NON_VALUE_SETTING_TYPES,
  typeFallbackDefault,
  type ParsedSchema,
  type ResolvedBlock,
  type SchemaBlock,
  type SchemaSetting,
  type SectionBlockInstance,
  type SectionDrop,
  type SectionInstance,
} from './types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the `section` drop for one section render. Returns a fresh
 * object on every call — callers can mutate the result if needed.
 */
export function resolveSectionDrop(
  sectionId: string,
  schema: ParsedSchema,
  instance?: SectionInstance,
): SectionDrop {
  const settings = resolveSectionSettings(schema, instance)
  const blocks = resolveSectionBlocks(schema, instance)
  return {
    id: sectionId,
    settings,
    blocks,
    blocks_count: blocks.length,
  }
}

/**
 * Resolve `section.settings` — walk every schema entry, apply the
 * instance override or fall back through the default chain. Filters
 * out layout separators (`header`, `paragraph`) which have no id.
 */
export function resolveSectionSettings(
  schema: ParsedSchema,
  instance?: SectionInstance,
): Record<string, unknown> {
  return resolveSettingsFromList(schema.settings, instance?.settings)
}

/**
 * Resolve `section.blocks` — walk the instance's block list (NOT
 * the schema's block schemas, because the schema only declares what
 * TYPES of block are allowed, not which instances exist). Each
 * instance block gets its settings resolved against the matching
 * block schema.
 */
export function resolveSectionBlocks(
  schema: ParsedSchema,
  instance?: SectionInstance,
): ResolvedBlock[] {
  const rawBlocks = instance?.blocks
  if (!rawBlocks || !Array.isArray(rawBlocks) || rawBlocks.length === 0) {
    return []
  }
  // Build a type → schema map once so we don't do an O(N*M) lookup.
  const byType = new Map<string, SchemaBlock>()
  for (const blk of schema.blocks ?? []) {
    if (blk.type) byType.set(blk.type, blk)
  }
  const out: ResolvedBlock[] = []
  rawBlocks.forEach((inst, idx) => {
    out.push(resolveOneBlock(inst, idx, byType))
  })
  return out
}

// ---------------------------------------------------------------------------
// Internals — exported for tests only
// ---------------------------------------------------------------------------

/**
 * Merge a list of schema setting entries with an optional instance
 * settings map. Shared between section-level and block-level
 * resolution because they use the same algorithm.
 */
export function resolveSettingsFromList(
  list: readonly SchemaSetting[],
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of list) {
    const type = typeof item.type === 'string' ? item.type : ''
    // Layout separators never appear in the resolved drop.
    if (NON_VALUE_SETTING_TYPES.has(type as 'header' | 'paragraph')) continue
    const id = item.id
    if (typeof id !== 'string' || !id) continue
    out[id] = pickSettingValue(type, item, overrides, id)
  }
  return out
}

/**
 * Pick the final value for one setting entry.
 *
 * Precedence: instance override → schema default → type fallback.
 *
 * The `hasOwn` check on the override object matters: an instance
 * that explicitly sets `heading: null` should produce `null`, not
 * fall through to the schema default. Shopify honours explicit nulls
 * as "cleared field" — we do the same.
 */
function pickSettingValue(
  type: string,
  item: SchemaSetting,
  overrides: Record<string, unknown> | undefined,
  id: string,
): unknown {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, id)) {
    return overrides[id]
  }
  if (Object.prototype.hasOwnProperty.call(item, 'default')) {
    return item.default
  }
  return typeFallbackDefault(type)
}

/**
 * Resolve one block instance against the block schema map. When the
 * block type isn't known to the schema, settings pass through
 * unchanged — this lets themes ship a JSON template with block data
 * for a schema that hasn't been parsed yet without losing the data.
 */
function resolveOneBlock(
  inst: SectionBlockInstance,
  index: number,
  byType: Map<string, SchemaBlock>,
): ResolvedBlock {
  const type = typeof inst.type === 'string' ? inst.type : ''
  const schema = byType.get(type)
  const overrides = isRecord(inst.settings) ? inst.settings : undefined
  const settings = schema
    ? resolveSettingsFromList(schema.settings ?? [], overrides)
    : { ...(overrides ?? {}) }

  // `id` may come from the JSON template (Shopify's editor-generated
  // hex string) or be omitted (programmatic template). We don't coerce
  // numeric ids to strings because Shopify uses strings exclusively.
  const rawId = (inst as { id?: unknown }).id
  const id =
    typeof rawId === 'string' && rawId
      ? rawId
      : `${type || 'block'}-${index}`

  const shopify_attributes = (inst as { shopify_attributes?: unknown })
    .shopify_attributes
  const out: ResolvedBlock = {
    id,
    type,
    settings,
  }
  if (typeof shopify_attributes === 'string') {
    out.shopify_attributes = shopify_attributes
  }
  return out
}

/** Plain-object guard (not an array, not null). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
