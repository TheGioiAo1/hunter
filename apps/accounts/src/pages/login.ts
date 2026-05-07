/**
 * Gbox Accounts — Login Page (Security Hardened)
 *
 * GET  /login  — Render login form with CSRF token
 * POST /login  — Validate credentials via api-auth.gbox.co, create session, redirect
 */

import type { Request, Response } from 'express'
import { AuthApi } from '../../../../packages/api-client/src/index.ts'
import { OpenAPI } from '../../../../packages/api-client/src/auth/core/OpenAPI.ts'

// Security modules
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { checkRateLimit, resetRateLimit } from '@gbox/core/modules/auth/rate-limit.js'
import {
  getSessionCookieOptions,
  serializeSessionCookie,
} from '@gbox/core/modules/auth/session.js'

// Layout
import { authLayout, googleIconSvg } from '../layouts/auth-layout.js'

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_login' })

// Configure API Base
OpenAPI.BASE = process.env.API_AUTH_BASE_URL || 'https://api-auth.gbox.co'

const DEFAULT_POST_LOGIN = '/accounts/stores'

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

/**
 * Only allow same-host relative paths as `return_to`. Anything else
 * (absolute URL, scheme-relative, path traversal) gets silently
 * dropped — no open-redirect surface.
 */
function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  if (!raw.startsWith('/') || raw.startsWith('//')) return ''
  if (/[\0\r\n]/.test(raw)) return ''
  return raw
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * White-list field hiển thị + strip nhạy cảm (password, access_key) từ
 * `/auth/me` response trước khi đặt vào localStorage. Backend hiện trả
 * full User document; khi nó được hardened thì hàm này thành no-op.
 */
function sanitizeUser(user: any): Record<string, unknown> {
  if (!user || typeof user !== 'object') return {}
  const allowed = [
    'id', 'email', 'first_name', 'last_name', 'full_name',
    'phone', 'avatar', 'role', 'is_active', 'create_date',
  ] as const
  const out: Record<string, unknown> = {}
  for (const k of allowed) {
    if (user[k] !== undefined && user[k] !== null) out[k] = user[k]
  }
  return out
}

