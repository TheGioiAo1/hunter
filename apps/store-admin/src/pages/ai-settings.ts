/**
 * Store Admin — AI Settings Page
 *
 * Endpoints:
 *   GET  /admin/store/:slug/settings/ai
 *        → Form to configure AI providers (OpenAI, Anthropic, Google)
 *
 *   POST /admin/store/:slug/settings/ai
 *        → Upserts AI config (encrypts API keys server-side)
 *
 * Key security:
 *   - API keys are encrypted with AES-256-GCM before hitting the DB
 *   - Admin UI never displays decrypted keys — only shows "Configured" badge
 *   - To change a key, the merchant must re-enter the full value
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  getAIConfig,
  upsertAIConfig,
  clearAIKey,
} from '@gbox/core/modules/ai/config-service.js'
import type { AIProvider } from '@gbox/core/modules/ai/config-service.js'
import { notify, byActor } from '../lib/notify.js'
import { pingProvider } from '@gbox/core/modules/clone-pro/v6/preflight/ping-provider.js'

// ─── Helpers ────────────────────────────────────────────────────

function escAttr(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function badge(configured: boolean): string {
  return configured
    ? '<span style="display:inline-block;padding:2px 10px;border-radius:4px;font-size:11px;font-weight:600;background:#065f46;color:#6ee7b7">Configured</span>'
    : '<span style="display:inline-block;padding:2px 10px;border-radius:4px;font-size:11px;font-weight:600;background:#1e293b;color:#64748b">Not set</span>'
}

function providerOption(value: string, label: string, current: string): string {
  return `<option value="${escAttr(value)}"${current === value ? ' selected' : ''}>${escAttr(label)}</option>`
}

// ─── Pure renderer (testable without DB or HTTP) ────────────────

export interface AiSettingsCurrentConfig {
  provider: 'anthropic' | 'openai' | 'google' | 'none'
  anthropic_model?: string
  openai_model?: string
  google_model?: string
  verified_at: string | null
  last_error: string | null
  monthly_cost_usd_cents: number
}

export interface AiSettingsViewModel {
  slug: string
  currentConfig: AiSettingsCurrentConfig | null
  csrfToken: string
  /** Optional flash messages pre-resolved by the request handler */
  flash?: { saved?: boolean; cleared?: boolean; error?: string }
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function renderVerificationStatus(config: AiSettingsCurrentConfig | null): string {
  if (!config) return ''
  if (config.verified_at) {
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(6,95,70,.15);border:1px solid rgba(16,185,129,.25);border-radius:8px;font-size:13px;margin-bottom:16px">
        <span style="color:#6ee7b7;font-weight:700">&#10003; Verified</span>
        <span style="color:var(--s-text-muted)">Last checked: ${escAttr(config.verified_at)}</span>
        <span style="margin-left:auto;color:var(--s-text-muted)">Monthly cost: ${escAttr(formatCents(config.monthly_cost_usd_cents))}</span>
      </div>`
  }
  if (config.last_error) {
    // Iron Rule 5: last_error is already sanitized (status code only) by pingProvider.
    // We add a generic "please re-check" phrase so sellers know what to do.
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(127,29,29,.2);border:1px solid rgba(239,68,68,.25);border-radius:8px;font-size:13px;margin-bottom:16px">
        <span style="color:#fca5a5;font-weight:700">&#10007; Verification failed</span>
        <span style="color:var(--s-text-muted)">Last error: ${escAttr(config.last_error)} — please re-check your API key</span>
        <span style="margin-left:auto;color:var(--s-text-muted)">Monthly cost: ${escAttr(formatCents(config.monthly_cost_usd_cents))}</span>
      </div>`
  }
  return `
    <div style="padding:10px 14px;background:rgba(30,41,59,.5);border:1px solid var(--s-input-border);border-radius:8px;font-size:13px;color:var(--s-text-muted);margin-bottom:16px">
      Not yet verified — save a valid API key to verify the connection.
    </div>`
}

/**
 * Pure HTML renderer for the AI settings page.
 * Exported for unit tests; no DB or HTTP dependencies.
 */
