/**
 * Gbox Platform — R2Store Unit Tests
 *
 * Decision #1 Step 1.2a — Two layers of tests:
 *
 * 1. PURE tests (always run): config validation, `url()` construction,
 *    and constructor argument checks. These don't touch the network and
 *    require no secrets.
 *
 * 2. LIVE tests (gated on env vars): put/get/has/delete round-trip
 *    against a real R2 bucket. Skipped unless `R2_ENDPOINT`,
 *    `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` are set — that way CI
 *    runs green without credentials, and a developer with a
 *    `.env.local` pointed at a scratch bucket can flip them on by
 *    sourcing env vars.
 *
 * To run live tests locally:
 *   R2_ENDPOINT=https://<acct>.r2.cloudflarestorage.com \
 *   R2_ACCESS_KEY_ID=... \
 *   R2_SECRET_ACCESS_KEY=... \
 *   R2_BUCKET=gbox-theme-assets-test \
 *   R2_PUBLIC_BASE_URL=https://cdn.gbox.co \
 *   npx vitest run packages/core/src/modules/storage/r2-store.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { R2Store } from './r2-store.js'

// ---------------------------------------------------------------------------
// Pure tests — always run
// ---------------------------------------------------------------------------

describe('R2Store (pure)', () => {
  const baseConfig = {
    endpoint: 'https://example.r2.cloudflarestorage.com',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
    bucket: 'gbox-theme-assets',
    publicBaseUrl: 'https://cdn.gbox.co',
  }

  it('constructs with valid config', () => {
    const store = new R2Store(baseConfig)
    expect(store.name).toBe('r2:gbox-theme-assets')
  })

  it('throws when endpoint is missing', () => {
    expect(() => new R2Store({ ...baseConfig, endpoint: '' })).toThrow(/endpoint/)
  })

  it('throws when accessKeyId is missing', () => {
    expect(() => new R2Store({ ...baseConfig, accessKeyId: '' })).toThrow(/accessKeyId/)
  })

  it('throws when secretAccessKey is missing', () => {
    expect(() => new R2Store({ ...baseConfig, secretAccessKey: '' })).toThrow(/secretAccessKey/)
  })

  it('throws when bucket is missing', () => {
    expect(() => new R2Store({ ...baseConfig, bucket: '' })).toThrow(/bucket/)
  })

  it('url() returns public CDN URL by default', () => {
    const store = new R2Store(baseConfig)
    expect(store.url('assets/theme.css')).toBe('https://cdn.gbox.co/assets/theme.css')
  })

  it('url() strips a trailing slash from publicBaseUrl', () => {
    const store = new R2Store({ ...baseConfig, publicBaseUrl: 'https://cdn.gbox.co/' })
    expect(store.url('a.png')).toBe('https://cdn.gbox.co/a.png')
  })

  it('url() percent-encodes key segments safely', () => {
    const store = new R2Store(baseConfig)
    // encodeURI leaves `/` alone — expected behavior, keys are path-like.
    expect(store.url('a b/c.png')).toBe('https://cdn.gbox.co/a%20b/c.png')
  })

  it('url() returns r2-signed:// sentinel when signed=true', () => {
    const store = new R2Store(baseConfig)
    expect(store.url('private/key', { signed: true })).toBe('r2-signed://private/key')
  })

  it('url() returns r2-signed:// sentinel when publicBaseUrl is not set', () => {
    const store = new R2Store({ ...baseConfig, publicBaseUrl: undefined })
    expect(store.url('x')).toBe('r2-signed://x')
  })
})

// ---------------------------------------------------------------------------
// Live tests — gated on env vars
// ---------------------------------------------------------------------------

const hasR2Creds =
  !!process.env.R2_ENDPOINT &&
  !!process.env.R2_ACCESS_KEY_ID &&
  !!process.env.R2_SECRET_ACCESS_KEY

const describeLive = hasR2Creds ? describe : describe.skip

describeLive('R2Store (live R2 bucket)', () => {
  // Lazy-init inside beforeAll so the constructor does not run at collection
  // time when env vars are missing (which would throw and fail the file even
  // with describe.skip, because vitest evaluates describe bodies eagerly).
  let store: R2Store
  const testKey = `test/smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`

  beforeAll(() => {
    store = new R2Store({
      endpoint: process.env.R2_ENDPOINT!,
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      bucket: process.env.R2_BUCKET || 'gbox-theme-assets',
      publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || 'https://cdn.gbox.co',
    })
  })

  it('put + get round-trip', async () => {
    const payload = 'gbox r2 smoke test'
    await store.put(testKey, payload, { contentType: 'text/plain' })

    const got = await store.get(testKey)
    expect(got).not.toBeNull()
    expect(new TextDecoder().decode(got!)).toBe(payload)
  })

  it('has() returns true for the put key, false for random', async () => {
    expect(await store.has(testKey)).toBe(true)
    expect(await store.has(`${testKey}.does-not-exist`)).toBe(false)
  })

  it('delete() removes the object, then get returns null', async () => {
    await store.delete(testKey)
    expect(await store.has(testKey)).toBe(false)
    expect(await store.get(testKey)).toBeNull()
  })
})