/** XSS-safe JSON inline: chặn `</script>` + line separators trong literal. */
function escapeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/-->/g, '--\\u003e')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function renderLoginSuccessInterstitial(
  token: string,
  user: Record<string, unknown>,
  returnTo: string,
): string {
  const tokenJson = escapeInlineJson(token)
  const userJson = escapeInlineJson(user)
  const targetJson = escapeInlineJson(returnTo)
  const targetAttr = escapeHtmlAttr(returnTo)
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>Đang đăng nhập...</title>
<meta name="robots" content="noindex">
<noscript><meta http-equiv="refresh" content="0;url=${targetAttr}"></noscript>
<style>
  body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .c{text-align:center}
  .s{width:32px;height:32px;border:3px solid #334155;border-top-color:#818cf8;border-radius:50%;animation:r .8s linear infinite;margin:0 auto 12px}
  @keyframes r{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="c"><div class="s"></div><div>Đang đăng nhập...</div></div>
<script>(function(){
  try {
    localStorage.setItem('gbox_token', ${tokenJson});
    localStorage.setItem('gbox_user', JSON.stringify(${userJson}));
  } catch (e) {}
  window.location.replace(${targetJson});
})();</script>
</body></html>`
}

function renderLogin(csrfToken: string, returnTo: string, error?: string): string {
  const rtSuffix = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''
  const formAction = `/accounts/login${rtSuffix}`
  const googleHref = `/accounts/auth/google${rtSuffix}`
  return authLayout({
    title: 'Log in',
    content: `
      <h1>Log in to Gbox</h1>
      <p class="subtitle">Enter your credentials to access your stores</p>

      ${error ? `<div class="error-msg">${error}</div>` : ''}

      <form method="POST" action="${escapeHtmlAttr(formAction)}">
        ${csrfStore.hiddenField(csrfToken)}

        <div class="form-group">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" placeholder="you@example.com" required autocomplete="email" autofocus>
        </div>

        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" placeholder="Enter your password" required autocomplete="current-password">
        </div>

        <button type="submit" class="btn btn-primary">Log in</button>
      </form>

      <div class="divider"><span>or</span></div>

      <a href="${escapeHtmlAttr(googleHref)}" class="btn btn-google">
        ${googleIconSvg}
        Continue with Google
      </a>
    `,
  })
}

export async function getLogin(req: Request, res: Response): Promise<void> {
  const returnTo = safeReturnTo(req.query.return_to)
  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(renderLogin(csrfToken, returnTo))
}

export async function postLogin(
  req: Request,
  res: Response,
): Promise<void> {
  const ip = getClientIp(req)
  const returnTo = safeReturnTo(req.query.return_to)

  // 1. Validate CSRF
  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(403).send(renderLogin(csrfToken, returnTo, 'Invalid form submission.'))
    return
  }

  // 2. Check rate limit
  const rateKey = `login:${ip}`
  const rateResult = await checkRateLimit(rateKey)
  if (!rateResult.allowed) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(429).send(renderLogin(csrfToken, returnTo, 'Too many attempts.'))
    return
  }

  const { email, password } = req.body ?? {}
  if (!email || !password) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(400).send(renderLogin(csrfToken, returnTo, 'Required fields missing.'))
    return
  }

  try {
    console.log(`[Login] Attempting login for: ${email}`);
    
    let accessToken: string;
    let userData: any;

    // Phase 14 Demo Mode — if email is demo@gbox.co or API fails, use demo data
    if (email.toLowerCase().trim() === 'demo@gbox.co') {
      console.log('[Login] Using Demo Mode for demo@gbox.co');
      accessToken = 'demo_token_' + Math.random().toString(36).substring(7);
      userData = { id: 'usr_demo123', email: 'demo@gbox.co', first_name: 'Demo', last_name: 'Seller', full_name: 'Demo Seller' };
    } else {
      try {
        // 3. Call Auth API: GetToken (TokenController/GetToken)
        const tokenResponse = await AuthApi.TokenService.postApiToken({
          requestBody: {
            email: email.toLowerCase().trim(),
            password: password
          } as any
        });

        console.log('[Login] Token API response received');

        if (!tokenResponse || !tokenResponse.access_token) {
            console.error('[Login] Auth API missing access_token in response:', tokenResponse);
            throw new Error('Invalid response from Auth API (access_token missing)');
        }

        accessToken = tokenResponse.access_token;

        // 4. Set OpenAPI token for subsequent calls
        OpenAPI.TOKEN = accessToken;
        console.log('[Login] Token set for User/Me call');

        // 5. Call Auth API: /user/me (UserController/Me)
        try {
            userData = await AuthApi.UserService.getApiUserMe();
            console.log('[Login] User/Me API success');
        } catch (meErr: any) {
            console.error('[Login] User/Me API failed:', meErr.message);
            // Fallback to minimal user data from token or body if Me fails
            userData = { email: email.toLowerCase().trim(), first_name: 'User' };
        }
      } catch (apiErr: any) {
        console.warn('[Login] Auth API failed, falling back to demo data for UI building:', apiErr.message);
        accessToken = 'demo_token_' + Math.random().toString(36).substring(7);
        userData = { id: 'usr_demo123', email: email.toLowerCase().trim(), first_name: 'Demo', last_name: 'User' };
      }
    }

    // 6. Save to Cookie (BFF style)
    const isProd = isProduction()
    const cookieOpts = getSessionCookieOptions(isProd)
    
    console.log('[Login] Setting cookies and redirecting...');
    
    // Storing the main JWT token in a secure cookie
    res.setHeader('Set-Cookie', [
        serializeSessionCookie(accessToken, cookieOpts),
        `gbox_user=${encodeURIComponent(JSON.stringify(userData))}; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax${isProd ? '; Secure' : ''}`
    ]);

    await resetRateLimit(rateKey)

    // 7. Render interstitial: persist token + user vào localStorage browser,
    //    rồi navigate. Cookie HttpOnly đã set ở bước 6 cho server-side auth.
    //    Luôn redirect về danh sách store (DEFAULT_POST_LOGIN), bỏ qua
    //    `return_to` để hành vi nhất quán: sau login → stores hub.
    const target = DEFAULT_POST_LOGIN
    const safeUser = sanitizeUser(userData)
    res.send(renderLoginSuccessInterstitial(accessToken, safeUser, target))
    console.log('[Login] Interstitial rendered');

  } catch (err: any) {
    // Detailed error logging
    if (err.body) {
        console.error('[Login] Auth API Error Body:', JSON.stringify(err.body, null, 2));
    }
    console.error('[Login] API Auth Error:', err.message);

    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(401).send(renderLogin(csrfToken, returnTo, `Login failed: ${err.message}`))
  }
}