export function renderAiSettingsPage(vm: AiSettingsViewModel): string {
  const { slug, currentConfig, csrfToken, flash } = vm
  const base = `/admin/store/${escAttr(slug)}`

  const provider = currentConfig?.provider || 'none'
  const openaiModel = currentConfig?.openai_model || 'gpt-4o-mini'
  const anthropicModel = currentConfig?.anthropic_model || 'claude-sonnet-4-20250514'
  const googleModel = currentConfig?.google_model || 'gemini-2.0-flash'

  const savedBanner = flash?.saved
    ? '<div style="padding:10px 16px;background:#065f46;color:#6ee7b7;border-radius:8px;margin-bottom:16px;font-size:13px">AI configuration saved and verified successfully.</div>'
    : ''
  const clearedBanner = flash?.cleared
    ? '<div style="padding:10px 16px;background:#1e40af;color:#93c5fd;border-radius:8px;margin-bottom:16px;font-size:13px">API key cleared successfully.</div>'
    : ''
  const errorBanner = flash?.error
    ? `<div style="padding:10px 16px;background:#7f1d1d;color:#fca5a5;border-radius:8px;margin-bottom:16px;font-size:13px">${escAttr(flash.error)}</div>`
    : ''

  return `
    <div class="page-header">
      <div>
        <h1 class="page-title">AI Provider Settings</h1>
        <p class="page-subtitle">
          <a href="${base}/settings" style="color:var(--s-accent);text-decoration:none">Settings</a> / AI Configuration
        </p>
      </div>
    </div>

    ${savedBanner}${clearedBanner}${errorBanner}

    ${renderVerificationStatus(currentConfig)}

    <form id="aiConfigForm" method="POST" action="${base}/settings/ai">
      ${csrfHiddenField(csrfToken)}

      <!-- Provider + Model -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">Provider &amp; Model</div>
        <div class="card-body">
          <div style="margin-bottom:16px">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--s-text-muted)">
              AI Provider
            </label>
            <select name="provider" style="width:100%;max-width:400px;padding:10px 14px;border:1px solid var(--s-input-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text)">
              ${providerOption('none', 'None (Rule-based only)', provider)}
              ${providerOption('openai', 'OpenAI (GPT-4o, GPT-4o-mini)', provider)}
              ${providerOption('anthropic', 'Anthropic (Claude)', provider)}
              ${providerOption('google', 'Google AI (Gemini)', provider)}
            </select>
          </div>

          <div style="margin-bottom:16px">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--s-text-muted)">
              Model (used when provider is set to OpenAI)
            </label>
            <select name="openai_model" style="width:100%;max-width:400px;padding:10px 14px;border:1px solid var(--s-input-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text)">
              ${providerOption('gpt-4o-mini', 'GPT-4o Mini (Fast, affordable)', openaiModel)}
              ${providerOption('gpt-4o', 'GPT-4o (Most capable)', openaiModel)}
              ${providerOption('gpt-4.1-mini', 'GPT-4.1 Mini', openaiModel)}
              ${providerOption('gpt-4.1', 'GPT-4.1 (Latest)', openaiModel)}
              ${providerOption('gpt-5', 'GPT-5', openaiModel)}
            </select>
          </div>

          <div style="margin-bottom:16px">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--s-text-muted)">
              Model (used when provider is set to Anthropic)
            </label>
            <select name="anthropic_model" style="width:100%;max-width:400px;padding:10px 14px;border:1px solid var(--s-input-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text)">
              ${providerOption('claude-sonnet-4-20250514', 'Claude Sonnet 4 (Balanced)', anthropicModel)}
              ${providerOption('claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (Fast)', anthropicModel)}
              ${providerOption('claude-opus-4-20250514', 'Claude Opus 4 (Most capable)', anthropicModel)}
            </select>
          </div>

          <div>
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--s-text-muted)">
              Model (used when provider is set to Google)
            </label>
            <select name="google_model" style="width:100%;max-width:400px;padding:10px 14px;border:1px solid var(--s-input-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text)">
              ${providerOption('gemini-2.0-flash', 'Gemini 2.0 Flash (Fast)', googleModel)}
              ${providerOption('gemini-2.5-pro', 'Gemini 2.5 Pro (Advanced)', googleModel)}
              ${providerOption('gemini-2.5-flash', 'Gemini 2.5 Flash (Latest)', googleModel)}
            </select>
          </div>
        </div>
      </div>

      <!-- API Key -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">API Key</div>
        <div class="card-body">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--s-text-muted)">
              API Key for the selected provider
            </label>
            <input type="password" name="api_key" autocomplete="off"
              placeholder="Paste your API key here…"
              style="width:100%;max-width:520px;padding:10px 14px;border:1px solid var(--s-input-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text)">
            <div style="font-size:11px;color:var(--s-text-dim);margin-top:6px;line-height:1.5">
              The key is encrypted with AES-256-GCM before storage and never displayed after saving.
              Clicking "Save &amp; Verify" will also run a live ping to confirm the key is valid.
            </div>
          </div>
        </div>
      </div>

      <!-- Submit -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
        <button type="submit" class="btn btn-primary" style="padding:10px 24px;font-size:14px">
          Save &amp; Verify
        </button>
        <span style="font-size:12px;color:var(--s-text-muted)">
          Saves the key and runs a live ping to the provider to confirm it works.
        </span>
      </div>
    </form>

    <!-- Info card -->
    <div class="card" style="border-color:var(--s-accent)">
      <div class="card-body" style="font-size:13px;color:var(--s-text-muted);line-height:1.6">
        <strong style="color:var(--s-accent)">How it works:</strong>
        <ul style="margin:8px 0 0 16px;padding:0">
          <li><strong>Anthropic:</strong> Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener" style="color:var(--s-accent)">console.anthropic.com</a></li>
          <li><strong>OpenAI:</strong> Get a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" style="color:var(--s-accent)">platform.openai.com</a></li>
          <li><strong>Google:</strong> Get a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="color:var(--s-accent)">Google AI Studio</a></li>
          <li><strong>Security:</strong> Keys are encrypted at rest and only decrypted in server memory when making API calls.</li>
        </ul>
      </div>
    </div>
  `
}

