/**
 * Store Admin — Marketing Pixels (multi-pixel, migration 034).
 *
 * Rewritten 2026-04-16 for row-per-pixel tracking. Every merchant
 * can install N Meta Pixels + N GA4 properties + N TikTok pixels
 * + N GTM containers and events fan out to all active rows.
 *
 * Routes (registered in server.ts):
 *   GET  /admin/store/:slug/settings/pixels            — list + add
 *   GET  /admin/store/:slug/settings/pixels/new        — create form
 *   POST /admin/store/:slug/settings/pixels            — create row
 *   GET  /admin/store/:slug/settings/pixels/:id/edit   — edit form
 *   POST /admin/store/:slug/settings/pixels/:id        — update row
 *   POST /admin/store/:slug/settings/pixels/:id/delete — HARD delete
 *   POST /admin/store/:slug/settings/pixels/:id/toggle — flip is_active
 *
 * Delete is intentionally destructive (no tombstone) per Thai's
 * 2026-04-16 decision: merchants re-add from scratch, the page stays
 * clean. See migration 034 docstring for the purge rationale.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout } from '../layouts/seller-layout.js'
import { notify, byActor } from '../lib/notify.js'
import {
  CANONICAL_EVENTS,
  DEFAULT_ENABLED_EVENTS,
  PROVIDER_LABELS,
  TRACKING_PROVIDERS,
  createPixel,
  deletePixel,
  getPixel,
  listPixels,
  providerNeedsToken,
  setPixelActive,
  updatePixel,
  type CanonicalEvent,
  type TrackingPixelPublic,
  type TrackingProvider,
} from '@gbox/core/modules/tracking/index.js'

// ---------------------------------------------------------------------------
// Tiny HTML helpers
// ---------------------------------------------------------------------------

function esc(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const INPUT_STYLE =
  'width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:var(--bg);color:var(--text-primary)'
const LABEL_STYLE =
  'display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)'
const HINT_STYLE = 'font-size:11px;color:var(--text-secondary);margin-top:4px'
const FIELD_WRAP = 'margin-bottom:16px'

function providerBadge(provider: TrackingProvider): string {
  const colors: Record<TrackingProvider, string> = {
    meta_pixel: '#3b82f6',
    ga4: '#10b981',
    gtm: '#f59e0b',
    tiktok: '#ec4899',
  }
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${colors[provider]}20;color:${colors[provider]};border:1px solid ${colors[provider]}40">${esc(PROVIDER_LABELS[provider])}</span>`
}

function activeBadge(isActive: boolean): string {
  return isActive
    ? '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#065f46;color:#6ee7b7">Active</span>'
    : '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#1e293b;color:#64748b">Paused</span>'
}

function tokenBadge(has: boolean): string {
  return has
    ? '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#065f46;color:#6ee7b7">Token set</span>'
    : '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#1e293b;color:#64748b">No token</span>'
}

function flashBanner(kind: 'saved' | 'created' | 'deleted' | 'toggled' | null): string {
  if (!kind) return ''
  const messages: Record<string, string> = {
    saved: 'Pixel updated successfully.',
    created: 'Pixel added successfully.',
    deleted: 'Pixel removed. All traces wiped.',
    toggled: 'Pixel status updated.',
  }
  return `<div style="padding:10px 16px;background:#065f46;color:#6ee7b7;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(messages[kind])}</div>`
}

// ---------------------------------------------------------------------------
// List page (GET /settings/pixels)
// ---------------------------------------------------------------------------

export async function getPixelConfigPage(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  const pixels = await listPixels(db, store.id)
  const csrfToken = req.csrfToken!
  const flash = typeof req.query.flash === 'string' ? (req.query.flash as any) : null

  const cards = pixels.length
    ? pixels.map((p) => pixelCardHtml(p, base, csrfToken)).join('')
    : emptyStateHtml(base)

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Marketing pixels</h1>
        <p class="page-subtitle">
          <a href="${base}/settings" style="color:var(--accent);text-decoration:none">Settings</a> / Marketing pixels
        </p>
      </div>
      <a href="${base}/settings/pixels/new" class="btn btn-primary">+ Add pixel</a>
    </div>

    ${flashBanner(flash)}

    <div style="margin-bottom:20px;padding:12px 16px;background:var(--bg-secondary);border-radius:8px;border:1px solid var(--border);font-size:12px;color:var(--text-secondary)">
      Install one or more pixels from <strong>Meta</strong>, <strong>Google Analytics 4</strong>,
      <strong>Google Tag Manager</strong>, or <strong>TikTok</strong>. Events fire to every active
      pixel both client-side (fbq/gtag/ttq) and server-side (Conversions API / Measurement Protocol /
      Events API) with a shared event_id so partners dedupe automatically.
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px">
      ${cards}
    </div>
  `

  const theme = (req as any).theme || 'dark'
  res.send(
    sellerLayout({
      title: 'Marketing pixels',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      theme: theme as 'dark' | 'light',
      activePage: 'settings',
      content,
    }),
  )
}

function pixelCardHtml(
  pixel: TrackingPixelPublic,
  base: string,
  csrfToken: string,
): string {
  const events = pixel.eventsEnabled.length
    ? pixel.eventsEnabled
        .map(
          (e) =>
            `<span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;background:var(--bg);border:1px solid var(--border);color:var(--text-secondary);margin:2px 4px 2px 0">${esc(e)}</span>`,
        )
        .join('')
    : '<span style="font-size:11px;color:var(--text-secondary)">No events enabled</span>'

  const tokenRow = providerNeedsToken(pixel.provider)
    ? `<div style="margin-top:8px">${tokenBadge(pixel.hasApiToken)}</div>`
    : ''

  return `
    <div class="card" style="display:flex;flex-direction:column;gap:0">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
          <span style="font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pixel.label)}</span>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${providerBadge(pixel.provider)}
            ${activeBadge(pixel.isActive)}
          </div>
        </div>
      </div>
      <div class="card-body" style="flex:1">
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text-primary);margin-bottom:8px">
          ${esc(pixel.pixelId)}
        </div>
        <div style="display:flex;flex-wrap:wrap;margin-bottom:8px">${events}</div>
        ${tokenRow}
        ${pixel.testEventCode ? `<div style="margin-top:8px;font-size:11px;color:var(--text-secondary)">Test code: <code>${esc(pixel.testEventCode)}</code></div>` : ''}
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center;justify-content:space-between">
        <div style="display:flex;gap:8px">
          <a href="${base}/settings/pixels/${esc(pixel.id)}/edit" class="btn btn-secondary" style="font-size:12px;padding:6px 10px">Edit</a>
          <form method="POST" action="${base}/settings/pixels/${esc(pixel.id)}/toggle" style="display:inline">
            <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />
            <button type="submit" class="btn btn-secondary" style="font-size:12px;padding:6px 10px">${pixel.isActive ? 'Pause' : 'Resume'}</button>
          </form>
        </div>
        <form method="POST" action="${base}/settings/pixels/${esc(pixel.id)}/delete" style="display:inline"
              onsubmit="return confirm('Remove this pixel? All settings will be wiped — you can add a new one anytime.')">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />
          <button type="submit" class="btn" style="font-size:12px;padding:6px 10px;color:#f87171;border:1px solid #f87171">Delete</button>
        </form>
      </div>
    </div>
  `
}

function emptyStateHtml(base: string): string {
  return `
    <div class="card" style="grid-column:1/-1">
      <div class="card-body" style="text-align:center;padding:48px 24px">
        <div style="font-size:18px;font-weight:600;margin-bottom:8px">No marketing pixels yet</div>
        <p style="font-size:13px;color:var(--text-secondary);max-width:440px;margin:0 auto 20px">
          Add your first Meta Pixel, Google Analytics 4 property, TikTok Pixel, or Google Tag Manager
          container. You can install as many as you need — events fan out to every active pixel.
        </p>
        <a href="${base}/settings/pixels/new" class="btn btn-primary">+ Add your first pixel</a>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Create / edit form
// ---------------------------------------------------------------------------

export async function getPixelNewPage(
  req: Request,
  res: Response,
): Promise<void> {
  return renderPixelForm(req, res, 'create', null)
}

export async function getPixelEditPage(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const pixelId = String(req.params.id ?? '')
  const pixel = await getPixel(db, store.id, pixelId)
  if (!pixel) {
    res.redirect(`/admin/store/${store.slug}/settings/pixels`)
    return
  }
  return renderPixelForm(req, res, 'edit', pixel)
}

async function renderPixelForm(
  req: Request,
  res: Response,
  mode: 'create' | 'edit',
  existing: TrackingPixelPublic | null,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const csrfToken = req.csrfToken!

  const action =
    mode === 'create'
      ? `${base}/settings/pixels`
      : `${base}/settings/pixels/${esc(existing!.id)}`

  const selectedProvider: TrackingProvider = existing?.provider ?? 'meta_pixel'
  const enabledEvents = existing?.eventsEnabled ?? [...DEFAULT_ENABLED_EVENTS]

  const providerOptions = TRACKING_PROVIDERS.map(
    (p) =>
      `<option value="${esc(p)}" ${p === selectedProvider ? 'selected' : ''}>${esc(PROVIDER_LABELS[p])}</option>`,
  ).join('')

  const eventCheckboxes = CANONICAL_EVENTS.map((ev) => {
    const checked = enabledEvents.includes(ev as CanonicalEvent) ? 'checked' : ''
    return `
      <label style="display:flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer;background:var(--bg)">
        <input type="checkbox" name="events" value="${esc(ev)}" ${checked} />
        ${esc(ev)}
      </label>
    `
  }).join('')

  const isEdit = mode === 'edit' && existing != null
  const tokenPlaceholder =
    isEdit && existing!.hasApiToken
      ? '••••••• (leave blank to keep existing token)'
      : 'Provider API token'

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">${isEdit ? 'Edit pixel' : 'Add pixel'}</h1>
        <p class="page-subtitle">
          <a href="${base}/settings" style="color:var(--accent);text-decoration:none">Settings</a> /
          <a href="${base}/settings/pixels" style="color:var(--accent);text-decoration:none">Marketing pixels</a> /
          ${isEdit ? esc(existing!.label) : 'New'}
        </p>
      </div>
      <div style="display:flex;gap:8px">
        <a href="${base}/settings/pixels" class="btn btn-secondary">Cancel</a>
        <button form="pixelForm" type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Add pixel'}</button>
      </div>
    </div>

    <form id="pixelForm" method="POST" action="${action}" style="max-width:680px">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />

      <div class="card">
        <div class="card-header">Pixel details</div>
        <div class="card-body">
          <div style="${FIELD_WRAP}">
            <label style="${LABEL_STYLE}">Provider</label>
            <select name="provider" style="${INPUT_STYLE}" ${isEdit ? 'disabled' : ''}>
              ${providerOptions}
            </select>
            ${isEdit ? `<input type="hidden" name="provider" value="${esc(selectedProvider)}" /><p style="${HINT_STYLE}">Provider can't be changed after creation — delete and re-add to switch.</p>` : '<p style="' + HINT_STYLE + '">Choose which tracking platform this pixel belongs to.</p>'}
          </div>

          <div style="${FIELD_WRAP}">
            <label style="${LABEL_STYLE}">Label <span style="color:var(--text-secondary);font-weight:400">(for your reference)</span></label>
            <input type="text" name="label" required maxlength="120" style="${INPUT_STYLE}"
              value="${esc(existing?.label ?? '')}" placeholder="e.g. Retargeting FB Pixel" />
            <p style="${HINT_STYLE}">Shown on this page so you can tell multiple pixels apart.</p>
          </div>

          <div style="${FIELD_WRAP}">
            <label style="${LABEL_STYLE}">Pixel / Measurement / Container ID</label>
            <input type="text" name="pixel_id" required maxlength="120" style="${INPUT_STYLE}"
              value="${esc(existing?.pixelId ?? '')}" placeholder="e.g. 123456789012345 / G-XXXXXXXXXX / GTM-XXXXXXX / CXXXXXXX" />
            <p style="${HINT_STYLE}">Exact ID issued by the provider — copy/paste from their Events Manager.</p>
          </div>

          <div style="${FIELD_WRAP}">
            <label style="${LABEL_STYLE}">API Token ${isEdit ? tokenBadge(existing!.hasApiToken) : ''}</label>
            <input type="password" name="api_token" style="${INPUT_STYLE}" autocomplete="off"
              placeholder="${esc(tokenPlaceholder)}" />
            <p style="${HINT_STYLE}">
              Required for server-side events (Meta CAPI / GA4 Measurement Protocol / TikTok Events API).
              GTM does not need a token. Encrypted at rest (AES-256-GCM) and never shown after save.
            </p>
          </div>

          <div style="${FIELD_WRAP}">
            <label style="${LABEL_STYLE}">Test event code <span style="color:var(--text-secondary);font-weight:400">(optional)</span></label>
            <input type="text" name="test_event_code" maxlength="120" style="${INPUT_STYLE}"
              value="${esc(existing?.testEventCode ?? '')}" placeholder="TEST12345" />
            <p style="${HINT_STYLE}">Meta test_event_code / GA4 debug flag — leave blank in production.</p>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-header">Events to fire</div>
        <div class="card-body">
          <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">
            Only checked events fire to this pixel. Event names use the Meta Standard Events
            vocabulary — GA4/TikTok equivalents are mapped automatically.
          </p>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${eventCheckboxes}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-header">Status</div>
        <div class="card-body">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px">
            <input type="checkbox" name="is_active" value="1" ${existing?.isActive !== false ? 'checked' : ''} />
            Active — the storefront injector and server dispatcher will use this pixel
          </label>
        </div>
      </div>
    </form>
  `

  const theme = (req as any).theme || 'dark'
  res.send(
    sellerLayout({
      title: isEdit ? 'Edit pixel' : 'Add pixel',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      theme: theme as 'dark' | 'light',
      activePage: 'settings',
      content,
    }),
  )
}

// ---------------------------------------------------------------------------
// Form handlers
// ---------------------------------------------------------------------------

function coerceEvents(raw: unknown): CanonicalEvent[] {
  if (Array.isArray(raw)) {
    return raw
      .map((x) => String(x))
      .filter((x): x is CanonicalEvent =>
        (CANONICAL_EVENTS as readonly string[]).includes(x),
      )
  }
  if (typeof raw === 'string' && (CANONICAL_EVENTS as readonly string[]).includes(raw)) {
    return [raw as CanonicalEvent]
  }
  return []
}

function coerceProvider(raw: unknown): TrackingProvider | null {
  if (typeof raw !== 'string') return null
  if ((TRACKING_PROVIDERS as readonly string[]).includes(raw)) {
    return raw as TrackingProvider
  }
  return null
}

export async function postPixelCreate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const body = req.body ?? {}

  const provider = coerceProvider(body.provider)
  if (!provider) {
    res.redirect(`/admin/store/${store.slug}/settings/pixels/new`)
    return
  }

  const label = String(body.label ?? '').trim()
  const pixelId = String(body.pixel_id ?? '').trim()
  if (!label || !pixelId) {
    res.redirect(`/admin/store/${store.slug}/settings/pixels/new`)
    return
  }

  const rawToken = String(body.api_token ?? '').trim()
  const apiToken = rawToken && providerNeedsToken(provider) ? rawToken : null

  const created = await createPixel(db, {
    shopId: store.id,
    provider,
    label,
    pixelId,
    apiToken,
    eventsEnabled: coerceEvents(body.events),
    testEventCode: String(body.test_event_code ?? '').trim() || null,
    isActive: body.is_active === '1' || body.is_active === true,
    createdBy: (req as any).storeUser?.id ?? null,
  })

  notify(db, {
    shopId: store.id,
    userId: (req as any).storeUser?.id,
    type: 'tracking_pixel_added',
    title: `Tracking pixel added: ${created.label}`,
    message: byActor((req as any).storeUser),
    resourceType: 'shop_tracking_pixels',
    resourceId: created.id,
  })

  res.redirect(`/admin/store/${store.slug}/settings/pixels?flash=created`)
}

export async function postPixelUpdate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const pixelRowId = String(req.params.id ?? '')
  const body = req.body ?? {}

  const existing = await getPixel(db, store.id, pixelRowId)
  if (!existing) {
    res.redirect(`/admin/store/${store.slug}/settings/pixels`)
    return
  }

  // Token input tri-state:
  //   blank   → keep existing (undefined)
  //   value   → replace
  //   "__clear__" sentinel (not used in UI yet) → clear
  let apiToken: string | null | undefined = undefined
  const rawToken = String(body.api_token ?? '')
  if (rawToken.trim()) apiToken = rawToken.trim()

  await updatePixel(db, store.id, pixelRowId, {
    label: String(body.label ?? '').trim() || undefined,
    pixelId: String(body.pixel_id ?? '').trim() || undefined,
    apiToken,
    eventsEnabled: coerceEvents(body.events),
    testEventCode: String(body.test_event_code ?? '').trim() || null,
    isActive: body.is_active === '1' || body.is_active === true,
  })

  notify(db, {
    shopId: store.id,
    userId: (req as any).storeUser?.id,
    type: 'tracking_pixel_updated',
    title: `Tracking pixel updated: ${existing.label}`,
    message: byActor((req as any).storeUser),
    resourceType: 'shop_tracking_pixels',
    resourceId: existing.id,
  })

  res.redirect(`/admin/store/${store.slug}/settings/pixels?flash=saved`)
}

export async function postPixelDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const pixelRowId = String(req.params.id ?? '')

  const existing = await getPixel(db, store.id, pixelRowId)
  if (existing) {
    await deletePixel(db, store.id, pixelRowId)
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'tracking_pixel_deleted',
      title: `Tracking pixel removed: ${existing.label}`,
      message: byActor((req as any).storeUser),
      resourceType: 'shop_tracking_pixels',
      resourceId: existing.id,
    })
  }

  res.redirect(`/admin/store/${store.slug}/settings/pixels?flash=deleted`)
}

export async function postPixelToggle(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const pixelRowId = String(req.params.id ?? '')

  const existing = await getPixel(db, store.id, pixelRowId)
  if (existing) {
    await setPixelActive(db, store.id, pixelRowId, !existing.isActive)
  }

  res.redirect(`/admin/store/${store.slug}/settings/pixels?flash=toggled`)
}
