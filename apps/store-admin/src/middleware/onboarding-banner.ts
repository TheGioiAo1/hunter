/**
 * Store-admin — Onboarding banner injection middleware (Phase D / Task D2).
 *
 * The Resume-setup banner is the only post-skip nudge in the wizard.
 * It renders above the page content on every `/admin/store/:slug/*`
 * view when `res.locals.showOnboardingBanner === true` (set by the
 * gate middleware for shops in state='skipped').
 *
 * Injection strategy
 * ------------------
 *
 * The seller-layout template embeds a well-known placeholder comment
 * (`<!--GBOX_ONBOARDING_BANNER_SLOT-->`) just above `${content}`. This
 * middleware wraps `res.send` and, before the body flushes to the
 * wire, string-replaces the placeholder with either:
 *
 *   - the banner HTML  (flag true)
 *   - an empty string  (flag false / unset)
 *
 * Why the comment-and-replace pattern: there are 200+ existing
 * `sellerLayout(...)` call sites in the tree. Adding a prop to every
 * one would be a huge mechanical diff; placeholder replacement keeps
 * the churn to two files (this middleware + seller-layout.ts).
 *
 * Correctness notes
 * -----------------
 *
 * - We only substitute on string bodies. Buffer / JSON / stream bodies
 *   pass through untouched — they don't render through sellerLayout
 *   and won't contain the slot comment anyway.
 *
 * - We capture the INNER `res.send` into a closure before assigning
 *   the wrapper. Calling `res.send` inside the wrapper would loop
 *   forever; `inner.call(res, body)` hits the real one exactly once.
 *
 * - CSRF token is read via `req.csrfToken()` (the csrf-csrf middleware
 *   exposes it as a function). If the token is missing (shouldn't
 *   happen for mutator surfaces, but defense in depth) we still render
 *   the banner; the dismiss POST will 403 and the seller can retry.
 */

import type { Request, Response, NextFunction } from 'express'

// Kept in sync with the slot inserted in apps/store-admin/src/layouts/
// seller-layout.ts above `${content}`. If either edge changes the
// string, both must change — the test suite locks the canonical form.
const SLOT_PLACEHOLDER = '<!--GBOX_ONBOARDING_BANNER_SLOT-->'

// ---------------------------------------------------------------------------
// HTML escaping — inlined to keep the middleware dependency-free.
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Banner HTML renderer
// ---------------------------------------------------------------------------

export interface RenderOnboardingResumeBannerOptions {
  readonly slug: string
  readonly csrfToken: string
}

/**
 * Returns the HTML for the Resume-setup banner. Pure — no DOM, no
 * side effects — so it's cheap to call on every skipped-state request.
 * Exported for the injector middleware below and for potential reuse
 * by a dedicated "/onboarding/banner" fragment endpoint in the future.
 *
 * Copy is intentionally generic — "finish setting up your store" —
 * so it reads well whether the seller bailed at Tab 1 or Tab 2 of the
 * wizard. It never mentions "Design Library" or god-admin surfaces.
 */
export function renderOnboardingResumeBanner(
  opts: RenderOnboardingResumeBannerOptions,
): string {
  const slug = escHtml(opts.slug)
  const csrf = escHtml(opts.csrfToken)
  const resumeHref = `/admin/store/${slug}/onboarding/first-run`
  const dismissAction = `/admin/store/${slug}/onboarding/dismiss-banner`

  return `
<aside class="gbox-onboarding-banner" role="complementary"
       aria-label="Finish setting up your store">
  <div class="gbox-onboarding-banner__body">
    <strong class="gbox-onboarding-banner__title">Finish setting up your store</strong>
    <p class="gbox-onboarding-banner__copy">Pick a theme source to get your storefront ready for customers.</p>
  </div>
  <div class="gbox-onboarding-banner__actions">
    <a class="gbox-onboarding-banner__cta" href="${resumeHref}">Resume setup &rarr;</a>
    <form class="gbox-onboarding-banner__dismiss-form"
          method="post" action="${dismissAction}">
      <input type="hidden" name="_csrf" value="${csrf}" />
      <button type="submit" class="gbox-onboarding-banner__dismiss"
              aria-label="Dismiss setup banner permanently">&times;</button>
    </form>
  </div>
</aside>`
}

// ---------------------------------------------------------------------------
// Injector middleware
// ---------------------------------------------------------------------------

export function onboardingBannerInjector(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Capture the real send BEFORE wrapping so the wrapper delegates to
  // it, not to itself. `bind` preserves `this`-as-res semantics even
  // though we explicitly pass `res` below.
  const originalSend = res.send.bind(res) as (body: unknown) => Response

  res.send = function wrappedSend(body: unknown): Response {
    if (typeof body === 'string' && body.includes(SLOT_PLACEHOLDER)) {
      const showBanner = Boolean((res.locals as any)?.showOnboardingBanner)
      let replacement = ''
      if (showBanner) {
        const slug = String(
          (req as any).store?.slug ?? (req.params as any)?.slug ?? '',
        )
        // 2026-04-25 — `req.csrfToken` is a STRING, not a function.
        // Pre-fix: `typeof csrfFn === 'function'` always returned false
        // → fallback `''` → banner's skip form embedded an empty token
        // → submit 403'd. Same root-cause class as the onboarding/clone
        // form bug (PR #94). Fixed there + here.
        const rawToken = (req as any).csrfToken
        const csrfToken =
          typeof rawToken === 'string'
            ? rawToken
            : typeof rawToken === 'function'
              ? String(rawToken.call(req) ?? '') // legacy / test-mock
              : ''
        replacement = renderOnboardingResumeBanner({ slug, csrfToken })
      }
      const patched = body.split(SLOT_PLACEHOLDER).join(replacement)
      return originalSend(patched)
    }
    return originalSend(body)
  } as Response['send']

  next()
}
