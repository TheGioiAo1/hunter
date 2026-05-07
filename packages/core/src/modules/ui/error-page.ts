/**
 * Gbox Platform — Error Page Templates (Phase 2 Step 2.11)
 *
 * Shared 4xx / 5xx error page renderers. Every admin error response
 * goes through `errorPage()` so the look is consistent across 404
 * Not Found, 403 Forbidden, 500 Internal Server Error, and any
 * custom code we need.
 *
 * The page body is deliberately self-contained — it doesn't depend
 * on the surrounding layout, so an error handler can return it even
 * when the layout itself is the thing that crashed.
 *
 * What we show
 * ------------
 * - A big status code (`404`, `500`, etc.)
 * - A human-readable title ("Page not found")
 * - A detail sentence explaining what happened
 * - A primary CTA (e.g., "Back to dashboard")
 * - An optional secondary CTA
 * - An optional support / debug line
 *
 * Philosophy: "clone giống hệt Shopify" — Shopify's error pages all
 * follow the same skeleton (big number + reassuring message + CTA).
 * "power-ful hơn Shopify nhờ Claude" — one renderer drives every
 * surface so fixing a typo fixes all three error types at once.
 */

// ---------------------------------------------------------------------------
// Helpers
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
// Types
// ---------------------------------------------------------------------------

export interface ErrorPageAction {
  label: string
  href: string
  /** `primary` (filled) is the default, `secondary` is outlined. */
  kind?: 'primary' | 'secondary'
}

export interface ErrorPageOptions {
  /** HTTP status code displayed as the headline number. */
  code: number | string
  /** Main heading (e.g., "Page not found"). */
  title: string
  /** Optional body text. Plain sentence — no HTML. */
  detail?: string
  /** Optional primary + secondary call-to-action buttons. */
  actions?: ErrorPageAction[]
  /**
   * Optional request id / trace id surfaced at the bottom of the
   * page. Handy for support tickets ("tell them it's req_abcd123").
   */
  requestId?: string
  /** Optional support contact line. */
  supportHref?: string
  /** Optional support label override. Defaults to the href. */
  supportLabel?: string
  /** Icon override. Defaults to an error glyph based on the code. */
  iconSvg?: string
}

// ---------------------------------------------------------------------------
// errorPage()
// ---------------------------------------------------------------------------

/**
 * Render the error page markup (minus the outer layout). Wrap this
 * inside `godLayout.render()` / `sellerLayout.render()` to get the
 * full admin chrome, OR return it standalone for an error mid-layout.
 */
export function errorPage(opts: ErrorPageOptions): string {
  const {
    code,
    title,
    detail,
    actions = [],
    requestId,
    supportHref,
    supportLabel,
    iconSvg,
  } = opts

  const buttonsHtml = actions
    .map(a => {
      const kind = a.kind ?? 'primary'
      return `<a href="${esc(a.href)}" class="gbox-err-btn gbox-err-btn-${esc(kind)}">${esc(a.label)}</a>`
    })
    .join('')

  const detailHtml = detail
    ? `<p class="gbox-err-detail">${esc(detail)}</p>`
    : ''

  const requestHtml = requestId
    ? `<p class="gbox-err-trace"><span>Request id:</span> <code>${esc(requestId)}</code></p>`
    : ''

  const supportHtml = supportHref
    ? `<p class="gbox-err-support"><a href="${esc(supportHref)}">${esc(supportLabel ?? supportHref)}</a></p>`
    : ''

  const icon = iconSvg ?? defaultErrorIcon(code)

  return `
    <section class="gbox-err" role="alert" aria-labelledby="gbox-err-title">
      <div class="gbox-err-icon" aria-hidden="true">${icon}</div>
      <div class="gbox-err-code">${esc(String(code))}</div>
      <h1 id="gbox-err-title" class="gbox-err-title">${esc(title)}</h1>
      ${detailHtml}
      <div class="gbox-err-actions">${buttonsHtml}</div>
      ${requestHtml}
      ${supportHtml}
    </section>
  `.trim()
}

// ---------------------------------------------------------------------------
// Convenience shortcuts
// ---------------------------------------------------------------------------

/**
 * Convenience shortcuts require `dashboardHref` as the first positional
 * argument so every caller declares the dashboard path explicitly —
 * god-admin callers pass `'/god-admin'`, seller-facing callers pass
 * `'/admin'` (or their store-scoped base). Previously this defaulted
 * to `'/god-admin'` which meant any future seller caller that forgot
 * to pass `overrides.actions` would leak a god-admin path into the
 * seller UI (Iron Rule 5 violation). Making it required turns that
 * oversight into a TypeScript compile error instead of a runtime leak.
 */

