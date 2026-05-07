/**
 * Store-admin — Onboarding wizard first-run page (Phase B / Task B1).
 *
 * GET /admin/store/:slug/onboarding/first-run
 *
 * Entry surface for a brand-new seller. One handler, three outcomes
 * based on the shop's `onboarding_state` column:
 *
 *   completed  → 302 to /admin/store/:slug (wizard done; don't re-show)
 *   pending    → render Theme Library welcome page
 *   skipped    → render Theme Library welcome page (seller came back via
 *                the Resume banner — same surface, same state-machine path)
 *
 * 2026-04-26: Clone Pro re-scoped to god-admin-only concierge tooling,
 * so the legacy `cloning` state branch is gone. Any shops still carrying
 * `onboarding_state='cloning'` (rare — only mid-flight at the cutover)
 * will see the Theme Library welcome page on next visit; god admin can
 * resume their clone via internal tooling.
 *
 * Query-string knobs
 * ------------------
 *
 *   ?welcome=1          — stamp the "Welcome to Gbox!" H1. Set by the
 *                         accounts portal on its first redirect into
 *                         the admin surface; subsequent visits drop it
 *                         for a calmer UX.
 *   ?tab=library        — deep-link to the Theme Library tab (alias for
 *                         legacy callers; library is now the default tab).
 *   ?from=domain-verified
 *                       — celebratory banner when the seller finished
 *                         wiring a custom domain mid-setup (Phase E).
 *
 * Composition
 * -----------
 *
 * This file does handler plumbing only — state routing, query parsing,
 * Url composition. The welcome HTML comes from `renderWelcome()` in
 * `@gbox/core/modules/ui/onboarding/welcome.ts`. The Theme Library
 * grid HTML comes from `renderFeaturedLibraryCardsHtml()` in
 * `./library.ts`. Both are unit-tested independently.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout } from '../../layouts/seller-layout.js'
import {
  renderWelcome,
  welcomeCss,
  welcomeRuntimeScriptBody,
} from '@gbox/core/modules/ui/onboarding/welcome.js'
import { renderFeaturedLibraryCardsHtml } from './library.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Narrow the `?tab=` value. 2026-04-26: clone tab dropped — only the
 * library tab remains, so this always resolves to 'library'. Kept as a
 * function for renderWelcome's contract; the parameter is ignored.
 */
function resolveActiveTab(_raw: unknown): 'library' {
  return 'library'
}

/**
 * Narrow the `?welcome=` value. Accepting only the literal '1' means
 * `/onboarding/first-run?welcome=yes` won't accidentally fire the big
 * hero — if somebody rolls a new variant we'll opt in explicitly.
 */
function resolveWelcome(raw: unknown): boolean {
  return raw === '1'
}

/**
 * Narrow the `?from=` value. Only `domain-verified` is recognised for
 * now (Phase E landing). Other values fall through silently so future
 * campaigns can drop their own `?from=xyz` without risk of this page
 * accidentally rendering their banner.
 */
function resolveFromSource(raw: unknown): 'domain-verified' | null {
  return raw === 'domain-verified' ? 'domain-verified' : null
}

