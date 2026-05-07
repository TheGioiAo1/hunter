/**
 * Gbox Checkout — HTML layout shell
 *
 * Pure functions that build the page chrome (doctype, head, body skeleton).
 * No template engine — these are tagged-template-style helpers so we can
 * audit every byte that lands in the response. The CSP forbids inline
 * scripts, so all interactivity comes from `/static/checkout-init.js`.
 *
 * Why no Liquid / Handlebars / React?
 *   1. Decision #1 (liquidjs themes) governs the *storefront*, NOT the
 *      checkout. Checkout is Gbox-controlled and identical for every
 *      shop — themability would defeat the PCI scope split.
 *   2. Inlining the HTML in TS keeps the build trivial and the CSP
 *      auditable: there's no template that could pull in third-party
 *      partials at runtime.
 */

/**
 * Escape a value for safe interpolation into HTML text or attribute
 * contexts. Use for ANY value that came from the user, the API, or the
 * database. Constants known at compile time can be inlined directly.
 */
export function esc(s: unknown): string {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface LayoutOptions {
  title: string
  /** Body content (already-escaped HTML). */
  body: string
  /** Optional shop name to render in the header. */
  shopName?: string | null
  /** Optional checkout id, rendered in the footer. */
  checkoutId?: string | null
  /** Optional inline script tags (e.g. PayPal SDK loader). */
  headScripts?: string
  /** Optional <link rel> tags for CSS hosted on /static. */
  headLinks?: string
}

const BASE_CSS = `
:root {
  color-scheme: light;
  --bg: #f6f6f7;
  --card-bg: #ffffff;
  --fg: #1f2327;
  --muted: #6d7175;
  --border: #e1e3e5;
  --accent: #008060;
  --accent-fg: #ffffff;
  --error: #d72c0d;
  --radius: 8px;
  --shadow: 0 1px 0 rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.1);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--fg);
  background: var(--bg);
}
.checkout-shell {
  max-width: 1080px;
  margin: 0 auto;
  padding: 32px 24px 64px;
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 48px;
}
@media (max-width: 720px) {
  .checkout-shell { grid-template-columns: 1fr; padding: 16px; gap: 24px; }
}
.checkout-header {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.brand { font-weight: 600; font-size: 20px; }
.secure-pill {
  font-size: 12px;
  color: var(--muted);
  background: #fff;
  border: 1px solid var(--border);
  padding: 4px 10px;
  border-radius: 999px;
}
.card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 24px;
}
.card + .card { margin-top: 16px; }
h1, h2 { margin: 0 0 16px; }
h1 { font-size: 22px; }
h2 { font-size: 16px; }
label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
input[type="text"], input[type="email"], select {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 14px;
  background: #fff;
}
input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.field { margin-bottom: 14px; }
.row { display: flex; gap: 12px; }
.row > .field { flex: 1; }
.btn {
  display: inline-block;
  padding: 12px 18px;
  background: var(--accent);
  color: var(--accent-fg);
  border: none;
  border-radius: 6px;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
}
.btn:hover { filter: brightness(0.95); }
.btn[disabled] { opacity: 0.6; cursor: not-allowed; }
.btn-link { background: none; color: var(--accent); border: none; padding: 0; font: inherit; cursor: pointer; }
.summary-line {
  display: flex; justify-content: space-between; padding: 6px 0;
  font-size: 14px;
}
.summary-line.total {
  border-top: 1px solid var(--border);
  margin-top: 8px;
  padding-top: 12px;
  font-weight: 600;
  font-size: 16px;
}
.error {
  background: #fff4f4;
  border: 1px solid var(--error);
  color: var(--error);
  padding: 12px 16px;
  border-radius: 6px;
  margin-bottom: 16px;
  font-size: 14px;
}
.steps {
  list-style: none;
  padding: 0;
  margin: 0 0 24px;
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: var(--muted);
}
.steps li.active { color: var(--fg); font-weight: 600; }
.steps li.done::after { content: " ✓"; color: var(--accent); }
.line-item {
  display: flex; gap: 12px; padding: 8px 0;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
}
.line-item:last-child { border-bottom: none; }
.line-item .qty {
  flex: 0 0 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #f0f0f0;
  border-radius: 4px;
  font-size: 12px;
}
.line-item .title { flex: 1; }
.line-item .price { flex: 0 0 auto; }
.checkout-footer {
  grid-column: 1 / -1;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  padding-top: 24px;
  border-top: 1px solid var(--border);
}
#gbox-paypal-buttons { min-height: 50px; }
.pay-block-status {
  font-size: 13px;
  color: var(--muted);
  margin-top: 12px;
  text-align: center;
}
`

export function renderLayout(opts: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(opts.title)} — Secure Checkout</title>
<style>${BASE_CSS}</style>
${opts.headLinks ?? ''}
${opts.headScripts ?? ''}
</head>
<body>
<main class="checkout-shell">
  <header class="checkout-header">
    <div class="brand">${esc(opts.shopName ?? 'Gbox')}</div>
    <div class="secure-pill">🔒 Secure checkout · checkout.gbox.co</div>
  </header>
  ${opts.body}
  <footer class="checkout-footer">
    Powered by Gbox · ${opts.checkoutId ? `Reference: ${esc(opts.checkoutId)}` : ''}
  </footer>
</main>
</body>
</html>`
}
