/**
 * Store Admin — Languages Settings
 *
 * Configure store languages for multi-language support.
 * Mirrors Shopify's Settings > Languages page.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { notify, byActor } from '../lib/notify.js'

const langCsrf = createCsrfStore({ cookieName: 'gbox_csrf_lang' })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getShopSetting(db: Kysely<Database>, shopId: string, key: string): Promise<any> {
  const row = await db
    .selectFrom('shop_settings')
    .select('value')
    .where('shop_id', '=', shopId)
    .where('key', '=', key)
    .executeTakeFirst()
  return row ? (row as any).value : null
}

async function setShopSetting(db: Kysely<Database>, shopId: string, key: string, value: any): Promise<void> {
  const existing = await db
    .selectFrom('shop_settings')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('key', '=', key)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('shop_settings')
      .set({ value: JSON.stringify(value), updated_at: new Date().toISOString() } as any)
      .where('shop_id', '=', shopId)
      .where('key', '=', key)
      .execute()
  } else {
    await db
      .insertInto('shop_settings')
      .values({ shop_id: shopId, key, value: JSON.stringify(value) } as any)
      .execute()
  }
}

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'vi', name: 'Vietnamese (Tiếng Việt)' },
  { code: 'ja', name: 'Japanese (日本語)' },
  { code: 'ko', name: 'Korean (한국어)' },
  { code: 'zh', name: 'Chinese (中文)' },
  { code: 'fr', name: 'French (Français)' },
  { code: 'de', name: 'German (Deutsch)' },
  { code: 'es', name: 'Spanish (Español)' },
  { code: 'pt', name: 'Portuguese (Português)' },
  { code: 'th', name: 'Thai (ไทย)' },
  { code: 'ar', name: 'Arabic (العربية)' },
]

// ---------------------------------------------------------------------------
// GET /settings/languages
// ---------------------------------------------------------------------------

export async function getLanguagesSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const isProduction = process.env.NODE_ENV === 'production'
  const csrfToken = await langCsrf.issue(res, isProduction)
  const successMsg = req.query.success === 'saved' ? 'Language settings saved.' : ''
  const errorMsg = typeof req.query.error === 'string' ? req.query.error : ''

  // API mode (no local DB): fall back to defaults — default='en', enabled=['en'].
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let defaultLang: any = null
  let enabledLangs: any = null
  if (hasDb) {
    try {
      ;[defaultLang, enabledLangs] = await Promise.all([
        getShopSetting(db, store.id, 'lang_default'),
        getShopSetting(db, store.id, 'lang_enabled'),
      ])
    } catch (e: any) {
      console.warn('[languages-settings] DB read failed:', e?.message)
    }
  }

  const defaultCode = defaultLang || 'en'
  const enabled: string[] = Array.isArray(enabledLangs) ? enabledLangs : [defaultCode]

  const content = `
    <div class="page-header" style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
      <a href="/admin/store/${esc(store.slug)}/settings" style="color:var(--s-text-secondary);text-decoration:none;font-size:13px">&larr; Settings</a>
      <div>
        <h1 style="margin:0;font-size:22px;font-weight:700">Languages</h1>
        <p style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">Manage store languages and translations</p>
      </div>
    </div>

    ${successMsg ? `<div style="background:color-mix(in srgb, var(--s-success,#22c55e) 14%, transparent);border:1px solid color-mix(in srgb, var(--s-success,#22c55e) 40%, transparent);border-radius:8px;padding:10px 14px;margin-bottom:16px;color:var(--s-text);font-size:13px">${esc(successMsg)}</div>` : ''}
    ${errorMsg ? `<div style="background:color-mix(in srgb, var(--s-danger,#ef4444) 14%, transparent);border:1px solid color-mix(in srgb, var(--s-danger,#ef4444) 40%, transparent);border-radius:8px;padding:10px 14px;margin-bottom:16px;color:var(--s-text);font-size:13px">${esc(errorMsg)}</div>` : ''}

    <form method="POST" action="/admin/store/${esc(store.slug)}/settings/languages" style="max-width:700px">
      ${csrfHiddenField(csrfToken)}

      <!-- Default Language -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Default Language</h2>
        <p style="margin:0 0 16px;color:var(--s-text-secondary);font-size:13px">The primary language for your store's admin and storefront</p>

        <select name="default_lang" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px">
          ${LANGUAGES.map(l => `<option value="${l.code}" ${defaultCode === l.code ? 'selected' : ''}>${l.name}</option>`).join('')}
        </select>
      </div>

      <!-- Published Languages -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Published Languages</h2>
        <p style="margin:0 0 16px;color:var(--s-text-secondary);font-size:13px">Customers can browse your store in these languages</p>

        <div style="display:flex;flex-direction:column;gap:8px">
          ${LANGUAGES.map(l => `
            <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--s-border);border-radius:6px;cursor:pointer;background:${enabled.includes(l.code) ? 'var(--s-surface)' : 'var(--s-bg)'}">
              <input type="checkbox" name="languages" value="${l.code}" ${enabled.includes(l.code) ? 'checked' : ''} style="width:16px;height:16px" />
              <span style="font-size:14px;color:var(--s-text-primary)">${l.name}</span>
              ${l.code === defaultCode ? '<span class="badge badge-info" style="font-size:10px;margin-left:auto">Default</span>' : ''}
            </label>
          `).join('')}
        </div>
      </div>

      <button type="submit" class="btn btn-primary" style="padding:10px 24px;font-size:14px;font-weight:600;border-radius:8px">Save Languages</button>
    </form>
  `

  res.send(
    sellerLayout({
      title: 'Languages',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'settings',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /settings/languages
// ---------------------------------------------------------------------------

export async function postLanguagesSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const body = req.body

  // Verify CSRF
  const csrfValid = await langCsrf.verify(req)
  if (!csrfValid) {
    res.status(403).send('Invalid or expired form submission. Please go back and try again.')
    return
  }

  // API mode (no local DB): no BE endpoint for shop_settings → show banner.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    res.redirect(`/admin/store/${store.slug}/settings/languages?error=${encodeURIComponent('Saving settings requires local DB or a BE endpoint - not supported in API mode.')}`)
    return
  }

  try {
    let langs = body.languages
    if (!Array.isArray(langs)) langs = langs ? [langs] : ['en']

    // Ensure default language is always in the list
    const defaultLang = body.default_lang || 'en'
    if (!langs.includes(defaultLang)) langs.push(defaultLang)

    await Promise.all([
      setShopSetting(db, store.id, 'lang_default', defaultLang),
      setShopSetting(db, store.id, 'lang_enabled', langs),
    ])
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'languages_settings_updated',
      title: 'Languages settings updated',
      message: byActor((req as any).storeUser),
      resourceType: null,
      resourceId: null,
    })
    res.redirect(`/admin/store/${store.slug}/settings/languages?success=saved`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/settings/languages?error=${encodeURIComponent(err.message)}`)
  }
}
