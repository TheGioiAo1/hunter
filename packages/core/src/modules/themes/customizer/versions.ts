/**
 * Theme Versions — capture / list / restore snapshots
 *
 * Sprint 10 of the Theme Editor master plan: closes the loop on
 * publish/draft workflow.
 *
 * A "version" is an append-only snapshot of EVERYTHING that defines a
 * theme's current rendering: every theme_files row, every page_sections
 * row, and the theme_global_settings row. We bundle all three into a
 * single `snapshot_json` payload and write to `theme_versions`.
 *
 * Why one big JSON blob?
 *   • The customer-visible artifact is "what does this draft look like
 *     when published?" — a single moment-in-time. Splitting into 3
 *     snapshot tables would just spawn 3 transactions to read it back.
 *   • Compression by Postgres TOAST gets us 4-10x size reduction for
 *     free; a typical Shopify-style theme weighs in at ~150 KB pre-toast.
 *   • Restore is atomic: one DELETE-INSERT chain inside a single tx,
 *     impossible to leave the theme in a half-restored state.
 *
 * What's intentionally NOT in the snapshot:
 *   • CDN-uploaded asset bytes (s3_key + cdn_url stay current — those
 *     are content-addressed, restoring an old theme just re-points to
 *     the same already-deployed asset URLs).
 *   • Section schemas (theme_section_schemas) — schema authors update
 *     these globally; pinning them to a version would break legitimate
 *     bug fixes. Restore uses the CURRENT schema with the snapshot's
 *     section instance settings.
 *
 * Iron Rule 5: throws native Error; caller wraps via safeMessage.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { synthesizeThemeFileSourceUrl } from '../theme-files-helpers.js'

export interface VersionSnapshot {
  /** ISO 8601 — when this snapshot was captured. */
  capturedAt: string
  /** Schema version of the snapshot payload (bump on breaking changes). */
  schemaVersion: 1
  files: Array<{
    path: string
    kind: string
    content: string
    custom_css?: string | null
  }>
  pageSections: Array<{
    page_type: string
    section_key: string
    section_type: string
    position: number
    settings_json: unknown
    blocks_json: unknown
    custom_css: string | null
    enabled: boolean
  }>
  globalSettings: {
    settings_json: unknown
    schema_json: unknown
  } | null
}

export interface VersionRow {
  id: string
  theme_id: string
  version: number
  status: string
  label: string | null
  created_by: string | null
  published_at: string | null
  created_at: string
}

/**
 * Capture the current state of a theme as a new theme_versions row.
 * Uses a single SELECT-then-INSERT transaction so a concurrent edit
 * during snapshotting still produces a consistent, point-in-time view.
 *
 * Returns the new version row's id and the auto-incremented version
 * number (max(version) + 1 within the theme).
 */
