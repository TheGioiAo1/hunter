/**
 * Gbox Platform — installGboxDawnTheme tests
 *
 * Decision #1 Step 1.17c. Verifies the install helper walks the
 * bundle in deterministic order, forwards every (themeId, key, source,
 * contentType) tuple to `updateThemeAsset`, threads `objectStore` /
 * `threshold` through to enable R2 routing, and returns an honest
 * report. We mock `updateThemeAsset` so the test stays Postgres-free.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the service module BEFORE importing install.ts so the
// install helper picks up the mocked updateThemeAsset.
vi.mock('../service.js', () => ({
  updateThemeAsset: vi.fn(async () => ({}) as any),
}))

import { updateThemeAsset } from '../service.js'
import { installGboxDawnTheme } from './install.js'
import {
  GBOX_DAWN_BUNDLE,
  GBOX_DAWN_BUNDLE_VERSION,
  listGboxDawnAssets,
} from './gbox-dawn-bundle.js'

const updateMock = vi.mocked(updateThemeAsset)

const fakeDb = {} as any // updateThemeAsset is mocked, db is irrelevant

beforeEach(() => {
  updateMock.mockClear()
})

describe('installGboxDawnTheme', () => {
  it('rejects an empty themeId', async () => {
    await expect(installGboxDawnTheme(fakeDb, '')).rejects.toThrow(/themeId/)
    // Mocked updateThemeAsset should never have been called.
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('writes one asset per bundle entry, in sorted key order', async () => {
    const report = await installGboxDawnTheme(fakeDb, 'theme-x')

    expect(report.installed).toBe(GBOX_DAWN_BUNDLE.size)
    expect(report.bundleVersion).toBe(GBOX_DAWN_BUNDLE_VERSION)
    expect(updateMock).toHaveBeenCalledTimes(GBOX_DAWN_BUNDLE.size)

    const expectedKeys = listGboxDawnAssets().map((a) => a.key)
    expect(report.keys).toEqual(expectedKeys)

    // Each call should match the corresponding asset, in order.
    expectedKeys.forEach((key, i) => {
      const call = updateMock.mock.calls[i]!
      expect(call[1]).toBe('theme-x') // themeId
      expect(call[2]).toBe(key) // key
      const asset = GBOX_DAWN_BUNDLE.get(key)!
      expect(call[3]).toBe(asset.source)
      expect(call[4]).toBe(asset.contentType)
    })
  })

  it('forwards objectStore + threshold through to updateThemeAsset deps', async () => {
    const fakeStore = { tag: 'fake-store' } as any
    await installGboxDawnTheme(fakeDb, 'theme-y', {
      objectStore: fakeStore,
      threshold: 64,
    })
    for (const call of updateMock.mock.calls) {
      const deps = call[5]
      expect(deps).toBeDefined()
      expect(deps?.objectStore).toBe(fakeStore)
      expect(deps?.threshold).toBe(64)
    }
  })

  it('invokes onAsset for every entry with index + total', async () => {
    const events: Array<{ key: string; index: number; total: number }> = []
    await installGboxDawnTheme(fakeDb, 'theme-z', {
      onAsset(asset, index, total) {
        events.push({ key: asset.key, index, total })
      },
    })
    expect(events).toHaveLength(GBOX_DAWN_BUNDLE.size)
    expect(events[0]?.index).toBe(0)
    expect(events[events.length - 1]?.index).toBe(GBOX_DAWN_BUNDLE.size - 1)
    for (const e of events) {
      expect(e.total).toBe(GBOX_DAWN_BUNDLE.size)
    }
  })

  it('swallows errors thrown from the onAsset callback', async () => {
    const report = await installGboxDawnTheme(fakeDb, 'theme-w', {
      onAsset() {
        throw new Error('logger blew up')
      },
    })
    expect(report.installed).toBe(GBOX_DAWN_BUNDLE.size)
  })

  it('propagates errors thrown by updateThemeAsset', async () => {
    updateMock.mockImplementationOnce(async () => {
      throw new Error('db down')
    })
    await expect(installGboxDawnTheme(fakeDb, 'theme-fail')).rejects.toThrow(
      /db down/,
    )
  })
})
