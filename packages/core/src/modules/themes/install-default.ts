/**
 * install-default.ts — install the bundled default theme into a shop.
 *
 * Used in two places:
 *   1. `provisionShop()` calls this once on first signup so a brand-new
 *      seller has a theme to edit (Phase ?? — wired in Sprint 8 PR-D).
 *   2. The `Online Store > Theme library` page exposes a "Use this
 *      theme" button that calls this on demand if the seller wants to
 *      reset to the default OR if their existing main theme broke.
 *
 * Idempotency:
 *   - If the shop already has a theme named `Gbox Default`, return its
 *     id without creating a duplicate. The seller's edits to that
 *     theme are preserved (we only create the theme on first call).
 *   - If `force=true`, install creates a fresh theme regardless. Used
 *     by the Theme library page when the seller picks "Reset to default".
 *
 * Iron Rule 5: every error that surfaces to the seller-facing flow
 * routes through `safeMessage()`; raw DB errors stay in server logs.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import {
  DEFAULT_THEME_FILES,
  DEFAULT_THEME_NAME,
  type DefaultThemeFile,
} from './default-theme-data.js'
import { synthesizeThemeFileSourceUrl } from './theme-files-helpers.js'

export interface InstallDefaultThemeInput {
  shopId: string
  /**
   * 'main'        — make this the active theme + demote any other main
   *                 to unpublished
   * 'unpublished' — install but keep the existing main untouched
   * 'auto'        — Shopify-style: become 'main' if the shop has no
   *                 main theme, else 'unpublished'. This is the right
   *                 default for the "Use Gbox Default" CTA — sellers
   *                 with empty stores expect their first install to
   *                 go live; sellers with an existing theme expect a
   *                 draft they can preview before promoting.
   * default: 'auto'
   */
  role?: 'main' | 'unpublished' | 'auto'
  /**
   * If true, always create a fresh theme even if `Gbox Default`
   * already exists. The new theme gets a name suffix
   * (`Gbox Default · 2`, `· 3`, …) so ids stay unique.
   */
  force?: boolean
}

export interface InstallDefaultThemeResult {
  themeId: string
  /** True if we just created the theme; false if we returned an existing one. */
  created: boolean
  filesWritten: number
  /** Number of theme_page_sections rows materialized from templates/*.json. */
  sectionsCreated: number
  /** Final role applied — 'main' if the shop was empty, else whatever the caller asked for. */
  role: 'main' | 'unpublished'
}

