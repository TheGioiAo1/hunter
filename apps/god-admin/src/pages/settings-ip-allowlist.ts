/**
 * God Admin — IP Allowlist Settings (Phase 0 §8 Item #4)
 *
 * Route surface
 * -------------
 *   GET  /god-admin/settings/ip-allowlist         — view + edit form
 *   POST /god-admin/settings/ip-allowlist/save    — replace the full list
 *
 * Storage model
 * -------------
 * The list lives on the `users.ip_allowlist` JSONB column (migration
 * 016). NULL or empty array = allowlist disabled (allow from anywhere).
 * Non-empty array = request IP must match at least one CIDR or the
 * god-auth / store-auth / session-auth middlewares refuse the request.
 *
 * Form semantics
 * --------------
 * - The textarea is freeform, one CIDR per line.
 * - Blank lines and `#`-prefixed comments are ignored.
 * - Every non-blank line is validated by `parseCidr`; any line that
 *   fails validation is shown back to the operator inline.
 * - Saving an empty textarea stores NULL (allowlist disabled) so we
 *   don't accidentally store `[]` and conflate the two states.
 *
 * Failure model
 * -------------
 * The middleware fails CLOSED on a broken allowlist — if the JSONB
 * column is non-empty but contains invalid CIDRs, nobody gets in. So
 * this page refuses to save a list containing ANY invalid lines, to
 * avoid footgunning ops into locking themselves out. They have to fix
 * the typos first.
 *
 * Self-lockout guard
 * ------------------
 * When saving, we normalise the caller's current request IP and check
 * it against the proposed list. If it doesn't match, we refuse the
 * save with a clear error pointing at the current IP. Ops can still
 * force-save by adding their IP explicitly — that's the whole point
 * of the guard: force them to actually type their IP before committing.
 *
 * Audit trail
 * -----------
 * Every successful save writes an `ip_allowlist_updated` audit event
 * with the before/after values so god-admin → Security → Audit log has
 * a full record of changes.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'

import { godLayout, readThemeFromRequest } from '../layouts/god-layout.js'
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import {
  parseCidr,
  parseCidrList,
  ipInAllowlist,
  normaliseRequestIp,
  InvalidCidrError,
} from '../../../../packages/core/src/modules/auth/ip-allowlist.js'

// ---------------------------------------------------------------------------
// Module-level CSRF store
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({
  cookieName: 'gbox_csrf_god_settings_ip_allowlist',
})

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

interface ParsedForm {
  /** Cleaned entries ready to be stored (comments/blanks stripped). */
  cleaned: string[]
  /** Raw textarea contents, preserved for re-display on error. */
  raw: string
  /** Per-line validation errors (index into the cleaned list). */
  errors: { raw: string; message: string }[]
}

function parseForm(raw: string): ParsedForm {
  const cleaned: string[] = []
  const errors: { raw: string; message: string }[] = []
  const lines = String(raw ?? '').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    // Strip inline comments: "1.2.3.0/24  # office"
    const noComment = trimmed.split('#')[0].trim()
    if (!noComment) continue
    try {
      parseCidr(noComment)
      cleaned.push(noComment)
    } catch (err) {
      errors.push({
        raw: noComment,
        message:
          err instanceof InvalidCidrError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err),
      })
    }
  }
  return { cleaned, raw: String(raw ?? ''), errors }
}

// ---------------------------------------------------------------------------
// Page renderer
// ---------------------------------------------------------------------------

interface RenderOpts {
  userEmail: string
  currentList: string[] | null
  textareaValue: string
  errors: { raw: string; message: string }[]
  notice: string | null
  error: string | null
  csrfToken: string
  currentIp: string
}

