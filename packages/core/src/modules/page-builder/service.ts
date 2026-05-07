/**
 * Gbox Platform — Page Builder Service
 *
 * CRUD operations for the page builder, working with:
 *   - theme_section_schemas  (built-in + custom section definitions)
 *   - theme_page_sections    (per-page section instances)
 *   - theme_global_settings  (theme-wide colors, fonts, social)
 *   - theme_versions         (draft / publish snapshot system)
 *   - theme_section_blocks   (block type definitions within sections)
 */

import crypto from 'crypto'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { BUILTIN_SECTIONS, type SectionSchema } from './section-registry.js'

/** Helper: wrap a value as a JSONB-compatible expression for Kysely inserts/updates */
function jsonb(value: unknown): any {
  return JSON.stringify(value) as any
}
import { autoSectionize } from './auto-sectionize.js'

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface SectionSchemaRow {
  id: string
  name: string
  type: string
  description: string | null
  schema_json: any
  default_html: string | null
  category: string
  icon: string
  max_blocks: number
  is_builtin: boolean
}

export interface PageSectionRow {
  id: string
  theme_id: string
  page_type: string
  section_key: string
  section_type: string
  position: number
  settings_json: any
  blocks_json: any
  custom_css: string | null
  enabled: boolean
}

export interface GlobalSettingsRow {
  id: string
  theme_id: string
  settings_json: any
  schema_json: any
}