export async function installDefaultTheme(
  db: Kysely<Database>,
  input: InstallDefaultThemeInput,
): Promise<InstallDefaultThemeResult> {
  const requestedRole = input.role ?? 'auto'
  const force = input.force ?? false

  // Resolve 'auto' to either 'main' or 'unpublished' by checking the
  // shop's existing theme inventory. Shopify-style: empty shop → first
  // install becomes the live theme; populated shop → install stays as
  // a draft so the seller can preview before promoting.
  let role: 'main' | 'unpublished'
  if (requestedRole === 'auto') {
    const existingMain = await (db as any)
      .selectFrom('themes')
      .select(['id'])
      .where('shop_id', '=', input.shopId)
      .where('role', '=', 'main')
      .executeTakeFirst()
    role = existingMain ? 'unpublished' : 'main'
  } else {
    role = requestedRole
  }

  // Idempotency check — find any existing theme with this name.
  if (!force) {
    const existing = await (db as any)
      .selectFrom('themes')
      .select(['id', 'role'])
      .where('shop_id', '=', input.shopId)
      .where('name', '=', DEFAULT_THEME_NAME)
      .executeTakeFirst()
    if (existing) {
      return {
        themeId: existing.id,
        created: false,
        filesWritten: 0,
        sectionsCreated: 0,
        role: existing.role as 'main' | 'unpublished',
      }
    }
  }

  // Disambiguate the name when forcing a fresh copy.
  let themeName = DEFAULT_THEME_NAME
  if (force) {
    const used = await (db as any)
      .selectFrom('themes')
      .select(['name'])
      .where('shop_id', '=', input.shopId)
      .where('name', 'like', `${DEFAULT_THEME_NAME}%`)
      .execute()
    const usedNames = new Set<string>((used as Array<{ name: string }>).map((r) => r.name))
    let n = 2
    while (usedNames.has(themeName)) {
      themeName = `${DEFAULT_THEME_NAME} · ${n}`
      n += 1
    }
  }

  // Wrap the entire write phase in a transaction. 2026-04-27 — without
  // this guard, a failure in persistFile() left an orphan themes row
  // (no files, no sections) on disk. The next call to installDefault
  // Theme then hit the idempotency check, returned the orphan id, and
  // the seller saw a "successful" install that produced an empty
  // theme. The customizer + storefront both need (themes ⨝ theme_files
  // ⨝ theme_page_sections) — partial state was worse than no state.
  //
  // The transaction also makes the demote-main step atomic with the
  // INSERT: if the new theme INSERT fails, we don't leave the
  // previously-main theme demoted to unpublished.
  const result = await (db as any).transaction().execute(async (trx: any) => {
    // Demote existing main if we're installing as main.
    if (role === 'main') {
      await trx
        .updateTable('themes')
        .set({ role: 'unpublished' })
        .where('shop_id', '=', input.shopId)
        .where('role', '=', 'main')
        .execute()
    }

    // Create the theme record.
    const inserted = await trx
      .insertInto('themes')
      .values({
        shop_id: input.shopId,
        name: themeName,
        role,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow()
    const themeId = (inserted as { id: string }).id

    // Persist every bundled file.
    let filesWritten = 0
    for (const file of DEFAULT_THEME_FILES) {
      await persistFile(trx, themeId, input.shopId, file)
      filesWritten += 1
    }

    // Resolve the default settings_data values into theme_global_settings.
    await persistGlobalSettings(trx, themeId)

    // Materialize section instances from every templates/*.json file. Without
    // this step the customizer sidebar shows nothing and the storefront
    // can't render anything (the engine joins theme_page_sections to look
    // up section_type → liquid file). This is the Shopify Online Store 2.0
    // contract: the JSON template lists which sections appear on a page,
    // and each section_type points at a sections/<type>.liquid file.
    const sectionsCreated = await persistTemplateSections(trx, themeId)

    return { themeId, filesWritten, sectionsCreated }
  })

  return {
    themeId: result.themeId,
    created: true,
    filesWritten: result.filesWritten,
    sectionsCreated: result.sectionsCreated,
    role,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function persistFile(
  db: Kysely<Database>,
  themeId: string,
  shopId: string,
  file: DefaultThemeFile,
): Promise<void> {
  // theme_files (Phase 21 PR4): the canonical store for v6+ themes.
  // We use 'manual' source — sellers' edits to these files are
  // preserved on re-install (L17 — the snapshot semantics protect
  // edited rows).
  //
  // 2026-04-27 — removed `.onConflict([shop_id, theme_id, path])`. The
  // theme_files table has only a PK on `id` + FK on `shop_id` — there
  // is NO UNIQUE constraint on the (shop_id, theme_id, path) tuple, so
  // Postgres rejected every insert with `there is no unique or
  // exclusion constraint matching the ON CONFLICT specification`. The
  // installer always creates a BRAND-NEW theme record (fresh themeId)
  // before this loop runs, so the tuple is guaranteed unique on first
  // insert — no conflict possible. The dedupe semantics the comment
  // promised never actually worked; if a future caller wants
  // re-install-into-existing-theme behaviour, it should DELETE existing
  // rows for that (shop_id, theme_id) first.
  await (db as any)
    .insertInto('theme_files')
    .values({
      shop_id: shopId,
      theme_id: themeId,
      kind: file.language === 'css' ? 'css' : file.language === 'js' ? 'js' : 'liquid',
      path: file.path,
      content: file.content,
      source: 'manual',
      // 2026-04-27 — synthesized per (themeId, path) so the
      // (shop_id, source_url) UNIQUE index doesn't trip when we write
      // 11 files for the same theme. Empty string collided on the
      // second row. See theme-files-helpers.ts module header for
      // background on why the index exists.
      source_url: synthesizeThemeFileSourceUrl(themeId, file.path),
      s3_key: '',
      cdn_url: '',
      byte_size: Buffer.byteLength(file.content, 'utf8'),
    })
    .execute()
}

async function persistGlobalSettings(
  db: Kysely<Database>,
  themeId: string,
): Promise<void> {
  // Read the bundled settings_data.json to seed defaults.
  const settingsDataFile = DEFAULT_THEME_FILES.find(
    (f) => f.path === 'config/settings_data.json',
  )
  if (!settingsDataFile) return
  let parsed: { current?: Record<string, unknown> } = {}
  try {
    parsed = JSON.parse(settingsDataFile.content)
  } catch {
    return
  }
  const settings = parsed.current ?? {}

  await (db as any)
    .insertInto('theme_global_settings')
    .values({
      theme_id: themeId,
      settings_json: JSON.stringify(settings),
    })
    .onConflict((oc: any) =>
      oc.columns(['theme_id']).doUpdateSet({
        settings_json: JSON.stringify(settings),
      }),
    )
    .execute()
}

/**
 * Walk every `templates/<page>.json` in DEFAULT_THEME_FILES, parse the
 * Shopify Online Store 2.0 shape `{ sections: { <key>: { type, settings,
 * blocks?, block_order?, disabled? } }, order: [<key>...] }`, and
 * materialize a `theme_page_sections` row per (page, section_key).
 *
 * The customizer sidebar reads from `theme_page_sections`. The
 * storefront engine pipeline joins `theme_page_sections → section_type
 * → sections/<type>.liquid` to render the page. Without this step, both
 * surfaces are blind to the theme's structure even though the .liquid
 * + .json files are sitting in `theme_files`.
 *
 * Returns the number of section rows created so the caller can log it
 * + return the count to the seller-facing UI.
 */
async function persistTemplateSections(
  db: Kysely<Database>,
  themeId: string,
): Promise<number> {
  const templates = DEFAULT_THEME_FILES.filter(
    (f) => f.path.startsWith('templates/') && f.path.endsWith('.json'),
  )

  let created = 0

  for (const template of templates) {
    // templates/index.json → 'index', templates/customers/login.json → 'customers/login'
    const pageType = template.path.replace(/^templates\//, '').replace(/\.json$/, '')

    let parsed: {
      sections?: Record<string, {
        type?: string
        settings?: Record<string, unknown>
        blocks?: Record<string, unknown>
        block_order?: string[]
        disabled?: boolean
      }>
      order?: string[]
    } = {}
    try {
      parsed = JSON.parse(template.content)
    } catch {
      continue // malformed JSON — skip this template
    }

    const sections = parsed.sections ?? {}
    const order = Array.isArray(parsed.order) ? parsed.order : Object.keys(sections)

    let position = 0
    for (const sectionKey of order) {
      const section = sections[sectionKey]
      if (!section || typeof section.type !== 'string') continue

      // Reconstruct the blocks array from Shopify's `blocks` map +
      // `block_order` array. The customizer's `theme_page_sections.
      // blocks_json` is a flat array of `{ id, type, settings }`.
      let blocksJson: unknown[] = []
      if (section.blocks && Array.isArray(section.block_order)) {
        const blockMap = section.blocks as Record<string, { type?: string; settings?: Record<string, unknown> }>
        blocksJson = section.block_order
          .map((blockId) => {
            const b = blockMap[blockId]
            if (!b || typeof b.type !== 'string') return null
            return { id: blockId, type: b.type, settings: b.settings ?? {} }
          })
          .filter((b) => b !== null)
      }

      await (db as any)
        .insertInto('theme_page_sections')
        .values({
          theme_id: themeId,
          page_type: pageType,
          section_key: sectionKey,
          section_type: section.type,
          position,
          settings_json: section.settings ?? {},
          blocks_json: blocksJson,
          enabled: section.disabled === true ? false : true,
        })
        .execute()

      position += 1
      created += 1
    }
  }

  return created
}
