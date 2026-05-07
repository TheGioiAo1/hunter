/**
 * God Admin — AI Support Settings (Phase 12.5 PR4)
 *
 * Single surface where THAI configures the Anthropic integration
 * powering the Support AI layer (suggest_reply / summarize_thread /
 * auto_categorize / sentiment_flag). Lives under /god-admin/settings/ai
 * so it slots into the existing "Settings" nav grouping.
 *
 * GET  /god-admin/settings/ai  — renders the 3-field form + a live
 *                                spend card (current-month cents by
 *                                surface + aggregate) + status chip
 *                                (ok / warn / exceeded / missing-key).
 *
 * POST /god-admin/settings/ai  — writes to `platform_settings` (3
 *                                keys: ai_support_anthropic_api_key,
 *                                ai_support_enabled,
 *                                ai_support_monthly_budget_cents).
 *                                The API key is AES-256-GCM encrypted
 *                                before write via encryptAnthropicKey.
 *
 * Why a dedicated page instead of reusing /god-admin/config?
 *   The platform-config registry is for 11 typed settings with a
 *   single kind-based renderer. AI support needs:
 *     1. A masked secret field with a "Clear" action (not just show/hide).
 *     2. A live spend widget backed by support_ai_usage aggregations.
 *     3. A separate explanatory block about the Hybrid Sonnet+Opus
 *        decision tree + the $200 cap semantics.
 *   Folding all that into platform-config would bloat the registry
 *   and mix read-only data (spend) into a write form. Dedicated page
 *   keeps each surface cohesive.
 *
 * Iron Rule 5 compliance:
 *   This page is god-admin-only and NEVER leaks to sellers. The
 *   `missingReason()` helper returns seller-friendly strings for the
 *   /seller widget, but those are displayed only when a SELLER hits
 *   a disabled AI surface — this page can use internal terms freely.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'
import { buildFlashCookie } from '../../../../packages/core/src/modules/ui/toast.js'
import { KyselyPlatformSettingsStore } from '../lib/platform-config-store.js'
import {
  AI_BUDGET_SETTING,
  AI_ENABLED_SETTING,
  AI_KEY_SETTING,
  encryptAnthropicKey,
  readAISupportConfig,
} from '../../../../packages/core/src/modules/support-ai/config-store.js'
import {
  evaluateBudget,
  monthKey,
} from '../../../../packages/core/src/modules/support-ai/budget.js'
import {
  getMonthlySpendCents,
  getMonthlySurfaceBreakdown,
} from '../../../../packages/core/src/modules/support-ai/usage-tracker.js'

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_ai_settings' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatCents(cents: number): string {
  const dollars = cents / 100
  return `$${dollars.toFixed(2)}`
}

function maskKey(plaintext: string): string {
  if (!plaintext) return ''
  if (plaintext.length <= 12) return '•'.repeat(plaintext.length)
  return `${plaintext.slice(0, 8)}…${plaintext.slice(-4)}`
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

function aiSettingsCss(): string {
  return `
    .ai-wrap { max-width: 920px; }
    .ai-card {
      background: var(--god-surface);
      border: 1px solid var(--god-border);
      border-radius: 10px;
      padding: 20px 24px;
      margin-bottom: 16px;
    }
    .ai-card-title {
      margin: 0 0 16px;
      font-size: 15px;
      font-weight: 700;
      color: var(--god-text);
      border-bottom: 1px solid var(--god-border);
      padding-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .ai-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .ai-chip-ok       { background: rgba(34,197,94,0.15);  color: #22c55e; }
    .ai-chip-warn     { background: rgba(234,179,8,0.15);  color: #eab308; }
    .ai-chip-exceeded { background: rgba(239,68,68,0.15);  color: #ef4444; }
    .ai-chip-off      { background: rgba(148,163,184,0.15); color: #94a3b8; }

    .ai-fields { display: flex; flex-direction: column; gap: 20px; }
    .ai-field  { display: flex; flex-direction: column; gap: 6px; }
    .ai-label  {
      font-size: 13px;
      font-weight: 600;
      color: var(--god-text);
    }
    .ai-help {
      font-size: 12px;
      color: var(--god-text-secondary, #9ca3af);
      margin: 0;
    }
    .ai-input {
      width: 100%;
      padding: 9px 12px;
      border-radius: 6px;
      border: 1px solid var(--god-border);
      background: var(--god-bg);
      color: var(--god-text);
      font-size: 13px;
      font-family: inherit;
    }
    .ai-input:focus {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 0;
      border-color: var(--god-accent, #3b82f6);
    }
    .ai-secret {
      position: relative;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .ai-secret input {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      padding-right: 76px;
    }
    .ai-secret-toggle {
      position: absolute;
      right: 8px;
      padding: 4px 10px;
      font-size: 11px;
      border-radius: 4px;
      border: 1px solid var(--god-border);
      background: var(--god-bg);
      color: var(--god-text-secondary, #9ca3af);
      cursor: pointer;
      font-weight: 500;
    }
    .ai-mask {
      font-size: 11px;
      color: var(--god-text-secondary, #9ca3af);
      margin-top: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .ai-toggle { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; }
    .ai-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
    .ai-toggle-track {
      width: 36px;
      height: 20px;
      border-radius: 999px;
      background: var(--god-border, rgba(255,255,255,0.15));
      position: relative;
      transition: background 0.15s;
    }
    .ai-toggle-dot {
      position: absolute;
      top: 2px; left: 2px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: var(--god-text, #f3f4f6);
      transition: transform 0.15s;
    }
    .ai-toggle input:checked + .ai-toggle-track {
      background: var(--god-accent, #3b82f6);
    }
    .ai-toggle input:checked + .ai-toggle-track .ai-toggle-dot {
      transform: translateX(16px);
    }
    .ai-toggle-label {
      font-size: 13px;
      color: var(--god-text-secondary, #9ca3af);
    }

    .ai-spend-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-top: 8px;
    }
    .ai-spend-cell {
      background: var(--god-bg, rgba(0,0,0,0.2));
      border: 1px solid var(--god-border);
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ai-spend-cell-label {
      font-size: 11px;
      color: var(--god-text-secondary, #9ca3af);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .ai-spend-cell-value {
      font-size: 20px;
      font-weight: 700;
      color: var(--god-text);
      font-variant-numeric: tabular-nums;
    }

    .ai-progress {
      height: 10px;
      border-radius: 999px;
      background: var(--god-border, rgba(255,255,255,0.1));
      overflow: hidden;
      margin: 12px 0 6px;
    }
    .ai-progress-bar {
      height: 100%;
      transition: width 0.2s ease-out;
    }
    .ai-progress-bar-ok       { background: #22c55e; }
    .ai-progress-bar-warn     { background: #eab308; }
    .ai-progress-bar-exceeded { background: #ef4444; }
    .ai-progress-meta {
      font-size: 12px;
      color: var(--god-text-secondary, #9ca3af);
      display: flex;
      justify-content: space-between;
    }

    .ai-notice {
      font-size: 12px;
      padding: 10px 14px;
      border-radius: 6px;
      border: 1px solid var(--god-border);
      background: rgba(234,179,8,0.08);
      color: var(--god-text-secondary, #9ca3af);
      margin-bottom: 12px;
      line-height: 1.5;
    }
    .ai-notice-danger {
      background: rgba(239,68,68,0.08);
      border-color: rgba(239,68,68,0.3);
      color: #fca5a5;
    }

    .ai-save-bar {
      position: sticky;
      bottom: 0;
      background: var(--god-surface);
      border-top: 1px solid var(--god-border);
      padding: 14px 24px;
      margin: 16px -24px -24px;
      display: flex;
      justify-content: flex-end;
      gap: 12px;
    }
    .ai-save-btn {
      padding: 9px 18px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      background: var(--god-accent, #3b82f6);
      color: #fff;
      border: none;
      cursor: pointer;
    }
    .ai-save-btn:hover { filter: brightness(1.1); }
    .ai-clear-btn {
      padding: 9px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      background: transparent;
      color: var(--god-danger, #ef4444);
      border: 1px solid var(--god-danger, #ef4444);
      cursor: pointer;
    }

    .ai-decision-tree {
      font-size: 12px;
      color: var(--god-text-secondary, #9ca3af);
      line-height: 1.6;
      padding-left: 18px;
    }
    .ai-decision-tree li { margin-bottom: 2px; }
  `
}

// ---------------------------------------------------------------------------
// GET /god-admin/settings/ai
// ---------------------------------------------------------------------------

export async function getAiSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user

  try {
    const cfg = await readAISupportConfig(db)
    const currentMonth = monthKey()
    const spent = await getMonthlySpendCents(db, currentMonth)
    const breakdown = await getMonthlySurfaceBreakdown(db, currentMonth)
    const status = evaluateBudget(spent, cfg.capCents)

    const hasKey = cfg.anthropicApiKey.length > 0
    const maskedKey = maskKey(cfg.anthropicApiKey)

    // Status chip
    let chipClass = 'ai-chip-off'
    let chipLabel = 'No key'
    if (hasKey && cfg.enabled) {
      if (status.state === 'ok') {
        chipClass = 'ai-chip-ok'
        chipLabel = 'Live'
      } else if (status.state === 'warn') {
        chipClass = 'ai-chip-warn'
        chipLabel = `${Math.floor(status.percentUsed * 100)}% used`
      } else {
        chipClass = 'ai-chip-exceeded'
        chipLabel = 'Over budget'
      }
    } else if (hasKey && !cfg.enabled) {
      chipLabel = 'Disabled'
    }

    // Progress bar
    let barClass = 'ai-progress-bar-ok'
    if (status.state === 'warn') barClass = 'ai-progress-bar-warn'
    if (status.state === 'exceeded') barClass = 'ai-progress-bar-exceeded'
    const barPercent = Math.min(100, Math.floor(status.percentUsed * 100))

    // CSRF
    const csrfToken = await csrfStore.issue(res, isProduction())
    const csrfField = csrfStore.hiddenField(csrfToken)

    // Spend grid
    const spendCells = [
      { label: 'Total this month', value: formatCents(spent) },
      { label: 'Suggest reply', value: formatCents(breakdown.suggest_reply) },
      { label: 'Summarize thread', value: formatCents(breakdown.summarize_thread) },
      { label: 'Auto-categorize', value: formatCents(breakdown.auto_categorize) },
      { label: 'Sentiment flag', value: formatCents(breakdown.sentiment_flag) },
    ]
    const spendGridHtml = spendCells
      .map(
        (c) =>
          `<div class="ai-spend-cell">` +
          `<div class="ai-spend-cell-label">${esc(c.label)}</div>` +
          `<div class="ai-spend-cell-value">${esc(c.value)}</div>` +
          `</div>`,
      )
      .join('')

    // Flash banner from query string (set by POST redirects for errors)
    let errorBanner = ''
    if (typeof req.query.error === 'string' && req.query.error) {
      errorBanner = `<div class="ai-notice ai-notice-danger">${esc(req.query.error)}</div>`
    }

    const content =
      `<style>${aiSettingsCss()}</style>` +
      `<div class="page-header"><h1>Support AI Configuration</h1></div>` +
      `<div class="ai-wrap">` +
      errorBanner +
      // ── Spend card ──
      `<section class="ai-card">` +
      `<h2 class="ai-card-title">Budget & spend (${esc(currentMonth)}) <span class="ai-chip ${chipClass}">${esc(chipLabel)}</span></h2>` +
      `<div class="ai-progress"><div class="ai-progress-bar ${barClass}" style="width:${barPercent}%"></div></div>` +
      `<div class="ai-progress-meta">` +
      `<span>${esc(formatCents(spent))} of ${esc(formatCents(cfg.capCents))} used</span>` +
      `<span>${esc(formatCents(status.remainingCents))} remaining</span>` +
      `</div>` +
      `<div class="ai-spend-grid">${spendGridHtml}</div>` +
      `</section>` +
      // ── Configuration form ──
      `<form method="post" action="/god-admin/settings/ai">` +
      csrfField +
      `<section class="ai-card">` +
      `<h2 class="ai-card-title">Anthropic integration</h2>` +
      `<div class="ai-fields">` +
      // Key
      `<div class="ai-field">` +
      `<label for="f-key" class="ai-label">API key</label>` +
      `<div class="ai-secret">` +
      `<input type="password" id="f-key" name="anthropic_api_key" value="" class="ai-input" placeholder="${hasKey ? 'Leave blank to keep existing key' : 'sk-ant-…'}" autocomplete="off">` +
      `<button type="button" class="ai-secret-toggle" onclick="(function(btn){var inp=document.getElementById('f-key');if(inp.type==='password'){inp.type='text';btn.textContent='Hide'}else{inp.type='password';btn.textContent='Show'}})(this)">Show</button>` +
      `</div>` +
      (hasKey
        ? `<div class="ai-mask">Stored: ${esc(maskedKey)} (encrypted at rest)</div>`
        : `<div class="ai-mask">No key stored. AI surfaces will return graceful "not configured" responses.</div>`) +
      `<p class="ai-help">Anthropic API key. Stored AES-256-GCM encrypted in <code>platform_settings</code>. Paste a new key to rotate; leave blank to keep the current one.</p>` +
      `</div>` +
      // Enabled toggle
      `<div class="ai-field">` +
      `<label class="ai-label">Master switch</label>` +
      `<input type="hidden" name="enabled" value="">` +
      `<label class="ai-toggle">` +
      `<input type="checkbox" name="enabled"${cfg.enabled ? ' checked' : ''}>` +
      `<span class="ai-toggle-track"><span class="ai-toggle-dot"></span></span>` +
      `<span class="ai-toggle-label">${cfg.enabled ? 'Enabled — AI surfaces respond live' : 'Disabled — all surfaces return "not configured"'}</span>` +
      `</label>` +
      `<p class="ai-help">Global kill-switch. When off, every surface throws AINotConfiguredError and the seller widget shows the Vietnamese fallback copy.</p>` +
      `</div>` +
      // Budget
      `<div class="ai-field">` +
      `<label for="f-budget" class="ai-label">Monthly budget (USD cents)</label>` +
      `<input type="number" id="f-budget" name="budget_cents" value="${esc(String(cfg.capCents))}" min="0" step="100" class="ai-input">` +
      `<p class="ai-help">Hard cap on Anthropic spend per calendar month (UTC). When reached, AI surfaces auto-disable until the next month rolls over. Current default: 20000 = $200.00.</p>` +
      `</div>` +
      `</div>` +
      `</section>` +
      // ── Decision tree help ──
      `<section class="ai-card">` +
      `<h2 class="ai-card-title">Hybrid Sonnet+Opus decision tree</h2>` +
      `<ul class="ai-decision-tree">` +
      `<li>Category = <code>payment</code> AND confidence < 0.85 → <strong>Opus 4</strong> ($15/$75 per 1M tokens)</li>` +
      `<li>Subject contains dispute / chargeback / legal / lawyer / fraud → <strong>Opus 4</strong></li>` +
      `<li>Confidence ≥ 0.85 → <strong>Opus 4</strong> (only highest-stakes tickets)</li>` +
      `<li>Everything else → <strong>Sonnet 4.5</strong> ($3/$15 per 1M tokens)</li>` +
      `<li>Summarize / Categorize / Sentiment surfaces → <strong>always Sonnet 4.5</strong></li>` +
      `</ul>` +
      `<p class="ai-help" style="margin-top:10px">Every call logs a <code>support_ai_usage</code> row with surface, model, tokens, cost, ticket, and actor. Accuracy audit: compare Opus-tagged rows vs actual ticket outcomes monthly.</p>` +
      `</section>` +
      // ── Save bar ──
      `<div class="ai-save-bar">` +
      (hasKey
        ? `<button type="submit" name="action" value="clear_key" class="ai-clear-btn" onclick="return confirm('Clear the stored Anthropic key? AI surfaces will disable until a new key is saved.')">Clear stored key</button>`
        : '') +
      `<button type="submit" name="action" value="save" class="ai-save-btn">Save</button>` +
      `</div>` +
      `</form>` +
      `</div>`

    res.send(
      godLayout({
        title: 'Support AI',
        userEmail: user.email,
        activePath: '/god-admin/settings/ai',
        content,
      }),
    )
  } catch (err) {
    console.error('[God Admin] AI settings render error:', err)
    res.status(500).send(
      godLayout({
        title: 'Support AI',
        userEmail: user.email,
        activePath: '/god-admin/settings/ai',
        content: `<div class="card"><p style="color:var(--god-danger,#ef4444)">Error loading AI settings: ${esc(String(err))}</p></div>`,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/settings/ai
// ---------------------------------------------------------------------------

export async function postAiSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/settings/ai')
    return
  }

  const user = req.godAdmin!.user
  const action = String(req.body.action ?? 'save')

  try {
    const store = new KyselyPlatformSettingsStore(db, user.id)

    if (action === 'clear_key') {
      await store.write(AI_KEY_SETTING, null)
      res.setHeader(
        'Set-Cookie',
        buildFlashCookie({
          kind: 'success',
          message: 'Anthropic key cleared. AI surfaces are now disabled.',
        }),
      )
      res.redirect('/god-admin/settings/ai')
      return
    }

    // action === 'save'
    const rawKey = String(req.body.anthropic_api_key ?? '').trim()
    const rawEnabled = req.body.enabled
    // hidden '' + checked 'on' → Express parses array; we want the last (=truthy).
    const enabledStr = Array.isArray(rawEnabled)
      ? String(rawEnabled[rawEnabled.length - 1])
      : String(rawEnabled ?? '')
    const enabled = enabledStr === 'on' || enabledStr === 'true' || enabledStr === '1'

    const rawBudget = String(req.body.budget_cents ?? '20000').trim()
    const budgetNum = Number.parseInt(rawBudget, 10)
    if (!Number.isFinite(budgetNum) || budgetNum < 0) {
      const q = encodeURIComponent('Budget must be a non-negative integer (cents).')
      res.redirect(`/god-admin/settings/ai?error=${q}`)
      return
    }

    // Validate key shape if supplied (very loose — Anthropic has changed prefixes)
    if (rawKey && rawKey.length < 20) {
      const q = encodeURIComponent('Anthropic key looks too short. Check you pasted the full sk-ant-… value.')
      res.redirect(`/god-admin/settings/ai?error=${q}`)
      return
    }

    // Write the 3 settings. Key only written if a new one was supplied —
    // leaving the field blank preserves the existing encrypted blob.
    if (rawKey) {
      const blob = encryptAnthropicKey(rawKey)
      await store.write(AI_KEY_SETTING, blob)
    }
    await store.write(AI_ENABLED_SETTING, enabled)
    await store.write(AI_BUDGET_SETTING, budgetNum)

    const msg = rawKey
      ? 'Support AI settings saved + Anthropic key rotated.'
      : 'Support AI settings saved.'
    res.setHeader(
      'Set-Cookie',
      buildFlashCookie({ kind: 'success', message: msg }),
    )
    res.redirect('/god-admin/settings/ai')
  } catch (err) {
    console.error('[God Admin] AI settings save error:', err)
    const q = encodeURIComponent(`Save failed: ${(err as Error).message}`)
    res.redirect(`/god-admin/settings/ai?error=${q}`)
  }
}
