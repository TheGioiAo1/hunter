/**
 * God Admin — Lenful API Log Explorer (Phase F6)
 *
 *   GET  /god-admin/fulfillments/api-log              — paginated list
 *   GET  /god-admin/fulfillments/api-log/:id          — detail modal (JSON body)
 *
 * Filters: status code (2xx/4xx/5xx/error), triggered_by, free text on
 * URL. Secrets are already redacted at write time by `redactRequestBody`
 * in crypto.ts; this explorer additionally runs a second-pass redactor
 * on display just in case.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'

function esc(s: unknown): string {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtDate(iso: string | Date | null | undefined): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch {
    return String(iso)
  }
}

function statusBadge(status: number | null | undefined): string {
  if (status === null || status === undefined) {
    return `<span style="display:inline-block;padding:2px 10px;background:#7f1d1d;color:#fecaca;border-radius:10px;font-size:11px;font-weight:600">ERR</span>`
  }
  const s = Number(status)
  let color = '#64748b'
  if (s >= 200 && s < 300) color = '#10b981'
  else if (s >= 300 && s < 400) color = '#f59e0b'
  else if (s >= 400 && s < 500) color = '#ef4444'
  else if (s >= 500) color = '#dc2626'
  return `<span style="display:inline-block;padding:2px 10px;background:${color}22;color:${color};border-radius:10px;font-size:11px;font-weight:600">${s}</span>`
}

/**
 * Display-time second-pass redaction — defence in depth. Rewrites any
 * substring of the JSON that looks like an API key / token / bearer /
 * password into [REDACTED].
 */
