/**
 * Gbox Platform — JSON template parser
 *
 * Decision #1 Step 1.12 — Parse a `templates/<name>.json` body into a
 * typed `JsonTemplate`. Runs once per unique source string; the
 * pipeline could cache the result per template file, but JSON parsing
 * is cheap enough that we don't bother for Step 1.12.
 *
 * Validation rules (strict — bad data throws):
 *
 *   - Top-level must be an object.
 *   - `sections` must be an object (non-null, non-array).
 *   - `order` must be an array of strings.
 *   - Every id in `order` must exist as a key in `sections` — an
 *     id pointing at a missing section is almost always a theme bug.
 *   - Each section entry must have a `type` string.
 *   - `blocks`, if present, must be an object; `block_order`, if
 *     present, must be a string[].
 *   - `block_order` ids not in `blocks` are silently skipped (matches
 *     Shopify — the editor leaves dangling ids when blocks are
 *     deleted).
 *   - Blocks in `blocks` that aren't in `block_order` are omitted
 *     from the rendered output (matches Shopify).
 *   - `wrapper` must be a string when present.
 *   - `layout` can be a string OR `false` (meaning no layout).
 *     Shopify uses `false` for bare templates; we normalize to
 *     `null` on the parsed object.
 *
 * Forward-compat:
 *
 *   Unknown top-level keys are preserved on the parsed object. The
 *   renderer ignores them but the theme editor can read them back
 *   when it re-serializes.
 *
 * Error mode:
 *
 *   Every thrown error is a `JsonTemplateParseError` carrying the
 *   source path when supplied. The pipeline re-raises the error
 *   unchanged — a bad JSON template is a deploy-time bug, and
 *   failing the whole request with a clear message is the right
 *   move.
 */

import type {
  JsonBlockInstance,
  JsonSectionInstance,
  JsonTemplate,
} from './types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a JSON template body into a typed `JsonTemplate`.
 *
 * @param rawJson    The raw template file contents.
 * @param sourcePath Optional logical path of the source file for
 *                   error messages.
 */
