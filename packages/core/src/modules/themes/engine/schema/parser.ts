/**
 * Gbox Platform — Section schema JSON parser
 *
 * Decision #1 Step 1.11 — Parse the raw body captured by the
 * `{% schema %}` tag into a typed `ParsedSchema`. This runs ONCE at
 * parse time (inside the SchemaTag constructor), so the result is
 * cached alongside the compiled template — no per-render JSON
 * re-parsing.
 *
 * Strictness:
 *
 *   - Strict JSON only. No trailing commas, no JS-style comments, no
 *     single-quoted strings. Matches Shopify's parser — themes that
 *     work on Shopify must work here unmodified.
 *   - Duplicate setting ids within one schema → throw. Shopify is
 *     silent about duplicates but the result is merchant confusion;
 *     we fail loud at parse time instead.
 *   - Unknown top-level keys are preserved on the result (editor
 *     round-trip) but never validated.
 *   - Unknown setting types are kept as-is (`type: string`) so the
 *     engine keeps working when Shopify ships a new setting type we
 *     haven't added to the enum.
 *
 * Error mode:
 *
 *   Every thrown error carries enough context for a theme developer
 *   to fix the JSON without opening our source code. Messages always
 *   include the source path (when available) and, for JSON syntax
 *   errors, the character offset from V8's SyntaxError.
 *
 *   The throw is at PARSE time, not render time. That means one bad
 *   section file kills that file's parse, not a whole page render.
 *   The section tag catches and emits the Shopify-style "Liquid
 *   error" placeholder comment so the rest of the page still renders.
 */

import type {
  ParsedSchema,
  SchemaBlock,
  SchemaSetting,
} from './types.js'
import { NON_VALUE_SETTING_TYPES } from './types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a `{% schema %}` body into a typed `ParsedSchema`.
 *
 * @param rawJson   The raw body captured by the SchemaTag (exactly
 *                  what appeared between `{% schema %}` and
 *                  `{% endschema %}`, including surrounding
 *                  whitespace).
 * @param sourcePath Optional logical path of the file the schema
 *                   came from — included in error messages.
 * @throws SchemaParseError on invalid JSON or structural violations.
 */
export function parseSchemaBody(
  rawJson: string,
  sourcePath?: string,
): ParsedSchema {
  const where = sourcePath ? ` in ${sourcePath}` : ''
  const trimmed = rawJson.trim()
  if (!trimmed) {
    // Empty body — treat as empty schema. Shopify's own parser throws
    // here; we're more lenient so a theme author can scaffold a
    // section without committing a real schema first.
    return emptySchema()
  }

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (err) {
    const msg = (err as Error).message
    throw new SchemaParseError(
      `[gbox-engine] invalid JSON in {% schema %}${where}: ${msg}`,
      sourcePath,
    )
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SchemaParseError(
      `[gbox-engine] {% schema %}${where} must be a JSON object, got ${describe(raw)}`,
      sourcePath,
    )
  }

  const obj = raw as Record<string, unknown>
  const settings = parseSettings(obj.settings, `settings`, where, sourcePath)
  const blocks = parseBlocks(obj.blocks, where, sourcePath)

  // Preserve every other field unchanged for editor round-trip.
  const out: ParsedSchema = {
    ...obj,
    settings,
    blocks,
  }
  return out
}

/**
 * Convenience: return an empty but structurally-complete schema.
 * Useful for sections that have no `{% schema %}` block — the
 * section tag falls back to this so `section.settings` is always
 * a real object (never `undefined`).
 */
