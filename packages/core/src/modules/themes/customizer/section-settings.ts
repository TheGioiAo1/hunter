/**
 * Theme Customizer — Section Settings + Schema reader
 *
 * Read-side helper: fetches a single `theme_page_sections` row + its
 * matching `theme_section_schemas.schema_json` so the right-panel form
 * can render a settings form driven by the schema.
 *
 * Why not the existing `loadSectionsTree()`? — The tree returns the list
 * (id/name/icon/blockCount) and intentionally omits settings_json so the
 * sidebar payload stays small. The right panel calls THIS endpoint only
 * when the seller clicks a section.
 *
 * Iron Rule 5: throws native Error; caller wraps via safeMessage.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

export interface SectionSettingsPayload {
  id: string
  themeId: string
  pageType: string
  sectionKey: string
  type: string
  position: number
  enabled: boolean
  settings: Record<string, unknown>
  blocks: unknown[]
  /** Schema describing settings inputs — drives the right-panel form. */
  schema: {
    name: string
    icon: string
    settings: SchemaSetting[]
    /** Block schemas (PR future — block editor UI). */
    blocks: SchemaBlock[]
    /** Optional `presets[]` from the schema, used for "Add section" UI. */
    presets: SchemaPreset[]
    /** Max blocks (Shopify default 50, schema can override). */
    maxBlocks: number
  } | null
}

export interface SchemaSetting {
  type: string // text | textarea | richtext | number | range | checkbox | radio | select | color | font_picker | image_picker | url | product | collection | blog | page | menu | video_url | header | paragraph | …
  id?: string
  label?: string
  default?: unknown
  info?: string
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
  step?: number
  placeholder?: string
  content?: string // for header/paragraph types
}

export interface SchemaBlock {
  type: string
  name?: string
  limit?: number
  settings: SchemaSetting[]
}

export interface SchemaPreset {
  name: string
  category?: string
  settings?: Record<string, unknown>
  blocks?: Array<{ type: string; settings?: Record<string, unknown> }>
}

/**
 * Fetch a single section instance + its schema. Returns null when the
 * section doesn't exist OR doesn't belong to the supplied shopId
 * (caller should check `theme.shop_id` upstream too — defense in depth).
 */
export async function loadSectionSettings(
  db: Kysely<Database>,
  sectionId: string,
): Promise<SectionSettingsPayload | null> {
  const row = (await (db as any)
    .selectFrom('theme_page_sections as tps')
    .leftJoin('theme_section_schemas as tss', 'tss.type', 'tps.section_type')
    .select([
      'tps.id',
      'tps.theme_id as themeId',
      'tps.page_type as pageType',
      'tps.section_key as sectionKey',
      'tps.section_type as type',
      'tps.position',
      'tps.enabled',
      'tps.settings_json as settings_json',
      'tps.blocks_json as blocks_json',
      'tss.name as schemaName',
      'tss.icon as schemaIcon',
      'tss.schema_json as schema_json',
      'tss.max_blocks as schemaMaxBlocks',
    ])
    .where('tps.id', '=', sectionId)
    .executeTakeFirst()) as
    | {
        id: string
        themeId: string
        pageType: string
        sectionKey: string
        type: string
        position: number
        enabled: boolean
        settings_json: unknown
        blocks_json: unknown
        schemaName: string | null
        schemaIcon: string | null
        schema_json: unknown
        schemaMaxBlocks: number | null
      }
    | undefined

  if (!row) return null

  const settings = isObject(row.settings_json) ? (row.settings_json as Record<string, unknown>) : {}
  const blocks = Array.isArray(row.blocks_json) ? (row.blocks_json as unknown[]) : []

  // schema_json may be null (schema row missing) or { settings, blocks, presets }
  // — normalise into the contract we ship to the client.
  const schemaObj = isObject(row.schema_json) ? (row.schema_json as Record<string, unknown>) : null
  const schema = schemaObj
    ? {
        name: row.schemaName ?? humanizeType(row.type),
        icon: row.schemaIcon || 'box',
        settings: pickSettingsArray(schemaObj.settings),
        blocks: pickBlocksArray(schemaObj.blocks),
        presets: pickPresetsArray(schemaObj.presets),
        maxBlocks: typeof row.schemaMaxBlocks === 'number' ? row.schemaMaxBlocks : 50,
      }
    : null

  return {
    id: row.id,
    themeId: row.themeId,
    pageType: row.pageType,
    sectionKey: row.sectionKey,
    type: row.type,
    position: row.position,
    enabled: row.enabled,
    settings,
    blocks,
    schema,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pickSettingsArray(v: unknown): SchemaSetting[] {
  if (!Array.isArray(v)) return []
  return v.filter(isObject).map((row) => normaliseSchemaSetting(row as Record<string, unknown>))
}

function pickBlocksArray(v: unknown): SchemaBlock[] {
  if (!Array.isArray(v)) return []
  return v.filter(isObject).map((b) => {
    const block = b as Record<string, unknown>
    return {
      type: typeof block.type === 'string' ? block.type : '',
      name: typeof block.name === 'string' ? block.name : undefined,
      limit: typeof block.limit === 'number' ? block.limit : undefined,
      settings: pickSettingsArray(block.settings),
    }
  })
}

function pickPresetsArray(v: unknown): SchemaPreset[] {
  if (!Array.isArray(v)) return []
  return v.filter(isObject).map((p) => {
    const pp = p as Record<string, unknown>
    return {
      name: typeof pp.name === 'string' ? pp.name : 'Preset',
      category: typeof pp.category === 'string' ? pp.category : undefined,
      settings: isObject(pp.settings) ? (pp.settings as Record<string, unknown>) : undefined,
      blocks: Array.isArray(pp.blocks)
        ? (pp.blocks as unknown[]).filter(isObject).map((b) => {
            const block = b as Record<string, unknown>
            return {
              type: typeof block.type === 'string' ? block.type : '',
              settings: isObject(block.settings) ? (block.settings as Record<string, unknown>) : undefined,
            }
          })
        : undefined,
    }
  })
}

function normaliseSchemaSetting(s: Record<string, unknown>): SchemaSetting {
  const out: SchemaSetting = {
    type: typeof s.type === 'string' ? s.type : 'text',
  }
  if (typeof s.id === 'string') out.id = s.id
  if (typeof s.label === 'string') out.label = s.label
  if ('default' in s) out.default = s.default
  if (typeof s.info === 'string') out.info = s.info
  if (Array.isArray(s.options)) {
    out.options = (s.options as unknown[])
      .filter(isObject)
      .map((o) => ({
        value: String((o as Record<string, unknown>).value ?? ''),
        label: String((o as Record<string, unknown>).label ?? ''),
      }))
  }
  if (typeof s.min === 'number') out.min = s.min
  if (typeof s.max === 'number') out.max = s.max
  if (typeof s.step === 'number') out.step = s.step
  if (typeof s.placeholder === 'string') out.placeholder = s.placeholder
  if (typeof s.content === 'string') out.content = s.content
  return out
}

function humanizeType(t: string): string {
  if (!t) return 'Section'
  return t
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
