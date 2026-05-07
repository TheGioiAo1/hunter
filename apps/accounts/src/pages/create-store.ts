/**
 * Gbox Accounts — Create Store Page
 *
 * GET  /create-store  — Render create store form
 * POST /create-store  — Create shop + defaults, redirect to admin
 */

import type { Request, Response } from 'express'
import {
  getSessionTokenFromCookies,
  validateSession,
  getUserShops,
} from '@gbox/core/modules/auth/session.js'
// Phase 0 Step 0.4b: CSRF on the create-store form.
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import {
  isReservedSlug,
  RESERVED_SLUG_MESSAGE,
} from '@gbox/core/modules/domains/reserved-slugs.js'
import { listLibraryCards } from '@gbox/core/modules/clone-pro/library/queries.js'
import { cloneThemeToShop } from '@gbox/core/modules/clone-pro/library/theme-clone.js'
// Phase 14 PR2 commit 4: welcome email after the first shop is created.
import { sendTemplatedEmail } from '@gbox/core/modules/email/send.js'
import { authLayout } from '../layouts/auth-layout.js'

// ---------------------------------------------------------------------------
// Module-level database client. Core modules are already updated to handle
// null db for demo/mock mode. Handlers are updated to remove the db parameter.
// ---------------------------------------------------------------------------

const db = null as any

// ---------------------------------------------------------------------------
// Module-level CSRF store
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_create_store' })

// ---------------------------------------------------------------------------
// Country → currency/timezone map
// ---------------------------------------------------------------------------

const COUNTRY_DEFAULTS: Record<string, { currency: string; timezone: string }> = {
  US: { currency: 'USD', timezone: 'America/New_York' },
  CA: { currency: 'CAD', timezone: 'America/Toronto' },
  GB: { currency: 'GBP', timezone: 'Europe/London' },
  AU: { currency: 'AUD', timezone: 'Australia/Sydney' },
  DE: { currency: 'EUR', timezone: 'Europe/Berlin' },
  FR: { currency: 'EUR', timezone: 'Europe/Paris' },
  JP: { currency: 'JPY', timezone: 'Asia/Tokyo' },
  IN: { currency: 'INR', timezone: 'Asia/Kolkata' },
  BR: { currency: 'BRL', timezone: 'America/Sao_Paulo' },
  MX: { currency: 'MXN', timezone: 'America/Mexico_City' },
  NG: { currency: 'NGN', timezone: 'Africa/Lagos' },
  ZA: { currency: 'ZAR', timezone: 'Africa/Johannesburg' },
  AE: { currency: 'AED', timezone: 'Asia/Dubai' },
  SG: { currency: 'SGD', timezone: 'Asia/Singapore' },
  NZ: { currency: 'NZD', timezone: 'Pacific/Auckland' },
  SE: { currency: 'SEK', timezone: 'Europe/Stockholm' },
  NL: { currency: 'EUR', timezone: 'Europe/Amsterdam' },
  IT: { currency: 'EUR', timezone: 'Europe/Rome' },
  ES: { currency: 'EUR', timezone: 'Europe/Madrid' },
  KR: { currency: 'KRW', timezone: 'Asia/Seoul' },
  CN: { currency: 'CNY', timezone: 'Asia/Shanghai' },
}

const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States',
  CA: 'Canada',
  GB: 'United Kingdom',
  AU: 'Australia',
  DE: 'Germany',
  FR: 'France',
  JP: 'Japan',
  IN: 'India',
  BR: 'Brazil',
  MX: 'Mexico',
  NG: 'Nigeria',
  ZA: 'South Africa',
  AE: 'United Arab Emirates',
  SG: 'Singapore',
  NZ: 'New Zealand',
  SE: 'Sweden',
  NL: 'Netherlands',
  IT: 'Italy',
  ES: 'Spain',
  KR: 'South Korea',
  CN: 'China',
}

// ---------------------------------------------------------------------------
// Gbox Shop Service — REST client (server-side fetch)
// Backend: D:\Gbox\Gbox-Shop-Service · ShopController.Initial → POST /api/init
// Auth: Bearer <jwt>; query: name. Response: { token: { access_token, expires }, shop_id }.
// ---------------------------------------------------------------------------