function secondPassRedact(s: string): string {
  if (!s) return s
  return s
    .replace(/"(password|token|access_token|bearer|secret|api_key|apikey)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"')
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/g, 'Bearer [REDACTED]')
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments/api-log
// ---------------------------------------------------------------------------

export async function getApiLog(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1)
  const limit = 50
  const filterStatus = typeof req.query.status === 'string' ? req.query.status : 'all'
  const filterTrigger = typeof req.query.trigger === 'string' ? req.query.trigger : ''
  const search = typeof req.query.q === 'string' ? req.query.q.trim() : ''

  try {
    let q = db
      .selectFrom('lenful_api_log')
      .select([
        'id',
        'method',
        'url',
        'status_code',
        'duration_ms',
        'triggered_by',
        'user_id',
        'error_msg',
        'created_at',
      ])
      .orderBy('created_at', 'desc')

    let countQ = db
      .selectFrom('lenful_api_log')
      .select((eb) => eb.fn.countAll<number>().as('n'))

    if (filterStatus === 'ok') {
      q = q.where('status_code', '>=', 200).where('status_code', '<', 300)
      countQ = countQ.where('status_code', '>=', 200).where('status_code', '<', 300)
    } else if (filterStatus === '4xx') {
      q = q.where('status_code', '>=', 400).where('status_code', '<', 500)
      countQ = countQ.where('status_code', '>=', 400).where('status_code', '<', 500)
    } else if (filterStatus === '5xx') {
      q = q.where('status_code', '>=', 500).where('status_code', '<', 600)
      countQ = countQ.where('status_code', '>=', 500).where('status_code', '<', 600)
    } else if (filterStatus === 'error') {
      q = q.where('status_code', 'is', null)
      countQ = countQ.where('status_code', 'is', null)
    }
    if (filterTrigger) {
      q = q.where('triggered_by', '=', filterTrigger)
      countQ = countQ.where('triggered_by', '=', filterTrigger)
    }
    if (search) {
      const s = `%${search}%`
      q = q.where('url', 'ilike', s)
      countQ = countQ.where('url', 'ilike', s)
    }

    const [rows, countRow] = await Promise.all([
      q.limit(limit).offset((page - 1) * limit).execute(),
      countQ.executeTakeFirst(),
    ])
    const total = Number(countRow?.n ?? 0)
    const pageCount = Math.max(1, Math.ceil(total / limit))

    // distinct triggers for dropdown
    const triggersRaw = await db
      .selectFrom('lenful_api_log')
      .select(['triggered_by'])
      .distinct()
      .orderBy('triggered_by', 'asc')
      .limit(30)
      .execute()
    const triggerOpts = triggersRaw
      .filter((r) => r.triggered_by)
      .map(
        (r) =>
          `<option value="${esc(r.triggered_by || '')}" ${r.triggered_by === filterTrigger ? 'selected' : ''}>${esc(r.triggered_by || '')}</option>`,
      )
      .join('')

    const body = rows.length
      ? rows
          .map((r) => {
            const urlShort = String(r.url || '').replace(/^https?:\/\/[^/]+/, '')
            return `
              <tr style="border-bottom:1px solid #1e293b;cursor:pointer" onclick="window.location.href='/god-admin/fulfillments/api-log/${esc(r.id)}'">
                <td style="padding:10px 12px">${statusBadge(r.status_code as any)}</td>
                <td style="padding:10px 12px;font-family:monospace;font-size:11px;color:#cbd5e1">${esc(r.method)}</td>
                <td style="padding:10px 12px;font-family:monospace;font-size:11px;color:#94a3b8;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.url)}">${esc(urlShort.slice(0, 120))}</td>
                <td style="padding:10px 12px;font-size:11px;color:#94a3b8">${r.duration_ms ?? '-'} ms</td>
                <td style="padding:10px 12px;font-size:11px;color:#64748b">${esc(r.triggered_by || '-')}</td>
                <td style="padding:10px 12px;font-size:11px;color:#94a3b8">${fmtDate(r.created_at as any)}</td>
              </tr>`
          })
          .join('')
      : '<tr><td colspan="6" style="padding:32px;text-align:center;color:#64748b">No log entries.</td></tr>'

    const prevPage = Math.max(1, page - 1)
    const nextPage = Math.min(pageCount, page + 1)
    const qs = (p: number) => {
      const u = new URLSearchParams()
      if (p > 1) u.set('page', String(p))
      if (filterStatus !== 'all') u.set('status', filterStatus)
      if (filterTrigger) u.set('trigger', filterTrigger)
      if (search) u.set('q', search)
      const out = u.toString()
      return out ? `?${out}` : ''
    }

    const statusTabs = [
      { id: 'all', label: 'All' },
      { id: 'ok', label: '2xx' },
      { id: '4xx', label: '4xx' },
      { id: '5xx', label: '5xx' },
      { id: 'error', label: 'Errors' },
    ]
      .map(
        (t) =>
          `<a href="?status=${t.id}${filterTrigger ? `&trigger=${encodeURIComponent(filterTrigger)}` : ''}${search ? `&q=${encodeURIComponent(search)}` : ''}"
             style="padding:6px 14px;background:${filterStatus === t.id ? '#3b82f6' : 'transparent'};color:${filterStatus === t.id ? '#fff' : '#94a3b8'};border:1px solid #334155;border-radius:6px;font-size:12px;text-decoration:none;margin-right:6px">${esc(t.label)}</a>`,
      )
      .join('')

    const content = `
      <div class="page-header">
        <h1>Lenful API Log</h1>
        <p style="color:#94a3b8;font-size:13px;margin:4px 0 0">
          Full audit trail of every HTTP call we make to Lenful, with request/response bodies. Secrets are redacted.
        </p>
      </div>

      <form method="GET" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px;padding:14px;background:#0f172a;border:1px solid #1e293b;border-radius:10px">
        <input type="hidden" name="status" value="${esc(filterStatus)}">
        <label style="display:block;font-size:11px;color:#94a3b8">Triggered by
          <select name="trigger" style="display:block;margin-top:4px;padding:8px 12px;background:#020617;border:1px solid #334155;border-radius:6px;color:#e2e8f0;min-width:220px">
            <option value="">Any actor</option>
            ${triggerOpts}
          </select>
        </label>
        <label style="display:block;font-size:11px;color:#94a3b8;flex:1;min-width:240px">Search URL
          <input type="text" name="q" value="${esc(search)}" placeholder="e.g. /api/order/create"
                 style="display:block;margin-top:4px;padding:8px 12px;background:#020617;border:1px solid #334155;border-radius:6px;color:#e2e8f0;width:100%">
        </label>
        <button type="submit" style="padding:9px 18px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Apply</button>
      </form>

      <div style="margin-bottom:14px">${statusTabs}</div>

      <div class="card" style="padding:0;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#0f172a;border-bottom:1px solid #1e293b">
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;width:80px">Status</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;width:70px">Method</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">URL</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;width:90px">Duration</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;width:180px">Trigger</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;width:160px">Timestamp</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
        <div style="display:flex;gap:8px;align-items:center;padding:14px 16px;border-top:1px solid #1e293b;font-size:12px">
          <span style="color:#94a3b8">Page ${page} / ${pageCount} • ${total} entries</span>
          <div style="margin-left:auto;display:flex;gap:6px">
            ${page > 1 ? `<a href="${qs(prevPage)}" style="padding:6px 12px;background:#1e293b;color:#cbd5e1;border-radius:6px;text-decoration:none">← Prev</a>` : ''}
            ${page < pageCount ? `<a href="${qs(nextPage)}" style="padding:6px 12px;background:#1e293b;color:#cbd5e1;border-radius:6px;text-decoration:none">Next →</a>` : ''}
          </div>
        </div>
      </div>

      <div style="margin-top:24px;padding:16px;background:#0f172a;border-radius:8px;border:1px solid #1e293b;font-size:12px;color:#94a3b8;line-height:1.7">
        <strong style="color:#e2e8f0">📋 F6 redaction</strong><br>
        • Bodies are redacted at write-time via <code>redactRequestBody()</code> in <code>crypto.ts</code>.<br>
        • A second-pass redactor runs on the detail view to catch any bearer tokens / passwords embedded in raw text.<br>
        • If you spot an un-redacted field, add its regex to <code>secondPassRedact()</code>.
      </div>
    `

    res.send(
      godLayout({
        title: 'Lenful API Log',
        userEmail: user.email,
        activePath: '/god-admin/fulfillments/api-log',
        content,
      }),
    )
  } catch (e: any) {
    console.error('[god-admin] api log error:', e)
    res.status(500).send('Error: ' + esc(e?.message ?? String(e)))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments/api-log/:id
// ---------------------------------------------------------------------------

export async function getApiLogDetail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const id = String(req.params.id ?? '')
  try {
    const row = await db
      .selectFrom('lenful_api_log')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) {
      res.status(404).send('Not found')
      return
    }

    const reqPretty = row.request_body
      ? secondPassRedact(
          typeof row.request_body === 'string'
            ? row.request_body
            : JSON.stringify(row.request_body, null, 2),
        )
      : '(empty)'
    const respPretty = row.response_body
      ? secondPassRedact(
          typeof row.response_body === 'string'
            ? row.response_body
            : JSON.stringify(row.response_body, null, 2),
        )
      : '(empty)'

    let reqFormatted = reqPretty
    try {
      reqFormatted = JSON.stringify(JSON.parse(reqPretty), null, 2)
    } catch {
      // already a string
    }
    let respFormatted = respPretty
    try {
      respFormatted = JSON.stringify(JSON.parse(respPretty), null, 2)
    } catch {
      // leave raw
    }

    const content = `
      <div style="padding:24px;max-width:1100px">
        <div style="margin-bottom:16px">
          <a href="/god-admin/fulfillments/api-log" style="color:#6366f1;text-decoration:none;font-size:13px">← Back to log</a>
        </div>

        <h1 style="margin:0 0 4px;font-size:22px;color:#fff">${statusBadge(row.status_code)} ${esc(row.method)} <span style="font-family:monospace;font-size:14px;color:#94a3b8">${esc(row.url)}</span></h1>
        <p style="margin:4px 0 20px;color:#94a3b8;font-size:12px">
          ${fmtDate(row.created_at as any)} • ${row.duration_ms ?? '-'} ms • triggered by <code>${esc(row.triggered_by || '-')}</code>
          ${row.error_msg ? ` • <span style="color:#ef4444">ERROR: ${esc(row.error_msg)}</span>` : ''}
        </p>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:14px">
            <h2 style="margin:0 0 10px;font-size:13px;color:#fff;text-transform:uppercase;letter-spacing:0.5px">Request</h2>
            <pre style="margin:0;padding:12px;background:#020617;border-radius:8px;font-size:11px;color:#cbd5e1;overflow:auto;max-height:520px;white-space:pre-wrap;word-break:break-all">${esc(reqFormatted)}</pre>
          </div>
          <div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:14px">
            <h2 style="margin:0 0 10px;font-size:13px;color:#fff;text-transform:uppercase;letter-spacing:0.5px">Response</h2>
            <pre style="margin:0;padding:12px;background:#020617;border-radius:8px;font-size:11px;color:#cbd5e1;overflow:auto;max-height:520px;white-space:pre-wrap;word-break:break-all">${esc(respFormatted)}</pre>
          </div>
        </div>
      </div>
    `

    res.send(
      godLayout({
        title: 'Lenful API Log — detail',
        userEmail: user.email,
        activePath: '/god-admin/fulfillments/api-log',
        content,
      }),
    )
  } catch (e: any) {
    console.error('[god-admin] api log detail error:', e)
    res.status(500).send('Error: ' + esc(e?.message ?? String(e)))
  }
}