// ─── GET /settings/ai ───────────────────────────────────────────

export async function getAiSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!

  const config = await getAIConfig(db, store.id)
  const csrfToken = req.csrfToken!

  const saved = req.query.saved === '1'
  const cleared = req.query.cleared === '1'
  const error = req.query.error as string | undefined

  // Build a currentConfig view from the public config object.
  const currentConfig = config ? {
    provider: config.provider as AiSettingsCurrentConfig['provider'],
    anthropic_model: config.anthropicModel,
    openai_model: config.openaiModel,
    google_model: config.googleModel,
    verified_at: config.verifiedAt,
    last_error: config.lastError,
    monthly_cost_usd_cents: config.monthlyCostUsdCents,
  } : null

  const content = renderAiSettingsPage({
    slug: store.slug,
    currentConfig,
    csrfToken,
    flash: {
      saved: saved || undefined,
      cleared: cleared || undefined,
      error,
    },
  })

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'AI Settings',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    theme: theme as 'dark' | 'light',
    activePage: 'settings',
    content,
  }))
}

// ─── POST /settings/ai ─────────────────────────────────────────

export async function postAiSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`

  try {
    const body = req.body || {}
    const provider = (body.provider || 'none') as AIProvider
    // The new unified `api_key` field holds the key for whichever provider
    // is selected. Legacy per-provider fields (`openai_key`, etc.) still work
    // so existing forms don't break.
    const apiKeyRaw: string = (body.api_key?.trim() || '') as string
    const openaiKeyRaw: string = (body.openai_key?.trim() || apiKeyRaw) as string
    const anthropicKeyRaw: string = (body.anthropic_key?.trim() || apiKeyRaw) as string
    const googleKeyRaw: string = (body.google_key?.trim() || apiKeyRaw) as string

    // Resolve the key for the selected provider (for the ping).
    const keyForPing: string =
      provider === 'openai' ? openaiKeyRaw
      : provider === 'anthropic' ? anthropicKeyRaw
      : provider === 'google' ? googleKeyRaw
      : ''

    // Resolve the model for the selected provider.
    const modelForPing: string =
      provider === 'openai' ? (body.openai_model?.trim() || 'gpt-4o-mini')
      : provider === 'anthropic' ? (body.anthropic_model?.trim() || 'claude-sonnet-4-20250514')
      : provider === 'google' ? (body.google_model?.trim() || 'gemini-2.0-flash')
      : ''

    await upsertAIConfig(db, store.id, {
      provider,
      enabled: body.enabled === '1',
      openaiKey: openaiKeyRaw || undefined,
      anthropicKey: anthropicKeyRaw || undefined,
      googleKey: googleKeyRaw || undefined,
      openaiModel: body.openai_model?.trim() || undefined,
      anthropicModel: body.anthropic_model?.trim() || undefined,
      googleModel: body.google_model?.trim() || undefined,
    })

    // Run pingProvider if we have a key for the selected provider.
    let verifiedAt: string | null = null
    let lastError: string | null = null

    if (provider !== 'none' && keyForPing) {
      const ping = await pingProvider({
        provider: provider as 'anthropic' | 'openai' | 'google',
        apiKey: keyForPing,
        model: modelForPing,
      })
      if (ping.ok) {
        verifiedAt = new Date().toISOString()
      } else {
        // Iron Rule 5: ping.error is already sanitized (status code only).
        // Never log raw error to seller-facing output.
        lastError = ping.error ?? 'Verification failed'
        console.warn('[AI Settings] pingProvider failed:', ping.raw)
      }
    }

    // Persist verified_at / last_error regardless of ping outcome.
    await (db as any)
      .updateTable('shop_ai_config')
      .set({ verified_at: verifiedAt, last_error: lastError })
      .where('shop_id', '=', store.id)
      .execute()

    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'ai_settings_updated',
      title: 'AI settings updated',
      message: byActor((req as any).storeUser),
      resourceType: null,
      resourceId: null,
    })

    res.redirect(`${base}/settings/ai?saved=1`)
  } catch (err: any) {
    console.error('[AI Settings] Save failed:', err.message)
    res.redirect(`${base}/settings/ai?error=${encodeURIComponent('Failed to save. Check that the encryption key is configured.')}`)
  }
}

// ─── GET /settings/ai/clear ─────────────────────────────────────

export async function getAiSettingsClearKey(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const provider = req.query.provider as string

  if (!['openai', 'anthropic', 'google'].includes(provider)) {
    res.redirect(`${base}/settings/ai?error=Invalid provider`)
    return
  }

  try {
    await clearAIKey(db, store.id, provider as 'openai' | 'anthropic' | 'google')
    res.redirect(`${base}/settings/ai?cleared=1`)
  } catch (err: any) {
    console.error('[AI Settings] Clear key failed:', err.message)
    res.redirect(`${base}/settings/ai?error=Failed to clear key`)
  }
}
