/**
 * Sidebar entry-point for Theme Editor.
 *
 * Sellers click "Online Store > Theme editor" in the sidebar (or use
 * `g e` from the command palette) and land here. We don't host the
 * editor itself — that's `/themes/:themeId/customize`. This thin
 * handler resolves the seller's main theme and 302s onward.
 *
 * State machine:
 *   - main theme exists → 302 to /themes/<main-id>/customize
 *   - no main theme but the shop has unpublished themes → 302 to the
 *     newest unpublished theme so the seller can still edit something
 *     instead of getting bounced into a list page
 *   - shop has zero themes → 302 to the Themes LIST page
 *     (/online-store/themes), which renders an empty state with an
 *     "Open Theme Library" CTA. We deliberately do NOT bounce
 *     directly to /online-store/library because that makes the
 *     "Theme editor" and "Library" sidebar entries feel like they
 *     point at the same screen. Themes list is the right
 *     intermediary surface — it shows the seller their theme
 *     inventory (even when empty) and offers a single "install one"
 *     path forward.
 *
 * Iron Rule 5: any DB error returns the seller-friendly safe message
 * via safeMessage().
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { safeMessage } from '@gbox/core/modules/support/safe-message.js'

export async function getThemeEditorEntry(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`

  try {
    // Prefer the main (published) theme — that's what the seller
    // expects to edit when they click the sidebar entry. Fall back to
    // the most recently created unpublished theme so the editor still
    // opens on something useful.
    const main = (await (db as any)
      .selectFrom('themes')
      .select(['id'])
      .where('shop_id', '=', store.id)
      .where('role', '=', 'main')
      .executeTakeFirst()) as { id: string } | undefined

    if (main) {
      res.redirect(302, `${base}/themes/${encodeURIComponent(main.id)}/customize`)
      return
    }

    const fallback = (await (db as any)
      .selectFrom('themes')
      .select(['id'])
      .where('shop_id', '=', store.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst()) as { id: string } | undefined

    if (fallback) {
      res.redirect(302, `${base}/themes/${encodeURIComponent(fallback.id)}/customize`)
      return
    }

    // No themes at all — bounce to the Themes list (empty state has
    // an "Open Theme Library" CTA). NOT to /online-store/library
    // directly, because that would make Theme editor and Library
    // feel like the same sidebar entry.
    res.redirect(302, `${base}/online-store/themes`)
  } catch (err) {
    res.status(500).send(safeMessage(err as Error).safe)
  }
}
