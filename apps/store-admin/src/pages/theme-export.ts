/**
 * GET /admin/store/:slug/themes/:themeId/export
 *
 * Streams a Shopify-format `.zip` reconstruction of the theme back to
 * the seller's browser. Used for backup, theme migration between
 * shops, or handing a theme to a developer for offline editing.
 *
 * Cross-shop probe defence: getTheme + shop_id check before any read.
 * Iron Rule 5: errors render seller-friendly messages via safeMessage.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { safeMessage } from '@gbox/core/modules/support/safe-message.js'
import { getTheme } from '@gbox/core/modules/themes/service.js'
import {
  exportThemeZip,
  exportFilename,
} from '@gbox/core/modules/themes/theme-zip-exporter.js'

export async function getThemeExport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const base = `/admin/store/${store.slug}`

  try {
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.redirect(`${base}/online-store/themes`)
      return
    }
    const result = await exportThemeZip(db, themeId)
    const filename = exportFilename(result.themeName)
    res
      .status(200)
      .setHeader('Content-Type', 'application/zip')
      .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      .setHeader('Content-Length', String(result.zipBytes.length))
      .setHeader('Cache-Control', 'no-store')
      .send(result.zipBytes)
  } catch (err) {
    res.status(500).send(safeMessage(err as Error).safe)
  }
}
