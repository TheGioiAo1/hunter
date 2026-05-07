/**
 * Tests for PlatformConfigService (Phase 2 Step 2.5).
 */

import { describe, it, expect } from 'vitest'
import {
  PlatformConfigService,
  InMemoryPlatformSettingsStore,
} from './service.js'
import { PLATFORM_SETTING_DEFS } from './definitions.js'

function makeService(initial: Record<string, unknown> = {}) {
  const store = new InMemoryPlatformSettingsStore(initial)
  return { svc: new PlatformConfigService(store), store }
}

describe('PlatformConfigService.getAll', () => {
  it('returns all 12 settings even when the store is empty', async () => {
    const { svc } = makeService()
    const all = await svc.getAll()
    expect(all.length).toBe(12)
  })

  it('marks every setting as isDefault when the store is empty', async () => {
    const { svc } = makeService()
    const all = await svc.getAll()
    expect(all.every((r) => r.isDefault)).toBe(true)
  })

  it('returns stored values when present and marks them as not default', async () => {
    const { svc } = makeService({ platform_name: 'Overridden' })
    const all = await svc.getAll()
    const row = all.find((r) => r.def.key === 'platform_name')!
    expect(row.value).toBe('Overridden')
    expect(row.isDefault).toBe(false)
  })

  it('preserves declaration order', async () => {
    const { svc } = makeService()
    const all = await svc.getAll()
    const keys = all.map((r) => r.def.key)
    const expected = PLATFORM_SETTING_DEFS.map((d) => d.key)
    expect(keys).toEqual(expected)
  })
})

describe('PlatformConfigService.get', () => {
  it('returns the default value for missing rows', async () => {
    const { svc } = makeService()
    expect(await svc.get('platform_name')).toBe('Gbox Platform')
    expect(await svc.get('maintenance_mode')).toBe(false)
    expect(await svc.get('password_min_length')).toBe(12)
  })

  it('returns the stored value when present', async () => {
    const { svc } = makeService({ platform_name: 'My Platform' })
    expect(await svc.get('platform_name')).toBe('My Platform')
  })

  it('returns undefined for unknown keys', async () => {
    const { svc } = makeService()
    // Cast through `unknown` to probe the runtime miss path without
    // triggering a no-op `@ts-expect-error` (the get() signature now
    // accepts string and never narrows to known keys).
    expect(await svc.get('never_seen' as never)).toBeUndefined()
  })
})

describe('PlatformConfigService.applyChange', () => {
  it('accepts and persists a valid text setting', async () => {
    const { svc, store } = makeService()
    const result = await svc.applyChange('platform_name', 'Gbox Inc')
    expect(result.ok).toBe(true)
    expect(result.value).toBe('Gbox Inc')
    expect((await store.readAll()).platform_name).toBe('Gbox Inc')
  })

  it('coerces form-posted numeric strings into numbers', async () => {
    const { svc, store } = makeService()
    const result = await svc.applyChange('password_min_length', '16')
    expect(result.ok).toBe(true)
    expect((await store.readAll()).password_min_length).toBe(16)
  })

  it('coerces "on" into true for boolean settings', async () => {
    const { svc, store } = makeService()
    const result = await svc.applyChange('maintenance_mode', 'on')
    expect(result.ok).toBe(true)
    expect((await store.readAll()).maintenance_mode).toBe(true)
  })

  it('coerces absent/empty checkboxes into false', async () => {
    const { svc, store } = makeService()
    const result = await svc.applyChange('signup_enabled', '')
    expect(result.ok).toBe(true)
    expect((await store.readAll()).signup_enabled).toBe(false)
  })

  it('rejects unknown keys', async () => {
    const { svc } = makeService()
    const result = await svc.applyChange('hackers_delight', 'true')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Unknown setting/)
  })

  it('rejects invalid URLs', async () => {
    const { svc } = makeService()
    const result = await svc.applyChange('platform_url', 'not a url')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not a valid URL/)
  })

  it('rejects non-numeric input for number settings', async () => {
    const { svc } = makeService()
    const result = await svc.applyChange('password_min_length', 'twelve')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not a number/)
  })

  it('rejects invalid select values', async () => {
    const { svc } = makeService()
    const result = await svc.applyChange('default_locale', 'zh-CN')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/must be one of/)
  })

  it('does NOT persist an invalid change', async () => {
    const { svc, store } = makeService({ platform_name: 'Original' })
    const result = await svc.applyChange('platform_name', '')
    expect(result.ok).toBe(false)
    // Store untouched
    expect((await store.readAll()).platform_name).toBe('Original')
  })
})

describe('PlatformConfigService.applyMany', () => {
  it('applies a batch of valid changes', async () => {
    const { svc, store } = makeService()
    const result = await svc.applyMany({
      platform_name: 'New Name',
      platform_url: 'https://new.gbox.co',
      maintenance_mode: 'on',
    })
    expect(result.platform_name).toBeNull()
    expect(result.platform_url).toBeNull()
    expect(result.maintenance_mode).toBeNull()

    const stored = await store.readAll()
    expect(stored.platform_name).toBe('New Name')
    expect(stored.platform_url).toBe('https://new.gbox.co')
    expect(stored.maintenance_mode).toBe(true)
  })

  it('returns per-key errors without aborting on the first failure', async () => {
    const { svc, store } = makeService()
    const result = await svc.applyMany({
      platform_name: '', // invalid
      platform_url: 'https://ok.gbox.co', // valid
      password_min_length: '5', // invalid (below 8)
    })
    expect(result.platform_name).toMatch(/required/)
    expect(result.platform_url).toBeNull()
    expect(result.password_min_length).toMatch(/at least 8/)

    // Valid one is persisted, invalid ones are not.
    const stored = await store.readAll()
    expect(stored.platform_url).toBe('https://ok.gbox.co')
    expect(stored.platform_name).toBeUndefined()
    expect(stored.password_min_length).toBeUndefined()
  })
})

describe('InMemoryPlatformSettingsStore', () => {
  it('starts empty by default', async () => {
    const store = new InMemoryPlatformSettingsStore()
    expect(await store.readAll()).toEqual({})
  })

  it('honors an initial snapshot', async () => {
    const store = new InMemoryPlatformSettingsStore({ foo: 'bar' })
    expect(await store.readAll()).toEqual({ foo: 'bar' })
  })

  it('write() upserts', async () => {
    const store = new InMemoryPlatformSettingsStore()
    await store.write('k', 1)
    await store.write('k', 2)
    expect((await store.readAll()).k).toBe(2)
  })
})
