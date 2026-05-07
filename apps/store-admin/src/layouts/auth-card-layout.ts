/**
 * Gbox Store Admin — Auth-Card Layout (white card on dark gradient)
 *
 * Used by the top-level `/stores` hub and `/stores/new` routes that live
 * OUTSIDE the per-shop dashboard. Deliberately matches the accounts-portal
 * look so the jump from accounts.<platform>/login → admin.<platform>/stores
 * feels like one continuous flow — Shopify style.
 *
 * NOTE: This is a duplicate of `apps/accounts/src/layouts/auth-layout.ts`.
 * They must stay visually identical. If you change one, change both. The
 * duplication is intentional: each app is a standalone express build that
 * ships its own assets, and promoting this file to a shared package would
 * balloon the scope of Phase 0.5.
 */

export interface LayoutOptions {
  title: string
  /** Content HTML to render inside the card */
  content: string
  /** Optional wider card (for stores list) */
  wide?: boolean
  /** Hide the card wrapper (for custom layouts) */
  noCard?: boolean
}

export function authCardLayout(opts: LayoutOptions): string {
  const { title, content, wide = false, noCard = false } = opts
  const maxWidth = wide ? '720px' : '440px'

  const cardHtml = noCard
    ? `<div style="width:100%;max-width:${maxWidth};padding:0 16px">${content}</div>`
    : `<div class="card" style="max-width:${maxWidth}">${content}</div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Gbox</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
      min-height: 100vh;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      color: #1e293b;
      padding: 24px 16px;
    }
    .logo { margin-bottom: 32px; text-align: center; }
    .logo-text { font-size: 32px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; }
    .logo-text span { color: #3b82f6; }

    .card {
      background: #ffffff; border-radius: 16px; padding: 40px; width: 100%;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }

    h1 { font-size: 24px; font-weight: 700; color: #0f172a; margin-bottom: 8px; }
    .subtitle { color: #64748b; font-size: 14px; margin-bottom: 24px; }

    .form-group { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 6px; }
    input[type="text"], input[type="email"], input[type="password"], select {
      width: 100%; padding: 10px 14px;
      border: 1.5px solid #d1d5db; border-radius: 10px;
      font-size: 15px; font-family: inherit;
      background: #f9fafb; color: #1e293b;
      transition: border-color 0.15s, box-shadow 0.15s;
      outline: none;
    }
    input:focus, select:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
      background: #ffffff;
    }
    input::placeholder { color: #9ca3af; }

    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 100%; padding: 11px 20px;
      border: none; border-radius: 10px;
      font-size: 15px; font-weight: 600; font-family: inherit;
      cursor: pointer;
      transition: background-color 0.15s, transform 0.1s;
      text-decoration: none; text-align: center;
    }
    .btn:active { transform: scale(0.98); }
    .btn-primary { background: #3b82f6; color: #ffffff; }
    .btn-primary:hover { background: #2563eb; }
    .btn-secondary { background: #f1f5f9; color: #374151; border: 1.5px solid #e2e8f0; }
    .btn-secondary:hover { background: #e2e8f0; }

    .error-msg {
      background: #fef2f2; color: #dc2626; border: 1px solid #fecaca;
      border-radius: 8px; padding: 10px 14px; font-size: 14px; margin-bottom: 16px;
    }

    .link { color: #3b82f6; text-decoration: none; font-weight: 500; }
    .link:hover { text-decoration: underline; }

    .text-center { text-align: center; }
    .text-sm { font-size: 13px; color: #64748b; }
    .mt-16 { margin-top: 16px; }
    .mt-24 { margin-top: 24px; }

    .footer { margin-top: 32px; text-align: center; color: #64748b; font-size: 12px; }
    .footer a { color: #94a3b8; text-decoration: none; margin: 0 8px; }
    .footer a:hover { color: #cbd5e1; }

    /* Store cards */
    .store-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px; margin-top: 16px;
    }
    .store-card {
      display: block; background: #f8fafc;
      border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 20px;
      text-decoration: none; color: inherit;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .store-card:hover {
      border-color: #3b82f6;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.1);
    }
    .store-card-name { font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 4px; }
    .store-card-slug { font-size: 13px; color: #64748b; margin-bottom: 8px; }
    .store-card-meta { display: flex; align-items: center; gap: 12px; font-size: 12px; color: #94a3b8; }

    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 6px;
      font-size: 11px; font-weight: 600; text-transform: uppercase;
    }
    .badge-owner { background: #dbeafe; color: #1d4ed8; }
    .badge-admin { background: #f3e8ff; color: #7c3aed; }
    .badge-staff { background: #fef3c7; color: #b45309; }

    @media (max-width: 480px) {
      .card { padding: 24px 20px; }
      body { padding: 16px 12px; }
      .store-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="logo">
    <div class="logo-text">G<span>box</span></div>
  </div>
  ${cardHtml}
  <div class="footer">
    <a href="/terms">Terms</a>
    <a href="/privacy">Privacy</a>
    <a href="/contact">Contact</a>
  </div>
</body>
</html>`
}
