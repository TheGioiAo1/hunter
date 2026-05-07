/**
 * Store Admin — Online Store Preferences
 *
 * Manages SEO, social sharing, Google Analytics, password protection,
 * and storefront metadata via shop_settings key-value table.
 * Mirrors Shopify's Online Store > Preferences page.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { notify, byActor } from '../lib/notify.js'

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
      .values({
        shop_id: shopId,
        key,
        value: JSON.stringify(value),
      } as any)
      .execute()
  }
}

// ---------------------------------------------------------------------------
// GET /online-store/preferences — Store preferences page
// ---------------------------------------------------------------------------

export async function getPreferences(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const successMsg = req.query.success === 'saved' ? 'Preferences saved.' : ''
  const errorMsg = typeof req.query.error === 'string' ? req.query.error : ''

  // API mode (no local DB): fallback every setting = null → form loads with
  // metaTitle = store.name (via || in template), other fields empty.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let metaTitle: any = null, metaDescription: any = null, socialImage: any = null
  let googleAnalytics: any = null, fbPixel: any = null
  let passwordEnabled: any = null, passwordMessage: any = null, customHeadCode: any = null

  if (hasDb) {
    try {
      ;[metaTitle, metaDescription, socialImage, googleAnalytics, fbPixel, passwordEnabled, passwordMessage, customHeadCode] = await Promise.all([
        getShopSetting(db, store.id, 'pref_meta_title'),
        getShopSetting(db, store.id, 'pref_meta_description'),
        getShopSetting(db, store.id, 'pref_social_image'),
        getShopSetting(db, store.id, 'pref_google_analytics'),
        getShopSetting(db, store.id, 'pref_fb_pixel'),
        getShopSetting(db, store.id, 'pref_password_enabled'),
        getShopSetting(db, store.id, 'pref_password_message'),
        getShopSetting(db, store.id, 'pref_custom_head_code'),
      ])
    } catch (e: any) {
      console.warn('[preferences] DB read failed:', e?.message)
    }
  }

  const content = `
    <div class="page-header" style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
      <a href="/admin/store/${esc(store.slug)}/online-store" style="color:var(--s-text-secondary);text-decoration:none;font-size:13px">&larr; Online Store</a>
      <div>
        <h1 style="margin:0;font-size:22px;font-weight:700">Preferences</h1>
        <p style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">SEO, social sharing, and storefront settings</p>
      </div>
    </div>

    ${successMsg ? `<div style="background:color-mix(in srgb, var(--s-success,#22c55e) 14%, transparent);border:1px solid color-mix(in srgb, var(--s-success,#22c55e) 40%, transparent);border-radius:8px;padding:10px 14px;margin-bottom:16px;color:var(--s-text);font-size:13px;max-width:700px">${esc(successMsg)}</div>` : ''}
    ${errorMsg ? `<div style="background:color-mix(in srgb, var(--s-danger,#ef4444) 14%, transparent);border:1px solid color-mix(in srgb, var(--s-danger,#ef4444) 40%, transparent);border-radius:8px;padding:10px 14px;margin-bottom:16px;color:var(--s-text);font-size:13px;max-width:700px">${esc(errorMsg)}</div>` : ''}

    <form method="POST" action="/admin/store/${esc(store.slug)}/online-store/preferences" style="max-width:700px">
      <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />

      <!-- Homepage SEO -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Homepage Title & Meta Description</h2>
        <p style="margin:0 0 16px;color:var(--s-text-secondary);font-size:13px">Used by search engines to display your store in results</p>

        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Homepage title</label>
          <input type="text" name="meta_title" value="${esc(metaTitle || store.name)}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          <div style="font-size:12px;color:var(--s-text-secondary);margin-top:4px">Max 70 characters recommended</div>
        </div>

        <div style="margin-bottom:8px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Homepage meta description</label>
          <textarea name="meta_description" rows="3" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px;resize:vertical" placeholder="A brief description of your store for search engines">${esc(metaDescription || '')}</textarea>
          <div style="font-size:12px;color:var(--s-text-secondary);margin-top:4px">Max 160 characters recommended</div>
        </div>
      </div>

      <!-- Social Sharing Image -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Social Sharing Image</h2>
        <p style="margin:0 0 16px;color:var(--s-text-secondary);font-size:13px">Used when your store is shared on social media (Open Graph)</p>

        <div style="margin-bottom:8px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Social sharing image URL</label>
          <input type="url" name="social_image" value="${esc(socialImage || '')}" placeholder="https://example.com/share-image.jpg" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          <div style="font-size:12px;color:var(--s-text-secondary);margin-top:4px">Recommended size: 1200 x 628 pixels</div>
        </div>
      </div>

      <!-- Tracking -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Tracking</h2>
        <p style="margin:0 0 16px;color:var(--s-text-secondary);font-size:13px">Connect analytics and marketing tools</p>

        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Google Analytics ID</label>
          <input type="text" name="google_analytics" value="${esc(googleAnalytics || '')}" placeholder="G-XXXXXXXXXX" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px;font-family:monospace" />
        </div>

        <div style="margin-bottom:8px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Facebook Pixel ID</label>
          <input type="text" name="fb_pixel" value="${esc(fbPixel || '')}" placeholder="123456789012345" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px;font-family:monospace" />
        </div>
      </div>

      <!-- Password Protection -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Password Protection</h2>
        <p style="margin:0 0 16px;color:var(--s-text-secondary);font-size:13px">Restrict access to your online store</p>

        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" name="password_enabled" value="true" ${passwordEnabled ? 'checked' : ''} style="width:16px;height:16px" />
            <span style="font-size:14px;font-weight:600;color:var(--s-text-primary)">Enable password</span>
          </label>
          <span style="font-size:12px;color:var(--s-text-secondary)">Visitors will need a password to access your store</span>
        </div>

        <div style="margin-bottom:8px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Message for visitors</label>
          <textarea name="password_message" rows="2" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px;resize:vertical" placeholder="Our store is coming soon...">${esc(passwordMessage || '')}</textarea>
        </div>
      </div>

      <!-- Custom Code -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Custom Head Code</h2>
        <p style="margin:0 0 16px;color:var(--s-text-secondary);font-size:13px">Add custom scripts or meta tags to your store's &lt;head&gt;</p>

        <div style="margin-bottom:8px">
          <textarea name="custom_head_code" rows="5" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:13px;font-family:monospace;resize:vertical" placeholder="<meta name=&quot;...&quot; content=&quot;...&quot; />">${esc(customHeadCode || '')}</textarea>
          <div style="font-size:12px;color:var(--s-text-secondary);margin-top:4px">Only add code from sources you trust</div>
        </div>
      </div>

      <button type="submit" class="btn btn-primary" style="padding:10px 24px;font-size:14px;font-weight:600;border-radius:8px">Save Preferences</button>
    </form>
  `

  res.send(
    sellerLayout({
      title: 'Preferences',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'online-store',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /online-store/preferences — Save preferences
// ---------------------------------------------------------------------------

export async function postPreferences(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const body = req.body

  // API mode (no local DB): no BE endpoint for shop_settings → show banner.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    res.redirect(`/admin/store/${store.slug}/online-store/preferences?error=${encodeURIComponent('Saving preferences requires local DB or a BE endpoint - not supported in API mode.')}`)
    return
  }

  try {
    await Promise.all([
      setShopSetting(db, store.id, 'pref_meta_title', body.meta_title || ''),
      setShopSetting(db, store.id, 'pref_meta_description', body.meta_description || ''),
      setShopSetting(db, store.id, 'pref_social_image', body.social_image || ''),
      setShopSetting(db, store.id, 'pref_google_analytics', body.google_analytics || ''),
      setShopSetting(db, store.id, 'pref_fb_pixel', body.fb_pixel || ''),
      setShopSetting(db, store.id, 'pref_password_enabled', body.password_enabled === 'true'),
      setShopSetting(db, store.id, 'pref_password_message', body.password_message || ''),
      setShopSetting(db, store.id, 'pref_custom_head_code', body.custom_head_code || ''),
    ])
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'preferences_updated',
      title: 'Online store preferences updated',
      message: byActor((req as any).storeUser),
      resourceType: null,
      resourceId: null,
    })
    res.redirect(`/admin/store/${store.slug}/online-store/preferences?success=saved`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/online-store/preferences?error=${encodeURIComponent(err.message)}`)
  }
}
