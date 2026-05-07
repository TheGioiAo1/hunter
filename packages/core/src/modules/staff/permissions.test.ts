import { describe, it, expect } from 'vitest'
import {
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
  STAFF_ROLES,
  isValidPermissionKey,
  isValidStaffRole,
  resolvePermissions,
  staffHasPermission,
  sanitisePermissionList,
  permissionsForRole,
} from './permissions.js'

describe('PERMISSION_CATALOG', () => {
  it('has at least 20 permissions', () => {
    expect(PERMISSION_CATALOG.length).toBeGreaterThanOrEqual(20)
  })
  it('every entry has a {resource}:{action} key', () => {
    for (const p of PERMISSION_CATALOG) {
      expect(p.key).toBe(`${p.resource}:${p.action}`)
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.description.length).toBeGreaterThan(0)
    }
  })
  it('PERMISSION_KEYS is derived in catalog order', () => {
    expect(PERMISSION_KEYS).toEqual(PERMISSION_CATALOG.map((p) => p.key))
  })
  it('no duplicates', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length)
  })
  it('includes the essential settings subdivisions', () => {
    const keys = new Set(PERMISSION_KEYS)
    expect(keys.has('settings:staff')).toBe(true)
    expect(keys.has('settings:billing')).toBe(true)
    expect(keys.has('settings:security')).toBe(true)
    expect(keys.has('settings:alerts')).toBe(true)
  })
  it('includes launch-critical resource:action pairs', () => {
    const keys = new Set(PERMISSION_KEYS)
    expect(keys.has('orders:view')).toBe(true)
    expect(keys.has('orders:manage')).toBe(true)
    expect(keys.has('orders:refund')).toBe(true)
    expect(keys.has('products:manage')).toBe(true)
    expect(keys.has('discounts:manage')).toBe(true)
    expect(keys.has('markets:manage')).toBe(true)
  })
})

describe('isValidPermissionKey', () => {
  it('accepts catalog keys', () => {
    expect(isValidPermissionKey('orders:view')).toBe(true)
    expect(isValidPermissionKey('products:manage')).toBe(true)
  })
  it('rejects unknown keys', () => {
    expect(isValidPermissionKey('orders:delete')).toBe(false)
    expect(isValidPermissionKey('')).toBe(false)
    expect(isValidPermissionKey(42 as any)).toBe(false)
    expect(isValidPermissionKey(null as any)).toBe(false)
  })
})

describe('STAFF_ROLES + isValidStaffRole', () => {
  it('has exactly owner/admin/staff/limited', () => {
    expect(STAFF_ROLES).toEqual(['owner', 'admin', 'staff', 'limited'])
  })
  it('validates role strings', () => {
    expect(isValidStaffRole('owner')).toBe(true)
    expect(isValidStaffRole('admin')).toBe(true)
    expect(isValidStaffRole('staff')).toBe(true)
    expect(isValidStaffRole('limited')).toBe(true)
    expect(isValidStaffRole('superuser')).toBe(false)
    expect(isValidStaffRole(null as any)).toBe(false)
  })
})

