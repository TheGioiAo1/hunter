/**
 * Theme Customizer — Sections Tree
 *
 * Reads theme_page_sections + joins theme_section_schemas to produce
 * an ordered tree of sections for a given template, ready for the
 * customizer sidebar UI to render.
 *
 * PR1 (read-only): consumed by GET /customize/sections.json.
 * PR3 (mutations): same shape; reorder/add/remove will write back.
 *
 * Iron Rule 5: throws native Error; caller wraps via safeMessage.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

export interface SectionTreeNode {
  /** theme_page_sections.id */
  id: string
  /** theme_page_sections.section_key — e.g. 'hero', 'featured-products' */
  key: string
  /** theme_page_sections.section_type — used to look up schema */
  type: string
  /** Display name from schema, or humanized type if no schema row */
  name: string
  /** Icon identifier from schema, defaults to 'box' */
  icon: string
  /** 0-based ordinal */
  position: number
  /** Hidden sections still appear in the tree but visually muted */
  enabled: boolean
  /** True when blocks_json is a non-empty array */
  hasBlocks: boolean
  /** Length of blocks_json array (0 when none) */
  blockCount: number
}

/**
 * Load all section instances for a (themeId, templateName) pair, ordered
 * by `position ASC`. Joins schema for display metadata; falls back when
 * the schema row is missing (legacy themes / unknown section types).
 */
export async function loadSectionsTree(
  db: Kysely<Database>,
  themeId: string,
  templateName: string = 'index',
): Promise<SectionTreeNode[]> {
  const rows = (await (db as any)
    .selectFrom('theme_page_sections as tps')
    .leftJoin('theme_section_schemas as tss', 'tss.type', 'tps.section_type')
    .select([
      'tps.id',
      'tps.section_key as key',
      'tps.section_type as type',
      'tps.position',
      'tps.enabled',
      'tps.blocks_json',
      'tss.name as schemaName',
      'tss.icon as schemaIcon',
    ])
    .where('tps.theme_id', '=', themeId)
    .where('tps.page_type', '=', templateName)
    .orderBy('tps.position', 'asc')
    .execute()) as Array<{
    id: string
    key: string
    type: string
    position: number
    enabled: boolean
    blocks_json: unknown
    schemaName: string | null
    schemaIcon: string | null
  }>

  return rows.map((r) => {
    const blocks = Array.isArray(r.blocks_json) ? r.blocks_json : []
    return {
      id: r.id,
      key: r.key,
      type: r.type,
      name: r.schemaName ?? humanizeType(r.type),
      icon: r.schemaIcon || 'box',
      position: r.position,
      enabled: r.enabled,
      hasBlocks: blocks.length > 0,
      blockCount: blocks.length,
    }
  })
}

/**
 * 'featured-products' → 'Featured Products', 'hero_banner' → 'Hero Banner'.
 * Internal helper for the schema-fallback path.
 */
export function humanizeType(t: string): string {
  if (!t) return 'Section'
  return t
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
