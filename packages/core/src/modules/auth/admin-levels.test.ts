/**
 * Gbox Platform — Admin Level Hierarchy Tests (Phase 0 Step 0.1)
 *
 * Exhaustive coverage for resolveAdminLevel + predicates. This is the
 * single source of truth for CLAUDE.md Rule 2 (6-level admin
 * hierarchy), so every branch needs a test.
 *
 * Run:
 *   npx vitest run packages/core/src/modules/auth/admin-levels.test.ts
 */

import { describe, expect, it } from 'vitest'

import {
  AdminLevel,
  ADMIN_LEVEL_NAMES,
  describeAdminLevel,
  hasAtLeastLevel,
  isGodAdmin,
  isMerchant,
  resolveAdminLevel,
  type AdminLevelInput,
} from './admin-levels.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const god: AdminLevelInput = {
  userRole: 'owner',
  isDefaultAdmin: true,
  shopRole: null,
}

const platformOwner: AdminLevelInput = {
  userRole: 'owner',
  isDefaultAdmin: false,
  shopRole: null,
}

const platformAdmin: AdminLevelInput = {
  userRole: 'admin',
  isDefaultAdmin: false,
  shopRole: null,
}

const storeOwner: AdminLevelInput = {
  userRole: 'user', // or any non-platform role
  isDefaultAdmin: false,
  shopRole: 'owner',
}

const storeAdmin: AdminLevelInput = {
  userRole: null,
  isDefaultAdmin: false,
  shopRole: 'admin',
}

const storeStaff: AdminLevelInput = {
  userRole: null,
  isDefaultAdmin: false,
  shopRole: 'staff',
}

const storeLimitedStaff: AdminLevelInput = {
  userRole: null,
  isDefaultAdmin: false,
  shopRole: 'limited',
}

const customer: AdminLevelInput = {
  userRole: null,
  isDefaultAdmin: false,
  shopRole: null,
}

// ---------------------------------------------------------------------------
// resolveAdminLevel — happy path per level
// ---------------------------------------------------------------------------

describe('resolveAdminLevel — happy path', () => {
  it('is_default_admin=true → GOD_ADMIN', () => {
    expect(resolveAdminLevel(god)).toBe(AdminLevel.GOD_ADMIN)
  })

  it('platform owner (is_default_admin=false) → PLATFORM_ADMIN', () => {
    expect(resolveAdminLevel(platformOwner)).toBe(AdminLevel.PLATFORM_ADMIN)
  })

  it("users.role='admin' → PLATFORM_ADMIN", () => {
    expect(resolveAdminLevel(platformAdmin)).toBe(AdminLevel.PLATFORM_ADMIN)
  })

  it("user_shops.role='owner' → STORE_OWNER", () => {
    expect(resolveAdminLevel(storeOwner)).toBe(AdminLevel.STORE_OWNER)
  })

  it("user_shops.role='admin' → STORE_ADMIN", () => {
    expect(resolveAdminLevel(storeAdmin)).toBe(AdminLevel.STORE_ADMIN)
  })

  it("user_shops.role='staff' → STORE_STAFF", () => {
    expect(resolveAdminLevel(storeStaff)).toBe(AdminLevel.STORE_STAFF)
  })

  it("user_shops.role='limited' → STORE_STAFF (same tier)", () => {
    expect(resolveAdminLevel(storeLimitedStaff)).toBe(AdminLevel.STORE_STAFF)
  })

  it('nothing set → CUSTOMER', () => {
    expect(resolveAdminLevel(customer)).toBe(AdminLevel.CUSTOMER)
  })
})

// ---------------------------------------------------------------------------
// Normalization — case, whitespace, nulls
// ---------------------------------------------------------------------------

