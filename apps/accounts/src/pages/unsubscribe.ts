/**
 * Gbox Accounts — Public unsubscribe endpoint (Phase 14 PR1)
 *
 * GET  /accounts/unsubscribe?token=<raw>           — flips subscribed=false
 * POST /accounts/unsubscribe?token=<raw>&action=resubscribe
 *                                                   — flips subscribed=true
 *
 * HOW IT HITS
 * -----------
 *   Every marketing / lifecycle / reviews email we send carries an
 *   unsubscribe link built by `packages/core/src/modules/email/
 *   preferences.ts::buildUnsubscribeUrl()`. The link points here. We
 *   hash the raw token (SHA-256) and look it up in
 *   `email_preferences.unsubscribe_token_hash`.
 *
 * FAIL-CLOSED + LEAK-FREE
 * -----------------------
 *   - If the token doesn't match any row we show the same friendly
 *     "We couldn't find that subscription" page regardless of whether
 *     the token is malformed, expired, or just wrong. No confirmation
 *     or denial.
 *   - No login required — the token IS the auth ("Amazon-style" one-
 *     click unsubscribe, per CAN-SPAM + RFC 8058 one-click norms).
 *   - Rate limit handled by the accounts-level `pageLimiter` mounted
 *     in server.ts before us.
 *
 * SELLER-FACING COPY (Iron Rule 5)
 * --------------------------------
 *   This page is rendered to CUSTOMERS (storefront buyers) and
 *   occasionally merchants. It MUST NOT mention "god admin", any
 *   internal path, or imply the user can self-serve a fix through an
 *   admin surface. The "contact support" fallback reads
 *   `contact@gbox.co` which is the seller-facing inbox.
 */

import type { Request, Response } from 'express'
import {
  unsubscribeByToken,
  resubscribeByToken,
} from '@gbox/core/modules/email/preferences.js'
import { authLayout } from '../layouts/auth-layout.js'

// ---------------------------------------------------------------------------
// Module-level database client. Core modules are already updated to handle
// null db for demo/mock mode. Handlers are updated to remove the db parameter.
// ---------------------------------------------------------------------------

const db = null as any

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function normalizeCategory(cat: string | null): string {
  if (!cat) return 'marketing emails'
  const map: Record<string, string> = {
    marketing: 'marketing emails',
    lifecycle: 'lifecycle emails (win-back, post-purchase)',
    reviews: 'review request emails',
    newsletter: 'newsletter',
    abandoned_cart: 'abandoned-cart reminders',
    back_in_stock: 'back-in-stock alerts',
    price_drop: 'price-drop alerts',
  }
  return map[cat] ?? cat
}

// ---------------------------------------------------------------------------
// Page renderers
// ---------------------------------------------------------------------------

interface RenderOpts {
  title: string
  heading: string
  subtitle: string
  details?: string
  action?: {
    kind: 'resubscribe' | 'none'
    token: string
  }
  error?: boolean
}

function renderPage(opts: RenderOpts): string {
  const {
    title, heading, subtitle, details,
    action, error,
  } = opts

  const detailsHtml = details
    ? `<p class="details">${esc(details)}</p>`
    : ''

  const actionHtml = action?.kind === 'resubscribe'
    ? `
      <form method="POST" action="/accounts/unsubscribe">
        <input type="hidden" name="token" value="${esc(action.token)}">
        <input type="hidden" name="action" value="resubscribe">
        <button type="submit" class="btn btn-secondary mt-16">Changed your mind? Re-subscribe</button>
      </form>
    `
    : ''

  const iconHtml = error
    ? `<div class="icon-wrap icon-err">
         <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
           <circle cx="12" cy="12" r="10"/>
           <line x1="12" cy="8" x2="12" y2="12"/>
           <line x1="12" cy="16" x2="12.01" y2="16"/>
         </svg>
       </div>`
    : `<div class="icon-wrap icon-ok">
         <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
           <polyline points="20 6 9 17 4 12"/>
         </svg>
       </div>`

  return authLayout({
    title,
    content: `
      <style>
        .icon-wrap {
          display: flex; align-items: center; justify-content: center;
          width: 64px; height: 64px; border-radius: 50%;
          margin: 0 auto 16px;
        }
        .icon-ok { background: #dcfce7; color: #16a34a; }
        .icon-err { background: #fee2e2; color: #dc2626; }
        .unsub-center { text-align: center; }
        .details {
          background: #f9fafb; border: 1px solid #e5e7eb;
          border-radius: 10px; padding: 12px 16px;
          color: #6b7280; font-size: 13px; margin: 16px 0;
        }
        .mt-16 { margin-top: 16px; }
        .support-link { color: #3b82f6; text-decoration: none; }
        .support-link:hover { text-decoration: underline; }
      </style>

      <div class="unsub-center">
        ${iconHtml}
        <h1>${esc(heading)}</h1>
        <p class="subtitle">${esc(subtitle)}</p>
        ${detailsHtml}
        ${actionHtml}
        <p class="subtitle mt-16" style="font-size:12px">
          Need more help? <a class="support-link" href="mailto:contact@gbox.co">contact@gbox.co</a>
        </p>
      </div>
    `,
  })
}

