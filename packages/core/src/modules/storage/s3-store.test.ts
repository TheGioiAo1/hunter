/**
 * Gbox Platform — S3Store Unit Tests
 *
 * Phase B. Two layers, same pattern as r2-store.test.ts:
 *
 *   1. PURE  — config validation, `url()` construction. Never hits net.
 *   2. LIVE  — put/get/has/delete/signedUrl against a scratch bucket.
 *              Gated on `AWS_REGION` + `S3_TEST_BUCKET` env vars so CI
 *              without AWS creds runs the pure suite in isolation.
 *
 * To run LIVE tests locally:
 *   AWS_REGION=ap-southeast-1 \
 *   S3_TEST_BUCKET=gbox-dev-scratch \
 *   AWS_ACCESS_KEY_ID=... \
 *   AWS_SECRET_ACCESS_KEY=... \
 *   npx vitest run packages/core/src/modules/storage/s3-store.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { S3Store } from './s3-store.js'

// ---------------------------------------------------------------------------
// Pure tests
// ---------------------------------------------------------------------------

describe('S3Store (pure)', () => {
  const baseConfig = {
    region: 'ap-southeast-1',
    bucket: 'gbox-public-media-prod',
    publicBaseUrl: 'https://cdn.gbox.co',
  }

  it('constructs with minimum config (region + bucket)', () => {
    const store = new S3Store({ region: 'ap-southeast-1', bucket: 'b' })
    expect(store.name).toBe('s3:b')
  })

  it('throws when region is missing', () => {
    expect(() => new S3Store({ ...baseConfig, region: '' })).toThrow(/region/)
  })

  it('throws when bucket is missing', () => {
    expect(() => new S3Store({ ...baseConfig, bucket: '' })).toThrow(/bucket/)
  })

  it('throws when accessKeyId is supplied without secretAccessKey', () => {
    expect(
      () => new S3Store({ ...baseConfig, accessKeyId: 'ak' }),
    ).toThrow(/secretAccessKey/)
  })

  it('throws when secretAccessKey is supplied without accessKeyId', () => {
    expect(
      () => new S3Store({ ...baseConfig, secretAccessKey: 'sk' }),
    ).toThrow(/accessKeyId/)
  })

  it('accepts both keys together (dev path)', () => {
    expect(
      () =>
        new S3Store({
          ...baseConfig,
          accessKeyId: 'ak',
          secretAccessKey: 'sk',
        }),
    ).not.toThrow()
  })

  it('url() returns the public CDN URL when publicBaseUrl is set', () => {
    const store = new S3Store(baseConfig)
    expect(store.url('shops/a/products/1.jpg')).toBe(
      'https://cdn.gbox.co/shops/a/products/1.jpg',
    )
  })

  it('url() strips trailing slash from publicBaseUrl', () => {
    const store = new S3Store({ ...baseConfig, publicBaseUrl: 'https://cdn.gbox.co/' })
    expect(store.url('a.png')).toBe('https://cdn.gbox.co/a.png')
  })

  it('url() percent-encodes key segments safely', () => {
    const store = new S3Store(baseConfig)
    // encodeURI leaves `/` alone — keys are path-like.
    expect(store.url('folder name/file.png')).toBe(
      'https://cdn.gbox.co/folder%20name/file.png',
    )
  })

  it('url() returns s3-signed:// sentinel when signed=true', () => {
    const store = new S3Store(baseConfig)
    expect(store.url('private', { signed: true })).toBe('s3-signed://private')
  })

  it('url() returns s3-signed:// sentinel when publicBaseUrl is omitted (private bucket)', () => {
    const store = new S3Store({ region: 'ap-southeast-1', bucket: 'gbox-private-prod' })
    expect(store.url('downloads/1.pdf')).toBe('s3-signed://downloads/1.pdf')
  })
})

// ---------------------------------------------------------------------------
// Live tests — gated on env vars
// ---------------------------------------------------------------------------

const hasS3Creds =
  !!process.env.S3_TEST_BUCKET &&
  !!process.env.AWS_REGION &&
  !!process.env.AWS_ACCESS_KEY_ID &&
  !!process.env.AWS_SECRET_ACCESS_KEY

const describeLive = hasS3Creds ? describe : describe.skip

describeLive('S3Store (live bucket)', () => {
  let store: S3Store
  const testKey = `test/s3-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`

  beforeAll(() => {
    store = new S3Store({
      region: process.env.AWS_REGION!,
      bucket: process.env.S3_TEST_BUCKET!,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      publicBaseUrl: process.env.CDN_PUBLIC_BASE_URL,
    })
  })

  it('put + get round-trip', async () => {
    const payload = 'gbox s3 smoke test'
    await store.put(testKey, payload, { contentType: 'text/plain' })
    const got = await store.get(testKey)
    expect(got).not.toBeNull()
    expect(new TextDecoder().decode(got!)).toBe(payload)
  })

  it('has() returns true after put, false for random key', async () => {
    expect(await store.has(testKey)).toBe(true)
    expect(await store.has(testKey + '.nope')).toBe(false)
  })

  it('signedUrl() returns a fetchable URL', async () => {
    const url = await store.signedUrl(testKey, { expiresIn: 60 })
    expect(url).toMatch(/^https:\/\/.*amazonaws\.com/)
    expect(url).toContain(encodeURIComponent(testKey.split('/').pop()!).split('%')[0])
  })

  it('delete() is idempotent and removes the object', async () => {
    await store.delete(testKey)
    await store.delete(testKey) // second call should not throw
    expect(await store.has(testKey)).toBe(false)
  })
})
