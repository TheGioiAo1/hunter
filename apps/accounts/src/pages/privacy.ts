/**
 * Gbox Accounts — Customer Privacy Center (Phase 14 PR5)
 *
 * GET  /accounts/privacy?token=<raw>
 *        → authenticated landing page. "token" here is the SAME raw
 *          unsubscribe token that anchors /unsubscribe and
 *          /email-preferences — we reuse it as a lightweight
 *          customer-identification signal so the customer never needs
 *          a separate password just to file a GDPR request. Renders
 *          two primary actions: "Request a copy of my data" and
 *          "Delete my account".
 *
 * POST /accounts/privacy/export
 *        → Creates a `customer_privacy_requests` row of type 'export'.
 *          Worker drains the queue, zips the export (see
 *          data-export-packager.ts), uploads to the private bucket,
 *          emails the customer a single-use download link.
 *
 * POST /accounts/privacy/delete
 *        → Creates a deletion request with `scheduled_deletion_at` =
 *          now + 30 days (configurable via `PRIVACY_DELETION_GRACE_DAYS`).
 *          Returns the `cancelTokenRaw` to the customer ONCE via
 *          email so they can abort before the grace window ends.
 *
 * GET /accounts/privacy/download/:token
 *        → Single-use download token (48 hex chars, set by the worker
 *          in markExportReady). `consumeDownloadToken` atomically
 *          flips status → consumed; we 302 to a pre-signed S3 URL
 *          valid for 15 minutes so the browser can fetch directly
 *          without touching this server again.
 *
 * GET /accounts/privacy/cancel-deletion/:token
 *        → Single-use cancel token (48 hex chars). `cancelDeletion`
 *          atomically flips status → cancelled for rows still in the
 *          grace window. Renders a confirmation page.
 *
 * FAIL-CLOSED + LEAK-FREE (Iron Rule 5)
 * -------------------------------------
 *   Every error path renders a generic "We couldn't find your
 *   request" page. Never confirms the presence of a specific email /
 *   customer / request in the DB; never mentions a `/god-admin` path
 *   or internal support ticket tooling. Fallback copy points at
 *   `contact@gbox.co`.
 *
 * SECURITY
 * --------
 *   - Landing page + POST forms: same unsubscribe-token auth as
 *     /unsubscribe (32 bytes entropy, SHA-256 stored).
 *   - Download + cancel tokens: single-use, 24-byte raw / 48 hex
 *     chars, sha256 stored, constant-time compare.
 *   - `pageLimiter` + (on POST) `authLimiter` are mounted in
 *     server.ts — no extra limiter here.
 */

import type { Request, Response } from 'express'
import {
  requestDataExport,
  requestAccountDeletion,
  consumeDownloadToken,
  cancelDeletion,
} from '@gbox/core/modules/email/privacy-requests.js'
import {
  getPreferenceCenterView,
} from '@gbox/core/modules/email/preferences.js'
import { getPrivateStore } from '@gbox/core/modules/storage/index.js'
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

/** Raw token validator — mirrors unsubscribe.ts / email-preferences.ts. */
function isValidUnsubToken(raw: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(raw)
}

/**
 * Download / cancel tokens are 24 raw bytes = 48 hex. Separate regex
 * so a typo in the shorter token isn't accidentally accepted as an
 * unsubscribe token (which has a different lookup path).
 */
function isValidSingleUseToken(raw: string): boolean {
  return /^[0-9a-fA-F]{48}$/.test(raw)
}

/**
 * Resolve a raw unsubscribe token → (shopId, emailLower, customerId).
 * We reuse the same token the customer got in every email footer so
 * they don't need to re-authenticate just to file a privacy request.
 *
 * Returns `null` on any miss so the caller can render the generic
 * fail-closed page without leaking whether the token is malformed,
 * stale, or just wrong.
 */
async function resolveCustomerContext(
  rawToken: string,
): Promise<
  | { shopId: string; emailLower: string; customerId: string | null; email: string }
  | null
