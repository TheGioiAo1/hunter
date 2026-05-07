/**
 * Store-admin — dismiss-banner handler (Phase C / Task C4).
 *
 * POST /admin/store/:slug/onboarding/dismiss-banner
 *
 * The ✕ on the "Finish setting up your store" Resume banner. Unlike
 * skip (which is reversible — seller can come back later), dismiss is
 * terminal: state moves to `completed`, `choice='dismissed'`, and the
 * banner never fires again for this shop.
 *
 * Why same-page redirect (not dashboard)
 * --------------------------------------
 *
 * Sellers dismiss the banner from wherever it appears (products list,
 * settings, analytics, …). Yanking them back to the dashboard on
 * every dismiss would be jarring. Referer-based redirect lets the
 * dismiss feel like closing a toast — the page stays put, the banner
 * just disappears.
 *
 * Referer is UNTRUSTED data by default (a seller could visit a malicious
 * page that POSTs to our dismiss endpoint, and we don't want to bounce
 * them back to that page). Guard: only honor a Referer whose path
 * segment starts with `/admin/store/` — any scheme+host that doesn't
 * parse into that shape falls through to the dashboard.
 *
 * State machine
 * -------------
 *
 * `markOnboardingCompleted` enforces the legal-predecessor guard in
 * SQL: WHERE onboarding_state IN ('cloning', 'skipped'). A seller who
 * somehow POSTs this while `pending` (they shouldn't have a banner to
 * click, but defense in depth) is a silent no-op — the row stays
 * `pending` and the wizard continues to be the default landing.
 *
 * CSRF is handled by the csrf-csrf middleware mounted on the app;
 * no explicit check here.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { markOnboardingCompleted } from '@gbox/core/modules/onboarding/state.js'

// ---------------------------------------------------------------------------
// Referer safety
// ---------------------------------------------------------------------------

/**
 * Extract a same-origin admin path from the Referer header, or null.
 *
 * Rules:
 *   - Accept paths that start with `/admin/store/`. Any other path
 *     (login, marketing, root) bounces to dashboard.
 *   - If Referer is a full URL, pull the pathname only — we never
 *     trust the host. A seller who landed on dismiss via an off-origin
 *     redirect should end up on their dashboard, not be re-sent to
 *     whatever malicious host spoofed the referer.
 *   - Missing/malformed → null.
 */
function safeRefererPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let pathname: string
  try {
    // URL() accepts absolute URLs; for plain paths we give it a dummy
    // base so we only ever compare the pathname.
    pathname = new URL(raw, 'http://_local').pathname
  } catch {
    return null
  }
  return pathname.startsWith('/admin/store/') ? pathname : null
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function postDismissOnboardingBanner(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!

  await markOnboardingCompleted(db, store.id, 'dismissed')

  const referer = safeRefererPath(req.headers?.referer)
  const target = referer ?? `/admin/store/${store.slug}`

  // 302 (not 301) — the wizard is a transient surface and we don't
  // want any intermediate cache to remember this redirect.
  res.redirect(302, target)
}