function renderPage(opts: RenderOpts): string {
  const listCount = Array.isArray(opts.currentList) ? opts.currentList.length : 0
  const enabled = listCount > 0
  const rows = Array.isArray(opts.currentList) ? opts.currentList : []

  const errorsHtml = opts.errors.length
    ? `<div class="err">
        <strong>${opts.errors.length} line${opts.errors.length === 1 ? '' : 's'} did not validate:</strong>
        <ul>
          ${opts.errors
            .map(
              (e) =>
                `<li><code>${escapeHtml(e.raw)}</code> — ${escapeHtml(e.message)}</li>`,
            )
            .join('')}
        </ul>
        <p>Fix or remove these lines and re-save.</p>
      </div>`
    : ''

  const noticeHtml = opts.notice
    ? `<div class="notice">${escapeHtml(opts.notice)}</div>`
    : ''

  const topErrorHtml = opts.error
    ? `<div class="err">${escapeHtml(opts.error)}</div>`
    : ''

  const currentRows = rows.length
    ? `<ul class="current">${rows.map((c) => `<li><code>${escapeHtml(c)}</code></li>`).join('')}</ul>`
    : `<p class="muted">No entries — allowlist is currently <strong>disabled</strong>. Any IP can reach the god-admin dashboards (subject to 2FA).</p>`

  return `
  <div class="wrap">
    <h1>IP Allowlist</h1>
    <p class="lead">
      Restrict where you can sign in to the god-admin dashboards from.
      One CIDR per line; <code>#</code> for comments. Blank textarea =
      allowlist disabled.
    </p>

    <div class="grid">
      <section class="card">
        <h2>Current status</h2>
        <p><strong>${enabled ? `Enabled — ${listCount} entr${listCount === 1 ? 'y' : 'ies'}` : 'Disabled'}</strong></p>
        ${currentRows}
      </section>

      <section class="card">
        <h2>Your request right now</h2>
        <p>This IP is the one the server sees for <em>your</em> browser:</p>
        <p class="ip-now"><code>${escapeHtml(opts.currentIp || 'unknown')}</code></p>
        <p class="muted">If you're about to enable the allowlist, make sure this IP is on the list — otherwise you'll lock yourself out the moment you save.</p>
      </section>
    </div>

    ${noticeHtml}
    ${topErrorHtml}
    ${errorsHtml}

    <form method="POST" action="/god-admin/settings/ip-allowlist/save" autocomplete="off">
      ${csrfStore.hiddenField(opts.csrfToken)}
      <label for="entries">Allowlist entries</label>
      <textarea id="entries" name="entries" rows="14" spellcheck="false" placeholder="10.0.0.0/8&#10;192.168.1.50&#10;# office static&#10;2001:db8::/32">${escapeHtml(opts.textareaValue)}</textarea>
      <div class="actions">
        <button type="submit" class="primary">Save allowlist</button>
        <a href="/god-admin/security" class="secondary">Cancel</a>
      </div>
    </form>

    <section class="card help">
      <h3>Format</h3>
      <ul>
        <li>IPv4 CIDR: <code>10.0.0.0/8</code></li>
        <li>Single IPv4: <code>1.2.3.4</code> (treated as <code>/32</code>)</li>
        <li>IPv6 CIDR: <code>2001:db8::/32</code></li>
        <li>Single IPv6: <code>::1</code> (treated as <code>/128</code>)</li>
        <li>Comments start with <code>#</code>. Inline comments after a value work too.</li>
      </ul>
      <h3>Enforcement</h3>
      <ul>
        <li>Applied by the god-admin auth middleware on every dashboard request.</li>
        <li>Applied by the store-admin auth middleware (per-shop + /stores hub).</li>
        <li>Login, logout and 2FA challenge pages are never blocked so you can always reach the challenge step.</li>
        <li>An allowlist with invalid CIDRs fails <em>closed</em> — saving is refused until every line parses cleanly.</li>
      </ul>
    </section>
  </div>

  <style>
    .wrap { max-width: 900px; padding: 24px 32px 64px; }
    h1 { font-size: 26px; margin: 0 0 6px; }
    .lead { color: #94a3b8; margin: 0 0 24px; }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 20px;
    }
    @media (max-width: 780px) { .grid { grid-template-columns: 1fr; } }
    .card {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 16px 18px;
    }
    .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin: 0 0 10px; }
    .card h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin: 14px 0 6px; }
    .card.help ul { margin: 0; padding-left: 18px; color: #cbd5e1; font-size: 13px; line-height: 1.7; }
    .current { list-style: none; padding: 0; margin: 6px 0 0; }
    .current li { padding: 4px 0; border-bottom: 1px dashed #1e293b; font-size: 13px; }
    .current li:last-child { border-bottom: none; }
    .ip-now { margin: 8px 0 6px; }
    .ip-now code {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 4px;
      padding: 4px 8px;
      color: #f1f5f9;
      font-size: 13px;
    }
    .muted { color: #64748b; font-size: 12px; margin: 8px 0 0; }
    .notice {
      background: #065f46;
      border: 1px solid #047857;
      border-radius: 8px;
      padding: 12px 14px;
      color: #d1fae5;
      margin: 0 0 16px;
    }
    .err {
      background: #450a0a;
      border: 1px solid #7f1d1d;
      border-radius: 8px;
      padding: 12px 14px;
      color: #fecaca;
      margin: 0 0 16px;
    }
    .err ul { margin: 6px 0 6px 18px; }
    label { display: block; font-size: 13px; color: #e2e8f0; margin: 18px 0 6px; }
    textarea {
      width: 100%;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #f1f5f9;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 13px;
      padding: 12px;
      resize: vertical;
    }
    .actions { margin-top: 14px; display: flex; gap: 10px; }
    button.primary {
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    button.primary:hover { background: #1d4ed8; }
    a.secondary {
      display: inline-flex;
      align-items: center;
      padding: 10px 18px;
      border-radius: 8px;
      color: #94a3b8;
      text-decoration: none;
      font-size: 14px;
      border: 1px solid #334155;
    }
    a.secondary:hover { color: #e2e8f0; border-color: #475569; }
    code { font-family: 'SF Mono', Monaco, monospace; font-size: 12px; color: #f1f5f9; }
  </style>`
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function readUserAllowlist(
  db: Kysely<Database>,
  userId: string,
): Promise<string[] | null> {
  const row = await db
    .selectFrom('users')
    .select(['ip_allowlist'])
    .where('id', '=', userId)
    .executeTakeFirst()
  const raw = row?.ip_allowlist as unknown
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string')
  }
  return null
}

