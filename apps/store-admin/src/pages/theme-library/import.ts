/**
 * POST /admin/store/:slug/online-store/theme-library/import
 *
 * Multipart upload — seller picks a .zip exported from their theme
 * editor (Gbox-format) and we ingest it as a new unpublished theme.
 *
 * Multer is wired in server.ts at route registration time, NOT here,
 * to keep this handler pure and testable.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { importThemeZip } from '@gbox/core/modules/themes/theme-zip-importer.js'

type RequestWithFile = Request & {
  file?: { buffer: Buffer; originalname: string; size: number; mimetype: string }
}

const ERR_LABEL: Record<string, string> = {
  too_large:               'Theme file too large (5 MB max).',
  invalid_zip:             'That file is not a valid theme zip.',
  missing_layout:          'Theme zip is missing layout/theme.liquid.',
  missing_settings_schema: 'Theme zip is missing config/settings_schema.json.',
  no_templates:            'Theme zip has no templates.',
  unsafe_path:             'Theme zip contains an unsafe path.',
  name_conflict:           'A theme with that name already exists.',
  persist_failed:          'We couldn\'t save the theme. Please try again.',
  no_file:                 'Please choose a .zip file before clicking Import.',
}

export async function postImportTheme(
  req: RequestWithFile,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`

  if (!req.file) {
    res.redirect(302, `${base}/online-store/theme-library?err=no_file`)
    return
  }

  // Basic content-type sanity. Multer reports both 'application/zip'
  // and 'application/x-zip-compressed' depending on browser.
  const okMime = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream']
  if (!okMime.includes(req.file.mimetype)) {
    res.redirect(302, `${base}/online-store/theme-library?err=invalid_zip`)
    return
  }

  const themeName =
    typeof req.body?.theme_name === 'string' && req.body.theme_name.trim().length > 0
      ? String(req.body.theme_name).trim()
      : (req.file.originalname || 'Imported theme').replace(/\.zip$/i, '')

  const result = await importThemeZip(db, {
    shopId: store.id,
    zipBytes: req.file.buffer,
    themeName,
    role: 'unpublished',
  })

  if (!result.ok) {
    res.redirect(302, `${base}/online-store/theme-library?err=${encodeURIComponent(result.error.code)}`)
    return
  }

  res.redirect(302, `${base}/themes/${encodeURIComponent(result.themeId)}/customize?imported=1`)
}

export function importErrorMessage(code: string): string {
  return ERR_LABEL[code] ?? 'Theme import failed. Please contact Gbox support.'
}
