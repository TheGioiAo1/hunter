/**
 * God Admin — Lenful Routing Rules (Phase F4)
 *
 *   GET  /god-admin/fulfillments/routing              — list + new-rule form
 *   POST /god-admin/fulfillments/routing              — create rule
 *   POST /god-admin/fulfillments/routing/:id          — update rule (toggle fields)
 *   POST /god-admin/fulfillments/routing/:id/delete   — remove rule
 *   POST /god-admin/fulfillments/routing/sweep        — run auto-push sweep NOW
 *
 * Match types supported
 *   all        — catch-all (default for "always auto-push")
 *   shop       — match by shops.id
 *   shop_slug  — match by shops.slug
 *   country    — match by shipping_address.country / country_code (ISO)
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'
import {
  listRoutingRules,
  createRoutingRule,
  updateRoutingRule,
  deleteRoutingRule,
  runAutoPushSweep,
} from '../../../../packages/core/src/modules/fulfillment/lenful/index.js'

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_lenful_routing' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function esc(s: unknown): string {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function parseShippingPriority(raw: string): number[] {
  const parts = raw.split(',').map((x) => x.trim()).filter(Boolean)
  const result: number[] = []
  for (const p of parts) {
    const n = Number.parseInt(p, 10)
    if (Number.isFinite(n) && n >= 0 && n <= 8) result.push(n)
  }
  if (result.length === 0) return [0, 1, 2]
  return Array.from(new Set(result))
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments/routing
// ---------------------------------------------------------------------------

export async function getRoutingRules(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)
  const flash = typeof req.query.msg === 'string' ? req.query.msg : ''
  const err = typeof req.query.err === 'string' ? req.query.err : ''

  try {
    const rules = await listRoutingRules(db)

    const rows = rules.length
      ? rules
          .map(
            (r) => `
          <tr style="border-bottom:1px solid #1e293b">
            <td style="padding:10px 12px;font-family:monospace;font-size:12px">${r.priority}</td>
            <td style="padding:10px 12px;font-size:12px">
              <div style="font-weight:600">${esc(r.match_type)}</div>
              <div style="color:#94a3b8;font-family:monospace;font-size:11px">${esc(r.match_value || '(any)')}</div>
            </td>
            <td style="padding:10px 12px;text-align:center">
              ${r.auto_push
                ? '<span style="color:#10b981;font-size:11px;font-weight:600">AUTO-PUSH</span>'
                : '<span style="color:#64748b;font-size:11px">manual</span>'}
            </td>
            <td style="padding:10px 12px;font-family:monospace;font-size:11px;color:#94a3b8">${esc(r.default_shipping_priority.join(', '))}</td>
            <td style="padding:10px 12px;text-align:center">
              ${r.is_active
                ? '<span style="display:inline-block;padding:2px 10px;background:#10b98122;color:#10b981;border-radius:10px;font-size:11px;font-weight:600">active</span>'
                : '<span style="display:inline-block;padding:2px 10px;background:#64748b22;color:#94a3b8;border-radius:10px;font-size:11px;font-weight:600">inactive</span>'}
            </td>
            <td style="padding:10px 12px;text-align:right">
              <form method="POST" action="/god-admin/fulfillments/routing/${esc(r.id)}" style="display:inline">
                ${csrfField}
                <input type="hidden" name="is_active" value="${r.is_active ? 'false' : 'true'}">
                <button type="submit" style="padding:5px 10px;background:#1e293b;color:#cbd5e1;border:1px solid #334155;border-radius:6px;font-size:11px;cursor:pointer">
                  ${r.is_active ? 'Disable' : 'Enable'}
                </button>
              </form>
              <form method="POST" action="/god-admin/fulfillments/routing/${esc(r.id)}" style="display:inline">
                ${csrfField}
                <input type="hidden" name="auto_push" value="${r.auto_push ? 'false' : 'true'}">
                <button type="submit" style="padding:5px 10px;background:#1e293b;color:#cbd5e1;border:1px solid #334155;border-radius:6px;font-size:11px;cursor:pointer;margin-left:4px">
                  ${r.auto_push ? 'Stop auto' : 'Start auto'}
                </button>
              </form>
              <form method="POST" action="/god-admin/fulfillments/routing/${esc(r.id)}/delete" style="display:inline">
                ${csrfField}
                <button type="submit" onclick="return confirm('Delete this rule?')" style="padding:5px 10px;background:#7f1d1d;color:#fecaca;border:1px solid #991b1b;border-radius:6px;font-size:11px;cursor:pointer;margin-left:4px">
                  Delete
                </button>
              </form>
            </td>
          </tr>
        `,
          )
          .join('')
      : '<tr><td colspan="6" style="padding:32px;text-align:center;color:#64748b">No routing rules yet. Add one below.</td></tr>'

    const flashBanner = flash
      ? `<div style="padding:10px 14px;background:#10b98122;color:#10b981;border-radius:8px;margin-bottom:16px;font-size:12px;white-space:pre-wrap">${esc(flash)}</div>`
      : ''
    const errBanner = err
      ? `<div style="padding:10px 14px;background:#ef444422;color:#ef4444;border-radius:8px;margin-bottom:16px;font-size:12px;white-space:pre-wrap">${esc(err)}</div>`
      : ''

    const content = `
      <div class="page-header" style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <h1>Lenful Routing Rules</h1>
          <p style="color:#94a3b8;font-size:13px;margin:4px 0 0">
            Decide which orders auto-push to Lenful the moment they're paid. Rules are evaluated in priority order (lowest first).
          </p>
        </div>
        <form method="POST" action="/god-admin/fulfillments/routing/sweep">
          ${csrfField}
          <button type="submit" style="padding:10px 20px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">
            Run sweep now
          </button>
        </form>
      </div>

      ${flashBanner}
      ${errBanner}

      <div class="card" style="padding:0;overflow:hidden;margin-top:16px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#0f172a;border-bottom:1px solid #1e293b">
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;width:80px">Priority</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Match</th>
              <th style="padding:10px 12px;text-align:center;font-size:11px;text-transform:uppercase;color:#94a3b8;width:120px">Mode</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;width:180px">Shipping priority</th>
              <th style="padding:10px 12px;text-align:center;font-size:11px;text-transform:uppercase;color:#94a3b8;width:100px">Status</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#94a3b8;width:280px">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <div style="margin-top:20px;background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px">
        <h2 style="margin:0 0 14px;font-size:15px;color:#fff">Add a new rule</h2>
        <form method="POST" action="/god-admin/fulfillments/routing">
          ${csrfField}
          <div style="display:grid;grid-template-columns:120px 160px 1fr 200px 120px;gap:12px;align-items:end">
            <label style="font-size:11px;color:#94a3b8">Priority
              <input type="number" name="priority" value="100" min="0" max="999"
                     style="width:100%;margin-top:4px;padding:9px 10px;background:#020617;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-family:monospace">
            </label>
            <label style="font-size:11px;color:#94a3b8">Match type
              <select name="match_type"
                      style="width:100%;margin-top:4px;padding:9px 10px;background:#020617;border:1px solid #334155;border-radius:6px;color:#e2e8f0">
                <option value="all">all (catch-all)</option>
                <option value="shop">shop (by id)</option>
                <option value="shop_slug">shop_slug</option>
                <option value="country">country (ISO)</option>
              </select>
            </label>
            <label style="font-size:11px;color:#94a3b8">Match value
              <input type="text" name="match_value" placeholder="(leave empty for match_type=all)"
                     style="width:100%;margin-top:4px;padding:9px 10px;background:#020617;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-family:monospace">
            </label>
            <label style="font-size:11px;color:#94a3b8">Shipping priority (0-8, csv)
              <input type="text" name="default_shipping_priority" value="0, 1, 2"
                     style="width:100%;margin-top:4px;padding:9px 10px;background:#020617;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-family:monospace">
            </label>
            <label style="font-size:11px;color:#94a3b8;display:flex;align-items:center;gap:6px;padding-bottom:9px">
              <input type="checkbox" name="auto_push" value="true" checked>
              Auto-push
            </label>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:14px">
            <button type="submit" style="padding:9px 22px;background:#10b981;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">
              Create rule
            </button>
          </div>
        </form>
      </div>

      <div style="margin-top:24px;padding:16px;background:#0f172a;border-radius:8px;border:1px solid #1e293b;font-size:12px;color:#94a3b8;line-height:1.7">
        <strong style="color:#e2e8f0">📋 How rules evaluate</strong><br>
        • Walks rules in ascending <code>priority</code>; first active match wins.<br>
        • A rule with <code>match_type=all</code> is a catch-all — put it last (highest number).<br>
        • <em>Sweep now</em> scans recent paid + unfulfilled orders without a lenful_orders row and auto-pushes any that match a rule with <code>auto_push=true</code>.<br>
        • Live order.paid hook integration will ship with the checkout-v2 milestone; today's cadence: cron + button.
      </div>
    `

    res.send(
      godLayout({
        title: 'Lenful Routing',
        userEmail: user.email,
        activePath: '/god-admin/fulfillments/routing',
        content,
      }),
    )
  } catch (e: any) {
    console.error('[god-admin] routing rules error:', e)
    res.status(500).send('Error: ' + esc(e?.message ?? String(e)))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/routing   — create
// ---------------------------------------------------------------------------

export async function postRoutingRuleCreate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/routing?err=' + encodeURIComponent('CSRF expired.'))
    return
  }
  const user = req.godAdmin!.user
  const body = req.body as Record<string, string>
  try {
    await createRoutingRule(db, {
      priority: Number.parseInt(String(body.priority ?? '100'), 10) || 100,
      match_type: String(body.match_type ?? 'all'),
      match_value: String(body.match_value ?? '').trim(),
      auto_push: String(body.auto_push ?? '') === 'true',
      default_shipping_priority: parseShippingPriority(String(body.default_shipping_priority ?? '')),
      is_active: true,
      created_by: user.id,
    })
    res.redirect('/god-admin/fulfillments/routing?msg=' + encodeURIComponent('Rule created.'))
  } catch (e: any) {
    res.redirect(
      '/god-admin/fulfillments/routing?err=' + encodeURIComponent(e?.message ?? String(e)),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/routing/:id  — update (toggle fields)
// ---------------------------------------------------------------------------

export async function postRoutingRuleUpdate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/routing?err=' + encodeURIComponent('CSRF expired.'))
    return
  }
  const id = String(req.params.id ?? '')
  const body = req.body as Record<string, string>
  try {
    const patch: any = {}
    if (typeof body.is_active === 'string') patch.is_active = body.is_active === 'true'
    if (typeof body.auto_push === 'string') patch.auto_push = body.auto_push === 'true'
    if (typeof body.priority === 'string') patch.priority = Number.parseInt(body.priority, 10)
    if (typeof body.match_type === 'string') patch.match_type = body.match_type
    if (typeof body.match_value === 'string') patch.match_value = body.match_value
    if (typeof body.default_shipping_priority === 'string') {
      patch.default_shipping_priority = parseShippingPriority(body.default_shipping_priority)
    }
    await updateRoutingRule(db, id, patch)
    res.redirect('/god-admin/fulfillments/routing?msg=' + encodeURIComponent('Rule updated.'))
  } catch (e: any) {
    res.redirect(
      '/god-admin/fulfillments/routing?err=' + encodeURIComponent(e?.message ?? String(e)),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/routing/:id/delete
// ---------------------------------------------------------------------------

export async function postRoutingRuleDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/routing?err=' + encodeURIComponent('CSRF expired.'))
    return
  }
  const id = String(req.params.id ?? '')
  try {
    await deleteRoutingRule(db, id)
    res.redirect('/god-admin/fulfillments/routing?msg=' + encodeURIComponent('Rule deleted.'))
  } catch (e: any) {
    res.redirect(
      '/god-admin/fulfillments/routing?err=' + encodeURIComponent(e?.message ?? String(e)),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/routing/sweep
// ---------------------------------------------------------------------------

export async function postRoutingRuleSweep(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/routing?err=' + encodeURIComponent('CSRF expired.'))
    return
  }
  const user = req.godAdmin!.user
  try {
    const result = await runAutoPushSweep(db, {
      triggeredBy: 'god-admin-routing-sweep',
      userId: user.id,
      limit: 200,
    })
    const summary = `Sweep: scanned ${result.scanned}, matched ${result.matched}, pushed ${result.pushed}, skipped ${result.skipped}, failed ${result.failed}.`
    const detail = result.errors.length > 0 ? '\n' + result.errors.slice(0, 10).join('\n') : ''
    if (result.failed > 0) {
      res.redirect(
        '/god-admin/fulfillments/routing?err=' + encodeURIComponent(summary + detail),
      )
    } else {
      res.redirect('/god-admin/fulfillments/routing?msg=' + encodeURIComponent(summary))
    }
  } catch (e: any) {
    res.redirect(
      '/god-admin/fulfillments/routing?err=' + encodeURIComponent(e?.message ?? String(e)),
    )
  }
}
