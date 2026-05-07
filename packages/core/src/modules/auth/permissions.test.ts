/**
 * Gbox Platform — Permission Catalog Tests (Phase 7.2)
 *
 * Locks down the action → minimum-level mapping. Anyone changing the
 * catalog has to update both the table and the test that asserts it,
 * which makes "oops I accidentally let staff delete shops" extremely
 * hard to ship.
 */

import { describe, it, expect } from 'vitest'
import {
  AdminLevel,
} from './admin-levels.js'
import {
  PERMISSIONS,
  permissionMinLevel,
  canPerform,
  type Permission,
} from './permissions.js'

// ---------------------------------------------------------------------------
// Catalog shape
// ---------------------------------------------------------------------------

describe('PERMISSIONS catalog', () => {
  it('declares every permission with a numeric level', () => {
    for (const [name, level] of Object.entries(PERMISSIONS)) {
      expect(typeof level).toBe('number')
      expect(level).toBeGreaterThanOrEqual(AdminLevel.GOD_ADMIN)
      expect(level).toBeLessThanOrEqual(AdminLevel.STORE_STAFF)
      expect(name.length).toBeGreaterThan(0)
    }
  })

  it('locks platform-only actions to GOD_ADMIN or PLATFORM_ADMIN', () => {
    expect(PERMISSIONS['platform.delete_shop']).toBe(AdminLevel.GOD_ADMIN)
    expect(PERMISSIONS['platform.manage_billing']).toBe(AdminLevel.GOD_ADMIN)
    expect(PERMISSIONS['platform.create_admin']).toBe(AdminLevel.GOD_ADMIN)
    expect(PERMISSIONS['platform.view_all_shops']).toBe(
      AdminLevel.PLATFORM_ADMIN,
    )
  })

  it('locks store-fatal actions to STORE_OWNER+', () => {
    expect(PERMISSIONS['shop.delete']).toBe(AdminLevel.STORE_OWNER)
    expect(PERMISSIONS['shop.transfer_ownership']).toBe(
      AdminLevel.STORE_OWNER,
    )
    expect(PERMISSIONS['shop.manage_billing']).toBe(AdminLevel.STORE_OWNER)
  })

  it('locks structural actions to STORE_ADMIN+', () => {
    expect(PERMISSIONS['shop.invite_staff']).toBe(AdminLevel.STORE_ADMIN)
    expect(PERMISSIONS['shop.manage_domain']).toBe(AdminLevel.STORE_ADMIN)
    expect(PERMISSIONS['shop.publish_theme']).toBe(AdminLevel.STORE_ADMIN)
  })

  it('opens routine actions to STORE_STAFF+', () => {
    expect(PERMISSIONS['shop.view_orders']).toBe(AdminLevel.STORE_STAFF)
    expect(PERMISSIONS['shop.manage_products']).toBe(AdminLevel.STORE_STAFF)
    expect(PERMISSIONS['shop.fulfill_order']).toBe(AdminLevel.STORE_STAFF)
  })
})

// ---------------------------------------------------------------------------
// permissionMinLevel
// ---------------------------------------------------------------------------

describe('permissionMinLevel', () => {
  it('returns the level for a known permission', () => {
    expect(permissionMinLevel('shop.delete')).toBe(AdminLevel.STORE_OWNER)
  })

  it('throws on an unknown permission (catches typos at boot time)', () => {
    expect(() =>
      permissionMinLevel('shop.does_not_exist' as Permission),
    ).toThrow(/unknown permission/i)
  })
})

// ---------------------------------------------------------------------------
// canPerform
// ---------------------------------------------------------------------------

describe('canPerform', () => {
  it('lets a god admin do everything', () => {
    const ctx = { isDefaultAdmin: true, userRole: 'owner', shopRole: null }
    for (const perm of Object.keys(PERMISSIONS) as Permission[]) {
      expect(canPerform(ctx, perm)).toBe(true)
    }
  })

  it('lets a platform admin manage AND delete shops, but NOT platform-tier god-only actions', () => {
    // Platform admin sits at level 1 — strictly more privileged
    // than store owner (2). They inherit every shop-tier action.
    const ctx = {
      isDefaultAdmin: false,
      userRole: 'admin',
      shopRole: null,
    }
    expect(canPerform(ctx, 'platform.view_all_shops')).toBe(true)
    expect(canPerform(ctx, 'shop.invite_staff')).toBe(true)
    expect(canPerform(ctx, 'shop.delete')).toBe(true)
    // …but god-admin-only platform actions remain off-limits.
    expect(canPerform(ctx, 'platform.delete_shop')).toBe(false)
    expect(canPerform(ctx, 'platform.create_admin')).toBe(false)
    expect(canPerform(ctx, 'platform.manage_billing')).toBe(false)
  })

  it('lets a store owner delete their own shop', () => {
    // userRole MUST be a non-platform value here ('staff') so the
    // shopRole='owner' is what determines the level. A user with
    // users.role='owner' would resolve to PLATFORM_ADMIN regardless
    // of shop context.
    const ctx = {
      isDefaultAdmin: false,
      userRole: 'staff',
      shopRole: 'owner',
    }
    expect(canPerform(ctx, 'shop.delete')).toBe(true)
    expect(canPerform(ctx, 'shop.transfer_ownership')).toBe(true)
    // …but cannot touch platform-tier actions.
    expect(canPerform(ctx, 'platform.delete_shop')).toBe(false)
    expect(canPerform(ctx, 'platform.view_all_shops')).toBe(false)
  })

  it('refuses store-fatal actions for store admin', () => {
    const ctx = {
      isDefaultAdmin: false,
      userRole: 'staff',
      shopRole: 'admin',
    }
    expect(canPerform(ctx, 'shop.invite_staff')).toBe(true)
    expect(canPerform(ctx, 'shop.delete')).toBe(false)
    expect(canPerform(ctx, 'shop.transfer_ownership')).toBe(false)
  })

  it('lets store staff handle routine work but nothing structural', () => {
    const ctx = {
      isDefaultAdmin: false,
      userRole: 'staff',
      shopRole: 'staff',
    }
    expect(canPerform(ctx, 'shop.view_orders')).toBe(true)
    expect(canPerform(ctx, 'shop.fulfill_order')).toBe(true)
    expect(canPerform(ctx, 'shop.manage_products')).toBe(true)
    expect(canPerform(ctx, 'shop.invite_staff')).toBe(false)
    expect(canPerform(ctx, 'shop.publish_theme')).toBe(false)
  })

  it('refuses everything for an anonymous user', () => {
    const ctx = { isDefaultAdmin: false, userRole: null, shopRole: null }
    expect(canPerform(ctx, 'shop.view_orders')).toBe(false)
    expect(canPerform(ctx, 'platform.view_all_shops')).toBe(false)
  })
})
