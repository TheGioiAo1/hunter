/**
 * Store Admin — Email Templates (Phase 14 PR1.5)
 *
 * The per-shop editor on top of the Shopify-class email system foundation
 * shipped in PR1 (migration 083 + `email_template_registry` +
 * `email_template_overrides`). Three handlers on one page:
 *
 *   1. GET  /admin/store/:slug/settings/email-templates
 *          → list all seller-visible templates (iron rule 5 — god_admin
 *            audience is filtered out), grouped by category, with a
 *            "Customized" badge for overrides this shop has in place.
 *
 *   2. GET  /admin/store/:slug/settings/email-templates/:key
 *          → render the edit form. Pre-fills from `resolveTemplate()`
 *            (override → DB default → in-code catalog) so the merchant
 *            always sees what would actually ship in an email.
 *
 *   3. POST /admin/store/:slug/settings/email-templates/:key/update
 *          → upsert the override (subject/html/text/active).
 *
 *   4. POST /admin/store/:slug/settings/email-templates/:key/reset
 *          → clear the override row (fall back to DB default /
 *            in-code catalog on next resolve).
 *
 * Iron rule 5 chokepoint is at the top of every handler: we look up the
 * template via `getTemplate(key)`, then reject with a seller-safe
 * "That email template is not available." if the template is either
 * unknown OR has audience='god_admin'. This is deliberately vague —
 * we never leak that the template exists but is platform-only.
 *
 * Iron rule 5 is further enforced at resolve time: forced-send
 * categories (transactional / ops / platform / legal) IGNORE the
 * override.active=false flag — sellers can't disable their own
 * password-reset email with a stray checkbox. See
 * `registry.ts::resolveTemplate` for the guard.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  getMerchantVisibleTemplates,
  getTemplate,
  resolveTemplate,
  upsertTemplateOverride,
  clearTemplateOverride,
  listShopOverrides,
  isForcedSendCategory,
  type ResolvedTemplate,
} from '@gbox/core/modules/email/registry.js'
import type { EmailTemplateCategory } from '@gbox/db/schema/tables.js'
import { safeEmailTemplatesMessage } from '../lib/email-templates-flash.js'
import {
  buildSamplePreviewVariables,
  renderPreviewDocument,
} from '../lib/email-preview.js'
// Phase 14 PR7 — send-test endpoint.
import { sendTemplatedEmail } from '@gbox/core/modules/email/send.js'

// ---------------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------------

function banner(kind: 'ok' | 'error', text: string): string {
  const bg = kind === 'ok' ? 'rgba(34,197,94,.1)' : 'rgba(239,68,68,.1)'
  const border = kind === 'ok' ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'
  const color = kind === 'ok' ? '#22c55e' : '#ef4444'
  return `<div style="padding:10px 14px;border-radius:8px;background:${bg};border:1px solid ${border};color:${color};font-size:13px;margin-bottom:16px">${esc(text)}</div>`
}

function categoryLabel(cat: EmailTemplateCategory): string {
  switch (cat) {
    case 'transactional': return 'Transactional'
    case 'marketing': return 'Marketing'
    case 'lifecycle': return 'Lifecycle'
    case 'reviews': return 'Reviews'
    case 'ops': return 'Operations'
    case 'legal': return 'Legal'
    case 'platform':
      // audience='god_admin' filter already excluded these from the
      // list, but keep a sane fallback label to avoid a blank column
      // in the off chance a future template slips through.
      return 'Platform'
    default: return String(cat)
  }
}

function categoryHint(cat: EmailTemplateCategory): string {
  if (isForcedSendCategory(cat)) {
    return 'Always sent — cannot be disabled (Gbox platform guarantee).'
  }
  switch (cat) {
    case 'marketing':
      return 'Respects customer unsubscribe + frequency caps.'
    case 'lifecycle':
      return 'Respects customer unsubscribe.'
    case 'reviews':
      return 'Respects customer unsubscribe.'
    default:
      return ''
  }
}

// Category display order — forced-send up top (lets the seller see at
// a glance what ships no-matter-what), then the opt-in buckets.
const CATEGORY_ORDER: EmailTemplateCategory[] = [
  'transactional',
  'ops',
  'legal',
  'marketing',
  'lifecycle',
  'reviews',
  'platform', // should be empty after iron-rule-5 filter; kept for safety
]

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/settings/email-templates
// ---------------------------------------------------------------------------

export async function getEmailTemplatesList(
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

  let overrides: Awaited<ReturnType<typeof listShopOverrides>>
  try {
    overrides = await listShopOverrides(
      db as unknown as Parameters<typeof listShopOverrides>[0],
      store.id,
    )
  } catch {
    res.status(500).send(
      sellerLayout({
        title: 'Email templates',
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

  // Iron rule 5 — only merchant-visible templates. This is THE chokepoint
  // that keeps god-admin audience out of the seller UI, so any edit /
  // reset path below that keys off a merchant-submitted `:key` param
  // can safely re-run `getTemplate()` + `audience !== 'god_admin'` guard.
  const merchantTemplates = getMerchantVisibleTemplates()
  const overrideByKey = new Map(overrides.map((o) => [o.template_key, o]))

  // Group by category using our fixed display order.
  const byCategory = new Map<EmailTemplateCategory, typeof merchantTemplates>()
  for (const t of merchantTemplates) {
    const list = byCategory.get(t.category) ?? []
    list.push(t)
    byCategory.set(t.category, list)
  }

  const flash = saved
    ? banner('ok', saved === 'reset' ? 'Reset to default.' : 'Template saved.')
    : err
      ? banner('error', decodeURIComponent(err))
      : ''

  let body = ''
  for (const cat of CATEGORY_ORDER) {
    const list = byCategory.get(cat)
    if (!list || list.length === 0) continue
    // Sort by priority then key for stable display.
    list.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key))

    body += `
      <div class="card" style="margin-bottom:20px">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <span style="font-weight:600">${esc(categoryLabel(cat))}</span>
            <span style="margin-left:8px;color:var(--s-text-dim);font-size:12px">${list.length} template${list.length === 1 ? '' : 's'}</span>
          </div>
          <span style="font-size:12px;color:var(--s-text-dim)">${esc(categoryHint(cat))}</span>
        </div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Template</th>
                  <th>Subject (default)</th>
                  <th>Status</th>
                  <th style="text-align:right">Action</th>
                </tr>
              </thead>
              <tbody>`
    for (const t of list) {
      const ov = overrideByKey.get(t.key)
      const overridden = !!ov
      // Compute status: forced-send categories ignore ov.active=false.
      let statusHtml: string
      if (isForcedSendCategory(t.category)) {
        statusHtml = `<span class="badge badge-success">Always on</span>`
      } else if (ov && ov.active === false) {
        statusHtml = `<span class="badge badge-warning">Disabled</span>`
      } else {
        statusHtml = `<span class="badge badge-success">Active</span>`
      }
      body += `
                <tr>
                  <td>
                    <div style="font-weight:500">${esc(t.key)}</div>
                    <div style="font-size:12px;color:var(--s-text-dim);margin-top:2px">${esc(t.description)}</div>
                    ${overridden ? '<span class="badge badge-info" style="margin-top:4px;display:inline-block">Customized</span>' : ''}
                  </td>
                  <td style="color:var(--s-text-muted);font-size:13px">${esc(t.subject)}</td>
                  <td>${statusHtml}</td>
                  <td style="text-align:right">
                    <a href="${base}/settings/email-templates/${encodeURIComponent(t.key)}/preview"
                       target="_blank" rel="noopener"
                       class="btn btn-outline btn-sm"
                       style="text-decoration:none;margin-right:4px"
                       aria-label="Open preview of ${esc(t.key)} in a new tab">Preview</a>
                    <a href="${base}/settings/email-templates/${encodeURIComponent(t.key)}"
                       class="btn btn-outline btn-sm"
                       style="text-decoration:none">${overridden ? 'Edit' : 'Customize'}</a>
                  </td>
                </tr>`
    }
    body += `
              </tbody>
            </table>
          </div>
        </div>
      </div>`
  }

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/settings" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Settings
        </a>
        <h1 class="page-title">Email templates</h1>
        <p class="page-subtitle">
          Customize the subject line, HTML, and text for any of the emails your store sends.
          Transactional templates (order confirmations, password resets) are always delivered — you can't disable them.
        </p>
      </div>
    </div>

    ${flash}

    ${body || '<div class="card"><div class="card-body">No templates available.</div></div>'}
  `

  res.send(
    sellerLayout({
      title: 'Email templates',
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
// GET /admin/store/:slug/settings/email-templates/:key
// ---------------------------------------------------------------------------

export async function getEmailTemplatesEditor(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}`
  const key = String(req.params.key || '').trim()

  // Iron rule 5 — unknown-or-god-admin ⇒ seller-safe 404.
  const spec = getTemplate(key)
  if (!spec || spec.audience === 'god_admin') {
    res.redirect(
      `${base}/settings/email-templates?err=${encodeURIComponent('That email template is not available.')}`,
    )
    return
  }

  let resolved: ResolvedTemplate | null
  try {
    resolved = await resolveTemplate(
      db as unknown as Parameters<typeof resolveTemplate>[0],
      store.id,
      key,
    )
  } catch {
    res.redirect(
      `${base}/settings/email-templates?err=${encodeURIComponent('Please contact Gbox support.')}`,
    )
    return
  }
  if (!resolved) {
    // Should not happen — we already validated spec above. Defensive.
    res.redirect(
      `${base}/settings/email-templates?err=${encodeURIComponent('That email template is not available.')}`,
    )
    return
  }

  const saved = typeof req.query.saved === 'string' ? req.query.saved : null
  const err = typeof req.query.err === 'string' ? req.query.err : null
  const flash = saved
    ? banner('ok', saved === 'reset' ? 'Reset to default.' : 'Template saved.')
    : err
      ? banner('error', decodeURIComponent(err))
      : ''

  const csrf = csrfHiddenField(((req as any).csrfToken as string) || '')
  const forced = isForcedSendCategory(spec.category)

  const varsHtml = spec.variables.length > 0
    ? spec.variables.map((v) => `<code style="background:var(--s-bg-elevated);padding:1px 6px;border-radius:4px;font-size:11px">{{${esc(v)}}}</code>`).join(' ')
    : '<span style="color:var(--s-text-dim);font-size:12px">No placeholders.</span>'

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/settings/email-templates" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Email templates
        </a>
        <h1 class="page-title">${esc(spec.key)}</h1>
        <p class="page-subtitle">
          ${esc(categoryLabel(spec.category))} · ${resolved.overridden ? 'Customized' : 'Using default'}
          ${forced ? ' · <strong>Always on</strong>' : ''}
        </p>
      </div>
    </div>

    ${flash}

    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><span>About this template</span></div>
      <div class="card-body">
        <div style="color:var(--s-text-muted);font-size:13px;margin-bottom:12px">${esc(spec.description)}</div>
        <div style="font-size:12px;color:var(--s-text-dim);margin-bottom:6px">Available placeholders:</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${varsHtml}</div>
      </div>
    </div>

    <!--
      Phase 14 PR2 commit 16 — iframe preview. Isolated from the dashboard's
      CSS so the email renders like a real inbox. The iframe src returns a
      standalone HTML document with sample variable values and a "Preview"
      ribbon pinned top-right. Sandboxed to block scripts + navigation
      (emails never need either — and templates are authored by the seller
      so we treat the output as untrusted).
    -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
        <span>Preview</span>
        <span style="font-size:12px;color:var(--s-text-dim)">Sample data · save to see your changes</span>
      </div>
      <div class="card-body" style="padding:0">
        <iframe
          title="Email preview for ${esc(spec.key)}"
          src="${base}/settings/email-templates/${encodeURIComponent(spec.key)}/preview"
          sandbox="allow-same-origin"
          loading="lazy"
          style="display:block;width:100%;min-height:520px;border:0;border-radius:0 0 8px 8px;background:#f5f5f5">
        </iframe>
      </div>
    </div>

    <!--
      Phase 14 PR7 — Send a real test email to the signed-in user's address.
      Uses the SAME rendering path as production (resolveTemplate -> interpolate
      -> transport) with sample variables, so merchants can sanity-check what
      will land in inboxes. Rate-limited (3/min/IP via strictLimiter + 5/hr/user
      at the handler layer) so the button cannot become a spam relay. Requires
      the email:send_test permission (admin + owner by default).
    -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
        <span>Send test</span>
        <span style="font-size:12px;color:var(--s-text-dim)">We'll send this template to your account email.</span>
      </div>
      <div class="card-body">
        <form method="post"
              action="${base}/settings/email-templates/${encodeURIComponent(spec.key)}/send-test"
              style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          ${csrf}
          <div style="font-size:13px;color:var(--s-text)">
            Recipient: <strong>${esc(user.email)}</strong>
          </div>
          <button type="submit" class="btn btn-outline" style="font-size:13px">
            Send test email
          </button>
          <span style="font-size:12px;color:var(--s-text-dim)">
            Limit: 5 per hour per user.
          </span>
        </form>
      </div>
    </div>

    <form method="post" action="${base}/settings/email-templates/${encodeURIComponent(spec.key)}/update"
          style="display:flex;flex-direction:column;gap:16px">
      ${csrf}

      <div class="card">
        <div class="card-header"><span>Content</span></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
          <label style="display:flex;flex-direction:column;gap:6px">
            <span style="font-size:13px;font-weight:500">Subject line</span>
            <input type="text" name="subject" value="${esc(resolved.subject)}" required maxlength="255"
                   style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg-elevated);color:var(--s-text);font-size:14px">
            <span style="font-size:12px;color:var(--s-text-dim)">Placeholders like <code>{{shop_name}}</code> are replaced at send time.</span>
          </label>

          <label style="display:flex;flex-direction:column;gap:6px">
            <span style="font-size:13px;font-weight:500">Body (HTML)</span>
            <textarea name="body_html" rows="14" required
                      style="width:100%;padding:10px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg-elevated);color:var(--s-text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.5">${esc(resolved.bodyHtml)}</textarea>
            <span style="font-size:12px;color:var(--s-text-dim)">Full HTML. Rendered by the transport at send time.</span>
          </label>

          <label style="display:flex;flex-direction:column;gap:6px">
            <span style="font-size:13px;font-weight:500">Body (plain text fallback)</span>
            <textarea name="body_text" rows="6"
                      style="width:100%;padding:10px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg-elevated);color:var(--s-text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.5">${esc(resolved.bodyText)}</textarea>
            <span style="font-size:12px;color:var(--s-text-dim)">Shown to clients that don't render HTML. If blank, we'll derive one from your HTML.</span>
          </label>

          ${forced ? `
          <div style="padding:10px 14px;border-radius:8px;background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.25);color:var(--s-text);font-size:13px">
            This template is always sent and cannot be disabled (Gbox platform guarantee). You can still customize the content.
          </div>
          ` : `
          <label style="display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer">
            <input type="checkbox" name="active" value="1" ${resolved.active ? 'checked' : ''}
                   style="width:16px;height:16px;accent-color:var(--s-accent)">
            <span>Send this email to customers</span>
          </label>
          `}
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:space-between;align-items:center">
        <div>
          ${resolved.overridden ? `
          <button type="submit"
                  form="reset-form"
                  class="btn btn-outline"
                  style="color:var(--s-danger,#ef4444)">Reset to default</button>
          ` : ''}
        </div>
        <div style="display:flex;gap:8px">
          <a href="${base}/settings/email-templates" class="btn btn-outline" style="text-decoration:none">Cancel</a>
          <button type="submit" class="btn btn-primary">Save template</button>
        </div>
      </div>
    </form>

    ${resolved.overridden ? `
    <form id="reset-form" method="post"
          action="${base}/settings/email-templates/${encodeURIComponent(spec.key)}/reset"
          style="display:none">
      ${csrf}
    </form>
    ` : ''}
  `

  res.send(
    sellerLayout({
      title: `Edit: ${spec.key}`,
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
// POST /admin/store/:slug/settings/email-templates/:key/update
// ---------------------------------------------------------------------------

export async function postEmailTemplatesEditorSave(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const key = String(req.params.key || '').trim()

  try {
    // Iron rule 5 chokepoint — re-validate `key` against the merchant-
    // visible catalog. Don't trust the URL param; a hostile seller could
    // post /settings/email-templates/platform_incident_alert/update and
    // we'd happily write to `email_template_overrides` otherwise. The
    // table FK to the registry would let the insert succeed because
    // god-admin templates are in the registry — so the check has to be
    // at this layer.
    const spec = getTemplate(key)
    if (!spec || spec.audience === 'god_admin') {
      throw new Error('not_seller_visible')
    }

    const body = (req.body ?? {}) as {
      subject?: string
      body_html?: string
      body_text?: string
      active?: string
    }
    const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
    const bodyHtml = typeof body.body_html === 'string' ? body.body_html : ''
    const bodyText = typeof body.body_text === 'string' ? body.body_text : ''
    const activeRaw = body.active === '1' || body.active === 'true'
    // Forced-send categories force active=true regardless of form input
    // — belt-and-braces on top of the resolve-time guard.
    const active = isForcedSendCategory(spec.category) ? true : activeRaw

    if (subject.length === 0) throw new Error('invalid subject')
    if (bodyHtml.length === 0) throw new Error('invalid body_html')

    await upsertTemplateOverride(
      db as unknown as Parameters<typeof upsertTemplateOverride>[0],
      {
        shopId: store.id,
        templateKey: key,
        subjectCustom: subject,
        bodyHtmlCustom: bodyHtml,
        bodyTextCustom: bodyText.length > 0 ? bodyText : null,
        active,
      },
    )

    res.redirect(`${base}/settings/email-templates/${encodeURIComponent(key)}?saved=1`)
  } catch (err) {
    res.redirect(
      `${base}/settings/email-templates/${encodeURIComponent(key)}?err=${encodeURIComponent(
        safeEmailTemplatesMessage(err),
      )}`,
    )
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/settings/email-templates/:key/reset
// ---------------------------------------------------------------------------

export async function postEmailTemplatesEditorReset(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const key = String(req.params.key || '').trim()

  try {
    // Iron rule 5 chokepoint (same shape as update).
    const spec = getTemplate(key)
    if (!spec || spec.audience === 'god_admin') {
      throw new Error('not_seller_visible')
    }

    await clearTemplateOverride(
      db as unknown as Parameters<typeof clearTemplateOverride>[0],
      store.id,
      key,
    )

    res.redirect(`${base}/settings/email-templates?saved=reset`)
  } catch (err) {
    res.redirect(
      `${base}/settings/email-templates?err=${encodeURIComponent(
        safeEmailTemplatesMessage(err),
      )}`,
    )
  }
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/settings/email-templates/:key/preview
//
// Phase 14 PR2 — seller preview: renders the resolved template (override
// → DB default → in-code catalog) with sample variables filled in, then
// returns a standalone HTML document suitable for iframe embed inside
// the editor page. Same iron-rule-5 chokepoint as the editor route:
// unknown-or-god-admin keys 404 with a seller-safe message.
//
// Headers
// -------
// - `Content-Type: text/html; charset=utf-8`
// - `Cache-Control: no-store` — preview must always reflect the latest
//   override state; caching would confuse merchants mid-edit.
// - `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
//    img-src https: data:; font-src https: data:` — emails never need
//   scripts; blocking them eliminates a whole class of XSS via crafted
//   template bodies.
// - `X-Frame-Options: SAMEORIGIN` — lets our editor's iframe render it
//   while still keeping third parties out.
// ---------------------------------------------------------------------------

export async function getEmailTemplatePreview(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const key = String(req.params.key || '').trim()

  // Iron rule 5 chokepoint — same shape as the editor route.
  const spec = getTemplate(key)
  if (!spec || spec.audience === 'god_admin') {
    res.status(404).type('text/html; charset=utf-8').send(
      '<!DOCTYPE html><html><body style="font:14px -apple-system,sans-serif;padding:24px;color:#6b7280">' +
        'Preview not available.' +
        '</body></html>',
    )
    return
  }

  let resolved: ResolvedTemplate | null
  try {
    resolved = await resolveTemplate(
      db as unknown as Parameters<typeof resolveTemplate>[0],
      store.id,
      key,
    )
  } catch {
    res.status(500).type('text/html; charset=utf-8').send(
      '<!DOCTYPE html><html><body style="font:14px -apple-system,sans-serif;padding:24px;color:#ef4444">' +
        'Please contact Gbox support.' +
        '</body></html>',
    )
    return
  }
  if (!resolved) {
    res.status(404).type('text/html; charset=utf-8').send(
      '<!DOCTYPE html><html><body style="font:14px -apple-system,sans-serif;padding:24px;color:#6b7280">' +
        'Preview not available.' +
        '</body></html>',
    )
    return
  }

  const variables = buildSamplePreviewVariables(spec)
  const html = renderPreviewDocument({ resolved, variables })

  res
    .status(200)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .setHeader('Cache-Control', 'no-store')
    .setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data:",
    )
    .setHeader('X-Frame-Options', 'SAMEORIGIN')
    .send(html)
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/settings/email-templates/:key/send-test
//
// Phase 14 PR7 (BUG-E6) — Send a real rendered test to the signed-in
// user's own email address. Uses the production send pipeline so
// template variables, HTML rendering, tracking injection, and delivery
// logging all run exactly as they would in production — we deliberately
// don't short-circuit this as a "just preview" so admins catch bugs
// that only surface after SMTP.
//
// Guards (defense in depth):
//   1. Route middleware requires `email:send_test` permission (staff
//      without the permission gets a 403 from require-permission.ts).
//   2. Route middleware attaches strictLimiter — per-IP 10/min global.
//   3. This handler enforces a per-user 5/hour soft limit by counting
//      recent email_deliveries with template_key=<key> + shop_id=<shop>
//      + recipient_email=<user.email>. Prevents a compromised session
//      from fanning out 600 msg/hour via the hundreds of templates.
//   4. Iron rule 5 re-check — getTemplate(key) must not be audience=
//      god_admin even though the route handler already guards. Defense
//      in depth for a future misconfiguration.
//
// Shopify parity: admin.shopify.com/email-templates has a similar
// "Send test email" button on every template editor. We match that UX
// so merchants coming from Shopify find it in the same place.
// ---------------------------------------------------------------------------

const SEND_TEST_HOURLY_LIMIT = 5

export async function postEmailTemplateSendTest(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const key = String(req.params.key || '').trim()
  const backToEditor = `${base}/settings/email-templates/${encodeURIComponent(key)}`

  try {
    // Iron rule 5 chokepoint (same shape as update/reset/preview).
    const spec = getTemplate(key)
    if (!spec || spec.audience === 'god_admin') {
      res.redirect(`${base}/settings/email-templates?err=unknown`)
      return
    }

    // Per-user hourly rate-limit. Count recent test-sends by looking
    // at delivery rows with idempotency_key LIKE 'send-test:%:<userId>:%'
    // in the last hour. We store `send-test:<key>:<userId>:<ts>` so the
    // LIKE is cheap and the count is honest.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const recentRow = (await (db as any)
      .selectFrom('email_deliveries')
      .select((eb: any) => eb.fn.countAll().as('count'))
      .where('shop_id', '=', store.id)
      .where('idempotency_key', 'like', `send-test:%:${user.id}:%`)
      .where('created_at', '>=', oneHourAgo)
      .executeTakeFirst()) as { count: number | string } | undefined

    const recent = Number(recentRow?.count ?? 0)
    if (recent >= SEND_TEST_HOURLY_LIMIT) {
      res.redirect(
        `${backToEditor}?err=${encodeURIComponent(
          `Hourly test-send limit reached (${SEND_TEST_HOURLY_LIMIT}/hour). Try again later.`,
        )}`,
      )
      return
    }

    // Resolve the template with sample variables. Same helpers the
    // preview iframe uses so WYSIWYG — merchants see in the inbox what
    // they saw in the preview panel.
    const resolved = await resolveTemplate(
      db as unknown as Parameters<typeof resolveTemplate>[0],
      store.id,
      key,
    )
    if (!resolved) {
      res.redirect(`${backToEditor}?err=unknown`)
      return
    }
    const variables = buildSamplePreviewVariables(spec)

    // Mint a unique idempotency key per send-test so concurrent clicks
    // don't dedupe — each press should produce a new message.
    const idempotencyKey = `send-test:${key}:${user.id}:${Date.now()}`

    const result = await sendTemplatedEmail(db, {
      templateKey: key,
      to: user.email,
      shopId: store.id,
      variables,
      recipientUserId: user.id,
      idempotencyKey,
    })

    if (!result.ok) {
      // Map reason → seller-safe flash. Iron rule 5: never leak
      // `iron_rule_5_blocked` literal (route guard already caught
      // god_admin keys but belt-and-suspenders — surface generic text).
      const reasonMsg = (() => {
        switch (result.reason) {
          case 'skipped_pref':
            return 'Your account is opted out of this email category. Update preferences and try again.'
          case 'skipped_suppressed':
            return 'Your address is on the suppression list. Un-suppress it first.'
          case 'transport_failed':
            return 'The email provider refused the send. Please contact Gbox support.'
          case 'db_write_failed':
            return 'We could not record the send. Please contact Gbox support.'
          default:
            return 'Test send did not go through. Please contact Gbox support.'
        }
      })()
      res.redirect(`${backToEditor}?err=${encodeURIComponent(reasonMsg)}`)
      return
    }

    res.redirect(
      `${backToEditor}?saved=${encodeURIComponent(
        `Test email queued to ${user.email}. Check your inbox in a minute.`,
      )}`,
    )
  } catch (err) {
    // Never bubble — send-test failure must not 500 the page.
    console.error('[email-templates] send-test failure:', err)
    res.redirect(
      `${backToEditor}?err=${encodeURIComponent(safeEmailTemplatesMessage(err))}`,
    )
  }
}