export function emptySchema(): ParsedSchema {
  return { settings: [], blocks: [] }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Dedicated error type so callers can `instanceof` it to distinguish
 * parser failures from generic runtime errors.
 */
export class SchemaParseError extends Error {
  override readonly name = 'SchemaParseError'
  constructor(message: string, readonly sourcePath?: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse and validate a `settings[]` array. Enforces:
 *   - Must be an array (or absent → empty array).
 *   - Each entry must be an object with a string `type`.
 *   - Value-typed entries (not header/paragraph) must have an `id`.
 *   - Within a single array, ids must be unique.
 */
function parseSettings(
  raw: unknown,
  scope: string,
  where: string,
  sourcePath?: string,
): SchemaSetting[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new SchemaParseError(
      `[gbox-engine] ${scope}${where} must be an array, got ${describe(raw)}`,
      sourcePath,
    )
  }

  const out: SchemaSetting[] = []
  const seenIds = new Set<string>()

  raw.forEach((entry, idx) => {
    if (!isPlainObject(entry)) {
      throw new SchemaParseError(
        `[gbox-engine] ${scope}[${idx}]${where} must be an object, got ${describe(entry)}`,
        sourcePath,
      )
    }
    const type = entry.type
    if (typeof type !== 'string' || !type) {
      throw new SchemaParseError(
        `[gbox-engine] ${scope}[${idx}]${where} is missing a "type" string`,
        sourcePath,
      )
    }

    const isNonValue = NON_VALUE_SETTING_TYPES.has(
      type as 'header' | 'paragraph',
    )
    const id = entry.id
    if (!isNonValue) {
      if (typeof id !== 'string' || !id) {
        throw new SchemaParseError(
          `[gbox-engine] ${scope}[${idx}] (type=${type})${where} requires an "id" string`,
          sourcePath,
        )
      }
      if (seenIds.has(id)) {
        throw new SchemaParseError(
          `[gbox-engine] ${scope}${where} has duplicate id "${id}"`,
          sourcePath,
        )
      }
      seenIds.add(id)
    } else if (id !== undefined && typeof id !== 'string') {
      // header/paragraph may carry a content key but not a numeric id.
      throw new SchemaParseError(
        `[gbox-engine] ${scope}[${idx}] (type=${type})${where} has non-string id`,
        sourcePath,
      )
    }

    // Copy the entry object by spread so the parser doesn't mutate
    // the original (JSON.parse returned a fresh object tree, but the
    // resolver receives `ParsedSchema` by reference — we want it to
    // be safe against caller mutation).
    out.push({ ...(entry as SchemaSetting) })
  })

  return out
}

/**
 * Parse and validate `blocks[]`. Each block is essentially a nested
 * schema with its own `settings[]`. We reuse `parseSettings` for the
 * inner validation so block settings get the same duplicate-id check.
 */
function parseBlocks(
  raw: unknown,
  where: string,
  sourcePath?: string,
): SchemaBlock[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new SchemaParseError(
      `[gbox-engine] blocks${where} must be an array, got ${describe(raw)}`,
      sourcePath,
    )
  }

  const out: SchemaBlock[] = []
  const seenTypes = new Set<string>()

  raw.forEach((entry, idx) => {
    if (!isPlainObject(entry)) {
      throw new SchemaParseError(
        `[gbox-engine] blocks[${idx}]${where} must be an object, got ${describe(entry)}`,
        sourcePath,
      )
    }
    const type = entry.type
    if (typeof type !== 'string' || !type) {
      throw new SchemaParseError(
        `[gbox-engine] blocks[${idx}]${where} is missing a "type" string`,
        sourcePath,
      )
    }
    if (seenTypes.has(type)) {
      throw new SchemaParseError(
        `[gbox-engine] blocks${where} has duplicate type "${type}"`,
        sourcePath,
      )
    }
    seenTypes.add(type)

    const innerScope = `blocks[${idx}].settings`
    const innerSettings = parseSettings(
      entry.settings,
      innerScope,
      where,
      sourcePath,
    )

    out.push({
      ...(entry as SchemaBlock),
      settings: innerSettings,
    })
  })

  return out
}

/** Plain-object type guard — rejects arrays and null. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Short human description of any value for error messages. */
function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}
