/**
 * Gbox Platform — requireLevel Middleware Tests (Phase 0 Step 0.8)
 *
 * Exhaustive coverage for the Express middleware factory that gates
 * routes on CLAUDE.md Rule 2's 6-level hierarchy. Uses vi.mock() to
 * stub the session module and a hand-rolled chainable fake for Kysely
 * so these tests need no Postgres, no Redis, and no Express app.
 *
 * Run:
 *   npx vitest run packages/core/src/modules/auth/require-level.test.ts
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the module under test.
// ---------------------------------------------------------------------------

vi.mock('./session.js', () => {
  return {
    getSessionTokenFromCookies: vi.fn(),
    validateSession: vi.fn(),
  }
})

import { AdminLevel } from './admin-levels.js'
import { requireLevel } from './require-level.js'
import {
  getSessionTokenFromCookies,
  validateSession,
} from './session.js'

const getSessionTokenFromCookiesMock = getSessionTokenFromCookies as unknown as Mock
const validateSessionMock = validateSession as unknown as Mock

// ---------------------------------------------------------------------------
// Fake Kysely — scripted results keyed by the first .where() column value.
// ---------------------------------------------------------------------------

/**
 * Per-table scripts. Each entry is a queue of `executeTakeFirst`
 * results; the fake pops one off the front for every `selectFrom(table)`
 * call so tests can assert the exact sequence of lookups.
 */
interface Script {
  users?: unknown[]
  shops?: unknown[]
  user_shops?: unknown[]
}

function createFakeDb(script: Script) {
  // Copy so we can mutate (shift) without affecting the test's script.
  const queues: Record<keyof Script, unknown[]> = {
    users: [...(script.users ?? [])],
    shops: [...(script.shops ?? [])],
    user_shops: [...(script.user_shops ?? [])],
  }

  const calls: Array<{ table: keyof Script; wheres: Array<[string, string, unknown]> }> = []

  const selectFrom = vi.fn((table: keyof Script) => {
    const entry = { table, wheres: [] as Array<[string, string, unknown]> }
    calls.push(entry)

    const builder: any = {
      select: vi.fn(() => builder),
      where: vi.fn((col: string, op: string, val: unknown) => {
        entry.wheres.push([col, op, val])
        return builder
      }),
      executeTakeFirst: vi.fn(async () => {
        const queue = queues[table]
        if (!queue) return undefined
        // If only a single value scripted, reuse it for every call on
        // that table (common case for the users row).
        return queue.length === 1 ? queue[0] : queue.shift()
      }),
      execute: vi.fn(async () => {
        const queue = queues[table] ?? []
        return queue
      }),
    }
    return builder
  })

  const db: any = { selectFrom }
  return { db, calls, selectFrom }
}

// ---------------------------------------------------------------------------
// Express stubs
// ---------------------------------------------------------------------------

function makeReq(overrides: Record<string, unknown> = {}): any {
  return {
    headers: { cookie: 'gbox_session=abc' },
    params: {},
    originalUrl: '/admin/orders',
    url: '/admin/orders',
    ...overrides,
  }
}

