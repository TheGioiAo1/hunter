/**
 * God Admin — Lenful Wallet Snapshot (Phase F5)
 *
 *   GET  /god-admin/fulfillments/wallet                — show balance + history
 *   POST /god-admin/fulfillments/wallet/capture        — force a fresh capture now
 *   POST /god-admin/fulfillments/wallet/threshold      — update alert threshold
 *
 * This page supports ops rolodex: "is the Lenful wallet low?" Ops runs
 * Capture, sees a banner if balance < threshold, and can top up through
 * Lenful's own UI.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'
import {
  captureWalletSnapshot,
  getLatestSnapshot,
  listSnapshots,
  getThreshold,
  setThreshold,
} from '../../../../packages/core/src/modules/fulfillment/lenful/index.js'

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_lenful_wallet' })

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

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return String(iso)
  }
}

function fmtMoney(amount: string | number, currency: string): string {
  const n = typeof amount === 'number' ? amount : Number.parseFloat(amount)
  if (!Number.isFinite(n)) return String(amount)
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 2,
  })
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments/wallet
// ---------------------------------------------------------------------------

export async function getWallet(
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
    const [latest, snapshots, threshold] = await Promise.all([
      getLatestSnapshot(db),
      listSnapshots(db, 30),
      getThreshold(db),
    ])

    const latestAmount = latest ? Number.parseFloat(latest.balance) : null
    const alert =
      latestAmount !== null && threshold !== null && latestAmount < threshold

    const alertBanner = alert
      ? `<div style="padding:14px 18px;border:1px solid #ef444466;background:#ef444422;border-radius:10px;margin-bottom:16px;color:#fecaca;font-size:13px">
          ⚠ Balance ${esc(fmtMoney(latest!.balance, latest!.currency))} is below threshold ${esc(fmtMoney(threshold!, latest!.currency))}. Top up Lenful wallet ASAP.
        </div>`
      : ''

    const cardBalance = latest
      ? `
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:26px">
          <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px">Latest balance</div>
          <div style="font-size:36px;font-weight:700;color:${alert ? '#f87171' : '#10b981'};margin-top:4px">${esc(fmtMoney(latest.balance, latest.currency))}</div>
          <div style="font-size:11px;color:#64748b;margin-top:6px">captured ${esc(fmtDate(latest.captured_at))}</div>
        </div>`
      : `
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:26px;color:#64748b">
          No snapshots yet. Click <strong>Capture now</strong> to pull a fresh balance from Lenful.
        </div>`

    const historyRows = snapshots.length
      ? snapshots
          .map(
            (s) => `
        <tr style="border-bottom:1px solid #1e293b">
          <td style="padding:10px 12px;font-family:monospace;font-size:12px">${esc(fmtMoney(s.balance, s.currency))}</td>
          <td style="padding:10px 12px;font-size:11px;color:#94a3b8">${esc(fmtDate(s.captured_at))}</td>
          <td style="padding:10px 12px;font-family:monospace;font-size:10px;color:#64748b">${esc(s.id.slice(0, 8))}</td>
        </tr>`,
          )
          .join('')
      : '<tr><td colspan="3" style="padding:24px;text-align:center;color:#64748b">No history.</td></tr>'

    // Simple sparkline using recent values
    const values = snapshots
      .slice()
      .reverse()
      .map((s) => Number.parseFloat(s.balance))
      .filter((v) => Number.isFinite(v))
    let sparkSvg = ''
    if (values.length >= 2) {
      const min = Math.min(...values)
      const max = Math.max(...values)
      const w = 600
      const h = 80
      const range = max - min || 1
      const step = w / (values.length - 1)
      const points = values
        .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
        .join(' ')
      sparkSvg = `
        <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:80px;margin-top:10px">
          <polyline fill="none" stroke="#10b981" stroke-width="2" points="${points}" />
        </svg>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:#64748b;margin-top:4px">
          <span>${esc(fmtMoney(min, latest?.currency || 'USD'))}</span>
          <span>${esc(fmtMoney(max, latest?.currency || 'USD'))}</span>
        </div>`
    }

    const thresholdValue = threshold !== null ? String(threshold) : ''

    const content = `
      <div class="page-header">
        <h1>Lenful Wallet</h1>
        <p style="color:#94a3b8;font-size:13px;margin:4px 0 0">
          Track the Gbox-owned Lenful wallet balance and get alerted when it drops below a configurable threshold.
        </p>
      </div>

      ${flash ? `<div style="padding:10px 14px;background:#10b98122;color:#10b981;border-radius:8px;margin-bottom:16px;font-size:12px">${esc(flash)}</div>` : ''}
      ${err ? `<div style="padding:10px 14px;background:#ef444422;color:#ef4444;border-radius:8px;margin-bottom:16px;font-size:12px">${esc(err)}</div>` : ''}

      ${alertBanner}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px">
        ${cardBalance}

        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:20px">
          <h2 style="margin:0 0 12px;font-size:14px;color:#fff">Alert threshold</h2>
          <form method="POST" action="/god-admin/fulfillments/wallet/threshold" style="display:flex;gap:8px;align-items:center">
            ${csrfField}
            <input type="number" name="threshold" value="${esc(thresholdValue)}" step="0.01" min="0"
                   placeholder="e.g. 200"
                   style="flex:1;padding:10px 12px;background:#020617;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-family:monospace">
            <button type="submit" style="padding:10px 18px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">Save</button>
          </form>
          <div style="font-size:10px;color:#64748b;margin-top:8px">Set to 0 to disable alerts.</div>

          <form method="POST" action="/god-admin/fulfillments/wallet/capture" style="margin-top:18px">
            ${csrfField}
            <button type="submit" style="width:100%;padding:11px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">
              Capture now
            </button>
          </form>
        </div>
      </div>

      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:20px;margin-top:20px">
        <h2 style="margin:0 0 10px;font-size:14px;color:#fff">Recent history</h2>
        ${sparkSvg || '<div style="color:#64748b;font-size:12px">Not enough data for sparkline yet.</div>'}
      </div>

      <div class="card" style="padding:0;overflow:hidden;margin-top:20px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#0f172a;border-bottom:1px solid #1e293b">
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Balance</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Captured at</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Snapshot id</th>
            </tr>
          </thead>
          <tbody>${historyRows}</tbody>
        </table>
      </div>

      <div style="margin-top:24px;padding:16px;background:#0f172a;border-radius:8px;border:1px solid #1e293b;font-size:12px;color:#94a3b8;line-height:1.7">
        <strong style="color:#e2e8f0">📋 F5 notes</strong><br>
        • <em>Capture now</em> hits Lenful's wallet API via the active credential.<br>
        • Phase F5 cron can drive this automatically; wire a daily job calling <code>captureWalletSnapshot</code>.<br>
        • Alerts are surfaced here as a banner — email/slack wiring lands after the alerts module.
      </div>
    `

    res.send(
      godLayout({
        title: 'Lenful Wallet',
        userEmail: user.email,
        activePath: '/god-admin/fulfillments/wallet',
        content,
      }),
    )
  } catch (e: any) {
    console.error('[god-admin] wallet error:', e)
    res.status(500).send('Error: ' + esc(e?.message ?? String(e)))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/wallet/capture
// ---------------------------------------------------------------------------

export async function postWalletCapture(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/wallet?err=' + encodeURIComponent('CSRF expired.'))
    return
  }
  const user = req.godAdmin!.user
  try {
    const result = await captureWalletSnapshot(db, {
      triggeredBy: 'god-admin-manual',
      userId: user.id,
    })
    if (!result.ok) {
      res.redirect(
        '/god-admin/fulfillments/wallet?err=' +
          encodeURIComponent('Capture failed: ' + (result.error || 'unknown')),
      )
      return
    }
    const msg = result.snapshot
      ? `Captured ${result.snapshot.balance} ${result.snapshot.currency}${result.alert ? ' ⚠ BELOW THRESHOLD' : ''}.`
      : 'Captured.'
    res.redirect('/god-admin/fulfillments/wallet?msg=' + encodeURIComponent(msg))
  } catch (e: any) {
    res.redirect(
      '/god-admin/fulfillments/wallet?err=' + encodeURIComponent(e?.message ?? String(e)),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/wallet/threshold
// ---------------------------------------------------------------------------

export async function postWalletThreshold(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/wallet?err=' + encodeURIComponent('CSRF expired.'))
    return
  }
  const user = req.godAdmin!.user
  const raw = String((req.body as any)?.threshold ?? '0')
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || value < 0) {
    res.redirect(
      '/god-admin/fulfillments/wallet?err=' + encodeURIComponent('Threshold must be a non-negative number.'),
    )
    return
  }
  try {
    await setThreshold(db, value, user.id)
    res.redirect(
      '/god-admin/fulfillments/wallet?msg=' + encodeURIComponent(`Threshold set to ${value}.`),
    )
  } catch (e: any) {
    res.redirect(
      '/god-admin/fulfillments/wallet?err=' + encodeURIComponent(e?.message ?? String(e)),
    )
  }
}