/** Tiny banner ribbon for the "Your domain is live!" celebratory nudge. */
function renderDomainVerifiedBanner(): string {
  return `
<div class="onboarding-banner onboarding-banner--success" role="status">
  <span class="onboarding-banner__icon" aria-hidden="true">🎉</span>
  <div>
    <strong>Your domain is live!</strong>
    <span> Now pick how you want to build your store.</span>
  </div>
</div>`
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function getOnboardingFirstRun(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  // --- 1. Terminal / transient states redirect out. -----------------

  const state = (store as any).onboarding_state ?? 'pending'

  if (state === 'completed') {
    res.redirect(302, base)
    return
  }
  // 2026-04-26: Clone-Pro re-scoped to god-admin-only. Any shop still
  // carrying onboarding_state='cloning' from before the cutover falls
  // through to the welcome page — god admin resumes the clone job via
  // internal tooling and resets the state back to 'pending' or 'completed'.

  // --- 2. Resolve query knobs (pending/skipped/defensive-cloning fall here). -

  const q = (req.query ?? {}) as Record<string, unknown>
  const activeTab = resolveActiveTab(q.tab)
  const welcome = resolveWelcome(q.welcome)
  const fromSource = resolveFromSource(q.from)

  // --- 3. Pre-render the Theme Library grid (or empty → empty state). ----

  const libraryCardsHtml = await renderFeaturedLibraryCardsHtml(db, store.slug)

  // --- 4. CSRF for the skip form. -----------------------------------
  //
  // The store-admin app-level middleware mounted on /admin/store/:slug
  // sets `req.csrfToken` to a STRING (the result of
  // `csrfStore.getOrIssue()`). The function-style read here was a
  // copy-paste from a `csrf-csrf` example and silently rendered an
  // EMPTY token in production — every onboarding skip form submit
  // would 403. Same root cause as the clone form's broken CSRF
  // (incident 2026-04-25).
  const rawToken = (req as any).csrfToken
  const csrfToken =
    typeof rawToken === 'string'
      ? rawToken
      : typeof rawToken === 'function'
        ? rawToken() // legacy / test-mock support; real middleware never hits this
        : ''

  // --- 5. Render. ---------------------------------------------------

  const welcomeHtml = renderWelcome({
    storeSlug: store.slug,
    welcome,
    activeTab,
    csrfToken,
    skipAction: `${base}/onboarding/skip`,
    libraryFullHref: `${base}/online-store/library?from=onboarding`,
    libraryCardsHtml,
  })

  const banner = fromSource === 'domain-verified' ? renderDomainVerifiedBanner() : ''
  // Phase 20 P1 — show the seller their store URL right at the top of
  // the wizard. After P0 every shop has a working <slug>.gbox.co
  // subdomain from minute zero, so we can promise this URL is LIVE
  // (not "after you publish" or "after you add a domain"). Custom
  // domain becomes the upgrade path, not the prerequisite.
  const liveUrl = `https://${store.slug}.gbox.co`
  const escUrl = liveUrl
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const liveUrlStrip = `
    <div class="onboarding-live-url" role="status">
      <div class="onboarding-live-url__icon" aria-hidden="true">🌐</div>
      <div class="onboarding-live-url__body">
        <div class="onboarding-live-url__label">Your store is already live at</div>
        <a class="onboarding-live-url__link" href="${escUrl}" target="_blank" rel="noopener noreferrer">${escUrl} ↗</a>
      </div>
    </div>`

  const content = `
    <style>${welcomeCss()}
      .onboarding-banner {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 18px;
        border-radius: 10px;
        margin: 0 0 20px;
        background: var(--god-accent-soft, rgba(59,130,246,0.12));
        border: 1px solid var(--god-accent, #3b82f6);
        color: var(--god-text, #f3f4f6);
      }
      .onboarding-banner--success {
        background: rgba(34,197,94,0.12);
        border-color: rgba(34,197,94,0.6);
      }
      .onboarding-banner__icon {
        font-size: 22px;
      }
      .onboarding-live-url {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 12px 16px;
        border-radius: 10px;
        margin: 0 0 16px;
        background: rgba(34,197,94,0.10);
        border: 1px solid rgba(34,197,94,0.45);
        color: var(--god-text, #f3f4f6);
      }
      .onboarding-live-url__icon { font-size: 20px; }
      .onboarding-live-url__body { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
      .onboarding-live-url__label {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--god-text-muted, #9ca3af);
      }
      .onboarding-live-url__link {
        font-family: 'SF Mono', Menlo, monospace;
        font-size: 14px;
        font-weight: 600;
        color: var(--god-accent, #3b82f6);
        text-decoration: none;
        word-break: break-all;
      }
      .onboarding-live-url__link:hover { text-decoration: underline; }
    </style>
    ${liveUrlStrip}
    ${banner}
    ${welcomeHtml}
    <script>${welcomeRuntimeScriptBody()}</script>
  `

  res.send(
    sellerLayout({
      title: 'Welcome to Gbox',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: (user as any).storeRole ?? 'owner',
      activePage: 'onboarding',
      content,
      cookieHeader: req.headers?.cookie ?? null,
    }),
  )
}
