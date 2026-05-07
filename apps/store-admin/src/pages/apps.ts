/**
 * Store Admin — Apps / Plugin System
 *
 * G.6: App/Plugin marketplace & management UI.
 * Shows installed apps, app store (available definitions), per-app config.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  listAppDefinitions,
  getInstalledApps,
  installApp,
  uninstallApp,
  updateAppConfig,
  type AppInstallationWithApp,
  type AppDefinition,
} from '@gbox/core/modules/apps/service.js'
import { notify, byActor } from '../lib/notify.js'

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/apps — Main apps page
// ---------------------------------------------------------------------------

export async function getApps(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const csrf = req.csrfToken || ''

  const search = (req.query.q as string || '').trim()

  const [installed, available] = await Promise.all([
    getInstalledApps(db, store.id),
    listAppDefinitions(db, search ? { search } : {}, { limit: 50 }),
  ])

  // Filter out already-installed apps from the store listing
  const installedAppIds = new Set(installed.map((i) => i.app_id))
  const storeApps = available.apps.filter((a) => !installedAppIds.has(a.id))

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Apps</h1>
        <p class="page-subtitle">${installed.length} app${installed.length !== 1 ? 's' : ''} installed</p>
      </div>
    </div>

    <!-- Search -->
    <div class="card" style="margin-bottom:24px">
      <div class="card-body" style="padding:12px 16px">
        <form method="get" style="display:flex;gap:8px">
          <input type="text" name="q" value="${esc(search)}" placeholder="Search apps..." class="form-input" style="flex:1" />
          <button type="submit" class="btn btn-outline btn-sm">Search</button>
          ${search ? `<a href="/admin/store/${store.slug}/apps" class="btn btn-outline btn-sm">Clear</a>` : ''}
        </form>
      </div>
    </div>

    <!-- Installed Apps -->
    <div style="margin-bottom:32px">
      <h2 style="font-size:18px;font-weight:600;margin-bottom:16px;color:var(--text-primary)">Installed Apps</h2>
      ${installed.length === 0 ? `
        <div class="card">
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-state-icon">&#128268;</div>
              <div class="empty-state-title">No apps installed</div>
              <div class="empty-state-text">Browse the App Store below to find apps for your store.</div>
            </div>
          </div>
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px">
          ${installed.map((inst) => renderInstalledAppCard(inst, store.slug, csrf)).join('\n')}
        </div>
      `}
    </div>

    <!-- App Store -->
    <div>
      <h2 style="font-size:18px;font-weight:600;margin-bottom:16px;color:var(--text-primary)">App Store</h2>
      ${storeApps.length === 0 ? `
        <div class="card">
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-state-icon">&#128722;</div>
              <div class="empty-state-title">${search ? 'No matching apps found' : 'All available apps are installed'}</div>
              <div class="empty-state-text">${search ? 'Try a different search term.' : 'Check back later for new apps.'}</div>
            </div>
          </div>
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px">
          ${storeApps.map((app) => renderStoreAppCard(app, store.slug, csrf)).join('\n')}
        </div>
      `}
    </div>
  `

  res.send(sellerLayout({
    title: 'Apps',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'apps',
    cookieHeader: req.headers.cookie ?? null,
    content,
  }))
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/apps/install — Install an app
// ---------------------------------------------------------------------------

export async function postInstallApp(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const appId = req.body.app_id as string

  if (!appId) {
    res.status(400).send('Missing app_id')
    return
  }

  try {
    await installApp(db, store.id, appId)
  } catch (err: any) {
    // Already installed or invalid — redirect with error
    res.redirect(`/admin/store/${store.slug}/apps?error=${encodeURIComponent(err.message)}`)
    return
  }

  notify(db, {
    shopId: store.id,
    userId: (req as any).storeUser?.id,
    type: 'app_installed',
    title: `App installed: ${appId}`,
    message: byActor((req as any).storeUser),
    resourceType: 'app',
    resourceId: appId,
  })

  res.redirect(`/admin/store/${store.slug}/apps`)
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/apps/uninstall — Uninstall an app
// ---------------------------------------------------------------------------

export async function postUninstallApp(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const appId = req.body.app_id as string

  if (!appId) {
    res.status(400).send('Missing app_id')
    return
  }

  try {
    await uninstallApp(db, store.id, appId)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/apps?error=${encodeURIComponent(err.message)}`)
    return
  }

  notify(db, {
    shopId: store.id,
    userId: (req as any).storeUser?.id,
    type: 'app_uninstalled',
    title: `App uninstalled: ${appId}`,
    message: byActor((req as any).storeUser),
    resourceType: 'app',
    resourceId: appId,
  })

  res.redirect(`/admin/store/${store.slug}/apps`)
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/apps/:appId/config — App configuration page
// ---------------------------------------------------------------------------

export async function getAppConfig(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const csrf = req.csrfToken || ''
  const appId = req.params.appId

  // Find the installation
  const installed = await getInstalledApps(db, store.id)
  const installation = installed.find((i) => i.app_id === appId)

  if (!installation) {
    res.redirect(`/admin/store/${store.slug}/apps`)
    return
  }

  const configJson = installation.config
    ? JSON.stringify(
        typeof installation.config === 'string'
          ? JSON.parse(installation.config as string)
          : installation.config,
        null,
        2,
      )
    : '{}'

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">${esc(installation.app.name)} — Configuration</h1>
        <p class="page-subtitle">App ID: ${esc(appId)}</p>
      </div>
      <a href="/admin/store/${store.slug}/apps" class="btn btn-outline btn-sm">Back to Apps</a>
    </div>

    <div class="card">
      <div class="card-header">
        <h3 class="card-title">App Details</h3>
      </div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">
          <div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:4px">Name</div>
            <div style="color:var(--text-primary)">${esc(installation.app.name)}</div>
          </div>
          <div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:4px">Developer</div>
            <div style="color:var(--text-primary)">${esc(installation.app.developer || 'Unknown')}</div>
          </div>
          <div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:4px">Status</div>
            <div><span class="badge badge-success">${esc(installation.status)}</span></div>
          </div>
          <div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:4px">Installed</div>
            <div style="color:var(--text-primary)">${new Date(installation.created_at).toLocaleDateString()}</div>
          </div>
        </div>
        ${installation.app.description ? `<p style="color:var(--text-secondary);margin-bottom:16px">${esc(installation.app.description)}</p>` : ''}
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-header">
        <h3 class="card-title">Configuration (JSON)</h3>
      </div>
      <div class="card-body">
        <form method="post" action="/admin/store/${store.slug}/apps/${esc(appId)}/config">
          ${csrfHiddenField(csrf)}
          <textarea
            name="config"
            class="form-input"
            rows="12"
            style="font-family:monospace;font-size:13px;width:100%;resize:vertical"
            placeholder='{ "key": "value" }'
          >${esc(configJson)}</textarea>
          <div style="margin-top:12px;display:flex;gap:8px">
            <button type="submit" class="btn btn-primary btn-sm">Save Configuration</button>
            <a href="/admin/store/${store.slug}/apps" class="btn btn-outline btn-sm">Cancel</a>
          </div>
        </form>
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: `${installation.app.name} Config`,
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'apps',
    cookieHeader: req.headers.cookie ?? null,
    content,
  }))
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/apps/:appId/config — Save app config
// ---------------------------------------------------------------------------

export async function postAppConfig(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const appId = req.params.appId
  const rawConfig = req.body.config as string

  // Find the installation
  const installed = await getInstalledApps(db, store.id)
  const installation = installed.find((i) => i.app_id === appId)

  if (!installation) {
    res.redirect(`/admin/store/${store.slug}/apps`)
    return
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawConfig)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Config must be a JSON object')
    }
  } catch (err: any) {
    res.redirect(
      `/admin/store/${store.slug}/apps/${appId}/config?error=${encodeURIComponent('Invalid JSON: ' + err.message)}`,
    )
    return
  }

  try {
    await updateAppConfig(db, installation.id, parsed)
  } catch (err: any) {
    res.redirect(
      `/admin/store/${store.slug}/apps/${appId}/config?error=${encodeURIComponent(err.message)}`,
    )
    return
  }

  notify(db, {
    shopId: store.id,
    userId: (req as any).storeUser?.id,
    type: 'app_config_updated',
    title: `App config updated: ${installation.app.name}`,
    message: byActor((req as any).storeUser),
    resourceType: 'app',
    resourceId: appId,
  })

  res.redirect(`/admin/store/${store.slug}/apps/${appId}/config`)
}

// ---------------------------------------------------------------------------
// Card renderers
// ---------------------------------------------------------------------------

function renderInstalledAppCard(
  inst: AppInstallationWithApp,
  storeSlug: string,
  csrf: string,
): string {
  const iconHtml = inst.app.icon_url
    ? `<img src="${esc(inst.app.icon_url)}" alt="" style="width:40px;height:40px;border-radius:8px" />`
    : `<div style="width:40px;height:40px;border-radius:8px;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;font-size:20px">&#128268;</div>`

  return `
    <div class="card">
      <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:12px">
          ${iconHtml}
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(inst.app.name)}</div>
            <div style="font-size:12px;color:var(--text-tertiary)">${esc(inst.app.developer || 'Unknown developer')}</div>
          </div>
          <span class="badge badge-success">${esc(inst.status)}</span>
        </div>
        ${inst.app.description ? `<p style="font-size:13px;color:var(--text-secondary);margin:0;line-height:1.4">${esc(inst.app.description)}</p>` : ''}
        <div style="display:flex;gap:8px;margin-top:auto">
          <a href="/admin/store/${storeSlug}/apps/${esc(inst.app_id)}/config" class="btn btn-outline btn-sm" style="flex:1;text-align:center">Configure</a>
          <form method="post" action="/admin/store/${storeSlug}/apps/uninstall" style="flex:1" onsubmit="return confirm('Uninstall ${esc(inst.app.name)}?')">
            ${csrfHiddenField(csrf)}
            <input type="hidden" name="app_id" value="${esc(inst.app_id)}" />
            <button type="submit" class="btn btn-outline btn-sm" style="width:100%;color:var(--error-color)">Uninstall</button>
          </form>
        </div>
      </div>
    </div>
  `
}

function renderStoreAppCard(
  app: AppDefinition,
  storeSlug: string,
  csrf: string,
): string {
  const iconHtml = app.icon_url
    ? `<img src="${esc(app.icon_url)}" alt="" style="width:40px;height:40px;border-radius:8px" />`
    : `<div style="width:40px;height:40px;border-radius:8px;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;font-size:20px">&#128268;</div>`

  return `
    <div class="card">
      <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:12px">
          ${iconHtml}
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(app.name)}</div>
            <div style="font-size:12px;color:var(--text-tertiary)">${esc(app.developer || 'Unknown developer')}</div>
          </div>
        </div>
        ${app.description ? `<p style="font-size:13px;color:var(--text-secondary);margin:0;line-height:1.4">${esc(app.description)}</p>` : ''}
        <div style="margin-top:auto">
          <form method="post" action="/admin/store/${storeSlug}/apps/install">
            ${csrfHiddenField(csrf)}
            <input type="hidden" name="app_id" value="${esc(app.id)}" />
            <button type="submit" class="btn btn-primary btn-sm" style="width:100%">Install</button>
          </form>
        </div>
      </div>
    </div>
  `
}
