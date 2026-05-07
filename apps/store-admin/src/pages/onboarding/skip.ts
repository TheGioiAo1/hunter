/**
 * Store-admin — Onboarding skip handler (Phase C / Task C3).
 *
 * POST /admin/store/:slug/onboarding/skip
 *
 * Called from the "I'll do this later" form on the welcome page. Small
 * by design — delegates the state transition to the Phase A helper and
 * bounces the seller to their dashboard.
 *
 * State machine
 * -------------
 *
 * Only legal from `pending` → `skipped`. The helper enforces that in
 * SQL (`WHERE onboarding_state = 'pending'`), so double-submits and
 * stale-tab POSTs are no-ops. That keeps this handler honest without a
 * second SELECT-then-UPDATE round-trip.
 *
 * After the transition, the onboarding-gate middleware (Task D1) reads
 * `shop.onboarding_state === 'skipped'` and sets
 * `res.locals.showOnboardingBanner = true` so every subsequent dashboard
 * view renders the Resume-setup banner.
 *
 * CSRF
 * ----
 *
 * POST is guarded by the csrf-csrf middleware mounted on the store-admin
 * app (see `server.ts`). This handler assumes the middleware has
 * already rejected missing/invalid tokens with a 403; no explicit
 * check is needed here.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { markOnboardingSkipped } from '@gbox/core/modules/onboarding/state.js'

export async function postOnboardingSkip(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!

  // Fire the transition. Guarded on state=pending inside the helper, so
  // any other state (cloning / completed / skipped) is a silent no-op
  // that preserves the existing state — safer than rejecting with an
  // error, which would confuse a seller who double-submitted.
  await markOnboardingSkipped(db, store.id)

  // Bounce to the dashboard. The banner is rendered on the next request
  // by the onboarding-gate middleware via res.locals, not inlined here,
  // so we keep the redirect clean.
  res.redirect(302, `/admin/store/${store.slug}`)
}