/** 404 Not Found — the most common error. */
export function notFoundPage(
  dashboardHref: string,
  overrides: Partial<ErrorPageOptions> = {},
): string {
  return errorPage({
    code: 404,
    title: 'Page not found',
    detail:
      "The page you're looking for doesn't exist or has been moved. Double-check the URL or head back to the dashboard.",
    actions: [{ label: 'Back to dashboard', href: dashboardHref, kind: 'primary' }],
    ...overrides,
  })
}

/** 403 Forbidden — user is logged in but lacks permission. */
export function forbiddenPage(
  dashboardHref: string,
  overrides: Partial<ErrorPageOptions> = {},
): string {
  return errorPage({
    code: 403,
    title: "You don't have access",
    detail:
      'Your account is signed in, but it lacks permission for this page. If you think this is a mistake, contact an administrator.',
    actions: [{ label: 'Back to dashboard', href: dashboardHref, kind: 'primary' }],
    ...overrides,
  })
}

/** 500 Internal Server Error — something crashed. */
export function serverErrorPage(
  dashboardHref: string,
  overrides: Partial<ErrorPageOptions> = {},
): string {
  return errorPage({
    code: 500,
    title: 'Something went wrong',
    detail:
      "Our servers hit an unexpected error. The team has been notified — please try again in a moment, or reach out if the problem persists.",
    actions: [
      { label: 'Try again', href: '#', kind: 'primary' },
      { label: 'Back to dashboard', href: dashboardHref, kind: 'secondary' },
    ],
    ...overrides,
  })
}

/** 401 Unauthorized — user needs to sign in. */
export function unauthorizedPage(
  overrides: Partial<ErrorPageOptions> = {},
): string {
  return errorPage({
    code: 401,
    title: 'Please sign in',
    detail: 'This page requires authentication. Sign in to continue.',
    actions: [{ label: 'Sign in', href: '/login', kind: 'primary' }],
    ...overrides,
  })
}

/** 503 Service Unavailable — maintenance or overload. */
export function serviceUnavailablePage(
  overrides: Partial<ErrorPageOptions> = {},
): string {
  return errorPage({
    code: 503,
    title: 'Service unavailable',
    detail:
      "We're doing quick maintenance. This usually only takes a few minutes — please try again shortly.",
    actions: [{ label: 'Try again', href: '#', kind: 'primary' }],
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Default icon per status family
// ---------------------------------------------------------------------------

function defaultErrorIcon(code: number | string): string {
  const n = typeof code === 'number' ? code : Number(code)
  if (Number.isFinite(n) && n >= 500) {
    // Server-side failure — broken gear.
    return `<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`
  }
  if (Number.isFinite(n) && (n === 403 || n === 401)) {
    // Access denied — locked.
    return `<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
  }
  // Default: 404-style "lost compass".
  return `<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M16 8l-4 8-4-4 8-4z"/></svg>`
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

export function errorPageCss(): string {
  return `
    .gbox-err {
      max-width: 520px;
      margin: 64px auto;
      text-align: center;
      padding: 40px 24px;
    }
    .gbox-err-icon {
      color: var(--god-text-muted, #9ca3af);
      margin-bottom: 16px;
    }
    .gbox-err-code {
      font-size: 72px;
      font-weight: 800;
      line-height: 1;
      color: var(--god-text, #111);
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }
    .gbox-err-title {
      font-size: 22px;
      font-weight: 600;
      margin: 0 0 12px 0;
      color: var(--god-text, #111);
    }
    .gbox-err-detail {
      font-size: 14px;
      line-height: 1.55;
      color: var(--god-text-muted, #6b7280);
      margin: 0 auto 24px auto;
      max-width: 420px;
    }
    .gbox-err-actions {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: center;
      margin-bottom: 20px;
    }
    .gbox-err-btn {
      display: inline-flex;
      align-items: center;
      padding: 10px 20px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      border: 1px solid transparent;
      transition: background-color 0.15s, border-color 0.15s;
    }
    .gbox-err-btn-primary {
      background: var(--god-accent, #3b82f6);
      color: #fff;
    }
    .gbox-err-btn-primary:hover {
      background: var(--god-accent-hover, #2563eb);
    }
    .gbox-err-btn-secondary {
      background: transparent;
      color: var(--god-text, #111);
      border-color: var(--god-border, #d1d5db);
    }
    .gbox-err-btn-secondary:hover {
      background: var(--god-bg-muted, #f3f4f6);
    }
    .gbox-err-trace {
      margin: 12px 0 0 0;
      font-size: 12px;
      color: var(--god-text-muted, #9ca3af);
    }
    .gbox-err-trace code {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      background: var(--god-bg-muted, #f3f4f6);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .gbox-err-support {
      margin: 8px 0 0 0;
      font-size: 13px;
    }
    .gbox-err-support a {
      color: var(--god-accent, #3b82f6);
      text-decoration: none;
    }
    .gbox-err-support a:hover {
      text-decoration: underline;
    }
  `
}