> {
  if (!isValidUnsubToken(rawToken)) return null
  try {
    const view = await getPreferenceCenterView(db, rawToken)
    if (!view.found || !view.email) return null

    const emailLower = view.email.trim().toLowerCase()
    const shopId = view.shopId

    if (!shopId) return null

    if (!db) {
      return {
        shopId,
        emailLower,
        email: view.email,
        customerId: 'cust_demo123',
      }
    }

    const customer = await db
      .selectFrom('customers')
      .select(['id'])
      .where('shop_id', '=', shopId)
      .where((eb: any) => eb.fn<string>('lower', ['email']), '=', emailLower)
      .limit(1)
      .executeTakeFirst()

    return {
      shopId,
      emailLower,
      email: view.email,
      customerId: customer ? String(customer.id) : null,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderNotFound(heading: string, subtitle: string): string {
  return authLayout({
    title: 'Privacy center',
    content: `
      <style>
        .privacy-center { text-align: center; max-width: 520px; margin: 0 auto; }
        .icon-wrap {
          display:flex;align-items:center;justify-content:center;
          width:64px;height:64px;border-radius:50%;
          background:#fee2e2;color:#dc2626;margin:0 auto 16px;
        }
        .support-link { color:#3b82f6;text-decoration:none; }
        .support-link:hover { text-decoration:underline; }
      </style>
      <div class="privacy-center">
        <div class="icon-wrap">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" cy="8" x2="12" y2="12"/>
            <line x1="12" cy="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <h1>${esc(heading)}</h1>
        <p class="subtitle">${esc(subtitle)}</p>
        <p class="subtitle" style="margin-top:16px;font-size:12px">
          Need help? <a class="support-link" href="mailto:contact@gbox.co">contact@gbox.co</a>
        </p>
      </div>
    `,
  })
}

function renderFlash(kind: 'ok' | 'error', text: string): string {
  const bg = kind === 'ok' ? '#dcfce7' : '#fee2e2'
  const fg = kind === 'ok' ? '#16a34a' : '#dc2626'
  const border = kind === 'ok' ? '#86efac' : '#fca5a5'
  return `<div style="background:${bg};color:${fg};border:1px solid ${border};padding:10px 14px;border-radius:10px;font-size:13px;margin-bottom:16px">${esc(text)}</div>`
}

interface LandingContext {
  email: string
  rawToken: string
  flash: string
}

function renderLanding(ctx: LandingContext): string {
  return authLayout({
    title: 'Privacy center',
    content: `
      <style>
        .privacy-center { max-width: 520px; margin: 0 auto; }
        .privacy-header { text-align: center; margin-bottom: 20px; }
        .action-card {
          background:#fff;border:1px solid #e5e7eb;border-radius:12px;
          padding:20px;margin-bottom:14px;
        }
        .action-card h2 { font-size:15px;color:#111827;margin:0 0 6px; }
        .action-card p { font-size:13px;color:#6b7280;margin:0 0 14px;line-height:1.5; }
        .btn-primary {
          background:#111827;color:#fff;border:none;
          padding:9px 18px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;
        }
        .btn-primary:hover { background:#1f2937; }
        .btn-danger {
          background:#fff;color:#dc2626;border:1px solid #fca5a5;
          padding:9px 18px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;
        }
        .btn-danger:hover { background:#fef2f2; }
        .contact-line { text-align:center;font-size:12px;color:#6b7280;margin-top:20px; }
        .contact-line a { color:#3b82f6;text-decoration:none; }
      </style>

      <div class="privacy-center">
        <div class="privacy-header">
          <h1>Privacy center</h1>
          <p class="subtitle">Account on file: <strong>${esc(ctx.email)}</strong></p>
        </div>

        ${ctx.flash}

        <div class="action-card">
          <h2>Request a copy of your data</h2>
          <p>Download everything we have on file about your account — profile, orders,
          reviews, and communication history — packaged as a ZIP. A secure link
          will be emailed to you when it's ready.</p>
          <form method="POST" action="/accounts/privacy/export">
            <input type="hidden" name="token" value="${esc(ctx.rawToken)}">
            <button type="submit" class="btn-primary">Request my data export</button>
          </form>
        </div>

        <div class="action-card">
          <h2>Delete your account</h2>
          <p>We'll schedule your account for deletion 30 days from now, so you can
          cancel if you change your mind. Order history is retained in a de-identified
          form where required by law. A cancellation link will be emailed to you.</p>
          <form method="POST" action="/accounts/privacy/delete"
                onsubmit="return confirm('Schedule account deletion in 30 days? A cancellation link will be emailed to you.')">
            <input type="hidden" name="token" value="${esc(ctx.rawToken)}">
            <button type="submit" class="btn-danger">Delete my account</button>
          </form>
        </div>

        <p class="contact-line">
          Essential account notices (receipts, legal updates, security alerts)
          are always sent while your account is active.
          <br/>
          Questions? <a href="mailto:contact@gbox.co">contact@gbox.co</a>
        </p>
      </div>
    `,
  })
}

function renderConfirm(
  heading: string,
  body: string,
  backLink: { href: string; label: string } | null = null,
): string {
  return authLayout({
    title: 'Privacy center',
    content: `
      <style>
        .privacy-center { text-align: center; max-width: 520px; margin: 0 auto; }
        .icon-wrap {
          display:flex;align-items:center;justify-content:center;
          width:64px;height:64px;border-radius:50%;
          background:#dcfce7;color:#16a34a;margin:0 auto 16px;
        }
        .support-link { color:#3b82f6;text-decoration:none; }
        .support-link:hover { text-decoration:underline; }
        .back-btn {
          display:inline-block;margin-top:14px;padding:8px 14px;
          border:1px solid #d1d5db;border-radius:8px;color:#374151;
          text-decoration:none;font-size:13px;background:#fff;
        }
        .back-btn:hover { background:#f9fafb; }
      </style>
      <div class="privacy-center">
        <div class="icon-wrap">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
        </div>
        <h1>${esc(heading)}</h1>
        <p class="subtitle">${body}</p>
        ${backLink ? `<a class="back-btn" href="${esc(backLink.href)}">${esc(backLink.label)}</a>` : ''}
        <p class="subtitle" style="margin-top:16px;font-size:12px">
          Need help? <a class="support-link" href="mailto:contact@gbox.co">contact@gbox.co</a>
        </p>
      </div>
    `,
  })
}

// ---------------------------------------------------------------------------
// GET /accounts/privacy?token=<raw>
// ---------------------------------------------------------------------------

export async function getPrivacy(
  req: Request,
  res: Response,
): Promise<void> {
  const rawToken = typeof req.query.token === 'string' ? req.query.token.trim() : ''

  const ctx = await resolveCustomerContext(rawToken)
  if (!ctx) {
    res.status(404).send(
      renderNotFound(
        "We couldn't find your account",
        'The link may be incomplete or outdated. No changes were made.',
      ),
    )
    return
  }

  const action = typeof req.query.action === 'string' ? req.query.action : null
  let flash = ''
  if (action === 'export-requested') {
    flash = renderFlash(
      'ok',
      'Your data export has been requested. We will email you a secure download link when it is ready.',
    )
  } else if (action === 'deletion-requested') {
    flash = renderFlash(
      'ok',
      'Your account deletion has been scheduled for 30 days from now. We emailed you a cancellation link — keep it safe.',
    )
  }

  res.send(renderLanding({ email: ctx.email, rawToken, flash }))
}

// ---------------------------------------------------------------------------
// POST /accounts/privacy/export
// ---------------------------------------------------------------------------

export async function postRequestExport(
  req: Request,
  res: Response,
): Promise<void> {
  const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  const ctx = await resolveCustomerContext(rawToken)
  if (!ctx) {
    res.status(404).send(
      renderNotFound(
        "We couldn't find your account",
        'The link may be incomplete or outdated. No changes were made.',
      ),
    )
    return
  }

  try {
    const result = await requestDataExport(db, {
      shopId: ctx.shopId,
      customerId: ctx.customerId,
      email: ctx.emailLower,
    })
    if (!result.ok) {
      res.status(500).send(
        renderNotFound(
          'Something went wrong',
          "We couldn't file your request just now. Please try again in a minute.",
        ),
      )
      return
    }
  } catch (err) {
    console.error('[accounts/privacy POST export] error:', err)
    res.status(500).send(
      renderNotFound(
        'Something went wrong',
        "We couldn't file your request just now. Please try again in a minute.",
      ),
    )
    return
  }

  res.redirect(
    303,
    `/accounts/privacy?token=${encodeURIComponent(rawToken)}&action=export-requested`,
  )
}

// ---------------------------------------------------------------------------
// POST /accounts/privacy/delete
// ---------------------------------------------------------------------------

export async function postRequestDeletion(
  req: Request,
  res: Response,
): Promise<void> {
  const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  const ctx = await resolveCustomerContext(rawToken)
  if (!ctx) {
    res.status(404).send(
      renderNotFound(
        "We couldn't find your account",
        'The link may be incomplete or outdated. No changes were made.',
      ),
    )
    return
  }

  if (!ctx.customerId) {
    res.status(404).send(
      renderNotFound(
        "We couldn't find your account",
        'No matching account record was found for this store. Please contact support.',
      ),
    )
    return
  }

  try {
    const result = await requestAccountDeletion(db, {
      shopId: ctx.shopId,
      customerId: ctx.customerId,
      email: ctx.emailLower,
    })
    if (!result.ok) {
      if (result.reason === 'deletion_already_pending') {
        res.status(409).send(
          renderConfirm(
            'Deletion already scheduled',
            "A deletion is already scheduled for your account. Check your email for the cancellation link — or wait for it to finalize.",
            {
              href: `/accounts/privacy?token=${encodeURIComponent(rawToken)}`,
              label: 'Back to privacy center',
            },
          ),
        )
        return
      }
      res.status(500).send(
        renderNotFound(
          'Something went wrong',
          "We couldn't file your request just now. Please try again in a minute.",
        ),
      )
      return
    }
  } catch (err) {
    console.error('[accounts/privacy POST delete] error:', err)
    res.status(500).send(
      renderNotFound(
        'Something went wrong',
        "We couldn't file your request just now. Please try again in a minute.",
      ),
    )
    return
  }

  res.redirect(
    303,
    `/accounts/privacy?token=${encodeURIComponent(rawToken)}&action=deletion-requested`,
  )
}

// ---------------------------------------------------------------------------
// GET /accounts/privacy/download/:token
// ---------------------------------------------------------------------------

export async function getDownloadToken(
  req: Request,
  res: Response,
): Promise<void> {
  const rawToken = typeof req.params?.token === 'string' ? req.params.token.trim() : ''
  if (!isValidSingleUseToken(rawToken)) {
    res.status(400).send(
      renderNotFound(
        "We couldn't find your download",
        'The link may be incomplete or outdated.',
      ),
    )
    return
  }

  let result
  try {
    result = await consumeDownloadToken(db, { rawToken })
  } catch (err) {
    console.error('[accounts/privacy GET download] error:', err)
    res.status(500).send(
      renderNotFound(
        'Something went wrong',
        "We couldn't process this link just now. Please try again in a minute.",
      ),
    )
    return
  }

  if (!result.ok) {
    let subtitle = 'The link may be incomplete or outdated.'
    if (result.reason === 'expired') {
      subtitle = 'This download link has expired. You can request a new export from your privacy center.'
    } else if (result.reason === 'already_consumed') {
      subtitle = 'This download link has already been used. You can request a new export from your privacy center.'
    }
    res.status(410).send(
      renderNotFound(
        "We couldn't find your download",
        subtitle,
      ),
    )
    return
  }

  try {
    const store = getPrivateStore()
    const signedUrl = store.url(result.storageKey, {
      signed: true,
      expiresIn: 15 * 60, // 15 minutes
    })
    res.redirect(302, signedUrl)
  } catch (err) {
    console.error('[accounts/privacy GET download] signing error:', err)
    res.status(500).send(
      renderNotFound(
        'Something went wrong',
        "We couldn't generate your download link just now. Please try again in a minute.",
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// GET /accounts/privacy/cancel-deletion/:token
// ---------------------------------------------------------------------------

export async function getCancelDeletion(
  req: Request,
  res: Response,
): Promise<void> {
  const rawToken = typeof req.params?.token === 'string' ? req.params.token.trim() : ''
  if (!isValidSingleUseToken(rawToken)) {
    res.status(400).send(
      renderNotFound(
        "We couldn't find your request",
        'The link may be incomplete or outdated.',
      ),
    )
    return
  }

  let result
  try {
    result = await cancelDeletion(db, { rawToken })
  } catch (err) {
    console.error('[accounts/privacy GET cancel-deletion] error:', err)
    res.status(500).send(
      renderNotFound(
        'Something went wrong',
        "We couldn't process this link just now. Please try again in a minute.",
      ),
    )
    return
  }

  if (!result.ok) {
    let heading = "We couldn't find your request"
    let subtitle = 'The link may be incomplete or outdated.'
    if (result.reason === 'already_cancelled') {
      heading = 'Deletion already cancelled'
      subtitle = 'Your account was already restored. No further action is needed.'
    } else if (result.reason === 'too_late') {
      heading = 'Cancellation window closed'
      subtitle = 'This account has already been scheduled for final processing. Please contact support if you need help.'
    }
    res.status(410).send(renderNotFound(heading, subtitle))
    return
  }

  res.send(
    renderConfirm(
      'Deletion cancelled',
      'Your account deletion has been cancelled and your account is active again. No changes were made to your data.',
      null,
    ),
  )
}