describe('resolveAdminLevel — normalization', () => {
  it('is case-insensitive on userRole', () => {
    expect(
      resolveAdminLevel({ userRole: 'OWNER', isDefaultAdmin: false }),
    ).toBe(AdminLevel.PLATFORM_ADMIN)
    expect(
      resolveAdminLevel({ userRole: 'Admin', isDefaultAdmin: false }),
    ).toBe(AdminLevel.PLATFORM_ADMIN)
  })

  it('is case-insensitive on shopRole', () => {
    expect(
      resolveAdminLevel({
        userRole: null,
        isDefaultAdmin: false,
        shopRole: 'Owner',
      }),
    ).toBe(AdminLevel.STORE_OWNER)
    expect(
      resolveAdminLevel({
        userRole: null,
        isDefaultAdmin: false,
        shopRole: 'STAFF',
      }),
    ).toBe(AdminLevel.STORE_STAFF)
  })

  it('trims whitespace around role strings', () => {
    expect(
      resolveAdminLevel({ userRole: '  admin  ', isDefaultAdmin: false }),
    ).toBe(AdminLevel.PLATFORM_ADMIN)
    expect(
      resolveAdminLevel({
        userRole: null,
        isDefaultAdmin: false,
        shopRole: '\towner\n',
      }),
    ).toBe(AdminLevel.STORE_OWNER)
  })

  it('treats null / undefined roles as customer', () => {
    expect(
      resolveAdminLevel({ userRole: null, isDefaultAdmin: null }),
    ).toBe(AdminLevel.CUSTOMER)
    expect(
      resolveAdminLevel({ userRole: undefined, isDefaultAdmin: undefined }),
    ).toBe(AdminLevel.CUSTOMER)
  })

  it('empty string userRole with no shop role → CUSTOMER', () => {
    expect(
      resolveAdminLevel({ userRole: '', isDefaultAdmin: false }),
    ).toBe(AdminLevel.CUSTOMER)
  })

  it('unknown userRole string falls through to per-shop check', () => {
    expect(
      resolveAdminLevel({
        userRole: 'intern',
        isDefaultAdmin: false,
        shopRole: 'admin',
      }),
    ).toBe(AdminLevel.STORE_ADMIN)
  })

  it('unknown userRole AND unknown shopRole → CUSTOMER', () => {
    expect(
      resolveAdminLevel({
        userRole: 'ghost',
        isDefaultAdmin: false,
        shopRole: 'phantom',
      }),
    ).toBe(AdminLevel.CUSTOMER)
  })

  it('resolves undefined input to CUSTOMER (defensive)', () => {
    expect(resolveAdminLevel(undefined as unknown as AdminLevelInput)).toBe(
      AdminLevel.CUSTOMER,
    )
  })
})

// ---------------------------------------------------------------------------
// Precedence — higher tier always wins
// ---------------------------------------------------------------------------

describe('resolveAdminLevel — precedence rules', () => {
  it('God Admin beats any per-shop role (even store staff)', () => {
    expect(
      resolveAdminLevel({
        userRole: 'owner',
        isDefaultAdmin: true,
        shopRole: 'staff', // would be a demotion
      }),
    ).toBe(AdminLevel.GOD_ADMIN)
  })

  it('Platform Admin beats per-shop role', () => {
    expect(
      resolveAdminLevel({
        userRole: 'admin',
        isDefaultAdmin: false,
        shopRole: 'limited',
      }),
    ).toBe(AdminLevel.PLATFORM_ADMIN)
  })

  it("user_shops.role='owner' beats user_shops.role='admin' ordering", () => {
    // Not a precedence conflict — just verify the two levels differ.
    expect(resolveAdminLevel(storeOwner)).toBeLessThan(
      resolveAdminLevel(storeAdmin),
    )
  })
})

// ---------------------------------------------------------------------------
// hasAtLeastLevel — universal gate
// ---------------------------------------------------------------------------

