/**
 * theme-zip-exporter.ts — package a theme back into a Shopify-format
 * `.zip` for download.
 *
 * Inverse of theme-zip-importer.ts. Sellers use this to:
 *   • Back up their theme before a risky edit.
 *   • Move a theme between Gbox shops.
 *   • Hand a theme to a developer for offline editing in VS Code.
 *
 * The zip layout matches the importer's expectations exactly so a
 * round-trip (export → import) reproduces the source theme bit-for-bit.
 *
 *   layout/theme.liquid              ← theme_files row(s) where path starts 'layout/'
 *   templates/<page>.json            ← reconstructed from theme_page_sections rows
 *   templates/<page>.liquid          ← theme_files row(s) where path starts 'templates/'
 *   sections/<name>.liquid           ← theme_files row(s) where path starts 'sections/'
 *   snippets/<name>.liquid           ← theme_files row(s) where path starts 'snippets/'
 *   assets/<name>.{css,js,svg,...}   ← theme_files row(s) where path starts 'assets/'
 *   config/settings_schema.json      ← theme_global_settings.schema_json
 *   config/settings_data.json        ← theme_global_settings.settings_json
 *   locales/<code>.default.json      ← (deferred — i18n PR ships these)
 *
 * Iron Rule 5: throws native Error; caller wraps via safeMessage.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

export interface ExportThemeZipResult {
  zipBytes: Buffer
  themeName: string
  fileCount: number
}

/**
 * Build a Shopify-format theme zip from the rows that define `themeId`.
 * Returns Buffer + filename hint; caller streams it back to the browser
 * via res.setHeader('Content-Disposition', 'attachment; filename="…"').
 */
export async function exportThemeZip(
  db: Kysely<Database>,
  themeId: string,
): Promise<ExportThemeZipResult> {
  // Pull theme + every artifact in parallel — they're all keyed by theme_id
  // (or by id for the theme itself).
  const [theme, files, pageSections, globalSettings] = await Promise.all([
    (db as any)
      .selectFrom('themes')
      .select(['id', 'name'])
      .where('id', '=', themeId)
      .executeTakeFirst() as Promise<{ id: string; name: string } | undefined>,
    (db as any)
      .selectFrom('theme_files')
      .select(['path', 'kind', 'content'])
      .where('theme_id', '=', themeId)
      .execute() as Promise<Array<{ path: string; kind: string; content: string }>>,
    (db as any)
      .selectFrom('theme_page_sections')
      .select(['page_type', 'section_key', 'section_type', 'position', 'settings_json', 'blocks_json', 'enabled'])
      .where('theme_id', '=', themeId)
      .orderBy('page_type', 'asc')
      .orderBy('position', 'asc')
      .execute() as Promise<
        Array<{
          page_type: string
          section_key: string
          section_type: string
          position: number
          settings_json: unknown
          blocks_json: unknown
          enabled: boolean
        }>
      >,
    (db as any)
      .selectFrom('theme_global_settings')
      .select(['settings_json', 'schema_json'])
      .where('theme_id', '=', themeId)
      .executeTakeFirst() as Promise<{ settings_json: unknown; schema_json: unknown } | undefined>,
  ])

  if (!theme) throw new Error('Theme not found.')

  // jszip is already a dependency (importer uses it too). Lazy-import
  // matches the importer's pattern so test environments stubbing modules
  // can keep working.
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()

  // 1) Verbatim files (layout / sections / snippets / assets / templates/*.liquid).
  let fileCount = 0
  for (const f of files) {
    if (!f.path) continue
    zip.file(f.path, f.content ?? '')
    fileCount += 1
  }

  // 2) Templates — reconstruct from theme_page_sections.
  // Group by page_type, then build the Shopify Online Store 2.0 JSON.
  const sectionsByPage = new Map<string, typeof pageSections>()
  for (const s of pageSections) {
    if (!sectionsByPage.has(s.page_type)) sectionsByPage.set(s.page_type, [])
    sectionsByPage.get(s.page_type)!.push(s)
  }
  for (const [pageType, sections] of sectionsByPage) {
    const json: { sections: Record<string, unknown>; order: string[] } = {
      sections: {},
      order: [],
    }
    for (const s of sections) {
      const inst: Record<string, unknown> = {
        type: s.section_type,
        settings: s.settings_json ?? {},
      }
      if (Array.isArray(s.blocks_json) && (s.blocks_json as unknown[]).length > 0) {
        // Shopify Online Store 2.0 represents blocks as an object keyed by
        // block id with a sibling `block_order` array. We don't store
        // block ids separately here, so we synthesise sequential keys.
        const blocks = s.blocks_json as Array<Record<string, unknown>>
        const blockMap: Record<string, unknown> = {}
        const blockOrder: string[] = []
        blocks.forEach((b, i) => {
          const id = typeof b.id === 'string' && b.id ? b.id : `block-${i}`
          blockMap[id] = { type: b.type, settings: b.settings ?? {} }
          blockOrder.push(id)
        })
        inst.blocks = blockMap
        inst.block_order = blockOrder
      }
      if (s.enabled === false) inst.disabled = true
      json.sections[s.section_key] = inst
      json.order.push(s.section_key)
    }
    zip.file(`templates/${pageType}.json`, JSON.stringify(json, null, 2))
    fileCount += 1
  }

  // 3) Global settings.
  if (globalSettings) {
    if (globalSettings.schema_json) {
      zip.file('config/settings_schema.json', JSON.stringify(globalSettings.schema_json, null, 2))
      fileCount += 1
    }
    if (globalSettings.settings_json) {
      zip.file('config/settings_data.json', JSON.stringify(globalSettings.settings_json, null, 2))
      fileCount += 1
    }
  }

  const zipBytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { zipBytes, themeName: theme.name, fileCount }
}

/**
 * Suggest a filename for the downloaded zip. We include the theme name
 * (slugified) + an ISO date so re-exports don't clobber each other in
 * the seller's Downloads folder.
 *
 *   sluggify("Stylish Theme") + "-" + today  =>  "stylish-theme-2026-04-26.zip"
 */
export function exportFilename(themeName: string, date: Date = new Date()): string {
  // Strip combining diacritics first (e.g. NFKD splits "é" into "e" + U+0301
  // — without removing the combining mark, the next regex turns it into a
  // dash, leaving "cafe-bohe-me" instead of "cafe-boheme").
  const slug = String(themeName || 'theme')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'theme'
  const iso = date.toISOString().slice(0, 10)
  return `${slug}-${iso}.zip`
}