const API_SHOP_BASE = (
  process.env.API_SHOP_BASE_URL || 'https://api-shop.gbox.co'
).replace(/\/+$/, '')

interface ShopInitResponse {
  token?: { access_token?: string; expires?: number }
  shop_id?: string
}

interface ShopInitResult {
  ok: boolean
  shopId?: string
  token?: { accessToken: string; expires: number }
  errorMessage?: string
  status?: number
}

async function createShopViaApi(
  token: string,
  name: string,
): Promise<ShopInitResult> {
  const url = `${API_SHOP_BASE}/api/init?name=${encodeURIComponent(name)}`
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    })
  } catch (err) {
    console.error('[create-store] Shop API network error:', err)
    return { ok: false, errorMessage: 'Network error contacting shop service.' }
  }
  const bodyText = await resp.text().catch(() => '')
  let body: any = {}
  try { body = bodyText ? JSON.parse(bodyText) : {} } catch { /* keep empty */ }

  if (!resp.ok) {
    // Backend RsMessage shape: { status: false, message: "..." }
    const msg =
      typeof body?.message === 'string' && body.message
        ? body.message
        : `Shop service rejected request (${resp.status}).`
    console.error(`[create-store] Shop API ${resp.status}: ${msg}`)
    return { ok: false, errorMessage: msg, status: resp.status }
  }
  const j = body as ShopInitResponse
  return {
    ok: true,
    shopId: j.shop_id,
    token: j.token?.access_token
      ? { accessToken: j.token.access_token, expires: j.token.expires ?? 0 }
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function getAdminUrl(shopSlug: string): string {
  const base = process.env.STORE_ADMIN_BASE_URL || (isProduction() ? 'https://admin.gbox.co' : '')
  return `${base}/admin/store/${shopSlug}`
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

interface LibraryThemeOption {
  readonly themeId: string
  readonly themeName: string
  readonly shopName: string
  readonly sourceUrl: string
}

function renderCreateStore(
  opts?: {
    error?: string
    values?: Record<string, string>
    csrfToken?: string
    libraryThemes?: readonly LibraryThemeOption[]
  },
): string {
  const v = opts?.values ?? {}
  const countryOptions = Object.entries(COUNTRY_NAMES)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(
      ([code, name]) =>
        `<option value="${code}" ${v.country === code ? 'selected' : ''}>${escapeHtml(name)}</option>`,
    )
    .join('')

  const libraryThemes = opts?.libraryThemes ?? []
  const themePickerBlock =
    libraryThemes.length > 0
      ? `
        <div class="form-group">
          <label for="starter_theme_id">Start with a theme from your library <span class="text-sm" style="color:#888">(optional)</span></label>
          <select id="starter_theme_id" name="starter_theme_id">
            <option value="">Use default theme</option>
            ${libraryThemes
              .map(
                (t) =>
                  `<option value="${escapeAttr(t.themeId)}" ${v.starter_theme_id === t.themeId ? 'selected' : ''}>${escapeHtml(t.themeName)} — from ${escapeHtml(t.shopName)}</option>`,
              )
              .join('')}
          </select>
          <p class="text-sm" style="color:#888;margin-top:4px">
            Copies the theme into your new store as the active design. You can change it later in Online Store → Design.
          </p>
        </div>`
      : ''

  return authLayout({
    title: 'Create a store',
    content: `
      <h1>Create a new store</h1>
      <p class="subtitle">Set up your online store in seconds</p>

      ${opts?.error ? `<div class="error-msg">${escapeHtml(opts.error)}</div>` : ''}

      <form method="POST" action="/accounts/create-store">
        ${opts?.csrfToken ? csrfStore.hiddenField(opts.csrfToken) : ''}
        <div class="form-group">
          <label for="store_name">Store name</label>
          <input type="text" id="store_name" name="store_name" placeholder="My Awesome Store" required value="${escapeAttr(v.store_name ?? '')}" autofocus>
        </div>

        <div class="form-group">
          <label for="country">Country / Region</label>
          <select id="country" name="country" required>
            <option value="">Select a country...</option>
            ${countryOptions}
          </select>
        </div>
        ${themePickerBlock}

        <button type="submit" class="btn btn-primary mt-16">Create store</button>
      </form>

      <p class="text-center text-sm mt-24">
        <a href="/accounts/stores" class="link">Back to stores</a>
      </p>
    `,
  })
}

async function loadLibraryThemes(
  userId: string,
): Promise<LibraryThemeOption[]> {
  try {
    const shops = await getUserShops(db, userId)
    const shopIds = shops.map((s) => s.shopId)
    if (shopIds.length === 0) return []
    const cards = await listLibraryCards(db, {
      userShopIds: shopIds,
      statusFilter: 'completed',
      limit: 50,
    })
    return cards
      .filter((c) => c.themeId)
      .map((c) => ({
        themeId: c.themeId as string,
        themeName: c.themeName ?? 'Untitled theme',
        shopName: c.shopName,
        sourceUrl: c.sourceUrl,
      }))
  } catch (err) {
    console.warn('[create-store] loadLibraryThemes failed:', (err as Error).message)
    return []
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function getCreateStore(
  req: Request,
  res: Response,
): Promise<void> {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (!token) {
    res.redirect('/accounts/login')
    return
  }
  const result = await validateSession(db, token)
  if (!result.valid || !result.session) {
    res.redirect('/accounts/login')
    return
  }
  const csrfToken = await csrfStore.issue(res, isProduction())
  const libraryThemes = await loadLibraryThemes(result.session.user.id)
  res.send(renderCreateStore({ csrfToken, libraryThemes }))
}

export async function postCreateStore(
  req: Request,
  res: Response,
): Promise<void> {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (!token) {
    res.redirect('/accounts/login')
    return
  }
  const result = await validateSession(db, token)
  if (!result.valid || !result.session) {
    res.redirect('/accounts/login')
    return
  }

  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(403).send(
      renderCreateStore({
        error: 'Invalid form submission. Please reload and try again.',
        values: req.body,
        csrfToken,
      }),
    )
    return
  }

  const { store_name, country, starter_theme_id } = req.body ?? {}

  if (!store_name || !country) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    const libraryThemes = await loadLibraryThemes(result.session.user.id)
    res.status(400).send(
      renderCreateStore({
        error: 'Store name and country are required.',
        values: req.body,
        csrfToken,
        libraryThemes,
      }),
    )
    return
  }

  let slug = slugify(store_name)
  if (!slug) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    const libraryThemes = await loadLibraryThemes(result.session.user.id)
    res.status(400).send(
      renderCreateStore({
        error: 'Please enter a valid store name.',
        values: req.body,
        csrfToken,
        libraryThemes,
      }),
    )
    return
  }

  if (isReservedSlug(slug)) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    const libraryThemes = await loadLibraryThemes(result.session.user.id)
    res.status(400).send(
      renderCreateStore({
        error: RESERVED_SLUG_MESSAGE,
        values: req.body,
        csrfToken,
        libraryThemes,
      }),
    )
    return
  }

  if (!db) {
    // Demo mode (no local DB): provision shop qua Gbox Shop Service.
    // Backend: POST /api/init?name=<store_name> với Bearer token người dùng.
    const initRs = await createShopViaApi(token, store_name.trim())
    if (!initRs.ok) {
      const csrfToken = await csrfStore.issue(res, isProduction())
      const libraryThemes = await loadLibraryThemes(result.session.user.id)
      res.status(initRs.status === 401 ? 401 : 400).send(
        renderCreateStore({
          error: initRs.errorMessage || 'Could not create store. Please try again.',
          values: req.body,
          csrfToken,
          libraryThemes,
        }),
      )
      return
    }

    // Backend cấp lại JWT mới (scope cho shop). Cập nhật cookie session
    // để các request kế tiếp dùng token mới — theo đúng spec controller.
    if (initRs.token?.accessToken) {
      const isProd = isProduction()
      const cookieAttrs = [
        `gbox_session=${encodeURIComponent(initRs.token.accessToken)}`,
        'Path=/',
        `Max-Age=${30 * 24 * 3600}`,
        'HttpOnly',
        'SameSite=Lax',
        ...(isProd ? ['Secure'] : []),
      ].join('; ')
      res.setHeader('Set-Cookie', cookieAttrs)
    }

    // Quay về danh sách shop. Stores list fetch tươi từ Shop API nên
    // shop vừa tạo sẽ xuất hiện với slug chính xác (derived từ
    // private_domain backend cấp). Tránh welcome page vì slug client-side
    // có thể lệch với private_domain `shop_<slug>` thực tế.
    res.redirect('/accounts/stores')
    return
  }

  const slugExists = await db
    .selectFrom('shops')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirst()

  if (slugExists) {
    slug = `${slug}-${Date.now().toString(36)}`
  }

  const defaults = COUNTRY_DEFAULTS[country] ?? { currency: 'USD', timezone: 'UTC' }

  const shop = await db
    .insertInto('shops')
    .values({
      name: store_name.trim(),
      slug,
      domain: `${slug}.gbox.co`,
      email: result.session.user.email,
      country,
      currency: defaults.currency,
      timezone: defaults.timezone,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  await db
    .insertInto('user_shops')
    .values({
      user_id: result.session.user.id,
      shop_id: shop.id,
      role: 'owner',
    })
    .execute()

  await db
    .insertInto('locations')
    .values({
      shop_id: shop.id,
      name: 'Default Location',
      country,
      is_primary: true,
      active: true,
    })
    .execute()

  const defaultSettings = [
    { key: 'email_from_name', value: JSON.stringify(store_name.trim()) },
    { key: 'email_from_address', value: JSON.stringify(result.session.user.email) },
    { key: 'order_confirmation_enabled', value: JSON.stringify(true) },
    { key: 'shipping_confirmation_enabled', value: JSON.stringify(true) },
    { key: 'checkout_language', value: JSON.stringify('en') },
  ]

  for (const setting of defaultSettings) {
    await db
      .insertInto('shop_settings')
      .values({
        shop_id: shop.id,
        key: setting.key,
        value: setting.value,
      })
      .execute()
  }

  const adminBaseForWelcome = (process.env.STORE_ADMIN_BASE_URL ?? '').replace(/\/+$/, '')
  const welcomeLoginUrl = adminBaseForWelcome
    ? `${adminBaseForWelcome}/store/${encodeURIComponent(slug)}/dashboard`
    : `/store/${encodeURIComponent(slug)}/dashboard`
  void sendTemplatedEmail(db, {
    templateKey: 'welcome',
    to: result.session.user.email,
    shopId: shop.id,
    variables: {
      user_name: result.session.user.name ?? result.session.user.email,
      shop_name: shop.name,
      login_url: welcomeLoginUrl,
    },
    idempotencyKey: `welcome:${result.session.user.id}:${shop.id}`,
  }).then((r) => {
    if (!r.ok) {
      console.warn(
        `[create-store] welcome email not sent for ${result.session.user.email} shop=${shop.id}: ${r.reason ?? 'unknown'}`,
      )
    }
  }).catch((err) => {
    console.error(
      `[create-store] welcome email threw for ${result.session.user.email} shop=${shop.id}:`,
      err,
    )
  })

  const storefrontUrl = adminBaseForWelcome
    ? `${adminBaseForWelcome.replace(/\/accounts(\/?)$/, '')}/${encodeURIComponent(slug)}`
    : `/${encodeURIComponent(slug)}`
  void (async () => {
    try {
      const { emitNewMerchantSignup } = await import(
        '@gbox/core/modules/platform-alerts/emitters.js'
      )
      const r = await emitNewMerchantSignup(db, {
        shopId: shop.id,
        shopName: shop.name,
        ownerEmail: result.session.user.email,
        country: shop.country ?? 'unknown',
        shopUrl: storefrontUrl,
      })
      if (!r.sent && r.reason !== 'deduped') {
        console.warn(
          `[create-store] new_merchant_signup alert not sent for shop=${shop.id}: ${r.reason}`,
        )
      }
    } catch (alertErr) {
      console.error(
        `[create-store] new_merchant_signup alert threw for shop=${shop.id}:`,
        alertErr,
      )
    }
  })()

  const starterThemeIdStr =
    typeof starter_theme_id === 'string' ? starter_theme_id.trim() : ''
  if (starterThemeIdStr) {
    try {
      const allowed = await loadLibraryThemes(result.session.user.id)
      const picked = allowed.find((t) => t.themeId === starterThemeIdStr)
      if (picked) {
        await cloneThemeToShop(db, {
          sourceThemeId: picked.themeId,
          targetShopId: shop.id,
          activate: true,
        })
      }
    } catch (themeErr) {
      console.warn(
        '[create-store] starter theme clone failed:',
        (themeErr as Error).message,
      )
    }
  }

  const wizardEnabled =
    (process.env.GBOX_ONBOARDING_WIZARD_ENABLED ?? 'true').toLowerCase() !== 'false'

  if (wizardEnabled) {
    res.redirect(
      `/accounts/welcome-to-admin?slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(shop.name)}`,
    )
  } else {
    res.redirect(
      `/accounts/store-created?slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(shop.name)}`,
    )
  }
}

export async function getWelcomeToAdmin(
  req: Request,
  res: Response,
): Promise<void> {
  const slug = String(req.query.slug || '').trim()
  const name = String(req.query.name || slug || 'your store').trim()
  if (!slug) { res.redirect('/accounts/stores'); return }

  const adminBase = getAdminUrl(slug)
  const wizardUrl = `${adminBase}/onboarding/first-run?welcome=1`

  res.send(authLayout({
    title: 'Store created — setting things up',
    content: `
      <div style="text-align:center;padding:32px 0">
        <div style="font-size:48px;margin-bottom:16px">🎉</div>
        <h1 style="margin:0 0 8px">Welcome to ${escapeHtml(name)}!</h1>
        <p class="subtitle">Taking you into setup…</p>
        <p style="margin-top:24px">
          <a href="${escapeAttr(wizardUrl)}" class="btn btn-primary">Continue to setup →</a>
        </p>
      </div>
      <script>setTimeout(function(){window.location.href="${wizardUrl.replace(/"/g, '\\"')}"},800)</script>
    `,
  }))
}

export async function getStoreCreated(
  req: Request,
  res: Response,
): Promise<void> {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (!token) { res.redirect('/accounts/login'); return }
  const result = await validateSession(db, token)
  if (!result.valid) { res.redirect('/accounts/login'); return }

  const slug = String(req.query.slug || '').trim()
  const name = String(req.query.name || slug || 'your store').trim()
  if (!slug) { res.redirect('/accounts/stores'); return }

  const adminUrl = getAdminUrl(slug)
  const liveUrl = `https://${slug}.gbox.co`

  res.send(authLayout({
    title: 'Store Created!',
    content: `
      <div style="text-align:center;padding:32px 0">
        <div style="font-size:48px;margin-bottom:16px">🎉</div>
        <h1 style="margin:0 0 8px">Store created!</h1>
        <p class="subtitle">"${escapeHtml(name)}" is ready.</p>
        <div style="margin:24px auto;max-width:420px;padding:16px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px">
          <div style="font-size:12px;color:#0369a1;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px">Your store is live at</div>
          <a href="${escapeAttr(liveUrl)}" target="_blank" rel="noopener noreferrer"
             style="font-family:monospace;font-size:16px;font-weight:600;color:#0c4a6e;text-decoration:none;word-break:break-all">
             ${escapeHtml(liveUrl)} ↗
          </a>
          <div style="margin-top:8px;font-size:12px;color:#075985">
            Wildcard SSL · Ready for customers from minute one. You can connect a custom domain anytime in Settings → Domains.
          </div>
        </div>
        <p class="subtitle">Redirecting to your dashboard...</p>
        <p style="margin-top:16px">
          <a href="${escapeAttr(adminUrl)}" class="btn btn-primary">Go to Dashboard →</a>
        </p>
        <p class="text-sm" style="margin-top:16px;color:#888">
          Not redirecting? <a href="${escapeAttr(adminUrl)}" class="link">Click here</a>
        </p>
      </div>
      <script>setTimeout(function(){window.location.href="${adminUrl.replace(/"/g, '\\"')}"},2500)</script>
    `,
  }))
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
