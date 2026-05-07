/**
 * Gbox Platform — Onboarding Welcome page component (Phase B / Task B2).
 *
 * Shopify-inspired two-tab welcome screen. Rendered by the store-admin
 * handler at `GET /admin/store/:slug/onboarding/first-run` when a
 * freshly-created store lands in `onboarding_state='pending'`.
 *
 * Layout
 * ------
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ [Welcome to Gbox!]  ← only when ?welcome=1          │
 *   │ A one-line pitch                                    │
 *   │                                                     │
 *   │ ┌──────────────────┐ ┌──────────────────┐           │
 *   │ │🚀 Clone from URL │ │🎨 Theme Library  │ ← tablist │
 *   │ └──────────────────┘ └──────────────────┘           │
 *   │ ┌───────────────────────────────────────┐           │
 *   │ │ Panel body (one of tabs, the other    │           │
 *   │ │ is `hidden`).                         │           │
 *   │ └───────────────────────────────────────┘           │
 *   └─────────────────────────────────────────────────────┘
 *
 * Tab 1 — Clone from URL   (default)
 *   - Pitch copy + big primary "Start cloning →" linking to
 *     `/admin/store/:slug/onboarding/clone`.
 *   - Tertiary "I'll do this later" POST form → marks
 *     `onboarding_state='skipped'` (Task A3 mutator).
 *
 * Tab 2 — Theme Library
 *   - 3-4 pre-rendered library preview cards (Task B3).
 *   - "Browse full library →" link into the design-library gallery.
 *   - Empty-state fallback when no featured rows are seeded yet — so
 *     a fresh DB without the seed script run still renders cleanly.
 *
 * ARIA contract (WAI-ARIA tablist pattern)
 * ----------------------------------------
 *
 *   role="tablist" wraps two role="tab" buttons with aria-selected +
 *   aria-controls; each role="tabpanel" carries aria-labelledby back
 *   to its tab. The inactive panel uses the `hidden` attribute (not
 *   display:none) so assistive tech correctly skips it.
 *
 * Label discipline
 * ----------------
 *
 *   Per Thai's rename (2026-04-18, "cho đúng bản chất"), every
 *   user-visible label on this surface says "Theme Library". The
 *   older internal label survives only as plumbing: the
 *   `libraryFullHref` prop's URL may contain the `design-library`
 *   route slug since URLs are not visible copy. A companion
 *   label-audit test (label-audit.test.ts) greps this file + CSS for
 *   the forbidden literal to lock the invariant.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WelcomeProps {
  /** Store slug — used for building tab routing + skip URL labels. */
  storeSlug: string
  /**
   * When true, render the giant "Welcome to Gbox!" H1. The accounts
   * portal sets ?welcome=1 on first redirect in; subsequent revisits
   * (seller clicks logo, clicks back) drop it for a calmer UX.
   */
  welcome: boolean
  /**
   * Which tab is selected on initial render. 2026-04-26: clone tab
   * dropped (god-admin-only concierge tooling now); only 'library'
   * remains. Field kept to preserve the public type signature.
   */
  activeTab: 'library'
  /** Anti-CSRF token for the skip form. */
  csrfToken: string
  /** form action for the "I'll do this later" POST. */
  skipAction: string
  /**
   * href for the "Browse full library →" link on tab 2. Typically
   * `/admin/store/:slug/design-library?from=onboarding`. URL may
   * contain `design-library` — that's plumbing, not a visible label.
   */
  libraryFullHref: string
  /**
   * Pre-rendered HTML for the library preview cards. Empty string
   * triggers the "Theme Library coming soon" empty state. Caller is
   * responsible for rendering via `libraryPreviewCards()` (Task B3).
   */
  libraryCardsHtml: string
}

// ---------------------------------------------------------------------------
// Safe HTML escape — used for every interpolated prop value.
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Hero block — only shown with ?welcome=1 to avoid shouting at returning sellers.
// ---------------------------------------------------------------------------

function renderHero(welcome: boolean): string {
  if (!welcome) return ''
  return `
<header class="onboarding-hero">
  <h1 class="onboarding-hero__title">Welcome to Gbox! 🎉</h1>
  <p class="onboarding-hero__sub">
    Let's get your store looking great. Pick how you want to start —
    you can always change your mind later.
  </p>
</header>`
}

// ---------------------------------------------------------------------------
// Theme Library panel — only panel after 2026-04-26 clone-pro retirement.
// ---------------------------------------------------------------------------

