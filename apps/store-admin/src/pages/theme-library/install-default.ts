/**
 * POST /admin/store/:slug/online-store/theme-library/install-default
 *
 * Seller clicks "Use this theme" on the Theme Library page → we
 * install the bundled default theme for their shop and redirect them
 * into the customizer.
 *
 * Iron Rule 5: every error path emits a `safeMessage` that's safe for
 * seller eyes. Stack traces stay in `console.error`.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { installDefaultTheme } from '@gbox/core/modules/themes/install-default.js'

export async function postInstallDefaultTheme(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  try {
    const store = req.store!
    const base = `/admin/store/${store.slug}`

    const force = String(req.body?.force ?? '') === '1'
    // 2026-04-26: default to 'auto' (Shopify-style first-theme-publishes).
    // Caller can still pin role explicitly via the form: role=main|unpublished.
    const explicitRole = req.body?.role
    const role: 'main' | 'unpublished' | 'auto' =
      explicitRole === 'main' || explicitRole === 'unpublished'
        ? explicitRole
        : 'auto'

    const result = await installDefaultTheme(db, {
      shopId: store.id,
      role,
      force,
    })

    // Land the seller in the customizer for the new (or returned) theme.
    res.redirect(302, `${base}/themes/${encodeURIComponent(result.themeId)}/customize`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[postInstallDefaultTheme] failed:', (err as Error).message)
    const store = req.store!
    res.redirect(302, `/admin/store/${store.slug}/online-store/theme-library?err=install_failed`)
  }
}