export async function createSnapshot(
  db: Kysely<Database>,
  themeId: string,
  options: {
    status?: 'draft' | 'published' | 'archived'
    label?: string | null
    createdBy?: string | null
  } = {},
): Promise<{ id: string; version: number }> {
  const status = options.status ?? 'draft'
  const label = options.label ?? null
  const createdBy = options.createdBy ?? null

  return await (db as any).transaction().execute(async (trx: any) => {
    // Pull every relevant row in parallel — they're all keyed by theme_id.
    const [files, sections, globalSettings, lastVersion] = await Promise.all([
      trx
        .selectFrom('theme_files')
        .select(['path', 'kind', 'content', 'custom_css'])
        .where('theme_id', '=', themeId)
        .execute(),
      trx
        .selectFrom('theme_page_sections')
        .select(['page_type', 'section_key', 'section_type', 'position', 'settings_json', 'blocks_json', 'custom_css', 'enabled'])
        .where('theme_id', '=', themeId)
        .orderBy('page_type', 'asc')
        .orderBy('position', 'asc')
        .execute(),
      trx
        .selectFrom('theme_global_settings')
        .select(['settings_json', 'schema_json'])
        .where('theme_id', '=', themeId)
        .executeTakeFirst(),
      trx
        .selectFrom('theme_versions')
        .select((eb: any) => eb.fn.max('version').as('max_version'))
        .where('theme_id', '=', themeId)
        .executeTakeFirst(),
    ])

    const version = ((lastVersion as { max_version: number | null } | undefined)?.max_version ?? 0) + 1
    const snapshot: VersionSnapshot = {
      capturedAt: new Date().toISOString(),
      schemaVersion: 1,
      files: files as VersionSnapshot['files'],
      pageSections: sections as VersionSnapshot['pageSections'],
      globalSettings: globalSettings ?? null,
    }

    const inserted = (await trx
      .insertInto('theme_versions')
      .values({
        theme_id: themeId,
        version,
        status,
        snapshot_json: snapshot,
        label,
        created_by: createdBy,
        published_at: status === 'published' ? new Date().toISOString() : null,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow()) as { id: string }

    return { id: inserted.id, version }
  })
}

/**
 * List versions for a theme, newest first. Pagination is intentionally
 * simple (limit-only) — themes rarely accumulate more than a few dozen
 * snapshots and the customizer dropdown only needs the latest 20-30.
 */
export async function listVersions(
  db: Kysely<Database>,
  themeId: string,
  limit: number = 30,
): Promise<VersionRow[]> {
  const rows = (await (db as any)
    .selectFrom('theme_versions')
    .select([
      'id',
      'theme_id',
      'version',
      'status',
      'label',
      'created_by',
      'published_at',
      'created_at',
    ])
    .where('theme_id', '=', themeId)
    .orderBy('version', 'desc')
    .limit(Math.max(1, Math.min(100, Math.floor(limit))))
    .execute()) as VersionRow[]
  return rows
}

/**
 * Restore a theme to a captured version. Wipes the theme's current
 * theme_files / theme_page_sections / theme_global_settings rows and
 * re-inserts from the snapshot, all inside a single transaction.
 *
 * The current state is NOT auto-snapshotted before the restore — that's
 * the caller's choice (the customizer's "Restore" button does this two
 * ways: with a confirm dialog that explicitly warns the seller, or by
 * calling createSnapshot beforehand and chaining).
 */
export async function restoreVersion(
  db: Kysely<Database>,
  themeId: string,
  versionId: string,
): Promise<{ restored: number }> {
  return await (db as any).transaction().execute(async (trx: any) => {
    const versionRow = (await trx
      .selectFrom('theme_versions')
      .select(['theme_id', 'snapshot_json'])
      .where('id', '=', versionId)
      .executeTakeFirst()) as { theme_id: string; snapshot_json: unknown } | undefined

    if (!versionRow) throw new Error('Version not found.')
    if (versionRow.theme_id !== themeId) {
      throw new Error('Version does not belong to this theme.')
    }

    const snapshot = versionRow.snapshot_json as VersionSnapshot | null
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.pageSections)) {
      throw new Error('Version snapshot is corrupt.')
    }

    // Pull the theme's shop_id once — needed for the theme_files INSERT
    // (table is shop-scoped to allow the shared-asset deduplication path).
    const themeRow = (await trx
      .selectFrom('themes')
      .select(['shop_id'])
      .where('id', '=', themeId)
      .executeTakeFirst()) as { shop_id: string } | undefined
    if (!themeRow) throw new Error('Theme not found.')

    // Wipe current state.
    await trx.deleteFrom('theme_files').where('theme_id', '=', themeId).execute()
    await trx.deleteFrom('theme_page_sections').where('theme_id', '=', themeId).execute()
    await trx.deleteFrom('theme_global_settings').where('theme_id', '=', themeId).execute()

    // Reinsert files. Empty s3_key/cdn_url values are fine — the engine's
    // db-loader serves bytes directly from `content`. source_url is
    // synthesized per (themeId, path) to satisfy the
    // idx_theme_files_shop_source_url UNIQUE constraint; see
    // theme-files-helpers.ts module header for background.
    let restoredFiles = 0
    for (const f of snapshot.files) {
      await trx
        .insertInto('theme_files')
        .values({
          shop_id: themeRow.shop_id,
          theme_id: themeId,
          kind: f.kind,
          path: f.path,
          content: f.content,
          custom_css: (f as any).custom_css ?? null,
          source: 'manual',
          source_url: synthesizeThemeFileSourceUrl(themeId, f.path),
          s3_key: '',
          cdn_url: '',
          byte_size: Buffer.byteLength(f.content || '', 'utf8'),
        })
        .execute()
      restoredFiles += 1
    }

    // Reinsert page sections.
    let restoredSections = 0
    for (const s of snapshot.pageSections) {
      await trx
        .insertInto('theme_page_sections')
        .values({
          theme_id: themeId,
          page_type: s.page_type,
          section_key: s.section_key,
          section_type: s.section_type,
          position: s.position,
          settings_json: s.settings_json,
          blocks_json: s.blocks_json,
          custom_css: s.custom_css,
          enabled: s.enabled,
        })
        .execute()
      restoredSections += 1
    }

    // Reinsert global settings.
    if (snapshot.globalSettings) {
      await trx
        .insertInto('theme_global_settings')
        .values({
          theme_id: themeId,
          settings_json: snapshot.globalSettings.settings_json,
          schema_json: snapshot.globalSettings.schema_json,
        })
        .execute()
    }

    return { restored: restoredFiles + restoredSections }
  })
}