function renderLibraryPanel(p: WelcomeProps, isActive: boolean): string {
  const hiddenAttr = isActive ? '' : ' hidden'
  const hasCards = p.libraryCardsHtml.trim().length > 0
  const skipFormHtml = `
  <form method="post"
        action="${esc(p.skipAction)}"
        class="onboarding-skip-form">
    <input type="hidden" name="_csrf" value="${esc(p.csrfToken)}">
    <button type="submit" class="onboarding-skip-btn">
      I'll do this later
    </button>
  </form>`
  const body = hasCards
    ? `
  <div class="onboarding-library-grid">
    ${p.libraryCardsHtml}
  </div>
  <div class="onboarding-library-footer">
    <a class="onboarding-library-browse"
       href="${esc(p.libraryFullHref)}">
      Browse full library →
    </a>
  </div>`
    : `
  <div class="onboarding-library-empty" role="status">
    <p class="onboarding-library-empty__title">Theme Library coming soon</p>
    <p class="onboarding-library-empty__body">
      Our curated theme picks are syncing — check back in a moment,
      or start with a URL clone instead.
    </p>
    <a class="onboarding-library-browse"
       href="${esc(p.libraryFullHref)}">
      Browse full library →
    </a>
  </div>`
  return `
<section role="tabpanel"
         id="panel-library"
         aria-labelledby="tab-library"
         class="onboarding-panel onboarding-panel--library"${hiddenAttr}>
  <div class="onboarding-pitch">
    <h2 class="onboarding-pitch__title">Start from a curated Theme Library</h2>
    <p class="onboarding-pitch__body">
      Hand-picked brand themes — preview them, copy the DESIGN.md spec,
      or install straight into your store.
    </p>
  </div>
  ${body}
  ${skipFormHtml}
</section>`
}

// ---------------------------------------------------------------------------
// Top-level render.
// ---------------------------------------------------------------------------

export function renderWelcome(p: WelcomeProps): string {
  // 2026-04-26: Clone tab dropped (god-admin-only concierge tooling).
  // The wizard now ships only the Theme Library panel — no tablist, just
  // a heading + cards + skip form.
  return `
<main class="onboarding-root" role="main">
  ${renderHero(p.welcome)}
  ${renderLibraryPanel(p, true)}
</main>`
}

// ---------------------------------------------------------------------------
// Inline CSS — tokenized via the shared --god-* variables so it tints
// correctly in both dark and light mode without duplication.
// ---------------------------------------------------------------------------