export function parseJsonTemplate(
  rawJson: string,
  sourcePath?: string,
): JsonTemplate {
  const where = sourcePath ? ` in ${sourcePath}` : ''

  let raw: unknown
  try {
    raw = JSON.parse(rawJson)
  } catch (err) {
    throw new JsonTemplateParseError(
      `[gbox-engine] invalid JSON template${where}: ${(err as Error).message}`,
      sourcePath,
    )
  }

  if (!isPlainObject(raw)) {
    throw new JsonTemplateParseError(
      `[gbox-engine] JSON template${where} must be an object, got ${describe(raw)}`,
      sourcePath,
    )
  }

  // ---- Parse sections map -----------------------------------------------
  const rawSections = raw.sections
  if (rawSections === undefined) {
    throw new JsonTemplateParseError(
      `[gbox-engine] JSON template${where} is missing "sections"`,
      sourcePath,
    )
  }
  if (!isPlainObject(rawSections)) {
    throw new JsonTemplateParseError(
      `[gbox-engine] "sections"${where} must be an object, got ${describe(rawSections)}`,
      sourcePath,
    )
  }

  const sections: Record<string, JsonSectionInstance> = {}
  for (const sectionId of Object.keys(rawSections)) {
    sections[sectionId] = parseSection(
      sectionId,
      rawSections[sectionId],
      where,
      sourcePath,
    )
  }

  // ---- Parse order array ------------------------------------------------
  const rawOrder = raw.order
  if (rawOrder === undefined) {
    throw new JsonTemplateParseError(
      `[gbox-engine] JSON template${where} is missing "order"`,
      sourcePath,
    )
  }
  if (!Array.isArray(rawOrder)) {
    throw new JsonTemplateParseError(
      `[gbox-engine] "order"${where} must be an array, got ${describe(rawOrder)}`,
      sourcePath,
    )
  }
  const order: string[] = []
  rawOrder.forEach((id, idx) => {
    if (typeof id !== 'string' || !id) {
      throw new JsonTemplateParseError(
        `[gbox-engine] "order"[${idx}]${where} must be a non-empty string, got ${describe(id)}`,
        sourcePath,
      )
    }
    if (!(id in sections)) {
      throw new JsonTemplateParseError(
        `[gbox-engine] "order"${where} references unknown section id "${id}"`,
        sourcePath,
      )
    }
    order.push(id)
  })

  // ---- Wrapper / layout -------------------------------------------------
  const wrapper = raw.wrapper
  if (wrapper !== undefined && typeof wrapper !== 'string') {
    throw new JsonTemplateParseError(
      `[gbox-engine] "wrapper"${where} must be a string, got ${describe(wrapper)}`,
      sourcePath,
    )
  }
  const rawLayout = raw.layout
  let layout: string | null | undefined
  if (rawLayout === false) layout = null
  else if (rawLayout === null) layout = null
  else if (typeof rawLayout === 'string') layout = rawLayout
  else if (rawLayout !== undefined) {
    throw new JsonTemplateParseError(
      `[gbox-engine] "layout"${where} must be a string or false, got ${describe(rawLayout)}`,
      sourcePath,
    )
  }

  // ---- Build result, preserving unknown top-level keys ------------------
  const out: JsonTemplate = {
    ...raw,
    sections,
    order,
  }
  if (wrapper !== undefined) out.wrapper = wrapper
  else delete out.wrapper
  if (layout !== undefined) out.layout = layout
  return out
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class JsonTemplateParseError extends Error {
  override readonly name = 'JsonTemplateParseError'
  constructor(message: string, readonly sourcePath?: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseSection(
  sectionId: string,
  raw: unknown,
  where: string,
  sourcePath?: string,
): JsonSectionInstance {
  if (!isPlainObject(raw)) {
    throw new JsonTemplateParseError(
      `[gbox-engine] sections["${sectionId}"]${where} must be an object, got ${describe(raw)}`,
      sourcePath,
    )
  }
  const type = raw.type
  if (typeof type !== 'string' || !type) {
    throw new JsonTemplateParseError(
      `[gbox-engine] sections["${sectionId}"]${where} is missing a "type" string`,
      sourcePath,
    )
  }
  const settings = raw.settings
  if (settings !== undefined && !isPlainObject(settings)) {
    throw new JsonTemplateParseError(
      `[gbox-engine] sections["${sectionId}"].settings${where} must be an object, got ${describe(settings)}`,
      sourcePath,
    )
  }

  // Blocks: object keyed by block id. block_order: string[] giving
  // render order. We produce a flat blocks[] array in block_order,
  // skipping missing ids.
  const blocks: JsonBlockInstance[] = []
  const rawBlocks = raw.blocks
  const rawBlockOrder = raw.block_order

  if (rawBlocks !== undefined && !isPlainObject(rawBlocks)) {
    throw new JsonTemplateParseError(
      `[gbox-engine] sections["${sectionId}"].blocks${where} must be an object, got ${describe(rawBlocks)}`,
      sourcePath,
    )
  }
  if (rawBlockOrder !== undefined && !Array.isArray(rawBlockOrder)) {
    throw new JsonTemplateParseError(
      `[gbox-engine] sections["${sectionId}"].block_order${where} must be an array, got ${describe(rawBlockOrder)}`,
      sourcePath,
    )
  }

  // Determine the iteration order. Prefer explicit block_order; fall
  // back to insertion order of the blocks object when block_order is
  // absent (same as Shopify behaviour).
  if (rawBlocks) {
    const ids: string[] =
      (rawBlockOrder as string[] | undefined) ?? Object.keys(rawBlocks)
    ids.forEach((id, idx) => {
      if (typeof id !== 'string' || !id) {
        throw new JsonTemplateParseError(
          `[gbox-engine] sections["${sectionId}"].block_order[${idx}]${where} must be a non-empty string, got ${describe(id)}`,
          sourcePath,
        )
      }
      const blk = (rawBlocks as Record<string, unknown>)[id]
      if (blk === undefined) {
        // Shopify silently drops dangling ids.
        return
      }
      if (!isPlainObject(blk)) {
        throw new JsonTemplateParseError(
          `[gbox-engine] sections["${sectionId}"].blocks["${id}"]${where} must be an object, got ${describe(blk)}`,
          sourcePath,
        )
      }
      const btype = blk.type
      if (typeof btype !== 'string' || !btype) {
        throw new JsonTemplateParseError(
          `[gbox-engine] sections["${sectionId}"].blocks["${id}"]${where} is missing a "type" string`,
          sourcePath,
        )
      }
      const bsettings = blk.settings
      if (bsettings !== undefined && !isPlainObject(bsettings)) {
        throw new JsonTemplateParseError(
          `[gbox-engine] sections["${sectionId}"].blocks["${id}"].settings${where} must be an object, got ${describe(bsettings)}`,
          sourcePath,
        )
      }
      blocks.push({
        ...(blk as object),
        id,
        type: btype,
        settings: bsettings as Record<string, unknown> | undefined,
      } as JsonBlockInstance)
    })
  }

  const section: JsonSectionInstance = {
    ...(raw as object),
    sectionId,
    type,
    settings: settings as Record<string, unknown> | undefined,
    blocks,
  }
  if ('disabled' in raw) section.disabled = Boolean(raw.disabled)
  return section
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}
