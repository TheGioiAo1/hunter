/**
 * Gbox Accounts — Customer Email Preference Center (Phase 14 PR1.5)
 *
 * GET  /accounts/email-preferences?token=<raw>
 *        → render every subscription row for (shop, email) that the
 *          token anchors — category toggles, frequency cap, quiet hours.
 * POST /accounts/email-preferences
 *        → apply the toggles (+ optional max_per_day / max_per_week /
 *          quiet_hours fields) back to the anchor row's preference set.
 *
 * HOW IT HITS
 * -----------
 *   Every marketing / lifecycle / reviews email footer carries BOTH
 *   links:
 *     · "Unsubscribe"          → /accounts/unsubscribe?token=<raw>
 *     · "Manage preferences"   → /accounts/email-preferences?token=<raw>
 *
 *   The two share the SAME raw unsubscribe token. A one-click unsub is
 *   the CAN-SPAM / RFC 8058 fast path; the preference center is for
 *   customers who want finer control (per-category + frequency).
 *
 * FAIL-CLOSED + LEAK-FREE (Iron rule 5)
 * -------------------------------------
 *   Same contract as /unsubscribe: any lookup miss (bad token, stale
 *   token, tampered token) returns a friendly "We couldn't find your
 *   preferences" page with no confirm/deny info. All support copy
 *   points at `contact@gbox.co` — never at a `/god-admin/*` path or
 *   anything that hints at internal tooling.
 *
 * SECURITY
 * --------
 *   No login — the token IS the auth (Amazon / Shopify / Klaviyo
 *   convention). The token has 32 bytes of crypto.randomBytes entropy,
 *   so brute-force is infeasible; stored only as SHA-256 hash.
 *   `pageLimiter` at router level caps hostile probing.
 */