function makeRes() {
  const res: any = {}
  res.statusCode = 200
  res.status = vi.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.type = vi.fn(() => res)
  res.send = vi.fn((body: unknown) => {
    res.body = body
    return res
  })
  res.redirect = vi.fn((target: string) => {
    res.redirectTarget = target
    return res
  })
  return res
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GOD_USER = {
  id: 'u-god',
  email: 'god@gbox.co',
  name: 'God Admin',
  role: 'owner',
  avatarUrl: null,
}

const PLATFORM_ADMIN_USER = {
  id: 'u-platform',
  email: 'platform@gbox.co',
  name: 'Platform',
  role: 'admin',
  avatarUrl: null,
}

const MERCHANT_USER = {
  id: 'u-merchant',
  email: 'merchant@example.com',
  name: 'Merchant',
  role: 'staff',
  avatarUrl: null,
}

function makeSession(user: typeof GOD_USER) {
  return {
    user,
    shopId: null,
    shopRole: null,
    createdAt: '2024-01-01T00:00:00Z',
    expiresAt: '2024-02-01T00:00:00Z',
  }
}

function okSession(user: typeof GOD_USER) {
  return { valid: true, session: makeSession(user), token: 'abc' }
}

// ---------------------------------------------------------------------------
// Setup — reset mocks between tests so call counts and return values
// never leak across cases.
// ---------------------------------------------------------------------------

beforeEach(() => {
  getSessionTokenFromCookiesMock.mockReset()
  validateSessionMock.mockReset()
  // Sensible defaults — most tests have a valid token in the cookie.
  getSessionTokenFromCookiesMock.mockImplementation((cookie: string) => {
    if (!cookie) return null
    const match = cookie.match(/gbox_session=([^;]+)/)
    return match ? match[1] : null
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Unauthenticated paths
// ---------------------------------------------------------------------------

describe('requireLevel — unauthenticated', () => {
  it('redirects to /accounts/login when cookie is missing', async () => {
    const { db } = createFakeDb({})
    const mw = requireLevel(db, { minimum: AdminLevel.STORE_STAFF })
    const req = makeReq({ headers: { cookie: '' }, originalUrl: '/foo' })
    const res = makeRes()
    const next = vi.fn()

    await mw(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.redirect).toHaveBeenCalledWith(
      '/accounts/login?return_to=%2Ffoo',
    )
    expect(validateSessionMock).not.toHaveBeenCalled()
  })

  it('redirects when the session token fails to validate', async () => {
    const { db } = createFakeDb({})
    validateSessionMock.mockResolvedValue({ valid: false, session: null, token: null })

    const mw = requireLevel(db, { minimum: AdminLevel.STORE_STAFF })
    const req = makeReq({ originalUrl: '/dash' })
    const res = makeRes()
    const next = vi.fn()

    await mw(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.redirect).toHaveBeenCalledWith(
      '/accounts/login?return_to=%2Fdash',
    )
  })

  it('invokes a custom onUnauthenticated handler when provided', async () => {
    const { db } = createFakeDb({})
    const customHandler = vi.fn((_req: any, res: any) => {
      res.status(401).send({ error: 'unauthenticated' })
    })
    const mw = requireLevel(db, {
      minimum: AdminLevel.STORE_STAFF,
      onUnauthenticated: customHandler,
    })
    const req = makeReq({ headers: { cookie: '' } })
    const res = makeRes()
    const next = vi.fn()

    await mw(req, res, next)

    expect(customHandler).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('escapes the return_to value so ampersands survive redirect', async () => {
    const { db } = createFakeDb({})
    const mw = requireLevel(db, { minimum: AdminLevel.STORE_STAFF })
    const req = makeReq({
      headers: { cookie: '' },
      originalUrl: '/search?q=shoes&sort=price',
    })
    const res = makeRes()
    await mw(req, res, vi.fn())

    expect(res.redirectTarget).toContain('%3Fq%3Dshoes%26sort%3Dprice')
  })
})

// ---------------------------------------------------------------------------
// God Admin (level 0) path
// ---------------------------------------------------------------------------

describe('requireLevel — God Admin', () => {
  it('lets the seeded God Admin through every gate', async () => {
    for (const level of [
      AdminLevel.GOD_ADMIN,
      AdminLevel.PLATFORM_ADMIN,
      AdminLevel.STORE_OWNER,
      AdminLevel.STORE_ADMIN,
      AdminLevel.STORE_STAFF,
      AdminLevel.CUSTOMER,
    ]) {
      const { db } = createFakeDb({
        users: [{ is_default_admin: true }],
      })
      validateSessionMock.mockResolvedValue(okSession(GOD_USER))

      const mw = requireLevel(db, { minimum: level })
      const req = makeReq()
      const res = makeRes()
      const next = vi.fn()

      await mw(req, res, next)

      expect(next).toHaveBeenCalledOnce()
      expect(req.auth.level).toBe(AdminLevel.GOD_ADMIN)
      expect(req.auth.levelLabel).toBe('God Admin')
      expect(req.auth.isDefaultAdmin).toBe(true)
      expect(res.status).not.toHaveBeenCalled()
    }
  })

  it('attaches the full session user on success', async () => {
    const { db } = createFakeDb({ users: [{ is_default_admin: true }] })
    validateSessionMock.mockResolvedValue(okSession(GOD_USER))

    const mw = requireLevel(db, { minimum: AdminLevel.GOD_ADMIN })
    const req = makeReq()
    const res = makeRes()
    await mw(req, res, vi.fn())

    expect(req.auth.user.email).toBe('god@gbox.co')
    expect(req.auth.session.user.email).toBe('god@gbox.co')
  })
})

// ---------------------------------------------------------------------------
// Platform Admin (level 1) path — role='owner'|'admin' with is_default_admin=false
// ---------------------------------------------------------------------------

describe('requireLevel — Platform Admin', () => {
  it('passes GOD_ADMIN gate? NO — platform admin is level 1', async () => {
    const { db } = createFakeDb({ users: [{ is_default_admin: false }] })
    validateSessionMock.mockResolvedValue(okSession(PLATFORM_ADMIN_USER))

    const mw = requireLevel(db, { minimum: AdminLevel.GOD_ADMIN })
    const req = makeReq()
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('passes PLATFORM_ADMIN gate for role=admin (non-default)', async () => {
    const { db } = createFakeDb({ users: [{ is_default_admin: false }] })
    validateSessionMock.mockResolvedValue(okSession(PLATFORM_ADMIN_USER))

    const mw = requireLevel(db, { minimum: AdminLevel.PLATFORM_ADMIN })
    const req = makeReq()
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.auth.level).toBe(AdminLevel.PLATFORM_ADMIN)
    expect(req.auth.levelLabel).toBe('Platform Admin')
    expect(req.auth.isDefaultAdmin).toBe(false)
  })

  it("passes PLATFORM_ADMIN gate for role=owner with is_default_admin=false", async () => {
    const { db } = createFakeDb({ users: [{ is_default_admin: false }] })
    validateSessionMock.mockResolvedValue(okSession({ ...GOD_USER, id: 'u-po' }))

    const mw = requireLevel(db, { minimum: AdminLevel.PLATFORM_ADMIN })
    const req = makeReq()
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.auth.level).toBe(AdminLevel.PLATFORM_ADMIN)
  })

  it('platform admins bypass the shop membership check', async () => {
    const { db, calls } = createFakeDb({
      users: [{ is_default_admin: false }],
      shops: [
        {
          id: 'shop-1',
          name: 'Acme',
          slug: 'acme',
          domain: null,
          status: 'active',
        },
      ],
      // Note: NO user_shops row scripted — if the middleware queried it
      // the executeTakeFirst would return undefined, which
      // resolveAdminLevel would reject, but PlatformAdmin should win
      // before the per-shop gate matters.
      user_shops: [],
    })
    validateSessionMock.mockResolvedValue(okSession(PLATFORM_ADMIN_USER))

    const mw = requireLevel(db, {
      minimum: AdminLevel.STORE_ADMIN,
      shopSlugParam: 'slug',
    })
    const req = makeReq({ params: { slug: 'acme' } })
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.auth.level).toBe(AdminLevel.PLATFORM_ADMIN)
    expect(req.auth.shop?.id).toBe('shop-1')
    // Shop was still loaded (middleware attaches it), and user_shops
    // was also queried — the bypass is at level-resolution time, not
    // query time.
    const tables = calls.map((c) => c.table)
    expect(tables).toContain('shops')
    expect(tables).toContain('user_shops')
  })
})

// ---------------------------------------------------------------------------
// Shop-scoped (merchant) paths
// ---------------------------------------------------------------------------

describe('requireLevel — shop-scoped', () => {
  it('404s when the slug does not resolve to a shop', async () => {
    const { db } = createFakeDb({
      users: [{ is_default_admin: false }],
      shops: [undefined], // no shop found
    })
    validateSessionMock.mockResolvedValue(okSession(MERCHANT_USER))

    const mw = requireLevel(db, {
      minimum: AdminLevel.STORE_STAFF,
      shopSlugParam: 'slug',
    })
    const req = makeReq({ params: { slug: 'ghost' } })
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.send).toHaveBeenCalled()
  })

  it('forbids a user with no user_shops row', async () => {
    const { db } = createFakeDb({
      users: [{ is_default_admin: false }],
      shops: [
        { id: 's1', name: 'Acme', slug: 'acme', domain: null, status: 'active' },
      ],
      user_shops: [undefined],
    })
    validateSessionMock.mockResolvedValue(okSession(MERCHANT_USER))

    const mw = requireLevel(db, {
      minimum: AdminLevel.STORE_STAFF,
      shopSlugParam: 'slug',
    })
    const req = makeReq({ params: { slug: 'acme' } })
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('allows a Store Staff user when STORE_STAFF is required', async () => {
    const { db } = createFakeDb({
      users: [{ is_default_admin: false }],
      shops: [
        { id: 's1', name: 'Acme', slug: 'acme', domain: null, status: 'active' },
      ],
      user_shops: [{ role: 'staff' }],
    })
    validateSessionMock.mockResolvedValue(okSession(MERCHANT_USER))

    const mw = requireLevel(db, {
      minimum: AdminLevel.STORE_STAFF,
      shopSlugParam: 'slug',
    })
    const req = makeReq({ params: { slug: 'acme' } })
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.auth.level).toBe(AdminLevel.STORE_STAFF)
    expect(req.auth.shopRole).toBe('staff')
    expect(req.auth.shop?.slug).toBe('acme')
  })

  it('forbids a Store Staff user when STORE_ADMIN is required', async () => {
    const { db } = createFakeDb({
      users: [{ is_default_admin: false }],
      shops: [
        { id: 's1', name: 'Acme', slug: 'acme', domain: null, status: 'active' },
      ],
      user_shops: [{ role: 'staff' }],
    })
    validateSessionMock.mockResolvedValue(okSession(MERCHANT_USER))

    const mw = requireLevel(db, {
      minimum: AdminLevel.STORE_ADMIN,
      shopSlugParam: 'slug',
    })
    const req = makeReq({ params: { slug: 'acme' } })
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('allows a Store Admin user when STORE_ADMIN is required', async () => {
    const { db } = createFakeDb({
      users: [{ is_default_admin: false }],
      shops: [
        { id: 's1', name: 'Acme', slug: 'acme', domain: null, status: 'active' },
      ],
      user_shops: [{ role: 'admin' }],
    })
    validateSessionMock.mockResolvedValue(okSession(MERCHANT_USER))

    const mw = requireLevel(db, {
      minimum: AdminLevel.STORE_ADMIN,
      shopSlugParam: 'slug',
    })
    const req = makeReq({ params: { slug: 'acme' } })
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.auth.level).toBe(AdminLevel.STORE_ADMIN)
    expect(req.auth.shopRole).toBe('admin')
  })

  it('allows a Store Owner user when STORE_OWNER is required', async () => {
    const { db } = createFakeDb({
      users: [{ is_default_admin: false }],
      shops: [
        { id: 's1', name: 'Acme', slug: 'acme', domain: null, status: 'active' },
      ],
      user_shops: [{ role: 'owner' }],
    })
    validateSessionMock.mockResolvedValue(okSession(MERCHANT_USER))

    const mw = requireLevel(db, {
      minimum: AdminLevel.STORE_OWNER,
      shopSlugParam: 'slug',
    })
    const req = makeReq({ params: { slug: 'acme' } })
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.auth.level).toBe(AdminLevel.STORE_OWNER)
  })

  it("maps shop role 'limited' to STORE_STAFF", async () => {
    const { db } = createFakeDb({
      users: [{ is_default_admin: false }],
      shops: [
        { id: 's1', name: 'Acme', slug: 'acme', domain: null, status: 'active' },
      ],
      user_shops: [{ role: 'limited' }],
    })
    validateSessionMock.mockResolvedValue(okSession(MERCHANT_USER))

    const mw = requireLevel(db, {
      minimum: AdminLevel.STORE_STAFF,
      shopSlugParam: 'slug',
    })
    const req = makeReq({ params: { slug: 'acme' } })
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.auth.level).toBe(AdminLevel.STORE_STAFF)
    expect(req.auth.shopRole).toBe('limited')
  })

  it('skips shop lookup when shopSlugParam is unset even if req.params has slug', async () => {
    const { db, calls } = createFakeDb({
      users: [{ is_default_admin: true }],
    })
    validateSessionMock.mockResolvedValue(okSession(GOD_USER))

    const mw = requireLevel(db, { minimum: AdminLevel.GOD_ADMIN })
    // Even though params.slug is present, the factory wasn't told to
    // read it, so no shop query should fire.
    const req = makeReq({ params: { slug: 'acme' } })
    const res = makeRes()
    await mw(req, res, vi.fn())

    const tables = calls.map((c) => c.table)
    expect(tables).toContain('users')
    expect(tables).not.toContain('shops')
    expect(tables).not.toContain('user_shops')
  })

  it('skips shop lookup when the named slug param is empty', async () => {
    const { db, calls } = createFakeDb({
      users: [{ is_default_admin: false }],
    })
    validateSessionMock.mockResolvedValue(okSession(PLATFORM_ADMIN_USER))

    const mw = requireLevel(db, {
      minimum: AdminLevel.PLATFORM_ADMIN,
      shopSlugParam: 'slug',
    })
    const req = makeReq({ params: { slug: '' } })
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    const tables = calls.map((c) => c.table)
    expect(tables).not.toContain('shops')
  })
})

// ---------------------------------------------------------------------------
// Custom onForbidden handler
// ---------------------------------------------------------------------------

describe('requireLevel — custom forbidden handler', () => {
  it('passes actual + required + label to the handler', async () => {
    const { db } = createFakeDb({
      users: [{ is_default_admin: false }],
      shops: [
        { id: 's1', name: 'Acme', slug: 'acme', domain: null, status: 'active' },
      ],
      user_shops: [{ role: 'staff' }],
    })
    validateSessionMock.mockResolvedValue(okSession(MERCHANT_USER))

    const onForbidden = vi.fn((_req: any, res: any, _ctx: any) => {
      res.status(403).send('custom')
    })
    const mw = requireLevel(db, {
      minimum: AdminLevel.STORE_OWNER,
      shopSlugParam: 'slug',
      onForbidden,
    })
    const req = makeReq({ params: { slug: 'acme' } })
    const res = makeRes()
    await mw(req, res, vi.fn())

    expect(onForbidden).toHaveBeenCalledOnce()
    const ctx = onForbidden.mock.calls[0][2]
    expect(ctx.required).toBe(AdminLevel.STORE_OWNER)
    expect(ctx.actual).toBe(AdminLevel.STORE_STAFF)
    expect(ctx.actualLabel).toBe('Store Staff')
    expect(res.body).toBe('custom')
  })
})

// ---------------------------------------------------------------------------
// Caller role edge cases — users with no shop membership at all
// ---------------------------------------------------------------------------

describe('requireLevel — customer-tier users', () => {
  it('rejects a role=staff user with no shop membership even at STORE_STAFF', async () => {
    const { db } = createFakeDb({
      users: [{ is_default_admin: false }],
    })
    validateSessionMock.mockResolvedValue(okSession(MERCHANT_USER))

    // No shopSlugParam → no shop context → user.role='staff' is
    // unknown at the platform axis, so level = CUSTOMER, which
    // fails STORE_STAFF.
    const mw = requireLevel(db, { minimum: AdminLevel.STORE_STAFF })
    const req = makeReq()
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('rejects a user whose users.is_default_admin row is missing entirely', async () => {
    const { db } = createFakeDb({
      users: [undefined], // users lookup returns undefined
    })
    validateSessionMock.mockResolvedValue(okSession(MERCHANT_USER))

    const mw = requireLevel(db, { minimum: AdminLevel.STORE_STAFF })
    const req = makeReq()
    const res = makeRes()
    const next = vi.fn()
    await mw(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })
})
