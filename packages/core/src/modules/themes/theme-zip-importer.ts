/**
 * theme-zip-importer.ts — accept an uploaded .zip and persist its
 * contents as a new theme.
 *
 * The .zip layout is the same Shopify-compatible structure the editor
 * + storefront expect:
 *
 *   layout/theme.liquid              (required)
 *   templates/<page>.json            (at least one required)
 *   config/settings_schema.json      (required)
 *   config/settings_data.json        (optional; defaults applied if missing)
 *   sections/<name>.liquid           (zero or more)
 *   snippets/<name>.liquid           (zero or more)
 *   assets/<name>.{css,js,...}       (zero or more)
 *   locales/<code>.default.json      (optional)
 *
 * Validation is strict but seller-friendly — every error returns an
 * Iron-Rule-5 safe message; no internal paths or stack traces leak.
 *
 * Adm-zip handles extraction in memory (no temp files, no fs side
 * effects). Caller is responsible for the multer plumbing and for
 * passing the raw Buffer.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { synthesizeThemeFileSourceUrl } from './theme-files-helpers.js'

export interface ImportThemeZipInput {
  shopId: string
  /** Raw .zip bytes from multer. */
  zipBytes: Buffer
  /**
   * Seller-supplied display name. If blank we fall back to the zip's
   * filename stem (handled by the caller — multer.originalname).
   */
  themeName: string
  /** 'main' | 'unpublished' (default: 'unpublished'). */
  role?: 'main' | 'unpublished'
}

export type ImportThemeZipResult =
  | { ok: true; themeId: string; filesWritten: number; sections: string[] }
  | { ok: false; error: ImportThemeZipError }

export type ImportThemeZipError =
  | { code: 'too_large'; safeMessage: string }
  | { code: 'invalid_zip'; safeMessage: string }
  | { code: 'missing_layout'; safeMessage: string }
  | { code: 'missing_settings_schema'; safeMessage: string }
  | { code: 'no_templates'; safeMessage: string }
  | { code: 'unsafe_path'; safeMessage: string }
  | { code: 'name_conflict'; safeMessage: string }
  | { code: 'persist_failed'; safeMessage: string }

const MAX_BYTES = 5 * 1024 * 1024 // 5 MB per theme zip
const ALLOWED_DIRS = ['layout', 'templates', 'sections', 'snippets', 'assets', 'config', 'locales'] as const
const ALLOWED_EXTS_BY_DIR: Record<string, readonly string[]> = {
  layout:    ['.liquid'],
  templates: ['.json', '.liquid'],
  sections:  ['.liquid'],
  snippets:  ['.liquid'],
  assets:    ['.css', '.js', '.json', '.svg', '.woff', '.woff2', '.ttf', '.otf'],
  config:    ['.json'],
  locales:   ['.json'],
}

interface ExtractedFile {
  path: string
  content: string
  language: 'liquid' | 'css' | 'js' | 'json'
}