describe('hasAtLeastLevel', () => {
  it('God Admin satisfies every requirement', () => {
    expect(hasAtLeastLevel(god, AdminLevel.GOD_ADMIN)).toBe(true)
    expect(hasAtLeastLevel(god, AdminLevel.PLATFORM_ADMIN)).toBe(true)
    expect(hasAtLeastLevel(god, AdminLevel.STORE_OWNER)).toBe(true)
    expect(hasAtLeastLevel(god, AdminLevel.STORE_ADMIN)).toBe(true)
    expect(hasAtLeastLevel(god, AdminLevel.STORE_STAFF)).toBe(true)
    expect(hasAtLeastLevel(god, AdminLevel.CUSTOMER)).toBe(true)
  })

  it('Store Staff fails GOD_ADMIN / PLATFORM_ADMIN / STORE_OWNER / STORE_ADMIN gates', () => {
    expect(hasAtLeastLevel(storeStaff, AdminLevel.GOD_ADMIN)).toBe(false)
    expect(hasAtLeastLevel(storeStaff, AdminLevel.PLATFORM_ADMIN)).toBe(false)
    expect(hasAtLeastLevel(storeStaff, AdminLevel.STORE_OWNER)).toBe(false)
    expect(hasAtLeastLevel(storeStaff, AdminLevel.STORE_ADMIN)).toBe(false)
  })

  it('Store Staff passes STORE_STAFF + CUSTOMER gates', () => {
    expect(hasAtLeastLevel(storeStaff, AdminLevel.STORE_STAFF)).toBe(true)
    expect(hasAtLeastLevel(storeStaff, AdminLevel.CUSTOMER)).toBe(true)
  })

  it('Customer fails every merchant gate', () => {
    expect(hasAtLeastLevel(customer, AdminLevel.STORE_STAFF)).toBe(false)
    expect(hasAtLeastLevel(customer, AdminLevel.STORE_ADMIN)).toBe(false)
    expect(hasAtLeastLevel(customer, AdminLevel.STORE_OWNER)).toBe(false)
    expect(hasAtLeastLevel(customer, AdminLevel.PLATFORM_ADMIN)).toBe(false)
    expect(hasAtLeastLevel(customer, AdminLevel.GOD_ADMIN)).toBe(false)
  })

  it('Store Owner satisfies STORE_OWNER but NOT PLATFORM_ADMIN', () => {
    expect(hasAtLeastLevel(storeOwner, AdminLevel.STORE_OWNER)).toBe(true)
    expect(hasAtLeastLevel(storeOwner, AdminLevel.PLATFORM_ADMIN)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isMerchant / isGodAdmin / describeAdminLevel
// ---------------------------------------------------------------------------

describe('isMerchant', () => {
  it('returns true for every merchant level', () => {
    expect(isMerchant(god)).toBe(true)
    expect(isMerchant(platformAdmin)).toBe(true)
    expect(isMerchant(storeOwner)).toBe(true)
    expect(isMerchant(storeAdmin)).toBe(true)
    expect(isMerchant(storeStaff)).toBe(true)
    expect(isMerchant(storeLimitedStaff)).toBe(true)
  })

  it('returns false for customers', () => {
    expect(isMerchant(customer)).toBe(false)
  })
})

describe('isGodAdmin', () => {
  it('returns true ONLY for the default God Admin', () => {
    expect(isGodAdmin(god)).toBe(true)
    expect(isGodAdmin(platformAdmin)).toBe(false)
    expect(isGodAdmin(platformOwner)).toBe(false)
    expect(isGodAdmin(storeOwner)).toBe(false)
    expect(isGodAdmin(customer)).toBe(false)
  })

  it('ignores the shopRole column entirely', () => {
    // Even a non-default "owner" with shopRole=owner is NOT God Admin.
    expect(isGodAdmin({
      userRole: 'owner',
      isDefaultAdmin: false,
      shopRole: 'owner',
    })).toBe(false)
  })
})

describe('describeAdminLevel', () => {
  it('returns the human-friendly name for every level', () => {
    expect(describeAdminLevel(god)).toBe('God Admin')
    expect(describeAdminLevel(platformAdmin)).toBe('Platform Admin')
    expect(describeAdminLevel(storeOwner)).toBe('Store Owner')
    expect(describeAdminLevel(storeAdmin)).toBe('Store Admin')
    expect(describeAdminLevel(storeStaff)).toBe('Store Staff')
    expect(describeAdminLevel(storeLimitedStaff)).toBe('Store Staff')
    expect(describeAdminLevel(customer)).toBe('Customer')
  })

  it('matches the exported names map exactly', () => {
    for (const level of Object.values(AdminLevel)) {
      if (typeof level !== 'number') continue
      expect(ADMIN_LEVEL_NAMES[level as AdminLevel]).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// Enum ordering sanity — the whole module depends on this
// ---------------------------------------------------------------------------

describe('AdminLevel enum ordering', () => {
  it('is strictly ascending from most to least privileged', () => {
    expect(AdminLevel.GOD_ADMIN).toBe(0)
    expect(AdminLevel.PLATFORM_ADMIN).toBe(1)
    expect(AdminLevel.STORE_OWNER).toBe(2)
    expect(AdminLevel.STORE_ADMIN).toBe(3)
    expect(AdminLevel.STORE_STAFF).toBe(4)
    expect(AdminLevel.CUSTOMER).toBe(5)
  })

  it('smaller number means more privileged (gate invariant)', () => {
    expect(AdminLevel.GOD_ADMIN).toBeLessThan(AdminLevel.PLATFORM_ADMIN)
    expect(AdminLevel.PLATFORM_ADMIN).toBeLessThan(AdminLevel.STORE_OWNER)
    expect(AdminLevel.STORE_OWNER).toBeLessThan(AdminLevel.STORE_ADMIN)
    expect(AdminLevel.STORE_ADMIN).toBeLessThan(AdminLevel.STORE_STAFF)
    expect(AdminLevel.STORE_STAFF).toBeLessThan(AdminLevel.CUSTOMER)
  })
})