async function writeUserAllowlist(
  db: Kysely<Database>,
  userId: string,
  list: string[] | null,
): Promise<void> {
  // Store NULL when empty so "disabled" and "[]" stay distinct. JSON
  // serialization handled by the driver for non-null lists.
  await db
    .updateTable('users')
    .set({
      ip_allowlist:
        list && list.length > 0 ? (JSON.stringify(list) as any) : null,
    })
    .where('id', '=', userId)
    .execute()
}

function formatListForTextarea(list: string[] | null): string {
  if (!list || list.length === 0) return ''
  return list.join('\n')
}

// ---------------------------------------------------------------------------
// GET — render the page
// ---------------------------------------------------------------------------

export async function getSettingsIpAllowlist(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const ctx = req.godAdmin
  if (!ctx) {
    res.redirect('/god-admin/login')
    return
  }

  const csrfToken = await csrfStore.issue(res, isProduction())
  const currentList = await readUserAllowlist(db, ctx.user.id)
  const currentIp = normaliseRequestIp(req.ip ?? null) ?? 'unknown'

  res.send(
    godLayout({
      title: 'IP Allowlist',
      userEmail: ctx.user.email,
      isDefaultAdmin: ctx.isDefaultAdmin,
      activePath: '/god-admin/settings/ip-allowlist',
      theme: readThemeFromRequest(req),
      content: renderPage({
        userEmail: ctx.user.email,
        currentList,
        textareaValue: formatListForTextarea(currentList),
        errors: [],
        notice: null,
        error: null,
        csrfToken,
        currentIp,
      }),
    }),
  )
}

// ---------------------------------------------------------------------------
// POST — save the list
// ---------------------------------------------------------------------------