// ---------------------------------------------------------------------------
// GET /accounts/unsubscribe?token=<raw>
// ---------------------------------------------------------------------------

export async function getUnsubscribe(
  req: Request,
  res: Response,
): Promise<void> {
  const rawToken = typeof req.query.token === 'string' ? req.query.token.trim() : ''

  if (!rawToken || !/^[0-9a-fA-F]{64}$/.test(rawToken)) {
    res.status(400).send(renderPage({
      title: 'Unsubscribe',
      heading: "We couldn't find that subscription",
      subtitle: "The unsubscribe link may be incomplete or outdated.",
      error: true,
    }))
    return
  }

  try {
    const result = await unsubscribeByToken(db, rawToken)
    if (!result.found) {
      res.status(404).send(renderPage({
        title: 'Unsubscribe',
        heading: "We couldn't find that subscription",
        subtitle: "The link may have expired, or it's already been used. No changes were made.",
        error: true,
      }))
      return
    }

    const categoryLabel = normalizeCategory(result.category)
    res.send(renderPage({
      title: 'Unsubscribed',
      heading: 'You have been unsubscribed',
      subtitle: `We won't send any more ${categoryLabel} to ${result.email ?? 'this address'}.`,
      details: 'You will still receive essential account emails (order confirmations, receipts, security alerts) — those are required for us to operate your account.',
      action: { kind: 'resubscribe', token: rawToken },
    }))
  } catch (err) {
    console.error('[accounts/unsubscribe] error:', err)
    res.status(500).send(renderPage({
      title: 'Unsubscribe',
      heading: 'Something went wrong',
      subtitle: "We couldn't process your unsubscribe request just now. Please try again in a minute.",
      error: true,
    }))
  }
}

// ---------------------------------------------------------------------------
// POST /accounts/unsubscribe  (body: token, action=resubscribe)
// ---------------------------------------------------------------------------

export async function postUnsubscribe(
  req: Request,
  res: Response,
): Promise<void> {
  const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  const action = typeof req.body?.action === 'string' ? req.body.action : ''

  if (!rawToken || !/^[0-9a-fA-F]{64}$/.test(rawToken)) {
    res.status(400).send(renderPage({
      title: 'Unsubscribe',
      heading: "We couldn't find that subscription",
      subtitle: "The unsubscribe link may be incomplete or outdated.",
      error: true,
    }))
    return
  }

  if (action !== 'resubscribe') {
    try {
      const result = await unsubscribeByToken(db, rawToken)
      if (!result.found) {
        res.status(404).send(renderPage({
          title: 'Unsubscribe',
          heading: "We couldn't find that subscription",
          subtitle: "The link may have expired, or it's already been used. No changes were made.",
          error: true,
        }))
        return
      }
      res.send(renderPage({
        title: 'Unsubscribed',
        heading: 'You have been unsubscribed',
        subtitle: `We won't send any more ${normalizeCategory(result.category)} to ${result.email ?? 'this address'}.`,
        details: 'You will still receive essential account emails (order confirmations, receipts, security alerts) — those are required for us to operate your account.',
        action: { kind: 'resubscribe', token: rawToken },
      }))
    } catch (err) {
      console.error('[accounts/unsubscribe POST] error:', err)
      res.status(500).send(renderPage({
        title: 'Unsubscribe',
        heading: 'Something went wrong',
        subtitle: "We couldn't process your request just now. Please try again.",
        error: true,
      }))
    }
    return
  }

  try {
    const result = await resubscribeByToken(db, rawToken)
    if (!result.found) {
      res.status(404).send(renderPage({
        title: 'Subscribe',
        heading: "We couldn't find that subscription",
        subtitle: 'The link may have expired. No changes were made.',
        error: true,
      }))
      return
    }
    res.send(renderPage({
      title: 'Re-subscribed',
      heading: "You're back on the list",
      subtitle: "We'll send you marketing + lifecycle emails again.",
      details: 'You can unsubscribe again any time from the link at the bottom of any email we send.',
    }))
  } catch (err) {
    console.error('[accounts/resubscribe] error:', err)
    res.status(500).send(renderPage({
      title: 'Re-subscribe',
      heading: 'Something went wrong',
      subtitle: "We couldn't process your request just now. Please try again.",
      error: true,
    }))
  }
}
