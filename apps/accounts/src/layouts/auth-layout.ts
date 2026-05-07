/**
 * Gbox Accounts Portal — Auth Layout
 *
 * Wraps all account pages in a consistent HTML shell:
 * dark gradient background, centered white card, Gbox branding.
 */

export interface LayoutOptions {
  title: string
  /** Content HTML to render inside the card */
  content: string
  /** Optional wider card (for stores list, account settings) */
  wide?: boolean
  /** Hide the card wrapper (for custom layouts) */
  noCard?: boolean
}

export function authLayout(opts: LayoutOptions): string {
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
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #1e293b;
      padding: 24px 16px;
    }

    .logo {
      margin-bottom: 32px;
      text-align: center;
    }

    .logo-text {
      font-size: 32px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -0.5px;
    }

    .logo-text span {
      color: #3b82f6;
    }

    .card {
      background: #ffffff;
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }

    h1 {
      font-size: 24px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 8px;
    }

    .subtitle {
      color: #64748b;
      font-size: 14px;
      margin-bottom: 24px;
    }

    .form-group {
      margin-bottom: 16px;
    }

    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 6px;
    }

    input[type="text"],
    input[type="email"],
    input[type="password"],
    select {
      width: 100%;
      padding: 10px 14px;
      border: 1.5px solid #d1d5db;
      border-radius: 10px;
      font-size: 15px;
      font-family: inherit;
      background: #f9fafb;
      color: #1e293b;
      transition: border-color 0.15s, box-shadow 0.15s;
      outline: none;
    }

    input:focus, select:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
      background: #ffffff;
    }

    input::placeholder {
      color: #9ca3af;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: 11px 20px;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: background-color 0.15s, transform 0.1s;
      text-decoration: none;
      text-align: center;
    }

    .btn:active {
      transform: scale(0.98);
    }

    .btn-primary {
      background: #3b82f6;
      color: #ffffff;
    }

    .btn-primary:hover {
      background: #2563eb;
    }

    .btn-secondary {
      background: #f1f5f9;
      color: #374151;
      border: 1.5px solid #e2e8f0;
    }

    .btn-secondary:hover {
      background: #e2e8f0;
    }

    .btn-danger {
      background: #ef4444;
      color: #ffffff;
    }

    .btn-danger:hover {
      background: #dc2626;
    }

    .btn-google {
      background: #ffffff;
      color: #374151;
      border: 1.5px solid #d1d5db;
      margin-top: 12px;
    }

    .btn-google:hover {
      background: #f9fafb;
    }

    .btn-google svg {
      margin-right: 10px;
    }

    .divider {
      display: flex;
      align-items: center;
      margin: 20px 0;
      color: #9ca3af;
      font-size: 13px;
    }

    .divider::before,
    .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #e5e7eb;
    }

    .divider span {
      padding: 0 12px;
    }

    .error-msg {
      background: #fef2f2;
      color: #dc2626;
      border: 1px solid #fecaca;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 14px;
      margin-bottom: 16px;
    }

    .success-msg {
      background: #f0fdf4;
      color: #16a34a;
      border: 1px solid #bbf7d0;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 14px;
      margin-bottom: 16px;
    }

    .link {
      color: #3b82f6;
      text-decoration: none;
      font-weight: 500;
    }

    .link:hover {
      text-decoration: underline;
    }

    .text-center {
      text-align: center;
    }

    .text-sm {
      font-size: 13px;
      color: #64748b;
    }

    .mt-16 { margin-top: 16px; }
    .mt-24 { margin-top: 24px; }
    .mb-8 { margin-bottom: 8px; }
    .mb-16 { margin-bottom: 16px; }
    .mb-24 { margin-bottom: 24px; }

    .footer {
      margin-top: 32px;
      text-align: center;
      color: #64748b;
      font-size: 12px;
    }

    .footer a {
      color: #94a3b8;
      text-decoration: none;
      margin: 0 8px;
    }

    .footer a:hover {
      color: #cbd5e1;
    }

    /* Store cards */
    .store-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
      margin-top: 16px;
    }

    .store-card {
      display: block;
      background: #f8fafc;
      border: 1.5px solid #e2e8f0;
      border-radius: 12px;
      padding: 20px;
      text-decoration: none;
      color: inherit;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .store-card:hover {
      border-color: #3b82f6;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.1);
    }

    .store-card-name {
      font-size: 16px;
      font-weight: 600;
      color: #0f172a;
      margin-bottom: 4px;
    }

    .store-card-slug {
      font-size: 13px;
      color: #64748b;
      margin-bottom: 8px;
    }

    .store-card-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      color: #94a3b8;
    }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .badge-owner { background: #dbeafe; color: #1d4ed8; }
    .badge-admin { background: #f3e8ff; color: #7c3aed; }
    .badge-staff { background: #fef3c7; color: #b45309; }

    /* Sessions list */
    .session-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px solid #f1f5f9;
    }

    .session-item:last-child {
      border-bottom: none;
    }

    .session-info {
      font-size: 13px;
      color: #475569;
    }

    .session-current {
      font-size: 11px;
      font-weight: 600;
      color: #16a34a;
      background: #f0fdf4;
      padding: 2px 8px;
      border-radius: 6px;
    }

    /* Tabs for account settings */
    .tabs {
      display: flex;
      border-bottom: 2px solid #e5e7eb;
      margin-bottom: 24px;
      gap: 4px;
    }

    .tab {
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      color: #64748b;
      text-decoration: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
      transition: color 0.15s, border-color 0.15s;
    }

    .tab:hover {
      color: #1e293b;
    }

    .tab.active {
      color: #3b82f6;
      border-bottom-color: #3b82f6;
    }

    @media (max-width: 480px) {
      .card {
        padding: 24px 20px;
      }

      body {
        padding: 16px 12px;
      }

      .store-grid {
        grid-template-columns: 1fr;
      }
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

/** Google icon SVG for the "Login with Google" button */
export const googleIconSvg = `<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
  <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
  <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
  <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
  <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 2.58 9 3.58z" fill="#EA4335"/>
</svg>`