export async function postSettingsIpAllowlistSave(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const ctx = req.godAdmin
  if (!ctx) {
    res.redirect('/god-admin/login')
    return
  }

  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    const currentList = await readUserAllowlist(db, ctx.user.id)
    const currentIp = normaliseRequestIp(req.ip ?? null) ?? 'unknown'
    res.status(403).send(
      godLayout({
        title: 'IP Allowlist',
        userEmail: ctx.user.email,
        isDefaultAdmin: ctx.isDefaultAdmin,
        activePath: '/god-admin/settings/ip-allowlist',
        theme: readThemeFromRequest(req),
        content: renderPage({
          userEmail: ctx.user.email,
          currentList,
          textareaValue: typeof req.body?.entries === 'string' ? req.body.entries : '',
          errors: [],
          notice: null,
          error: 'Session expired — reload and try again.',
          csrfToken,
          currentIp,
        }),
      }),
    )
    return
  }

  const rawEntries = typeof req.body?.entries === 'string' ? req.body.entries : ''
  const parsed = parseForm(rawEntries)
  const csrfToken = await csrfStore.issue(res, isProduction())
  const currentIp = normaliseRequestIp(req.ip ?? null) ?? 'unknown'
  const currentList = await readUserAllowlist(db, ctx.user.id)

  // Refuse to save if any line failed validation — we never want a
  // half-broken allowlist in the DB because the middleware fails closed.
  if (parsed.errors.length > 0) {
    res.status(400).send(
      godLayout({
        title: 'IP Allowlist',
        userEmail: ctx.user.email,
        isDefaultAdmin: ctx.isDefaultAdmin,
        activePath: '/god-admin/settings/ip-allowlist',
        theme: readThemeFromRequest(req),
        content: renderPage({
          userEmail: ctx.user.email,
          currentList,
          textareaValue: rawEntries,
          errors: parsed.errors,
          notice: null,
          error: 'Some entries are invalid. Fix them before saving.',
          csrfToken,
          currentIp,
        }),
      }),
    )
    return
  }

  // Self-lockout guard — if the new list is non-empty and the caller's
  // own IP isn't covered, refuse the save and tell them which IP they
  // need to add. They can override by typing it in explicitly.
  if (parsed.cleaned.length > 0) {
    const compiled = parseCidrList(parsed.cleaned)
    const myIp = normaliseRequestIp(req.ip ?? null)
    if (!myIp || !ipInAllowlist(myIp, compiled.valid)) {
      res.status(400).send(
        godLayout({
          title: 'IP Allowlist',
          userEmail: ctx.user.email,
          isDefaultAdmin: ctx.isDefaultAdmin,
          activePath: '/god-admin/settings/ip-allowlist',
          theme: readThemeFromRequest(req),
          content: renderPage({
            userEmail: ctx.user.email,
            currentList,
            textareaValue: rawEntries,
            errors: [],
            notice: null,
            error:
              `Refused to save: your current IP (${myIp ?? 'unknown'}) is not ` +
              `covered by the proposed allowlist. Add it explicitly before ` +
              `saving or you'll lock yourself out.`,
            csrfToken,
            currentIp,
          }),
        }),
      )
      return
    }
  }

  // All checks passed — write and audit.
  const newList = parsed.cleaned.length > 0 ? parsed.cleaned : null
  await writeUserAllowlist(db, ctx.user.id, newList)

  // Direct audit insert — the shared `logAuditEvent` helper uses a
  // fixed `resource_type: 'auth'` and typed action enum; this is a
  // user-scoped security config change so we write the row by hand.
  await db
    .insertInto('audit_logs')
    .values({
      shop_id: null,
      user_id: ctx.user.id,
      action: 'ip_allowlist_updated',
      resource_type: 'user',
      resource_id: ctx.user.id,
      details: JSON.stringify({
        before: currentList ?? null,
        after: newList ?? null,
        entry_count_before: currentList?.length ?? 0,
        entry_count_after: newList?.length ?? 0,
        source: 'god-admin',
        actor_email: ctx.user.email,
        actor_ip: req.ip ?? null,
      }),
      ip_address: req.ip ?? null,
    })
    .execute()
    .catch((err) =>
      console.error('[settings-ip-allowlist] audit write failed:', err),
    )

  const refreshed = await readUserAllowlist(db, ctx.user.id)
  const newCsrfToken = await csrfStore.issue(res, isProduction())
  res.send(
    godLayout({
      title: 'IP Allowlist',
      userEmail: ctx.user.email,
      isDefaultAdmin: ctx.isDefaultAdmin,
      activePath: '/god-admin/settings/ip-allowlist',
      theme: readThemeFromRequest(req),
      content: renderPage({
        userEmail: ctx.user.email,
        currentList: refreshed,
        textareaValue: formatListForTextarea(refreshed),
        errors: [],
        notice:
          refreshed === null
            ? 'Allowlist disabled — sign-in from any IP is allowed.'
            : `Allowlist saved — ${refreshed.length} entr${refreshed.length === 1 ? 'y' : 'ies'} active.`,
        error: null,
        csrfToken: newCsrfToken,
        currentIp,
      }),
    }),
  )
}