describe('resolvePermissions', () => {
  it('owner gets every key in the catalog', () => {
    const out = resolvePermissions('owner', [])
    expect(out.length).toBe(PERMISSION_KEYS.length)
    expect(new Set(out)).toEqual(new Set(PERMISSION_KEYS))
  })
  it('owner ignores overrides', () => {
    const out = resolvePermissions('owner', ['-orders:view'])
    expect(out.includes('orders:view')).toBe(true)
  })
  it('admin gets everything except billing by default', () => {
    const out = resolvePermissions('admin', null)
    expect(out.includes('settings:billing')).toBe(false)
    expect(out.includes('orders:manage')).toBe(true)
    expect(out.includes('settings:staff')).toBe(true)
  })
  it('admin can be granted billing via override', () => {
    const out = resolvePermissions('admin', ['settings:billing'])
    expect(out.includes('settings:billing')).toBe(true)
  })
  it('staff gets the day-to-day template', () => {
    const out = resolvePermissions('staff', null)
    expect(out).toContain('orders:view')
    expect(out).toContain('orders:manage')
    expect(out).toContain('products:manage')
    expect(out).not.toContain('settings:staff')
    expect(out).not.toContain('analytics:view')
  })
  it('staff can have analytics added via override', () => {
    const out = resolvePermissions('staff', ['analytics:view'])
    expect(out).toContain('analytics:view')
  })
  it('staff loses a template permission via negative override', () => {
    const base = resolvePermissions('staff', null)
    expect(base).toContain('inventory:manage')
    const out = resolvePermissions('staff', ['-inventory:manage'])
    expect(out).not.toContain('inventory:manage')
  })
  it('limited gets only home:view by default', () => {
    const out = resolvePermissions('limited', null)
    expect(out).toEqual(['home:view'])
  })
  it('limited can be granted specific perms', () => {
    const out = resolvePermissions('limited', ['orders:view', 'customers:view'])
    expect(out).toContain('home:view')
    expect(out).toContain('orders:view')
    expect(out).toContain('customers:view')
    expect(out.length).toBe(3)
  })
  it('drops unknown overrides silently', () => {
    const out = resolvePermissions('staff', ['not:a:real:key', 'orders:delete'])
    expect(out).not.toContain('not:a:real:key')
    expect(out).not.toContain('orders:delete')
  })
  it('result is sorted + deduped', () => {
    const out = resolvePermissions('limited', ['orders:view', 'orders:view', 'customers:view'])
    expect(out).toEqual([...out].sort())
    expect(new Set(out).size).toBe(out.length)
  })
})

describe('staffHasPermission', () => {
  it('owner always allowed', () => {
    expect(staffHasPermission('owner', [], 'orders:refund')).toBe(true)
    expect(staffHasPermission('owner', null, 'settings:billing')).toBe(true)
  })
  it('returns true when the key is in the resolved list', () => {
    expect(staffHasPermission('staff', ['orders:view'], 'orders:view')).toBe(true)
  })
  it('returns false when key is missing', () => {
    expect(staffHasPermission('staff', ['orders:view'], 'orders:refund')).toBe(false)
  })
  it('returns false when resolved is empty or null', () => {
    expect(staffHasPermission('staff', [], 'orders:view')).toBe(false)
    expect(staffHasPermission('staff', null, 'orders:view')).toBe(false)
  })
})

describe('sanitisePermissionList', () => {
  it('keeps valid keys + negatives, drops unknowns and empties', () => {
    const out = sanitisePermissionList([
      'orders:view',
      '-inventory:manage',
      'not:real',
      '',
      null as any,
      'products:manage',
    ])
    expect(out).toContain('orders:view')
    expect(out).toContain('-inventory:manage')
    expect(out).toContain('products:manage')
    expect(out).not.toContain('not:real')
  })
  it('dedupes + sorts', () => {
    const out = sanitisePermissionList(['orders:view', 'orders:view', 'customers:view'])
    expect(out).toEqual(['customers:view', 'orders:view'])
  })
  it('returns [] for non-array input', () => {
    expect(sanitisePermissionList(null)).toEqual([])
    expect(sanitisePermissionList(undefined)).toEqual([])
    expect(sanitisePermissionList('orders:view' as any)).toEqual([])
  })
})

describe('permissionsForRole', () => {
  it('owner → everything', () => {
    expect(permissionsForRole('owner').length).toBe(PERMISSION_KEYS.length)
  })
  it('admin → catalog minus billing', () => {
    const out = permissionsForRole('admin')
    expect(out).not.toContain('settings:billing')
    expect(out.length).toBe(PERMISSION_KEYS.length - 1)
  })
  it('limited → just home:view', () => {
    expect(permissionsForRole('limited')).toEqual(['home:view'])
  })
})
