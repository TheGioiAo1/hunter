/**
 * Theme Customizer — Section Mutations
 *
 * Write-side helpers for the right-panel + section-tree:
 *
 *   updateSectionSettings(db, sectionId, patch)  — merges into settings_json
 *   addSection(db, themeId, template, type, presetIndex?, insertAfterId?)
 *   removeSection(db, sectionId)
 *   reorderSections(db, themeId, template, orderedIds)
 *   toggleSectionVisibility(db, sectionId, enabled)
 *
 * Each mutation runs as a single SQL statement OR a tiny transaction.
 * No history/undo at this layer — the customizer client keeps a local
 * undo stack and replays mutations on undo (PR future).
 *
 * Iron Rule 5: throws native Error; caller wraps via safeMessage.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

export interface AddSectionInput {
  themeId: string
  pageType: string
  type: string
  /** Optional preset index — pulls preset.settings + preset.blocks from schema. */
  presetIndex?: number
  /** Insert after this section id; null/undefined → append. */
  insertAfterId?: string | null
  /** Optional client-supplied key. Falls back to `<type>-<n>` when omitted. */
  sectionKey?: string
  /** Optional initial settings (overrides preset). */
  settings?: Record<string, unknown>
  /** Optional initial blocks (overrides preset). */
  blocks?: unknown[]
}

export interface AddSectionResult {
  id: string
  sectionKey: string
  position: number
}

/**
 * Merge a partial settings patch into `settings_json`. We do this in JS
 * (read → merge → write) because Kysely's JSON merge support varies by
 * dialect and the row payload is tiny. Returns the new settings object.
 */
export async function updateSectionSettings(
  db: Kysely<Database>,
  sectionId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isObject(patch)) {
    throw new Error('Section settings patch must be an object.')
  }

  const row = (await (db as any)
    .selectFrom('theme_page_sections')
    .select(['settings_json'])
    .where('id', '=', sectionId)
    .executeTakeFirst()) as { settings_json: unknown } | undefined

  if (!row) throw new Error('Section not found.')

  const current = isObject(row.settings_json) ? (row.settings_json as Record<string, unknown>) : {}
  const merged: Record<string, unknown> = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) {
      delete merged[k]
    } else {
      merged[k] = v
    }
  }

  await (db as any)
    .updateTable('theme_page_sections')
    .set({ settings_json: merged, updated_at: new Date() })
    .where('id', '=', sectionId)
    .execute()

  return merged
}

/**
 * Replace a section's blocks_json wholesale. Used by the block editor
 * for add/remove/reorder operations within a section. Caller is
 * responsible for validating block shape.
 */
export async function updateSectionBlocks(
  db: Kysely<Database>,
  sectionId: string,
  blocks: unknown[],
): Promise<void> {
  if (!Array.isArray(blocks)) {
    throw new Error('Blocks payload must be an array.')
  }

  await (db as any)
    .updateTable('theme_page_sections')
    .set({ blocks_json: blocks, updated_at: new Date() })
    .where('id', '=', sectionId)
    .execute()
}

/**
 * Toggle a section's `enabled` flag. UI calls this for the "Hide" /
 * "Show" eyeball action. We don't delete — sellers expect to undo.
 */
export async function toggleSectionVisibility(
  db: Kysely<Database>,
  sectionId: string,
  enabled: boolean,
): Promise<void> {
  await (db as any)
    .updateTable('theme_page_sections')
    .set({ enabled, updated_at: new Date() })
    .where('id', '=', sectionId)
    .execute()
}

/**
 * Append (or insert-after) a new section to a template. Computes a
 * unique `section_key` by suffixing `-2`, `-3`… until free. Position is
 * `current_max_position + 1` for append; for insert-after we shift later
 * sections by `+1` in a single UPDATE.
 *
 * presetIndex (when provided) reads `theme_section_schemas.schema_json.presets[i]`
 * and pre-seeds `settings_json` + `blocks_json` from it.
 */
