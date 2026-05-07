/**
 * Store Admin — Custom Data (Metafield Definitions)
 *
 * Manage metafield definitions — equivalent to Shopify's
 * Settings > Custom Data page. Shows which resource types
 * have metafields defined and allows creating new definitions.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import type { MetafieldOwnerType } from '@gbox/core/modules/metafields/service.js'

// Map settings-page plural keys ("products") to the internal owner_type
// enum stored in the metafields table ("product"). Keeps the UI list
// shop-scoped (not tied to a specific product/collection/…).
const SEGMENT_TO_OWNER_TYPE: Record<string, MetafieldOwnerType> = {
  products: 'product',
  collections: 'collection',
  customers: 'customer',
  orders: 'order',
  pages: 'page',
  shop: 'shop',
}

// ---------------------------------------------------------------------------
// Resource types that support metafields
// ---------------------------------------------------------------------------

const RESOURCE_TYPES = [
  { key: 'products', label: 'Products', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7.5 4.27 9 5.15M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>' },
  { key: 'collections', label: 'Collections', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>' },
  { key: 'customers', label: 'Customers', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
  { key: 'orders', label: 'Orders', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' },
  { key: 'pages', label: 'Pages', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>' },
  { key: 'shop', label: 'Shop', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>' },
]

// ---------------------------------------------------------------------------
// GET /settings/custom-data
// ---------------------------------------------------------------------------

export async function getCustomDataSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'

  // Count metafields per resource type — one shop-scoped aggregate query
  // per type rather than N+1 row fetches. Falls back to 0 on error so the
  // settings page never blows up just because one row count failed.
  const counts: Record<string, number> = {}
  for (const rt of RESOURCE_TYPES) {
    const ownerType = SEGMENT_TO_OWNER_TYPE[rt.key]
    if (!ownerType) {
      counts[rt.key] = 0
      continue
    }
    try {
      const row = await (db as Kysely<Database>)
        .selectFrom('metafields')
        .select(({ fn }) => fn.count<number>('id').as('c'))
        .where('shop_id', '=', store.id)
        .where('owner_type', '=', ownerType)
        .executeTakeFirst()
      counts[rt.key] = row ? Number(row.c) || 0 : 0
    } catch {
      counts[rt.key] = 0
    }
  }

  const totalMetafields = Object.values(counts).reduce((a, b) => a + b, 0)

  const resourceCards = RESOURCE_TYPES.map(rt => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px;border:1px solid var(--s-border);border-radius:8px;background:var(--s-bg)">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="color:var(--s-text-secondary)">${rt.icon}</div>
        <div>
          <div style="font-weight:600;font-size:14px;color:var(--s-text-primary)">${rt.label}</div>
          <div style="font-size:12px;color:var(--s-text-secondary)">${counts[rt.key]} metafield${counts[rt.key] !== 1 ? 's' : ''} defined</div>
        </div>
      </div>
      <span style="font-size:12px;color:var(--s-text-secondary)">${rt.key}</span>
    </div>
  `).join('')

  const content = `
    <div class="page-header" style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
      <a href="/admin/store/${esc(store.slug)}/settings" style="color:var(--s-text-secondary);text-decoration:none;font-size:13px">&larr; Settings</a>
      <div>
        <h1 style="margin:0;font-size:22px;font-weight:700">Custom Data</h1>
        <p style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">Metafield definitions for ${esc(store.name)}</p>
      </div>
    </div>

    <div class="stats-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px">
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Total Metafields</div>
        <div style="font-size:28px;font-weight:700;color:var(--s-text-primary)">${totalMetafields}</div>
      </div>
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Resource Types</div>
        <div style="font-size:28px;font-weight:700;color:var(--s-text-primary)">${RESOURCE_TYPES.length}</div>
      </div>
    </div>

    <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px;max-width:700px">
      <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Metafield Definitions</h2>
      <p style="margin:0 0 16px;color:var(--s-text-secondary);font-size:13px">Add custom data to your store's resources using the Metafields API</p>

      <div style="display:flex;flex-direction:column;gap:8px">
        ${resourceCards}
      </div>
    </div>

    <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px;max-width:700px">
      <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">API Reference</h2>
      <p style="margin:0 0 16px;color:var(--s-text-secondary);font-size:13px">Metafields can be managed via the REST API</p>

      <div style="background:var(--s-bg);border:1px solid var(--s-border);border-radius:6px;padding:16px;font-family:monospace;font-size:13px;color:var(--s-text-primary);overflow-x:auto">
        <div style="color:var(--s-text-secondary);margin-bottom:4px"># Set a metafield</div>
        <div>POST /api/store/:slug/metafields</div>
        <div style="color:var(--s-text-secondary);margin:8px 0 4px"># List metafields for a resource</div>
        <div>GET /api/store/:slug/metafields?owner_type=products&owner_id=:id</div>
        <div style="color:var(--s-text-secondary);margin:8px 0 4px"># Delete a metafield</div>
        <div>DELETE /api/store/:slug/metafields/:id</div>
      </div>
    </div>
  `

  res.send(
    sellerLayout({
      title: 'Custom Data',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'settings',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}