export interface ThemeVersionRow {
  id: string
  theme_id: string
  version: number
  status: string
  snapshot_json: any
  label: string | null
  created_by: string | null
  published_at: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short hex ID for section keys. */
function shortId(): string {
  return crypto.randomBytes(4).toString('hex')
}

// ---------------------------------------------------------------------------
// Section Schemas
// ---------------------------------------------------------------------------

/**
 * Seed all built-in section schemas into the database.
 *
 * Uses `ON CONFLICT (type) DO UPDATE` so the operation is fully idempotent —
 * safe to call on every server start.
 *
 * @returns The number of sections upserted.
 */
export async function seedBuiltinSections(
  db: Kysely<Database>,
): Promise<number> {
  if (BUILTIN_SECTIONS.length === 0) return 0

  const values = BUILTIN_SECTIONS.map((section) => ({
    name: section.name,
    type: section.type,
    description: section.description,
    schema_json: jsonb({
      settings: section.settings,
      blocks: section.blocks ?? [],
      presets: section.presets ?? [],
    }),
    default_html: null,
    category: section.category,
    icon: section.icon,
    max_blocks: section.maxBlocks ?? 16,
    is_builtin: true,
  }))

  await db
    .insertInto('theme_section_schemas')
    .values(values)
    .onConflict((oc) =>
      oc.column('type').doUpdateSet((eb) => ({
        name: eb.ref('excluded.name'),
        description: eb.ref('excluded.description'),
        schema_json: eb.ref('excluded.schema_json'),
        category: eb.ref('excluded.category'),
        icon: eb.ref('excluded.icon'),
        max_blocks: eb.ref('excluded.max_blocks'),
        is_builtin: eb.ref('excluded.is_builtin'),
      })),
    )
    .execute()

  return BUILTIN_SECTIONS.length
}

/**
 * List all section schemas (built-in + custom).
 */
export async function listSectionSchemas(
  db: Kysely<Database>,
): Promise<SectionSchemaRow[]> {
  const rows = await db
    .selectFrom('theme_section_schemas')
    .select([
      'id',
      'name',
      'type',
      'description',
      'schema_json',
      'default_html',
      'category',
      'icon',
      'max_blocks',
      'is_builtin',
    ])
    .orderBy('category', 'asc')
    .orderBy('name', 'asc')
    .execute()

  return rows as SectionSchemaRow[]
}

/**
 * Get a section schema by its unique type key.
 */
export async function getSectionSchema(
  db: Kysely<Database>,
  type: string,
): Promise<SectionSchemaRow | null> {
  const row = await db
    .selectFrom('theme_section_schemas')
    .select([
      'id',
      'name',
      'type',
      'description',
      'schema_json',
      'default_html',
      'category',
      'icon',
      'max_blocks',
      'is_builtin',
    ])
    .where('type', '=', type)
    .executeTakeFirst()

  return (row as SectionSchemaRow) ?? null
}

// ---------------------------------------------------------------------------
// Page Sections — CRUD
// ---------------------------------------------------------------------------

/**
 * List all sections for a specific page of a theme, ordered by position.
 */
export async function listPageSections(
  db: Kysely<Database>,
  themeId: string,
  pageType: string,
): Promise<PageSectionRow[]> {
  const rows = await db
    .selectFrom('theme_page_sections')
    .select([
      'id',
      'theme_id',
      'page_type',
      'section_key',
      'section_type',
      'position',
      'settings_json',
      'blocks_json',
      'custom_css',
      'enabled',
    ])
    .where('theme_id', '=', themeId)
    .where('page_type', '=', pageType)
    .orderBy('position', 'asc')
    .execute()

  return rows as PageSectionRow[]
}

/**
 * Get a single section by its ID.
 */
export async function getPageSection(
  db: Kysely<Database>,
  sectionId: string,
): Promise<PageSectionRow | null> {
  const row = await db
    .selectFrom('theme_page_sections')
    .select([
      'id',
      'theme_id',
      'page_type',
      'section_key',
      'section_type',
      'position',
      'settings_json',
      'blocks_json',
      'custom_css',
      'enabled',
    ])
    .where('id', '=', sectionId)
    .executeTakeFirst()

  return (row as PageSectionRow) ?? null
}

/**
 * Add a new section to a page.
 *
 * Generates a unique `section_key` like `hero_a1b2c3d4` and serialises
 * settings / blocks to JSONB.
 */
export async function addPageSection(
  db: Kysely<Database>,
  input: {
    themeId: string
    pageType: string
    sectionType: string
    position: number
    settings?: Record<string, any>
    blocks?: Array<{ type: string; settings: Record<string, any> }>
    customCss?: string
  },
): Promise<PageSectionRow> {
  const sectionKey = `${input.sectionType.replace(/-/g, '_')}_${shortId()}`

  const blocks = (input.blocks ?? []).map((b) => ({
    id: crypto.randomUUID(),
    type: b.type,
    settings: b.settings,
  }))

  const row = await db
    .insertInto('theme_page_sections')
    .values({
      theme_id: input.themeId,
      page_type: input.pageType,
      section_key: sectionKey,
      section_type: input.sectionType,
      position: input.position,
      settings_json: jsonb(input.settings ?? {}),
      blocks_json: jsonb(blocks),
      custom_css: input.customCss ?? null,
      enabled: true,
    })
    .returning([
      'id',
      'theme_id',
      'page_type',
      'section_key',
      'section_type',
      'position',
      'settings_json',
      'blocks_json',
      'custom_css',
      'enabled',
    ])
    .executeTakeFirstOrThrow()

  return row as PageSectionRow
}

/**
 * Update the settings JSON of a section.
 */
export async function updateSectionSettings(
  db: Kysely<Database>,
  sectionId: string,
  settings: Record<string, any>,
): Promise<PageSectionRow> {
  const row = await db
    .updateTable('theme_page_sections')
    .set({
      settings_json: jsonb(settings),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', sectionId)
    .returning([
      'id',
      'theme_id',
      'page_type',
      'section_key',
      'section_type',
      'position',
      'settings_json',
      'blocks_json',
      'custom_css',
      'enabled',
    ])
    .executeTakeFirstOrThrow()

  return row as PageSectionRow
}

/**
 * Replace the blocks array of a section.
 *
 * Blocks without an `id` are assigned a new UUID.
 */
export async function updateSectionBlocks(
  db: Kysely<Database>,
  sectionId: string,
  blocks: Array<{ type: string; id?: string; settings: Record<string, any> }>,
): Promise<PageSectionRow> {
  const normalised = blocks.map((b) => ({
    id: b.id ?? crypto.randomUUID(),
    type: b.type,
    settings: b.settings,
  }))

  const row = await db
    .updateTable('theme_page_sections')
    .set({
      blocks_json: jsonb(normalised),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', sectionId)
    .returning([
      'id',
      'theme_id',
      'page_type',
      'section_key',
      'section_type',
      'position',
      'settings_json',
      'blocks_json',
      'custom_css',
      'enabled',
    ])
    .executeTakeFirstOrThrow()

  return row as PageSectionRow
}

/**
 * Update the custom CSS of a section.
 */
export async function updateSectionCss(
  db: Kysely<Database>,
  sectionId: string,
  css: string,
): Promise<PageSectionRow> {
  const row = await db
    .updateTable('theme_page_sections')
    .set({
      custom_css: css,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', sectionId)
    .returning([
      'id',
      'theme_id',
      'page_type',
      'section_key',
      'section_type',
      'position',
      'settings_json',
      'blocks_json',
      'custom_css',
      'enabled',
    ])
    .executeTakeFirstOrThrow()

  return row as PageSectionRow
}

/**
 * Toggle a section's enabled/disabled state.
 */
export async function toggleSection(
  db: Kysely<Database>,
  sectionId: string,
  enabled: boolean,
): Promise<PageSectionRow> {
  const row = await db
    .updateTable('theme_page_sections')
    .set({
      enabled,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', sectionId)
    .returning([
      'id',
      'theme_id',
      'page_type',
      'section_key',
      'section_type',
      'position',
      'settings_json',
      'blocks_json',
      'custom_css',
      'enabled',
    ])
    .executeTakeFirstOrThrow()

  return row as PageSectionRow
}

/**
 * Delete a section by ID.
 */
export async function deletePageSection(
  db: Kysely<Database>,
  sectionId: string,
): Promise<void> {
  await db
    .deleteFrom('theme_page_sections')
    .where('id', '=', sectionId)
    .execute()
}

/**
 * Reorder all sections on a page.
 *
 * The `orderedIds` array defines the new position order (index = position).
 * Runs inside a transaction so either all positions update or none do.
 */
export async function reorderSections(
  db: Kysely<Database>,
  themeId: string,
  pageType: string,
  orderedIds: string[],
): Promise<void> {
  // Validate that orderedIds contains ALL existing sections for this page
  const existing = await db
    .selectFrom('theme_page_sections')
    .select('id')
    .where('theme_id', '=', themeId)
    .where('page_type', '=', pageType)
    .execute()

  const existingIds = new Set(existing.map((r) => r.id))
  const providedIds = new Set(orderedIds)

  for (const id of existingIds) {
    if (!providedIds.has(id)) {
      throw new Error(`orderedIds is missing section ${id}`)
    }
  }
  for (const id of providedIds) {
    if (!existingIds.has(id)) {
      throw new Error(`orderedIds contains unknown section ${id}`)
    }
  }

  await db.transaction().execute(async (trx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await trx
        .updateTable('theme_page_sections')
        .set({ position: i, updated_at: new Date().toISOString() })
        .where('id', '=', orderedIds[i])
        .where('theme_id', '=', themeId)
        .where('page_type', '=', pageType)
        .execute()
    }
  })
}

/**
 * Duplicate a section.
 *
 * Creates a copy with a new ID and key, placed directly after the original
 * (position + 1). Does not shift other sections.
 */
export async function duplicateSection(
  db: Kysely<Database>,
  sectionId: string,
): Promise<PageSectionRow> {
  const original = await getPageSection(db, sectionId)
  if (!original) {
    throw new Error(`Section not found: ${sectionId}`)
  }

  const newKey = `${original.section_type.replace(/-/g, '_')}_${shortId()}`
  const newPosition = original.position + 1

  return await db.transaction().execute(async (trx) => {
    // Shift all sections at position >= newPosition up by 1
    await trx
      .updateTable('theme_page_sections')
      .set({ position: sql`position + 1`, updated_at: new Date().toISOString() })
      .where('theme_id', '=', original.theme_id)
      .where('page_type', '=', original.page_type)
      .where('position', '>=', newPosition)
      .execute()

    const row = await trx
      .insertInto('theme_page_sections')
      .values({
        theme_id: original.theme_id,
        page_type: original.page_type,
        section_key: newKey,
        section_type: original.section_type,
        position: newPosition,
        settings_json: jsonb(original.settings_json),
        blocks_json: jsonb(original.blocks_json),
        custom_css: original.custom_css,
        enabled: original.enabled,
      })
      .returning([
        'id',
        'theme_id',
        'page_type',
        'section_key',
        'section_type',
        'position',
        'settings_json',
        'blocks_json',
        'custom_css',
        'enabled',
      ])
      .executeTakeFirstOrThrow()

    return row as PageSectionRow
  })
}

// ---------------------------------------------------------------------------
// Global Settings
// ---------------------------------------------------------------------------

/**
 * Get the global settings row for a theme.
 */
export async function getGlobalSettings(
  db: Kysely<Database>,
  themeId: string,
): Promise<GlobalSettingsRow | null> {
  const row = await db
    .selectFrom('theme_global_settings')
    .select(['id', 'theme_id', 'settings_json', 'schema_json'])
    .where('theme_id', '=', themeId)
    .executeTakeFirst()

  return (row as GlobalSettingsRow) ?? null
}

/**
 * Update global settings for a theme.
 *
 * Creates the row if it doesn't exist (upsert on `theme_id`).
 */
export async function updateGlobalSettings(
  db: Kysely<Database>,
  themeId: string,
  settings: Record<string, any>,
): Promise<GlobalSettingsRow> {
  const row = await db
    .insertInto('theme_global_settings')
    .values({
      theme_id: themeId,
      settings_json: jsonb(settings),
    })
    .onConflict((oc) =>
      oc.column('theme_id').doUpdateSet({
        settings_json: jsonb(settings),
        updated_at: new Date().toISOString(),
      }),
    )
    .returning(['id', 'theme_id', 'settings_json', 'schema_json'])
    .executeTakeFirstOrThrow()

  return row as GlobalSettingsRow
}

/**
 * Initialise global settings with a default schema.
 *
 * Called when a theme is first customised. Creates the row with empty
 * settings and a base schema covering colours, typography, and social links.
 */
export async function initGlobalSettings(
  db: Kysely<Database>,
  themeId: string,
): Promise<GlobalSettingsRow> {
  const defaultSchema = [
    {
      name: 'Colors',
      settings: [
        { id: 'color_primary', type: 'color', label: 'Primary color', default: '#000000' },
        { id: 'color_secondary', type: 'color', label: 'Secondary color', default: '#ffffff' },
        { id: 'color_accent', type: 'color', label: 'Accent color', default: '#3b82f6' },
        { id: 'color_background', type: 'color', label: 'Background', default: '#ffffff' },
        { id: 'color_text', type: 'color', label: 'Text color', default: '#1f2937' },
      ],
    },
    {
      name: 'Typography',
      settings: [
        { id: 'font_heading', type: 'font', label: 'Heading font', default: 'Inter' },
        { id: 'font_body', type: 'font', label: 'Body font', default: 'Inter' },
        { id: 'font_scale', type: 'range', label: 'Font size scale', default: 100, min: 75, max: 150, step: 5, unit: '%' },
      ],
    },
    {
      name: 'Social links',
      settings: [
        { id: 'social_facebook', type: 'url', label: 'Facebook' },
        { id: 'social_instagram', type: 'url', label: 'Instagram' },
        { id: 'social_twitter', type: 'url', label: 'Twitter / X' },
        { id: 'social_youtube', type: 'url', label: 'YouTube' },
        { id: 'social_tiktok', type: 'url', label: 'TikTok' },
      ],
    },
  ]

  // Insert only if the row doesn't exist yet (ON CONFLICT DO NOTHING).
  // Then always SELECT to return the row — doNothing() + returning()
  // returns nothing when the row already exists, which would crash
  // executeTakeFirstOrThrow().
  await db
    .insertInto('theme_global_settings')
    .values({
      theme_id: themeId,
      settings_json: jsonb({}),
      schema_json: jsonb(defaultSchema),
    })
    .onConflict((oc) => oc.column('theme_id').doNothing())
    .execute()

  const row = await db
    .selectFrom('theme_global_settings')
    .select(['id', 'theme_id', 'settings_json', 'schema_json'])
    .where('theme_id', '=', themeId)
    .executeTakeFirstOrThrow()

  return row as GlobalSettingsRow
}

// ---------------------------------------------------------------------------
// Theme Versions (Draft / Publish)
// ---------------------------------------------------------------------------

/**
 * Create a snapshot of the current page builder state as a new version.
 *
 * Captures all page sections and global settings for the theme.
 */
export async function createVersion(
  db: Kysely<Database>,
  themeId: string,
  options?: { label?: string; createdBy?: string },
): Promise<ThemeVersionRow> {
  return await db.transaction().execute(async (trx) => {
    // Determine next version number
    const latest = await trx
      .selectFrom('theme_versions')
      .select('version')
      .where('theme_id', '=', themeId)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst()

    const nextVersion = (latest?.version ?? 0) + 1

    // Snapshot all page sections
    const sections = await trx
      .selectFrom('theme_page_sections')
      .selectAll()
      .where('theme_id', '=', themeId)
      .execute()

    // Snapshot global settings
    const globalSettings = await trx
      .selectFrom('theme_global_settings')
      .selectAll()
      .where('theme_id', '=', themeId)
      .executeTakeFirst()

    const snapshot = {
      sections,
      globalSettings: globalSettings ?? null,
    }

    const row = await trx
      .insertInto('theme_versions')
      .values({
        theme_id: themeId,
        version: nextVersion,
        status: 'draft',
        snapshot_json: jsonb(snapshot),
        label: options?.label ?? null,
        created_by: options?.createdBy ?? null,
      })
      .returning([
        'id',
        'theme_id',
        'version',
        'status',
        'snapshot_json',
        'label',
        'created_by',
        'published_at',
        'created_at',
      ])
      .executeTakeFirstOrThrow()

    return row as ThemeVersionRow
  })
}

/**
 * Publish a version.
 *
 * Sets the version status to `published` and archives any previously
 * published version for the same theme.
 */
export async function publishVersion(
  db: Kysely<Database>,
  versionId: string,
): Promise<ThemeVersionRow> {
  return await db.transaction().execute(async (trx) => {
    // Look up the version to find its theme_id
    const version = await trx
      .selectFrom('theme_versions')
      .select(['id', 'theme_id'])
      .where('id', '=', versionId)
      .executeTakeFirstOrThrow()

    // Archive any currently published version for this theme
    await trx
      .updateTable('theme_versions')
      .set({ status: 'archived' })
      .where('theme_id', '=', version.theme_id)
      .where('status', '=', 'published')
      .execute()

    // Publish the target version
    const row = await trx
      .updateTable('theme_versions')
      .set({
        status: 'published',
        published_at: new Date().toISOString(),
      })
      .where('id', '=', versionId)
      .returning([
        'id',
        'theme_id',
        'version',
        'status',
        'snapshot_json',
        'label',
        'created_by',
        'published_at',
        'created_at',
      ])
      .executeTakeFirstOrThrow()

    return row as ThemeVersionRow
  })
}

/**
 * List all versions for a theme, newest first.
 */
export async function listVersions(
  db: Kysely<Database>,
  themeId: string,
): Promise<ThemeVersionRow[]> {
  const rows = await db
    .selectFrom('theme_versions')
    .select([
      'id',
      'theme_id',
      'version',
      'status',
      'snapshot_json',
      'label',
      'created_by',
      'published_at',
      'created_at',
    ])
    .where('theme_id', '=', themeId)
    .orderBy('version', 'desc')
    .execute()

  return rows as ThemeVersionRow[]
}

/**
 * Restore a version — load its snapshot back into the live sections.
 *
 * Deletes all current page sections and global settings for the theme,
 * then re-inserts from the snapshot. Runs in a transaction.
 */
export async function restoreVersion(
  db: Kysely<Database>,
  versionId: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const version = await trx
      .selectFrom('theme_versions')
      .select(['theme_id', 'snapshot_json'])
      .where('id', '=', versionId)
      .executeTakeFirstOrThrow()

    const snapshot =
      typeof version.snapshot_json === 'string'
        ? JSON.parse(version.snapshot_json)
        : version.snapshot_json

    const themeId = version.theme_id

    // Clear current live data
    await trx
      .deleteFrom('theme_page_sections')
      .where('theme_id', '=', themeId)
      .execute()

    await trx
      .deleteFrom('theme_global_settings')
      .where('theme_id', '=', themeId)
      .execute()

    // Re-insert sections from snapshot
    if (snapshot.sections && snapshot.sections.length > 0) {
      for (const s of snapshot.sections) {
        await trx
          .insertInto('theme_page_sections')
          .values({
            theme_id: themeId,
            page_type: s.page_type,
            section_key: s.section_key,
            section_type: s.section_type,
            position: s.position,
            settings_json: jsonb(s.settings_json),
            blocks_json: jsonb(s.blocks_json),
            custom_css: s.custom_css ?? null,
            enabled: s.enabled ?? true,
          })
          .execute()
      }
    }

    // Re-insert global settings from snapshot
    if (snapshot.globalSettings) {
      const gs = snapshot.globalSettings
      await trx
        .insertInto('theme_global_settings')
        .values({
          theme_id: themeId,
          settings_json: jsonb(gs.settings_json),
          schema_json: jsonb(gs.schema_json),
        })
        .execute()
    }
  })
}

// ---------------------------------------------------------------------------
// Auto-Sectionize Integration
// ---------------------------------------------------------------------------

/**
 * Take raw HTML template, auto-detect sections, and save them to the database.
 *
 * Uses the auto-sectionize engine to parse the HTML into logical sections,
 * then persists each one as a `theme_page_sections` row.
 *
 * @returns The newly created page section rows.
 */
export async function sectionizeAndSave(
  db: Kysely<Database>,
  themeId: string,
  pageType: string,
  html: string,
  sourceUrl?: string,
): Promise<PageSectionRow[]> {
  const result = autoSectionize(html, { sourceUrl })

  const rows: PageSectionRow[] = await db.transaction().execute(async (trx) => {
    const inserted: PageSectionRow[] = []

    for (const section of result.sections) {
      const sectionKey = `${section.sectionType.replace(/-/g, '_')}_${crypto.randomBytes(4).toString('hex')}`

      const blocks = (section.blocks ?? []).map((b) => ({
        id: crypto.randomUUID(),
        type: b.type,
        settings: b.settings,
      }))

      const row = await trx
        .insertInto('theme_page_sections')
        .values({
          theme_id: themeId,
          page_type: pageType,
          section_key: sectionKey,
          section_type: section.sectionType,
          position: section.position,
          settings_json: jsonb(section.settings ?? {}),
          blocks_json: jsonb(blocks),
          custom_css: null,
          enabled: true,
        })
        .returning([
          'id',
          'theme_id',
          'page_type',
          'section_key',
          'section_type',
          'position',
          'settings_json',
          'blocks_json',
          'custom_css',
          'enabled',
        ])
        .executeTakeFirstOrThrow()

      inserted.push(row as PageSectionRow)
    }

    return inserted
  })

  return rows
}
