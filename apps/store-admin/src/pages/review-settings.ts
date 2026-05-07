/**
 * Store Admin — Review Settings (Phase 10 PR3)
 *
 * Two write paths on one page:
 *   1. Moderation — `profanity_filter_enabled` + `profanity_extra_terms`.
 *   2. Notifications — `notify_customer_on_approve` / `notify_customer_on_reply`.
 *
 * Iron rule 5: every error path routes through `safeMessage` → "Please
 * contact Gbox support." — we never expose an internal stack / path
 * trace to the seller. The page URL is `/admin/store/:slug/products/reviews/settings`
 * so it sits next to the existing reviews moderation queue.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  getShopReviewSettings,
  upsertShopReviewSettings,
} from '@gbox/core/modules/reviews/settings.js'
// Iron rule 5 helper — dep-free so the PR3 smoke can import it directly
// from `../lib/review-settings-flash.js` without pulling in the admin
// server graph (which drags in AI SDKs not installed on the smoke box).
import { safeReviewSettingsMessage } from '../lib/review-settings-flash.js'

function banner(kind: 'ok' | 'error', text: string): string {
  const bg = kind === 'ok' ? 'var(--success-bg,#0f5132)' : 'var(--danger-bg,#842029)'
  const color = kind === 'ok' ? 'var(--success-text,#d1e7dd)' : 'var(--danger-text,#f8d7da)'
  return `<div style="padding:10px 14px;border-radius:6px;background:${bg};color:${color};margin-bottom:16px">${esc(text)}</div>`
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/products/reviews/settings
// ---------------------------------------------------------------------------

export async function getReviewSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}`
  const saved = typeof req.query.saved === 'string' ? req.query.saved : null
  const err = typeof req.query.err === 'string' ? req.query.err : null
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  let settings: any = {
    profanityEnabled: false,
    profanityExtraTerms: [],
    notifyOnApprove: false,
    notifyOnReply: false,
  }

  if (hasDb) {
    try {
      settings = await getShopReviewSettings(db, store.id)
    } catch {
      res.status(500).send(
        sellerLayout({
          title: 'Review settings',
          storeName: store.name,
          storeSlug: store.slug,
          userName: user.name,
          userEmail: user.email,
          userRole: user.role,
          storeRole: (user as any).storeRole,
          theme: theme as 'dark' | 'light',
          activePage: 'settings',
          content: banner('error', 'Please contact Gbox support.'),
        }),
      )
      return
    }
  }

  const csrf = csrfHiddenField((req as any).csrfToken || '')
  const termsText = (settings.profanityExtraTerms ?? []).join(', ')

  const flash = saved
    ? banner(
        'ok',
        saved === 'moderation'
          ? 'Moderation settings saved.'
          : saved === 'notifications'
            ? 'Notification preferences saved.'
            : 'Saved.',
      )
    : err
      ? banner('error', decodeURIComponent(err))
      : ''

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Review settings</h1>
        <p class="page-subtitle">
          <a href="${base}/products/reviews" style="color:var(--accent);text-decoration:none">Reviews</a> / Settings
        </p>
      </div>
    </div>

    ${flash}

    <div class="card" style="margin-bottom:24px">
      <div class="card-header"><h2 class="card-title" id="moderation-heading">Moderation</h2></div>
      <div class="card-body">
        <form method="post" action="${base}/products/reviews/settings/moderation"
              aria-labelledby="moderation-heading"
              style="display:flex;flex-direction:column;gap:16px">
          ${csrf}
          <label style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" name="profanity_filter_enabled" value="1"
                   id="profanity_filter_enabled"
                   ${settings.profanityFilterEnabled ? 'checked' : ''}
                   aria-describedby="profanity_filter_help">
            <span><strong>Enable profanity filter</strong> — auto-flag reviews with profanity so they wait for manual approval.</span>
          </label>
          <span id="profanity_filter_help" class="sr-only">When on, reviews with any profanity hit are routed to pending status for manual approval.</span>
          <label for="profanity_extra_terms" style="display:flex;flex-direction:column;gap:4px">
            <span>Extra terms to block (comma-separated)</span>
            <textarea id="profanity_extra_terms"
                      name="profanity_extra_terms"
                      rows="4"
                      aria-describedby="profanity_extra_terms_help"
                      style="font-family:monospace;resize:vertical;padding:8px;background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border);border-radius:6px">${esc(termsText)}</textarea>
            <span id="profanity_extra_terms_help" style="color:var(--text-secondary);font-size:12px">
              Up to 200 terms. We already catch common English and Vietnamese profanity — add your own brand-specific blockers here.
            </span>
          </label>
          <div><button type="submit" class="btn btn-primary">Save moderation</button></div>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2 class="card-title" id="notifications-heading">Customer notifications</h2></div>
      <div class="card-body">
        <form method="post" action="${base}/products/reviews/settings/notifications"
              aria-labelledby="notifications-heading"
              style="display:flex;flex-direction:column;gap:12px">
          ${csrf}
          <label style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" name="notify_customer_on_approve" value="1"
                   id="notify_customer_on_approve"
                   ${settings.notifyCustomerOnApprove ? 'checked' : ''}>
            <span>Email the reviewer when their review is approved and goes live.</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" name="notify_customer_on_reply" value="1"
                   id="notify_customer_on_reply"
                   ${settings.notifyCustomerOnReply ? 'checked' : ''}>
            <span>Email the reviewer when you post a reply to their review.</span>
          </label>
          <div><button type="submit" class="btn btn-primary">Save notifications</button></div>
        </form>
      </div>
    </div>
  `

  res.send(
    sellerLayout({
      title: 'Review settings',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: (user as any).storeRole,
      theme: theme as 'dark' | 'light',
      activePage: 'settings',
      content,
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/products/reviews/settings/moderation
// ---------------------------------------------------------------------------

export async function postReviewSettingsModeration(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  if (!hasDb) {
    res.redirect(`${base}/products/reviews/settings?saved=moderation`)
    return
  }

  try {
    const body = (req.body ?? {}) as {
      profanity_filter_enabled?: string
      profanity_extra_terms?: string
    }
    const enabled = body.profanity_filter_enabled === '1' || body.profanity_filter_enabled === 'true'
    const terms = typeof body.profanity_extra_terms === 'string' ? body.profanity_extra_terms : ''

    await upsertShopReviewSettings(db, store.id, {
      profanityFilterEnabled: enabled,
      profanityExtraTerms: terms,
    })

    res.redirect(`${base}/products/reviews/settings?saved=moderation`)
  } catch (err) {
    res.redirect(
      `${base}/products/reviews/settings?err=${encodeURIComponent(
        safeReviewSettingsMessage(err),
      )}`,
    )
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/products/reviews/settings/notifications
// ---------------------------------------------------------------------------

export async function postReviewSettingsNotifications(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  if (!hasDb) {
    res.redirect(`${base}/products/reviews/settings?saved=notifications`)
    return
  }

  try {
    const body = (req.body ?? {}) as {
      notify_customer_on_approve?: string
      notify_customer_on_reply?: string
    }
    const onApprove = body.notify_customer_on_approve === '1' || body.notify_customer_on_approve === 'true'
    const onReply = body.notify_customer_on_reply === '1' || body.notify_customer_on_reply === 'true'

    await upsertShopReviewSettings(db, store.id, {
      notifyCustomerOnApprove: onApprove,
      notifyCustomerOnReply: onReply,
    })

    res.redirect(`${base}/products/reviews/settings?saved=notifications`)
  } catch (err) {
    res.redirect(
      `${base}/products/reviews/settings?err=${encodeURIComponent(
        safeReviewSettingsMessage(err),
      )}`,
    )
  }
}
