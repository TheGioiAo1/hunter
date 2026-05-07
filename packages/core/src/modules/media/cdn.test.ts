/**
 * Gbox Platform — cdnImage() tests
 *
 * Phase B spec §16.1.
 *
 * The helper accepts multiple input shapes (bare string, product_images
 * row, media_assets row) so the test matrix checks each path produces
 * the expected URL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cdnImage, cdnSrcSet, defaultSrcSet } from './cdn.js'

// 32 bytes of zeros in hex — deterministic test fixture.
const TEST_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000'
const TEST_SALT =
  '0000000000000000000000000000000000000000000000000000000000000000'

describe('cdnImage (passthrough — no imgproxy env)', () => {
  const originalKey = process.env.IMGPROXY_KEY
  const originalSalt = process.env.IMGPROXY_SALT

  beforeEach(() => {
    delete process.env.IMGPROXY_KEY
    delete process.env.IMGPROXY_SALT
  })

  afterEach(() => {
    if (originalKey !== undefined) process.env.IMGPROXY_KEY = originalKey
    if (originalSalt !== undefined) process.env.IMGPROXY_SALT = originalSalt
  })

  it('returns the raw src for a bare string', () => {
    expect(cdnImage('https://cdn.gbox.co/shops/a/products/1.jpg')).toBe(
      'https://cdn.gbox.co/shops/a/products/1.jpg',
    )
  })

  it('reads cdn_url from object shape', () => {
    expect(
      cdnImage({ cdn_url: 'https://example.com/img.png' }, { width: 800 }),
    ).toBe('https://example.com/img.png')
  })

  it('falls back to src when cdn_url missing', () => {
    expect(cdnImage({ src: 'https://example.com/img.png' })).toBe(
      'https://example.com/img.png',
    )
  })

  it('returns empty string for null/undefined/empty', () => {
    expect(cdnImage(null)).toBe('')
    expect(cdnImage(undefined)).toBe('')
    expect(cdnImage('')).toBe('')
    expect(cdnImage({ cdn_url: null })).toBe('')
  })

  it('appends version query from updated_at', () => {
    const url = cdnImage({
      cdn_url: 'https://cdn.gbox.co/a.jpg',
      updated_at: '2026-04-19T10:00:00Z',
    })
    expect(url).toMatch(/^https:\/\/cdn\.gbox\.co\/a\.jpg\?v=[a-z0-9]+$/)
  })

  it('uses pre-baked variant when width matches', () => {
    const url = cdnImage(
      {
        cdn_url: 's3://bucket/products/1.jpg',
        variants_json: { '512': 'https://cdn.gbox.co/pre/1-512.webp' },
      },
      { width: 400 }, // normalizes to 512 bucket
    )
    expect(url).toBe('https://cdn.gbox.co/pre/1-512.webp')
  })
})

describe('cdnImage (imgproxy path)', () => {
  const originalKey = process.env.IMGPROXY_KEY
  const originalSalt = process.env.IMGPROXY_SALT
  const originalBase = process.env.CDN_PUBLIC_BASE_URL

  beforeEach(() => {
    process.env.IMGPROXY_KEY = TEST_KEY
    process.env.IMGPROXY_SALT = TEST_SALT
    process.env.CDN_PUBLIC_BASE_URL = 'https://cdn.gbox.co'
  })

  afterEach(() => {
    if (originalKey !== undefined) process.env.IMGPROXY_KEY = originalKey
    else delete process.env.IMGPROXY_KEY
    if (originalSalt !== undefined) process.env.IMGPROXY_SALT = originalSalt
    else delete process.env.IMGPROXY_SALT
    if (originalBase !== undefined) process.env.CDN_PUBLIC_BASE_URL = originalBase
    else delete process.env.CDN_PUBLIC_BASE_URL
  })

  it('signs URL when source is an s3:// URI', () => {
    const url = cdnImage(
      { cdn_url: 's3://gbox-public-media-prod/shops/a/products/1.jpg' },
      { width: 800, format: 'webp' },
    )
    expect(url).toMatch(/^https:\/\/cdn\.gbox\.co\/img\/[A-Za-z0-9_-]+\//)
    expect(url).toContain('rs:fill:1024:0')
    expect(url).toContain('f:webp')
  })

  it('passes through non-s3 URLs (no signing)', () => {
    // External URL — imgproxy can't fetch from HTTP origins by default
    // (IMGPROXY_ALLOWED_SOURCES is s3-only), so cdnImage returns raw.
    const url = cdnImage(
      { cdn_url: 'https://external.com/img.jpg' },
      { width: 800 },
    )
    expect(url).toBe('https://external.com/img.jpg')
  })

  it('pre-baked variant still short-circuits imgproxy', () => {
    const url = cdnImage(
      {
        cdn_url: 's3://bucket/k.jpg',
        variants_json: { '1024': 'https://cdn.gbox.co/pre/k-1024.webp' },
      },
      { width: 1000 }, // normalizes to 1024
    )
    expect(url).toBe('https://cdn.gbox.co/pre/k-1024.webp')
  })

  it('deterministic — same input produces same signed URL', () => {
    const input = {
      cdn_url: 's3://b/k.jpg',
    }
    const a = cdnImage(input, { width: 800, format: 'webp' })
    const b = cdnImage(input, { width: 800, format: 'webp' })
    expect(a).toBe(b)
  })
})

describe('cdnSrcSet / defaultSrcSet', () => {
  const originalKey = process.env.IMGPROXY_KEY

  beforeEach(() => {
    delete process.env.IMGPROXY_KEY
  })

  afterEach(() => {
    if (originalKey !== undefined) process.env.IMGPROXY_KEY = originalKey
  })

  it('cdnSrcSet builds comma-separated width descriptors', () => {
    const out = cdnSrcSet('https://cdn.gbox.co/a.jpg', [400, 800, 1200])
    expect(out).toBe(
      'https://cdn.gbox.co/a.jpg 400w, https://cdn.gbox.co/a.jpg 800w, https://cdn.gbox.co/a.jpg 1200w',
    )
  })

  it('defaultSrcSet emits the 4 canonical breakpoints', () => {
    const out = defaultSrcSet('https://cdn.gbox.co/a.jpg')
    expect(out).toContain('400w')
    expect(out).toContain('800w')
    expect(out).toContain('1200w')
    expect(out).toContain('1600w')
  })

  it('srcset handles null input gracefully', () => {
    expect(cdnSrcSet(null, [400, 800])).toBe(' 400w,  800w')
  })
})
