/**
 * Gbox Platform — provisionShop + ensureShopHasTheme tests
 *
 * Decision #1 Step 1.18. Verifies the orchestrator wires
 * createShop → createTheme → installGboxDawnTheme correctly.
 *
 * We mock the three downstream modules so these tests stay
 * Postgres-free and fast.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE the imports that depend on them
// ---------------------------------------------------------------------------

vi.mock('./service.js', () => ({
  createShop: vi.fn(async (_db: any, data: any) => ({
    id: 'shop-001',
    name: data.name,
    slug: data.slug,
    email: data.email,
  })),
}))

vi.mock('../themes/service.js', () => ({
  createTheme: vi.fn(async (_db: any, _shopId: string, data: any) => ({
    id: 'theme-001',
    shop_id: _shopId,
    name: data.name,
    role: data.role ?? 'unpublished',
  })),
}))

vi.mock('../themes/seed/install.js', () => ({
  installGboxDawnTheme: vi.fn(async (_db: any, _themeId: string, _opts: any) => ({
    installed: 56,
    bundleVersion: '1.0.0',
    keys: [],
  })),
}))

// ---------------------------------------------------------------------------
// Imports (pick up mocked versions)
// ---------------------------------------------------------------------------

import { createShop } from './service.js'
import { createTheme } from '../themes/service.js'
import { installGboxDawnTheme } from '../themes/seed/install.js'
import { ensureShopHasTheme, provisionShop } from './provision.js'

const createShopMock = vi.mocked(createShop)
const createThemeMock = vi.mocked(createTheme)
const installMock = vi.mocked(installGboxDawnTheme)

const fakeDb: any = {
  selectFrom: () => ({
    select: () => ({
      where: () => ({
        executeTakeFirst: async () => undefined,
      }),
    }),
  }),
}

beforeEach(() => {
  createShopMock.mockClear()
  createThemeMock.mockClear()
  installMock.mockClear()
})

// ---------------------------------------------------------------------------
// provisionShop
// ---------------------------------------------------------------------------

describe('provisionShop', () => {
  it('calls createShop → createTheme → installGboxDawnTheme in sequence', async () => {
    const result = await provisionShop(fakeDb, {
      name: 'My Shop',
      slug: 'my-shop',
      email: 'test@example.com',
    })

    expect(createShopMock).toHaveBeenCalledOnce()
    expect(createThemeMock).toHaveBeenCalledOnce()
    expect(installMock).toHaveBeenCalledOnce()

    // Shop was created first.
    expect(createShopMock.mock.calls[0]![1]).toMatchObject({
      name: 'My Shop',
      slug: 'my-shop',
    })

    // Theme created for that shop with role='main'.
    expect(createThemeMock.mock.calls[0]![1]).toBe('shop-001')
    expect(createThemeMock.mock.calls[0]![2]).toMatchObject({
      name: 'Gbox Dawn',
      role: 'main',
    })

    // Install ran against the new theme.
    expect(installMock.mock.calls[0]![1]).toBe('theme-001')

    // Result aggregates all three.
    expect(result.shop.id).toBe('shop-001')
    expect(result.theme.id).toBe('theme-001')
    expect(result.install.installed).toBe(56)
  })

  it('accepts a custom theme name', async () => {
    await provisionShop(
      fakeDb,
      { name: 'Shop', slug: 'shop', email: 'e@e.com' },
      { themeName: 'Custom Dawn' },
    )

    expect(createThemeMock.mock.calls[0]![2]).toMatchObject({
      name: 'Custom Dawn',
    })
  })

  it('forwards objectStore + threshold to installGboxDawnTheme', async () => {
    const fakeStore = { tag: 'r2' } as any
    await provisionShop(
      fakeDb,
      { name: 'Shop', slug: 'shop', email: 'e@e.com' },
      { objectStore: fakeStore, threshold: 128 },
    )

    const installOpts = installMock.mock.calls[0]![2]
    expect(installOpts?.objectStore).toBe(fakeStore)
    expect(installOpts?.threshold).toBe(128)
  })

  it('propagates createShop errors', async () => {
    createShopMock.mockRejectedValueOnce(new Error('slug taken'))
    await expect(
      provisionShop(fakeDb, { name: 'Shop', slug: 'dup', email: 'e@e.com' }),
    ).rejects.toThrow(/slug taken/)

    // Theme and install should NOT have been called.
    expect(createThemeMock).not.toHaveBeenCalled()
    expect(installMock).not.toHaveBeenCalled()
  })

  it('propagates createTheme errors', async () => {
    createThemeMock.mockRejectedValueOnce(new Error('db down'))
    await expect(
      provisionShop(fakeDb, { name: 'Shop', slug: 's', email: 'e@e.com' }),
    ).rejects.toThrow(/db down/)

    expect(installMock).not.toHaveBeenCalled()
  })

  it('propagates installGboxDawnTheme errors', async () => {
    installMock.mockRejectedValueOnce(new Error('install failed'))
    await expect(
      provisionShop(fakeDb, { name: 'Shop', slug: 's', email: 'e@e.com' }),
    ).rejects.toThrow(/install failed/)
  })
})

// ---------------------------------------------------------------------------
// ensureShopHasTheme
// ---------------------------------------------------------------------------

describe('ensureShopHasTheme', () => {
  it('is a no-op when the shop already has a theme', async () => {
    const dbWithTheme: any = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => ({ id: 'existing-theme' }),
          }),
        }),
      }),
    }

    const result = await ensureShopHasTheme(dbWithTheme, 'shop-x')
    expect(result.created).toBe(false)
    expect(result.theme).toBeUndefined()
    expect(result.install).toBeUndefined()
    expect(createThemeMock).not.toHaveBeenCalled()
    expect(installMock).not.toHaveBeenCalled()
  })

  it('creates + installs when no theme exists', async () => {
    const result = await ensureShopHasTheme(fakeDb, 'shop-y')
    expect(result.created).toBe(true)
    expect(result.theme?.id).toBe('theme-001')
    expect(result.install?.installed).toBe(56)

    expect(createThemeMock).toHaveBeenCalledOnce()
    expect(createThemeMock.mock.calls[0]![1]).toBe('shop-y')
    expect(createThemeMock.mock.calls[0]![2]).toMatchObject({
      name: 'Gbox Dawn',
      role: 'main',
    })
    expect(installMock).toHaveBeenCalledOnce()
  })

  it('accepts a custom theme name', async () => {
    await ensureShopHasTheme(fakeDb, 'shop-z', { themeName: 'My Theme' })
    expect(createThemeMock.mock.calls[0]![2]).toMatchObject({
      name: 'My Theme',
    })
  })
})
