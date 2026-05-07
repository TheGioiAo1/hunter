/**
 * Store Admin — Inventory Locations
 *
 * CRUD for inventory locations. Lists locations from the locations table.
 * Each store can have multiple locations (warehouse, store, etc.).
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { logSellerAction } from '../middleware/store-auth.js'
import { notify, byActor } from '../lib/notify.js'

// ─── GET: List Locations ───────────────────────────────────────

export async function getLocations(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const saved = req.query.saved === '1'
  const deleted = req.query.deleted === '1'

  const csrfToken = req.csrfToken!
  const csrfField = csrfHiddenField(csrfToken)

  const locations = await db.selectFrom('locations')
    .select(['id', 'name', 'address', 'city', 'province', 'country', 'zip', 'phone', 'is_primary', 'active', 'created_at'])
    .where('shop_id', '=', store.id)
    .orderBy('is_primary', 'desc')
    .orderBy('name', 'asc')
    .execute()

  const activeCount = locations.filter(l => l.active).length

  // Editing state
  const editId = (req.query.edit as string || '').trim()
  const editLocation = editId ? locations.find(l => l.id === editId) : null

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/settings" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Settings
        </a>
        <h1 class="page-title">Locations</h1>
        <p class="page-subtitle">${locations.length} location${locations.length !== 1 ? 's' : ''} (${activeCount} active)</p>
      </div>
    </div>

    ${saved ? `
      <div style="background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-success);font-size:13px">
        Location saved successfully.
      </div>
    ` : ''}

    ${deleted ? `
      <div style="background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-success);font-size:13px">
        Location deleted.
      </div>
    ` : ''}

    <!-- LOCATION LIST -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span>Locations</span>
        <span style="font-size:12px;color:var(--s-text-dim)">${locations.length} total</span>
      </div>
      <div class="card-body" style="padding:0">
        ${locations.length > 0 ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Address</th>
                  <th>City</th>
                  <th>Country</th>
                  <th>Phone</th>
                  <th>Status</th>
                  <th style="text-align:right">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${locations.map(loc => {
                  const addressParts = [loc.address, loc.city, loc.province, loc.zip].filter(Boolean)
                  return `
                    <tr>
                      <td>
                        <div style="display:flex;align-items:center;gap:6px">
                          <span style="font-weight:600">${esc(loc.name)}</span>
                          ${loc.is_primary ? '<span class="badge badge-info" style="font-size:10px">Primary</span>' : ''}
                        </div>
                      </td>
                      <td style="font-size:13px;color:var(--s-text-dim)">${esc(loc.address || '--')}</td>
                      <td style="font-size:13px">${esc(loc.city || '--')}</td>
                      <td style="font-size:13px">${esc(loc.country || '--')}</td>
                      <td style="font-size:13px;color:var(--s-text-dim)">${esc(loc.phone || '--')}</td>
                      <td>
                        <span class="badge ${loc.active ? 'badge-success' : 'badge-warning'}">${loc.active ? 'Active' : 'Inactive'}</span>
                      </td>
                      <td style="text-align:right">
                        <div style="display:flex;gap:4px;justify-content:flex-end">
                          <a href="${base}/settings/locations?edit=${esc(loc.id)}" class="btn btn-outline btn-sm" style="text-decoration:none;font-size:11px">Edit</a>
                          ${!loc.is_primary ? `
                            <form method="POST" action="${base}/settings/locations/delete" style="display:inline"
                              onsubmit="return confirm('Delete location ${esc(loc.name)}?')">
                              ${csrfField}
                              <input type="hidden" name="location_id" value="${esc(loc.id)}">
                              <button type="submit" class="btn btn-outline btn-sm" style="color:var(--s-danger);border-color:var(--s-danger);font-size:11px">Delete</button>
                            </form>
                          ` : ''}
                        </div>
                      </td>
                    </tr>
                  `
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div style="text-align:center;padding:40px;color:var(--s-text-dim)">
            <div style="font-size:32px;margin-bottom:12px">&#128205;</div>
            <div style="font-weight:600;margin-bottom:4px">No locations</div>
            <div style="font-size:13px">Add your first inventory location below.</div>
          </div>
        `}
      </div>
    </div>

    <!-- EDIT LOCATION (shown when ?edit=id) -->
    ${editLocation ? `
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <span>Edit Location: ${esc(editLocation.name)}</span>
          <a href="${base}/settings/locations" class="btn btn-outline btn-sm" style="text-decoration:none;font-size:11px">Cancel</a>
        </div>
        <div class="card-body">
          <form method="POST" action="${base}/settings/locations/update">
            ${csrfField}
            <input type="hidden" name="location_id" value="${esc(editLocation.id)}">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Name</label>
                <input type="text" name="name" value="${esc(editLocation.name)}" required
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Phone</label>
                <input type="text" name="phone" value="${esc(editLocation.phone || '')}"
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
              </div>
            </div>
            <div style="margin-bottom:16px">
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Address</label>
              <input type="text" name="address" value="${esc(editLocation.address || '')}"
                style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:16px;margin-bottom:16px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">City</label>
                <input type="text" name="city" value="${esc(editLocation.city || '')}"
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Province/State</label>
                <input type="text" name="province" value="${esc(editLocation.province || '')}"
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Country</label>
                <input type="text" name="country" value="${esc(editLocation.country || '')}"
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">ZIP/Postal</label>
                <input type="text" name="zip" value="${esc(editLocation.zip || '')}"
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" name="active" value="true" ${editLocation.active ? 'checked' : ''}
                  style="width:16px;height:16px;accent-color:var(--s-accent)">
                <span style="font-size:13px">Active</span>
              </label>
            </div>
            <button type="submit" class="btn btn-primary">Save Changes</button>
          </form>
        </div>
      </div>
    ` : ''}

    <!-- CREATE LOCATION FORM -->
    <div class="card">
      <div class="card-header">
        <span>Add Location</span>
      </div>
      <div class="card-body">
        <form method="POST" action="${base}/settings/locations/create">
          ${csrfField}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
            <div>
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Location Name</label>
              <input type="text" name="name" placeholder="e.g., Main Warehouse" required
                style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Phone</label>
              <input type="text" name="phone" placeholder="Optional"
                style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
            </div>
          </div>
          <div style="margin-bottom:16px">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Address</label>
            <input type="text" name="address" placeholder="Street address"
              style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:16px;margin-bottom:16px">
            <div>
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">City</label>
              <input type="text" name="city" placeholder="City"
                style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Province/State</label>
              <input type="text" name="province" placeholder="Province"
                style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Country</label>
              <input type="text" name="country" placeholder="Country"
                style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">ZIP/Postal</label>
              <input type="text" name="zip" placeholder="ZIP"
                style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
            </div>
          </div>
          <button type="submit" class="btn btn-primary">Add Location</button>
        </form>
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Locations',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'settings',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ─── POST: Create Location ─────────────────────────────────────

export async function postCreateLocation(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`

  const { name, address, city, province, country, zip, phone } = req.body

  if (!name || !name.trim()) {
    res.redirect(`${base}/settings/locations`)
    return
  }

  // Check if this is the first location (make it primary)
  const existingCount = await db.selectFrom('locations')
    .select(db.fn.count('id').as('count'))
    .where('shop_id', '=', store.id)
    .executeTakeFirst()

  const isPrimary = Number(existingCount?.count ?? 0) === 0

  const location = await db.insertInto('locations')
    .values({
      shop_id: store.id,
      name: name.trim(),
      address: address?.trim() || null,
      city: city?.trim() || null,
      province: province?.trim() || null,
      country: country?.trim() || null,
      zip: zip?.trim() || null,
      phone: phone?.trim() || null,
      is_primary: isPrimary,
      active: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await logSellerAction(db, req, 'create', 'location', location.id, {
    name: name.trim(),
  })

  notify(db, {
    shopId: store.id,
    userId: (req as any).storeUser?.id,
    type: 'location_created',
    title: `Location created: ${name.trim()}`,
    message: byActor((req as any).storeUser),
    resourceType: 'location',
    resourceId: location.id,
  })

  res.redirect(`${base}/settings/locations?saved=1`)
}

// ─── POST: Update Location ─────────────────────────────────────

export async function postUpdateLocation(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`

  const { location_id, name, address, city, province, country, zip, phone, active } = req.body

  if (!location_id || !name?.trim()) {
    res.redirect(`${base}/settings/locations`)
    return
  }

  // Verify location belongs to store
  const existing = await db.selectFrom('locations')
    .select('id')
    .where('id', '=', location_id)
    .where('shop_id', '=', store.id)
    .executeTakeFirst()

  if (!existing) {
    res.redirect(`${base}/settings/locations`)
    return
  }

  await db.updateTable('locations')
    .set({
      name: name.trim(),
      address: address?.trim() || null,
      city: city?.trim() || null,
      province: province?.trim() || null,
      country: country?.trim() || null,
      zip: zip?.trim() || null,
      phone: phone?.trim() || null,
      active: active === 'true',
    })
    .where('id', '=', location_id)
    .where('shop_id', '=', store.id)
    .execute()

  await logSellerAction(db, req, 'update', 'location', location_id, {
    name: name.trim(),
  })

  notify(db, {
    shopId: store.id,
    userId: (req as any).storeUser?.id,
    type: 'location_updated',
    title: `Location updated: ${name.trim()}`,
    message: byActor((req as any).storeUser),
    resourceType: 'location',
    resourceId: location_id,
  })

  res.redirect(`${base}/settings/locations?saved=1`)
}

// ─── POST: Delete Location ─────────────────────────────────────

export async function postDeleteLocation(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`

  const { location_id } = req.body
  if (!location_id) {
    res.redirect(`${base}/settings/locations`)
    return
  }

  // Verify location belongs to store and is not primary
  const existing = await db.selectFrom('locations')
    .select(['id', 'name', 'is_primary'])
    .where('id', '=', location_id)
    .where('shop_id', '=', store.id)
    .executeTakeFirst()

  if (!existing || existing.is_primary) {
    res.redirect(`${base}/settings/locations`)
    return
  }

  await db.deleteFrom('locations')
    .where('id', '=', location_id)
    .where('shop_id', '=', store.id)
    .execute()

  await logSellerAction(db, req, 'delete', 'location', location_id, {
    name: existing.name,
  })

  notify(db, {
    shopId: store.id,
    userId: (req as any).storeUser?.id,
    type: 'location_deleted',
    title: `Location deleted: ${existing.name}`,
    message: byActor((req as any).storeUser),
    resourceType: 'location',
    resourceId: location_id,
  })

  res.redirect(`${base}/settings/locations?deleted=1`)
}