export function welcomeCss(): string {
  return `
    .onboarding-root {
      max-width: 880px;
      margin: 0 auto;
      padding: 48px 24px 64px;
      color: var(--god-text, #f3f4f6);
      font-family: inherit;
    }
    .onboarding-hero {
      text-align: center;
      margin-bottom: 36px;
    }
    .onboarding-hero__title {
      font-size: 32px;
      font-weight: 700;
      margin: 0 0 8px;
      letter-spacing: -0.02em;
      color: var(--god-text, #f3f4f6);
    }
    .onboarding-hero__sub {
      font-size: 15px;
      line-height: 1.5;
      color: var(--god-text-secondary, #9ca3af);
      max-width: 560px;
      margin: 0 auto;
    }
    .onboarding-tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 24px;
    }
    .onboarding-tab {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      padding: 18px 20px;
      border-radius: 12px;
      background: var(--god-surface, rgba(255,255,255,0.03));
      border: 1px solid var(--god-border, rgba(255,255,255,0.08));
      color: var(--god-text, #f3f4f6);
      font-family: inherit;
      text-align: left;
      cursor: pointer;
      transition: transform 0.1s ease, background 0.1s ease, border-color 0.1s ease;
    }
    .onboarding-tab:hover {
      transform: translateY(-1px);
      background: var(--god-surface-hover, rgba(255,255,255,0.05));
    }
    .onboarding-tab[aria-selected="true"] {
      background: var(--god-accent-soft, rgba(59,130,246,0.12));
      border-color: var(--god-accent, #3b82f6);
    }
    .onboarding-tab:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }
    .onboarding-tab__icon {
      font-size: 22px;
      margin-bottom: 8px;
    }
    .onboarding-tab__label {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .onboarding-tab__hint {
      font-size: 12px;
      color: var(--god-text-secondary, #9ca3af);
    }
    .onboarding-panel {
      background: var(--god-surface, rgba(255,255,255,0.03));
      border: 1px solid var(--god-border, rgba(255,255,255,0.08));
      border-radius: 12px;
      padding: 32px;
    }
    .onboarding-panel[hidden] {
      display: none;
    }
    .onboarding-pitch__title {
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 8px;
      color: var(--god-text, #f3f4f6);
    }
    .onboarding-pitch__body {
      font-size: 14px;
      line-height: 1.6;
      color: var(--god-text-secondary, #9ca3af);
      margin: 0 0 24px;
      max-width: 560px;
    }
    .onboarding-actions {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    .onboarding-cta {
      display: inline-flex;
      align-items: center;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      border: 1px solid transparent;
      transition: transform 0.1s ease, box-shadow 0.1s ease;
    }
    .onboarding-cta--primary {
      background: var(--god-accent, #3b82f6);
      color: #ffffff;
    }
    .onboarding-cta--primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(59,130,246,0.3);
    }
    .onboarding-cta:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }
    .onboarding-skip-form {
      margin: 0;
    }
    .onboarding-skip-btn {
      background: transparent;
      border: none;
      padding: 8px 4px;
      font-size: 13px;
      font-weight: 500;
      color: var(--god-text-secondary, #9ca3af);
      cursor: pointer;
      text-decoration: underline;
      font-family: inherit;
    }
    .onboarding-skip-btn:hover {
      color: var(--god-text, #f3f4f6);
    }
    .onboarding-skip-btn:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
      border-radius: 4px;
    }
    .onboarding-library-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .onboarding-library-footer {
      text-align: right;
    }
    .onboarding-library-browse {
      display: inline-block;
      font-size: 13px;
      font-weight: 500;
      color: var(--god-accent, #3b82f6);
      text-decoration: none;
    }
    .onboarding-library-browse:hover {
      text-decoration: underline;
    }
    .onboarding-library-empty {
      text-align: center;
      padding: 28px 16px;
      background: var(--god-surface-low, rgba(255,255,255,0.02));
      border-radius: 8px;
    }
    .onboarding-library-empty__title {
      font-size: 15px;
      font-weight: 600;
      margin: 0 0 6px;
      color: var(--god-text, #f3f4f6);
    }
    .onboarding-library-empty__body {
      font-size: 13px;
      line-height: 1.5;
      color: var(--god-text-secondary, #9ca3af);
      max-width: 440px;
      margin: 0 auto 14px;
    }
    @media (max-width: 600px) {
      .onboarding-tabs {
        grid-template-columns: 1fr;
      }
      .onboarding-panel {
        padding: 20px;
      }
      .onboarding-hero__title {
        font-size: 26px;
      }
    }
  `
}

// ---------------------------------------------------------------------------
// Runtime script — inline vanilla JS that wires the tablist.
//
// Exported as a string (not a module) because the store-admin pages
// inline their runtime JS into a <script> tag rather than shipping
// bundles. Keeping it vanilla + tiny is the simplest shape.
//
// Behaviour:
//  - Click a tab → flip `aria-selected`, set the inactive tab's
//    `tabindex=-1`, toggle the matching panel's `hidden` attribute,
//    update `?tab=` query via history.replaceState (so a reload keeps
//    the user on the same tab).
//  - ArrowLeft / ArrowRight on a focused tab → move focus + activate
//    the sibling tab (WAI-ARIA tablist pattern).
// ---------------------------------------------------------------------------

export function welcomeRuntimeScriptBody(): string {
  return `
(function(){
  var tabs = Array.prototype.slice.call(
    document.querySelectorAll('[role="tab"]'),
  );
  if (tabs.length !== 2) return;
  function activate(targetId) {
    tabs.forEach(function (t) {
      var isActive = t.id === targetId;
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
      t.setAttribute('tabindex', isActive ? '0' : '-1');
      var panelId = t.getAttribute('aria-controls');
      var panel = panelId ? document.getElementById(panelId) : null;
      if (panel) {
        if (isActive) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
      }
    });
    // Reflect in the URL so reloads land on the same tab.
    try {
      var url = new URL(window.location.href);
      if (targetId === 'tab-library') url.searchParams.set('tab', 'library');
      else url.searchParams.delete('tab');
      history.replaceState(null, '', url.toString());
    } catch (e) { /* no-op — older browsers */ }
  }
  tabs.forEach(function (tab, idx) {
    tab.addEventListener('click', function () {
      activate(tab.id);
      tab.focus();
    });
    tab.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        var next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        activate(next.id);
        next.focus();
      } else if (e.key === 'Home') {
        e.preventDefault(); activate(tabs[0].id); tabs[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault(); activate(tabs[tabs.length - 1].id); tabs[tabs.length - 1].focus();
      }
    });
  });
})();
`
}
