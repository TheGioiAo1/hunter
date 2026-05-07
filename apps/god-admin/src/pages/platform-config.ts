/**
 * God Admin — Platform Configuration (Phase 2 Step 2.5)
 *
 * Was a read-only feature-flag preview; is now a Shopify-grade
 * settings page editing the 11 typed platform settings in
 * `@gbox/core/modules/platform-config`:
 *
 *   GET  /god-admin/config  — rendered form, one section per category,
 *                             one input per setting, field-level errors
 *                             preserved via query-string on redirect.
 *   POST /god-admin/config  — applyMany(): coerce + validate + persist.
 *                             Successes → toast via gbox_flash cookie.
 *                             Failures → redirect back with ?error=…
 *
 * Access
 * ------
 * Every god-admin route is already gated by `createGodAuthMiddleware`
 * at the app level (requireLevel(0)). Per Iron Rule #2, no other role
 * can even *see* this page. The handlers still re-check CSRF on POST
 * because these settings control the whole platform.
 *
 * Flash cookie
 * ------------
 * On successful save we set a `gbox_flash` cookie (via
 * `buildFlashCookie`) which the layout picks up and turns into a
 * toast on the next render. No server-side state required.
 *
 * Triết lý: "clone giống hệt Shopify" (section-grouped settings,
 * inline help under each field, green success toast on save) +
 * "power-ful hơn Shopify nhờ Claude" (one typed registry drives the
 * form, the validator, the service, and the DB).
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import {
  PlatformConfigService,
  groupByCategory,
  type PlatformSettingDef,
  type ResolvedPlatformSetting,
} from '../../../../packages/core/src/modules/platform-config/index.js'
import { KyselyPlatformSettingsStore } from '../lib/platform-config-store.js'
import { buildFlashCookie } from '../../../../packages/core/src/modules/ui/toast.js'
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'

// ---------------------------------------------------------------------------
// Module-level CSRF store
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_platform_config' })

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

// ---------------------------------------------------------------------------
// Field renderer — kind → HTML
// ---------------------------------------------------------------------------

function renderField(
  resolved: ResolvedPlatformSetting,
  fieldError: string | undefined,
): string {
  const def = resolved.def
  const value = resolved.value
  const id = `f-${def.key}`
  const helpId = `${id}-help`
  const errClass = fieldError ? ' pc-field-invalid' : ''

  let inputHtml = ''
  switch (def.kind) {
    case 'secret': {
      // Masked API key field with show/hide toggle
      const val = String(value ?? '')
      const masked = val ? val.substring(0, 8) + '...' + val.substring(val.length - 4) : ''
      inputHtml =
        `<div style="position:relative;display:flex;gap:8px;align-items:center">` +
        `<input type="password" id="${id}" name="${esc(def.key)}" value="${esc(val)}" class="pc-input" aria-describedby="${helpId}" placeholder="Paste your API key here..." style="flex:1;font-family:monospace;padding-right:80px">` +
        `<button type="button" onclick="(function(btn){var inp=document.getElementById('${id}');if(inp.type==='password'){inp.type='text';btn.textContent='Hide'}else{inp.type='password';btn.textContent='Show'}})(this)" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);padding:4px 10px;font-size:11px;border-radius:4px;border:1px solid var(--god-border);background:var(--god-bg);color:var(--god-text-secondary,#9ca3af);cursor:pointer;font-weight:500">Show</button>` +
        `</div>` +
        (val ? `<div style="font-size:11px;color:var(--god-text-secondary,#9ca3af);margin-top:4px;font-family:monospace">Current: ${esc(masked)}</div>` : '')
      break
    }
    case 'text':
    case 'email':
    case 'url': {
      const type = def.kind === 'email' ? 'email' : def.kind === 'url' ? 'url' : 'text'
      inputHtml = `<input type="${type}" id="${id}" name="${esc(def.key)}" value="${esc(String(value ?? ''))}" class="pc-input" aria-describedby="${helpId}">`
      break
    }
    case 'number': {
      inputHtml = `<input type="number" id="${id}" name="${esc(def.key)}" value="${esc(String(value ?? 0))}" class="pc-input" aria-describedby="${helpId}">`
      break
    }
    case 'boolean': {
      const checked = value === true ? ' checked' : ''
      // Hidden companion with value='' guarantees the POST sees the
      // key even when the checkbox is unchecked (= browser omits it).
      inputHtml =
        `<input type="hidden" name="${esc(def.key)}" value="">` +
        `<label class="pc-toggle">` +
        `<input type="checkbox" id="${id}" name="${esc(def.key)}"${checked} aria-describedby="${helpId}">` +
        `<span class="pc-toggle-track"><span class="pc-toggle-dot"></span></span>` +
        `<span class="pc-toggle-label">${value === true ? 'Enabled' : 'Disabled'}</span>` +
        `</label>`
      break
    }
    case 'select': {
      const optionsHtml = (def.options ?? [])
        .map(
          (o) =>
            `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`,
        )
        .join('')
      inputHtml = `<select id="${id}" name="${esc(def.key)}" class="pc-input" aria-describedby="${helpId}">${optionsHtml}</select>`
      break
    }
  }

  const badge = resolved.isDefault
    ? `<span class="pc-default-badge" title="Using the code default">default</span>`
    : ''
  const errHtml = fieldError
    ? `<div class="pc-field-error" role="alert">${esc(fieldError)}</div>`
    : ''

  return (
    `<div class="pc-field${errClass}">` +
    `<label for="${id}" class="pc-label">${esc(def.label)}${badge}</label>` +
    inputHtml +
    `<p id="${helpId}" class="pc-help">${esc(def.help)}</p>` +
    errHtml +
    `</div>`
  )
}

function renderCategory(
  name: string,
  resolved: ResolvedPlatformSetting[],
  fieldErrors: Record<string, string>,
): string {
  const fieldsHtml = resolved
    .map((r) => renderField(r, fieldErrors[r.def.key]))
    .join('')
  return (
    `<section class="pc-card">` +
    `<h2 class="pc-card-title">${esc(name)}</h2>` +
    `<div class="pc-fields">${fieldsHtml}</div>` +
    `</section>`
  )
}

function platformConfigCss(): string {
  return `
    .pc-wrap { max-width: 840px; }
    .pc-card {
      background: var(--god-surface);
      border: 1px solid var(--god-border);
      border-radius: 10px;
      padding: 20px 24px;
      margin-bottom: 16px;
    }
    .pc-card-title {
      margin: 0 0 16px;
      font-size: 15px;
      font-weight: 700;
      color: var(--god-text);
      border-bottom: 1px solid var(--god-border);
      padding-bottom: 10px;
    }
    .pc-fields { display: flex; flex-direction: column; gap: 20px; }
    .pc-field { display: flex; flex-direction: column; gap: 4px; }
    .pc-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--god-text);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .pc-default-badge {
      font-size: 10px;
      font-weight: 500;
      padding: 2px 6px;
      border-radius: 999px;
      background: var(--god-border-light, rgba(255,255,255,0.05));
      color: var(--god-text-secondary, #9ca3af);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .pc-input {
      width: 100%;
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid var(--god-border);
      background: var(--god-bg);
      color: var(--god-text);
      font-size: 13px;
      font-family: inherit;
    }
    .pc-input:focus {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 0;
      border-color: var(--god-accent, #3b82f6);
    }
    .pc-help {
      font-size: 12px;
      color: var(--god-text-secondary, #9ca3af);
      margin: 0;
    }
    .pc-field-error {
      font-size: 12px;
      color: var(--god-danger, #ef4444);
      font-weight: 600;
    }
    .pc-field-invalid .pc-input { border-color: var(--god-danger, #ef4444); }

    /* Toggle switch */
    .pc-toggle { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; }
    .pc-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
    .pc-toggle-track {
      width: 36px;
      height: 20px;
      border-radius: 999px;
      background: var(--god-border, rgba(255,255,255,0.15));
      position: relative;
      transition: background 0.15s;
    }
    .pc-toggle-dot {
      position: absolute;
      top: 2px; left: 2px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: var(--god-text, #f3f4f6);
      transition: transform 0.15s;
    }
    .pc-toggle input:checked + .pc-toggle-track {
      background: var(--god-accent, #3b82f6);
    }
    .pc-toggle input:checked + .pc-toggle-track .pc-toggle-dot {
      transform: translateX(16px);
    }
    .pc-toggle-label {
      font-size: 13px;
      color: var(--god-text-secondary, #9ca3af);
    }
    .pc-toggle input:focus-visible + .pc-toggle-track {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }

    /* Save bar */
    .pc-save-bar {
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
    .pc-save-btn {
      padding: 9px 18px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      background: var(--god-accent, #3b82f6);
      color: #fff;
      border: none;
      cursor: pointer;
    }
    .pc-save-btn:hover { filter: brightness(1.1); }
    .pc-save-btn:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }
  `
}

// ---------------------------------------------------------------------------
// GET /god-admin/config
// ---------------------------------------------------------------------------

export async function getPlatformConfig(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user

  try {
    const store = new KyselyPlatformSettingsStore(db, user.id)
    const svc = new PlatformConfigService(store)
    const all = await svc.getAll()

    // Parse ?errors= query param (set on redirect from POST when
    // validation fails — JSON-encoded map of key → error message).
    let fieldErrors: Record<string, string> = {}
    if (typeof req.query.errors === 'string') {
      try {
        fieldErrors = JSON.parse(decodeURIComponent(req.query.errors)) as Record<string, string>
      } catch {
        fieldErrors = {}
      }
    }

    // CSRF token embedded in the edit form.
    const csrfToken = await csrfStore.issue(res, isProduction())
    const csrfField = csrfStore.hiddenField(csrfToken)

    // Group by category and render.
    const grouped = groupByCategory()
    const byKey: Record<string, ResolvedPlatformSetting> = {}
    for (const r of all) byKey[r.def.key] = r

    const sectionsHtml = Object.entries(grouped)
      .map(([categoryName, defs]) => {
        const resolved = defs.map(
          (d: PlatformSettingDef) => byKey[d.key],
        ) as ResolvedPlatformSetting[]
        return renderCategory(categoryName, resolved, fieldErrors)
      })
      .join('')

    const hasErrors = Object.keys(fieldErrors).length > 0
    const errorBanner = hasErrors
      ? `<div class="pc-card" style="border-color:var(--god-danger,#ef4444);color:var(--god-danger,#ef4444);font-size:13px;font-weight:600">Some fields have errors. Please review and try again.</div>`
      : ''

    const content =
      `<style>${platformConfigCss()}</style>` +
      `<div class="page-header"><h1>Platform Configuration</h1></div>` +
      `<form method="post" action="/god-admin/config" class="pc-wrap">` +
      csrfField +
      errorBanner +
      sectionsHtml +
      `<div class="pc-save-bar">` +
      `<button type="submit" class="pc-save-btn">Save changes</button>` +
      `</div>` +
      `</form>`

    res.send(
      godLayout({
        title: 'Platform Config',
        userEmail: user.email,
        activePath: '/god-admin/config',
        content,
      }),
    )
  } catch (err) {
    console.error('[God Admin] Platform config error:', err)
    res.status(500).send(
      godLayout({
        title: 'Platform Config',
        userEmail: user.email,
        activePath: '/god-admin/config',
        content: `<div class="card"><p style="color:var(--god-danger,#ef4444)">Error: ${esc(String(err))}</p></div>`,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/config
// ---------------------------------------------------------------------------

export async function postPlatformConfig(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  // CSRF reject silently.
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/config')
    return
  }

  const user = req.godAdmin!.user

  try {
    const store = new KyselyPlatformSettingsStore(db, user.id)
    const svc = new PlatformConfigService(store)

    // Pluck only the keys we know about from the body so users can't
    // write arbitrary columns.
    const all = await svc.getAll()
    const changes: Record<string, string> = {}
    for (const r of all) {
      const raw = req.body[r.def.key]
      if (raw === undefined || raw === null) continue
      changes[r.def.key] = String(raw)
    }

    const results = await svc.applyMany(changes)

    // Collect field errors — null means success.
    const fieldErrors: Record<string, string> = {}
    for (const [k, v] of Object.entries(results)) {
      if (v) fieldErrors[k] = v
    }

    if (Object.keys(fieldErrors).length > 0) {
      const q = encodeURIComponent(JSON.stringify(fieldErrors))
      res.redirect(`/god-admin/config?errors=${q}`)
      return
    }

    // Success: set flash toast and redirect.
    const changedKeys = Object.keys(changes)
    const n = changedKeys.length
    res.setHeader(
      'Set-Cookie',
      buildFlashCookie({
        kind: 'success',
        message: `Platform config saved (${n} field${n === 1 ? '' : 's'} updated).`,
      }),
    )
    res.redirect('/god-admin/config')
  } catch (err) {
    console.error('[God Admin] Platform config save error:', err)
    res.status(500).send(
      godLayout({
        title: 'Platform Config',
        userEmail: user.email,
        activePath: '/god-admin/config',
        content: `<div class="card"><p style="color:var(--god-danger,#ef4444)">Save failed: ${esc(String(err))}</p></div>`,
      }),
    )
  }
}
