/**
 * Store-admin — Onboarding gate middleware (Phase D / Task D1).
 *
 * Mounted after `storeAuth` on `/admin/store/:slug`. Reads
 * `req.store.onboarding_state` and decides whether the request should:
 *
 *   - redirect into the wizard  (pending, non-bypass paths)
 *   - render with a banner flag (skipped, signal to layout)
 *   - fall through untouched    (cloning, completed, bypass paths)
 *
 * The gate is an *optional* enforcement point — the Shopify-style
 * choice (from Phase A owner lock-in) is "first-run opens the wizard,
 * but Skip is always available". So once a seller is past pending,
 * they are never again forced into onboarding by middleware. The
 * banner in D2 is the sole nudge after skip.
 *
 * Rollout flag: `GBOX_ONBOARDING_WIZARD_ENABLED` — when !== 'true',
 * the gate short-circuits to next() so we can kill-switch on server 1
 * without a redeploy. Default is ON (i.e. anything other than the
 * exact string 'false' keeps the gate live; see checks below).
 *
 * Bypass list for pending state:
 *
 *   /admin/store/:slug/onboarding/*   ← wizard itself (otherwise loop)
 *   /admin/store/:slug/api/*          ← JSON surface, don't HTML-redirect
 *   /admin/store/:slug/assets/*       ← static files
 *   /admin/store/:slug/logout         ← always leave allowed
 *
 * 2026-04-26: removed /clone-pro/* bypass — clone is god-admin-only
 * concierge tooling and no longer reachable from seller surfaces.
 *
 * The regex anchor `(\/|$)` on each path ensures we only match the
 * segment boundary — a route like `/onboardings-legacy` must NOT be
 * accidentally unblocked by the `/onboarding` bypass.
 */

import type { Request, Response, NextFunction } from 'express'

// ---------------------------------------------------------------------------
// Bypass regex list
// ---------------------------------------------------------------------------

const BYPASS_REGEXES: readonly RegExp[] = [
  /^\/admin\/store\/[^/]+\/onboarding(\/|$)/,
  /^\/admin\/store\/[^/]+\/api(\/|$)/,
  /^\/admin\/store\/[^/]+\/assets(\/|$)/,
  /^\/admin\/store\/[^/]+\/logout(\/|$)/,
]

function isBypassPath(path: string): boolean {
  return BYPASS_REGEXES.some((re) => re.test(path))
}

/**
 * Reconstruct the full request path before Express's mount-path strip.
 *
 * `app.use('/admin/store/:slug', onboardingGate)` registers the gate
 * UNDER `/admin/store/:slug`, which means by the time it runs Express
 * has already chopped the mount prefix off `req.url` / `req.path`. So
 * for a request like `/admin/store/best-store/onboarding/first-run`,
 * the gate sees `req.path === '/onboarding/first-run'`, NOT the full
 * URL.
 *
 * The BYPASS regexes above were authored assuming the FULL URL (the
 * unit tests pass `'/admin/store/lifeasy/onboarding/first-run'`
 * directly, sidestepping Express). Without the prefix the bypass never
 * matched in production — every wizard URL fell through to the
 * "redirect to first-run" branch, creating an infinite loop the
 * moment the seller hit `/onboarding/first-run` itself.
 *
 * `req.baseUrl` holds the mount prefix (with `:slug` already
 * substituted), and `req.path` is the rest. Concatenating them
 * reconstructs what the regexes were originally designed against.
 * `req.originalUrl` would also work but it includes the query string,
 * so this form is a touch tidier.
 */
function getFullPath(req: { baseUrl?: string; path: string }): string {
  return (req.baseUrl ?? '') + req.path
}

// ---------------------------------------------------------------------------
// Flag guard
// ---------------------------------------------------------------------------

/**
 * The wizard is ON by default. Set GBOX_ONBOARDING_WIZARD_ENABLED to the
 * literal string 'false' to disable — any other value (including
 * unset) keeps it enabled. This asymmetry is intentional: a misspelled
 * flag should not accidentally disable the production surface.
 */
function isWizardEnabled(): boolean {
  const raw = process.env.GBOX_ONBOARDING_WIZARD_ENABLED
  if (raw == null) return true
  return raw.toLowerCase() !== 'false'
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function onboardingGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Kill-switch: entire feature off → no-op. Must come first so a
  // broken storeAuth upstream (e.g. during the rollout window) can't
  // accidentally light up the gate on shops that haven't been
  // backfilled yet.
  if (!isWizardEnabled()) {
    next()
    return
  }

  const shop = (req as any).store as
    | { slug?: string; onboarding_state?: string }
    | undefined

  // Defense in depth — if storeAuth didn't populate req.store the
  // downstream handler will render its own error. The gate should not
  // turn that into a redirect loop.
  if (!shop) {
    next()
    return
  }

  // Undefined / missing state is treated as 'pending'. Legacy rows
  // pre-migration-050 or backfill races should still get nudged into
  // the wizard rather than bypassing silently.
  const state = shop.onboarding_state ?? 'pending'

  // 'cloning' is a legacy state from the retired clone-pro surface.
  // Treat it as 'completed' so the seller's request falls through to
  // their dashboard instead of looping the (now-410) clone-pro routes.
  if (state === 'completed' || state === 'cloning') {
    next()
    return
  }

  if (state === 'skipped') {
    // Don't bother flagging the banner when the seller is already
    // inside the wizard (no point — they're reading the same surface).
    if (!isBypassPath(getFullPath(req))) {
      res.locals.showOnboardingBanner = true
    }
    next()
    return
  }

  // state === 'pending' (default). Redirect UI requests to the wizard;
  // let API / assets / logout / clone-pro through untouched.
  if (isBypassPath(getFullPath(req))) {
    next()
    return
  }

  const slug = shop.slug ?? req.params?.slug ?? ''
  res.redirect(302, `/admin/store/${slug}/onboarding/first-run`)
}