export async function importThemeZip(
  db: Kysely<Database>,
  input: ImportThemeZipInput,
): Promise<ImportThemeZipResult> {
  if (input.zipBytes.byteLength > MAX_BYTES) {
    return {
      ok: false,
      error: { code: 'too_large', safeMessage: 'Theme file is too large (5 MB max). Please remove unused assets and try again.' },
    }
  }

  // jszip is already a dependency of @gbox/core. Lazy-import keeps
  // this module loadable in test environments that stub the network.
  let JSZip: any
  try {
    JSZip = (await import('jszip')).default
  } catch {
    return {
      ok: false,
      error: { code: 'persist_failed', safeMessage: 'Server is missing the zip extraction tool. Please contact Gbox support.' },
    }
  }

  let zip: any
  try {
    zip = await JSZip.loadAsync(input.zipBytes)
  } catch {
    return {
      ok: false,
      error: { code: 'invalid_zip', safeMessage: 'That file is not a valid theme zip. Please re-export and try again.' },
    }
  }

  // Walk + classify + filter.
  const files: ExtractedFile[] = []
  const zipFiles = zip.files as Record<string, any>
  for (const entryName of Object.keys(zipFiles)) {
    const entry = zipFiles[entryName]
    if (entry.dir) continue
    const relPath = normaliseEntryPath(entryName)
    if (relPath == null) {
      return {
        ok: false,
        error: { code: 'unsafe_path', safeMessage: 'The zip contains an unsafe path. Theme zips can\'t escape the theme directory.' },
      }
    }
    const cls = classify(relPath)
    if (!cls) continue // silently drop unrecognised paths (README, license, etc)
    let content: string
    try {
      content = await entry.async('string')
    } catch {
      return {
        ok: false,
        error: { code: 'invalid_zip', safeMessage: 'A file inside the zip could not be read. Please re-export.' },
      }
    }
    files.push({ path: relPath, content, language: cls })
  }

  // Required files check.
  const hasLayout = files.some((f) => f.path === 'layout/theme.liquid')
  if (!hasLayout) {
    return {
      ok: false,
      error: { code: 'missing_layout', safeMessage: 'Theme zip is missing layout/theme.liquid. Please make sure the zip contains the theme\'s root layout file.' },
    }
  }
  const hasSettingsSchema = files.some((f) => f.path === 'config/settings_schema.json')
  if (!hasSettingsSchema) {
    return {
      ok: false,
      error: { code: 'missing_settings_schema', safeMessage: 'Theme zip is missing config/settings_schema.json.' },
    }
  }
  const templates = files.filter((f) => f.path.startsWith('templates/'))
  if (templates.length === 0) {
    return {
      ok: false,
      error: { code: 'no_templates', safeMessage: 'Theme zip has no templates. Add at least one templates/<page>.json file.' },
    }
  }

  // Disambiguate name if it collides.
  const themeName = await disambiguateName(db, input.shopId, input.themeName.trim() || 'Imported theme')

  // Demote main if needed.
  const role = input.role ?? 'unpublished'
  if (role === 'main') {
    await (db as any)
      .updateTable('themes')
      .set({ role: 'unpublished' })
      .where('shop_id', '=', input.shopId)
      .where('role', '=', 'main')
      .execute()
  }

  // Insert theme + files.
  let themeId: string
  try {
    const inserted = await (db as any)
      .insertInto('themes')
      .values({ shop_id: input.shopId, name: themeName, role })
      .returning(['id'])
      .executeTakeFirstOrThrow()
    themeId = (inserted as { id: string }).id

    for (const file of files) {
      await (db as any)
        .insertInto('theme_files')
        .values({
          shop_id: input.shopId,
          theme_id: themeId,
          kind: file.language === 'css' ? 'css' : file.language === 'js' ? 'js' : 'liquid',
          path: file.path,
          content: file.content,
          source: 'manual',
          // 2026-04-27 — synthesized so the (shop_id, source_url)
          // UNIQUE index is satisfied. See theme-files-helpers.ts
          // module header. Without this every zip with > 1 file
          // tripped the index on the second row.
          source_url: synthesizeThemeFileSourceUrl(themeId, file.path),
          s3_key: '',
          cdn_url: '',
          byte_size: Buffer.byteLength(file.content, 'utf8'),
        })
        // No onConflict — the theme is brand new and (shop_id,
        // theme_id, path) has no UNIQUE constraint anyway. The
        // previous .onConflict([shop_id, theme_id, path]) silently
        // failed at runtime (no matching index). Removed.
        .execute()
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[theme-zip-importer] persist failed:', (err as Error).message)
    return {
      ok: false,
      error: { code: 'persist_failed', safeMessage: 'We couldn\'t save the theme. Please contact Gbox support.' },
    }
  }

  const sections = files.filter((f) => f.path.startsWith('sections/')).map((f) => f.path.replace(/^sections\//, '').replace(/\.liquid$/, ''))
  return { ok: true, themeId, filesWritten: files.length, sections }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Resolve a zip entry path to a safe relative path within the theme
 * directory. Returns null on traversal attempts (..) or absolute paths.
 */
function normaliseEntryPath(entry: string): string | null {
  // Strip a single leading directory if every entry shares it (Shopify
  // exporter often nests the theme under a `<theme-name>/` folder).
  const parts = entry.replace(/\\/g, '/').split('/')
  if (parts[0] === '') parts.shift()
  for (const p of parts) {
    if (p === '..' || p.startsWith('/')) return null
    if (p === '' && parts.length > 0) continue
  }
  return parts.filter(Boolean).join('/')
}

function classify(path: string): 'liquid' | 'css' | 'js' | 'json' | null {
  // Strip leading directory wrapper if the zip nests files under
  // `<theme-name>/layout/...` etc.
  const rel = path.includes('/') ? path : `__/${path}`
  // Accept either `layout/theme.liquid` or `<theme>/layout/theme.liquid`.
  let inner = rel
  for (const dir of ALLOWED_DIRS) {
    const idx = rel.indexOf(`${dir}/`)
    if (idx >= 0) {
      inner = rel.slice(idx)
      break
    }
  }
  const head = inner.split('/')[0] ?? ''
  if (!ALLOWED_DIRS.includes(head as typeof ALLOWED_DIRS[number])) return null
  const ext = '.' + (inner.split('.').pop() ?? '')
  const allowed = ALLOWED_EXTS_BY_DIR[head] ?? []
  if (!allowed.includes(ext)) return null
  if (ext === '.liquid') return 'liquid'
  if (ext === '.css') return 'css'
  if (ext === '.js') return 'js'
  if (ext === '.json') return 'json'
  return null
}

async function disambiguateName(
  db: Kysely<Database>,
  shopId: string,
  candidate: string,
): Promise<string> {
  const used = await (db as any)
    .selectFrom('themes')
    .select(['name'])
    .where('shop_id', '=', shopId)
    .where('name', 'like', `${candidate}%`)
    .execute()
  const usedNames = new Set<string>((used as Array<{ name: string }>).map((r) => r.name))
  if (!usedNames.has(candidate)) return candidate
  let n = 2
  while (usedNames.has(`${candidate} (${n})`)) n += 1
  return `${candidate} (${n})`
}