import type { Request, Response } from 'express'
import {
  getPreferenceCenterView,
  bulkUpdateSubscriptionsByToken,
  updateFrequencyCap,
  type PreferenceCenterView,
  type PreferenceCenterPrefRow,
  type EmailPreferenceCategory,
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

function categoryLabel(cat: EmailPreferenceCategory): string {
  switch (cat) {
    case 'marketing': return 'Marketing emails'
    case 'lifecycle': return 'Lifecycle emails'
    case 'reviews': return 'Review requests'
    case 'newsletter': return 'Newsletter'
    case 'abandoned_cart': return 'Abandoned-cart reminders'
    case 'back_in_stock': return 'Back-in-stock alerts'
    case 'price_drop': return 'Price-drop alerts'
    default: return String(cat)
  }
}

function categoryHint(cat: EmailPreferenceCategory): string {
  switch (cat) {
    case 'marketing':
      return 'Promotions, flash sales, new collections.'
    case 'lifecycle':
      return 'Win-back and post-purchase emails.'
    case 'reviews':
      return 'Invitations to review products you bought.'
    case 'newsletter':
      return 'Periodic brand broadcasts.'
    case 'abandoned_cart':
      return 'Reminders when you leave items in your cart.'
    case 'back_in_stock':
      return 'Alerts when items you watched are restocked.'
    case 'price_drop':
      return 'Alerts when items you watched get cheaper.'
    default: return ''
  }
}

function isValidToken(raw: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(raw)
}

function renderNotFound(title: string, heading: string, subtitle: string): string {
  return authLayout({
    title,
    content: `
      <style>
        .pref-center { text-align: center; }
        .icon-wrap {
          display:flex;align-items:center;justify-content:center;
          width:64px;height:64px;border-radius:50%;
          background:#fee2e2;color:#dc2626;margin:0 auto 16px;
        }
        .support-link { color:#3b82f6;text-decoration:none; }
        .support-link:hover { text-decoration:underline; }
      </style>
      <div class="pref-center">
        <div class="icon-wrap">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
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

function renderCenter(
  view: PreferenceCenterView,
  rawToken: string,
  flash: string,
): string {
  // Focused row — the one the unsubscribe token anchors. Show its
  // frequency-cap + quiet-hours controls. Other rows get a simple
  // subscribe toggle only (keeps the page short + scannable).
  const focused = view.preferences.find((p) => p.category === view.focusedCategory) ?? null

  let categoriesHtml = ''
  for (const row of view.preferences) {
    const isFocused = row.category === view.focusedCategory
    categoriesHtml += `
      <label class="pref-row" ${isFocused ? 'data-focused="1"' : ''}>
        <input type="checkbox"
               name="subscribe_${esc(row.category)}"
               value="1"
               ${row.subscribed ? 'checked' : ''}>
        <div style="flex:1">
          <div class="pref-row-title">${esc(categoryLabel(row.category))}${isFocused ? ' <span class="focus-tag">Selected</span>' : ''}</div>
          <div class="pref-row-hint">${esc(categoryHint(row.category))}</div>
        </div>
      </label>`
  }

  const freqHtml = focused ? renderFrequencyPanel(focused) : ''

  return authLayout({
    title: 'Email preferences',
    content: `
      <style>
        .pref-center { max-width: 520px; margin: 0 auto; }
        .pref-header { text-align: center; margin-bottom: 20px; }
        .pref-row {
          display:flex;align-items:flex-start;gap:12px;
          padding:12px 14px;border:1px solid #e5e7eb;border-radius:10px;
          margin-bottom:10px;cursor:pointer;background:#fff;
        }
        .pref-row[data-focused="1"] { border-color:#93c5fd;background:#eff6ff; }
        .pref-row input[type="checkbox"] {
          width:18px;height:18px;margin-top:2px;accent-color:#3b82f6;cursor:pointer;
        }
        .pref-row-title { font-weight:600;font-size:14px;color:#111827; }
        .pref-row-hint { font-size:12px;color:#6b7280;margin-top:2px; }
        .focus-tag {
          display:inline-block;background:#3b82f6;color:#fff;
          font-size:10px;padding:1px 6px;border-radius:9999px;margin-left:6px;vertical-align:1px;
        }
        .freq-panel {
          margin-top:20px;padding:16px;background:#f9fafb;
          border:1px solid #e5e7eb;border-radius:12px;
        }
        .freq-panel h2 { font-size:14px;color:#111827;margin-bottom:4px; }
        .freq-panel p.panel-hint { font-size:12px;color:#6b7280;margin-bottom:12px; }
        .freq-grid { display:grid;grid-template-columns:1fr 1fr;gap:10px; }
        .freq-field { display:flex;flex-direction:column;gap:4px; }
        .freq-field label { font-size:12px;color:#374151;font-weight:500; }
        .freq-field input, .freq-field select {
          padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;
          font-size:13px;background:#fff;color:#111827;
        }
        .btn-row {
          display:flex;gap:8px;justify-content:space-between;margin-top:20px;
        }
        .btn-primary-full {
          flex:1;background:#111827;color:#fff;border:none;
          padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;
        }
        .btn-primary-full:hover { background:#1f2937; }
        .btn-secondary {
          padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;
          background:#fff;color:#374151;font-size:14px;cursor:pointer;text-decoration:none;
        }
        .btn-secondary:hover { background:#f9fafb; }
        .contact-line { text-align:center;font-size:12px;color:#6b7280;margin-top:20px; }
        .contact-line a { color:#3b82f6;text-decoration:none; }
      </style>

      <div class="pref-center">
        <div class="pref-header">
          <h1>Email preferences</h1>
          <p class="subtitle">Manage what you get from <strong>${esc(view.email ?? '')}</strong></p>
        </div>

        ${flash}

        <form method="POST" action="/accounts/email-preferences">
          <input type="hidden" name="token" value="${esc(rawToken)}">

          <div>
            ${categoriesHtml || '<p class="subtitle">No subscriptions on record.</p>'}
          </div>

          ${freqHtml}

          <div class="btn-row">
            <button type="submit" name="action" value="save" class="btn-primary-full">Save preferences</button>
            <button type="submit" name="action" value="unsubscribe_all" class="btn-secondary"
                    formnovalidate
                    onclick="return confirm('Unsubscribe from every email from this store?')">
              Unsubscribe from all
            </button>
          </div>
        </form>

        <p class="contact-line">
          Essential account emails (order confirmations, receipts, security alerts) are always sent.
          <br/>
          Need help? <a href="mailto:contact@gbox.co">contact@gbox.co</a>
        </p>
      </div>
    `,
  })
}

function renderFrequencyPanel(row: PreferenceCenterPrefRow): string {
  // Common IANA zones — cheap dropdown instead of a full 400-zone list.
  // The backend accepts any valid IANA zone; anything NOT in this list
  // silently falls back to the row's current value on save.
  const zones = [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Asia/Bangkok',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Australia/Sydney',
  ]
  const selectedZone = row.quiet_hours_timezone ?? 'UTC'
  const zonesHtml = zones
    .map((z) => `<option value="${esc(z)}"${z === selectedZone ? ' selected' : ''}>${esc(z)}</option>`)
    .join('')

  return `
    <div class="freq-panel">
      <h2>Frequency + quiet hours</h2>
      <p class="panel-hint">Applies to the category above. Leave blank for no limit.</p>
      <div class="freq-grid">
        <div class="freq-field">
          <label for="max_per_day">Max per day</label>
          <input type="number" id="max_per_day" name="max_per_day" min="0" max="255"
                 value="${row.max_per_day == null ? '' : String(row.max_per_day)}"
                 placeholder="e.g. 1">
        </div>
        <div class="freq-field">
          <label for="max_per_week">Max per week</label>
          <input type="number" id="max_per_week" name="max_per_week" min="0" max="999"
                 value="${row.max_per_week == null ? '' : String(row.max_per_week)}"
                 placeholder="e.g. 3">
        </div>
        <div class="freq-field">
          <label for="quiet_hours_start">Quiet hours start</label>
          <input type="time" id="quiet_hours_start" name="quiet_hours_start"
                 value="${esc(trimSecs(row.quiet_hours_start))}">
        </div>
        <div class="freq-field">
          <label for="quiet_hours_end">Quiet hours end</label>
          <input type="time" id="quiet_hours_end" name="quiet_hours_end"
                 value="${esc(trimSecs(row.quiet_hours_end))}">
        </div>
        <div class="freq-field" style="grid-column:1 / -1">
          <label for="quiet_hours_timezone">Timezone</label>
          <select id="quiet_hours_timezone" name="quiet_hours_timezone">${zonesHtml}</select>
        </div>
      </div>
    </div>
  `
}

/** 'HH:MM:SS' → 'HH:MM' for <input type="time">. Pass-through for other shapes. */
function trimSecs(s: string | null): string {
  if (!s) return ''
  const m = /^(\d{1,2}:\d{2})(?::\d{2}.*)?$/.exec(s)
  return m ? m[1] : s
}

// ---------------------------------------------------------------------------
// GET /accounts/email-preferences?token=<raw>
// ---------------------------------------------------------------------------

export async function getEmailPreferences(
  req: Request,
  res: Response,
): Promise<void> {
  const rawToken = typeof req.query.token === 'string' ? req.query.token.trim() : ''
  if (!isValidToken(rawToken)) {
    res.status(400).send(
      renderNotFound(
        'Email preferences',
        "We couldn't find your preferences",
        'The link may be incomplete or outdated.',
      ),
    )
    return
  }

  try {
    const view = await getPreferenceCenterView(db, rawToken)
    if (!view.found) {
      res.status(404).send(
        renderNotFound(
          'Email preferences',
          "We couldn't find your preferences",
          'The link may have expired. No changes were made.',
        ),
      )
      return
    }

    const saved = typeof req.query.saved === 'string' ? req.query.saved : null
    const flash = saved === 'prefs'
      ? renderFlash('ok', 'Preferences saved.')
      : saved === 'all-unsub'
        ? renderFlash('ok', 'You have been unsubscribed from all emails.')
        : ''

    res.send(renderCenter(view, rawToken, flash))
  } catch (err) {
    console.error('[accounts/email-preferences GET] error:', err)
    res.status(500).send(
      renderNotFound(
        'Email preferences',
        'Something went wrong',
        "We couldn't load your preferences just now. Please try again in a minute.",
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /accounts/email-preferences
// ---------------------------------------------------------------------------
//
// Form fields:
//   token                 — raw unsub token (required)
//   action                — 'save' | 'unsubscribe_all'
//   subscribe_<category>  — checkbox per category. Present=subscribed,
//                           absent=unsubscribed.
//   max_per_day, max_per_week, quiet_hours_start,
//   quiet_hours_end, quiet_hours_timezone
//                         — frequency-cap fields for the focused category
//                           (the one the token anchors to).

export async function postEmailPreferences(
  req: Request,
  res: Response,
): Promise<void> {
  const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  const action = typeof req.body?.action === 'string' ? req.body.action : 'save'

  if (!isValidToken(rawToken)) {
    res.status(400).send(
      renderNotFound(
        'Email preferences',
        "We couldn't find your preferences",
        'The link may be incomplete or outdated.',
      ),
    )
    return
  }

  try {
    const view = await getPreferenceCenterView(db, rawToken)
    if (!view.found) {
      res.status(404).send(
        renderNotFound(
          'Email preferences',
          "We couldn't find your preferences",
          'The link may have expired. No changes were made.',
        ),
      )
      return
    }

    if (action === 'unsubscribe_all') {
      // Turn every subscribed category off.
      await bulkUpdateSubscriptionsByToken(
        db,
        rawToken,
        view.preferences
          .filter((p) => p.subscribed)
          .map((p) => ({ category: p.category, subscribed: false })),
      )
      res.redirect(`/accounts/email-preferences?token=${encodeURIComponent(rawToken)}&saved=all-unsub`)
      return
    }

    // action === 'save' (default)
    // Build updates: for every category in the view, checkbox present =
    // subscribed=true, absent = subscribed=false.
    const body = (req.body ?? {}) as Record<string, unknown>
    const updates: Array<{ category: EmailPreferenceCategory; subscribed: boolean }> = []
    for (const row of view.preferences) {
      const key = `subscribe_${row.category}`
      const raw = body[key]
      const on = raw === '1' || raw === 'on' || raw === 'true'
      if (on !== row.subscribed) {
        updates.push({ category: row.category, subscribed: on })
      }
    }
    if (updates.length > 0) {
      await bulkUpdateSubscriptionsByToken(db, updates)
    }

    // Frequency cap / quiet hours — applied to the focused row only
    // (the one the token anchors to). UI only surfaces those controls
    // there, so keep the write scope matching.
    const focused = view.preferences.find((p) => p.category === view.focusedCategory)
    if (focused) {
      await updateFrequencyCap(db, {
        preferenceId: focused.id,
        maxPerDay: parseNullableInt(body.max_per_day, 0, 255),
        maxPerWeek: parseNullableInt(body.max_per_week, 0, 999),
        quietHoursStart: parseNullableTime(body.quiet_hours_start),
        quietHoursEnd: parseNullableTime(body.quiet_hours_end),
        quietHoursTimezone: parseNullableTz(body.quiet_hours_timezone),
      })
    }

    res.redirect(`/accounts/email-preferences?token=${encodeURIComponent(rawToken)}&saved=prefs`)
  } catch (err) {
    console.error('[accounts/email-preferences POST] error:', err)
    res.status(500).send(
      renderNotFound(
        'Email preferences',
        'Something went wrong',
        "We couldn't save your preferences just now. Please try again.",
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseNullableInt(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  if (n < min || n > max) return null
  return n
}

function parseNullableTime(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null
  // HTML <input type="time"> gives us 'HH:MM' or 'HH:MM:SS'.
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1]), mm = Number(m[2]), ss = m[3] ? Number(m[3]) : 0
  if (h < 0 || h > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(mm)}:${pad(ss)}`
}

function parseNullableTz(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null
  const s = v.trim()
  // Cheap validation — reject anything that isn't an IANA-looking name.
  // `Intl.DateTimeFormat` in `isInsideQuietHours` falls back to UTC if
  // the zone is still bad, so this is a defensive first pass.
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(s) && s !== 'UTC') return null
  return s
}