export async function addSection(
  db: Kysely<Database>,
  input: AddSectionInput,
): Promise<AddSectionResult> {
  // Pull schema row to (a) verify the type exists and (b) source preset
  // defaults if requested. We allow unknown types — themes can add custom
  // sections without registering a schema first; the customizer will show
  // an empty form until the schema is added.
  const schemaRow = (await (db as any)
    .selectFrom('theme_section_schemas')
    .select(['schema_json'])
    .where('type', '=', input.type)
    .executeTakeFirst()) as { schema_json: unknown } | undefined

  let presetSettings: Record<string, unknown> | undefined
  let presetBlocks: unknown[] | undefined

  if (schemaRow && typeof input.presetIndex === 'number') {
    const schemaJson = isObject(schemaRow.schema_json) ? (schemaRow.schema_json as Record<string, unknown>) : null
    const presets = schemaJson && Array.isArray(schemaJson.presets) ? (schemaJson.presets as unknown[]) : []
    const preset = presets[input.presetIndex]
    if (isObject(preset)) {
      const p = preset as Record<string, unknown>
      if (isObject(p.settings)) presetSettings = p.settings as Record<string, unknown>
      if (Array.isArray(p.blocks)) presetBlocks = p.blocks as unknown[]
    }
  }

  // Compute final settings + blocks: client overrides preset, preset
  // overrides nothing (we don't synthesise from `setting.default` here —
  // sellers expect "Add section" without preset to drop in clean).
  const finalSettings: Record<string, unknown> = {
    ...(presetSettings ?? {}),
    ...(input.settings ?? {}),
  }
  const finalBlocks: unknown[] = input.blocks ?? presetBlocks ?? []

  // section_key — append a numeric suffix until unique within the (theme, page, key) tuple.
  const existingKeys = (await (db as any)
    .selectFrom('theme_page_sections')
    .select(['section_key'])
    .where('theme_id', '=', input.themeId)
    .where('page_type', '=', input.pageType)
    .execute()) as Array<{ section_key: string }>

  const used = new Set(existingKeys.map((r) => r.section_key))
  const baseKey = input.sectionKey?.trim() || input.type
  let key = baseKey
  let n = 2
  while (used.has(key)) {
    key = `${baseKey}-${n}`
    n += 1
  }

  // Position: insert-after if requested (and the anchor exists), else append.
  let position: number
  if (input.insertAfterId) {
    const anchor = (await (db as any)
      .selectFrom('theme_page_sections')
      .select(['position'])
      .where('id', '=', input.insertAfterId)
      .where('theme_id', '=', input.themeId)
      .where('page_type', '=', input.pageType)
      .executeTakeFirst()) as { position: number } | undefined

    if (anchor) {
      position = anchor.position + 1
      // Bump every later section by +1 to make room.
      await (db as any)
        .updateTable('theme_page_sections')
        .set((eb: any) => ({ position: eb('position', '+', 1) }))
        .where('theme_id', '=', input.themeId)
        .where('page_type', '=', input.pageType)
        .where('position', '>=', position)
        .execute()
    } else {
      // Anchor missing — fall back to append.
      position = (await nextPosition(db, input.themeId, input.pageType)) + 1
    }
  } else {
    position = (await nextPosition(db, input.themeId, input.pageType)) + 1
  }

  const inserted = (await (db as any)
    .insertInto('theme_page_sections')
    .values({
      theme_id: input.themeId,
      page_type: input.pageType,
      section_key: key,
      section_type: input.type,
      position,
      settings_json: finalSettings,
      blocks_json: finalBlocks,
      enabled: true,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()) as { id: string }

  return { id: inserted.id, sectionKey: key, position }
}

/**
 * Hard-delete a section row. We don't soft-delete — sellers expect a
 * removed section to be gone, and the customizer's local undo stack
 * will replay an `addSection` to restore it (with the same payload).
 */
export async function removeSection(
  db: Kysely<Database>,
  sectionId: string,
): Promise<void> {
  await (db as any)
    .deleteFrom('theme_page_sections')
    .where('id', '=', sectionId)
    .execute()
}

/**
 * Replace the position ordering for a (themeId, pageType) tuple. Pass
 * the desired final order as an array of ids — every id in the list
 * gets its position rewritten to its array index. Ids not in the list
 * are pushed to the end in arbitrary order (defensive — should not
 * happen in practice).
 *
 * We do this in a single transaction so the section tree never observes
 * a partial state.
 */
export async function reorderSections(
  db: Kysely<Database>,
  themeId: string,
  pageType: string,
  orderedIds: string[],
): Promise<void> {
  if (!Array.isArray(orderedIds)) {
    throw new Error('Reorder payload must be an array.')
  }
  if (orderedIds.length === 0) return

  await (db as any).transaction().execute(async (trx: any) => {
    // Pull every existing id so we can append leftovers.
    const rows = (await trx
      .selectFrom('theme_page_sections')
      .select(['id'])
      .where('theme_id', '=', themeId)
      .where('page_type', '=', pageType)
      .execute()) as Array<{ id: string }>

    const known = new Set(rows.map((r) => r.id))
    const cleaned: string[] = orderedIds.filter((id) => known.has(id))
    for (const r of rows) {
      if (!cleaned.includes(r.id)) cleaned.push(r.id)
    }

    let i = 0
    for (const id of cleaned) {
      await trx
        .updateTable('theme_page_sections')
        .set({ position: i, updated_at: new Date() })
        .where('id', '=', id)
        .execute()
      i += 1
    }
  })
}

// ─── Internal helpers ────────────────────────────────────────────────────

async function nextPosition(
  db: Kysely<Database>,
  themeId: string,
  pageType: string,
): Promise<number> {
  const max = (await (db as any)
    .selectFrom('theme_page_sections')
    .select((eb: any) => eb.fn.max('position').as('max_pos'))
    .where('theme_id', '=', themeId)
    .where('page_type', '=', pageType)
    .executeTakeFirst()) as { max_pos: number | null } | undefined

  return max?.max_pos ?? -1
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
