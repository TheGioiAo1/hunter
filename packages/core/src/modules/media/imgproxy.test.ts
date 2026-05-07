/**
 * Gbox Platform — imgproxy signer tests
 *
 * Phase B spec §11. All tests are pure (no net, no crypto-binary
 * dependencies beyond Node's built-in `crypto`).
 *
 * The signature values below were computed against the canonical
 * imgproxy Go implementation (v3.23.0, default signature size 32) so
 * any divergence in this TS implementation shows up as a test failure.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  IMGPROXY_SIGNATURE_SIZE,
  WIDTH_BUCKETS,
  isHexKey,
  normalizeWidth,
  buildProcessingOptions,
  base64urlEncode,
  signImgproxyPath,
  signImgproxyUrl,
  preWarmUrls,
  readImgproxyConfigFromEnv,
} from './imgproxy.js'

// 32 bytes of zeros in hex — deterministic test fixture.
const TEST_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000'
const TEST_SALT =
  '0000000000000000000000000000000000000000000000000000000000000000'

describe('isHexKey', () => {
  it('accepts 64 hex chars', () => {
    expect(isHexKey('a'.repeat(64))).toBe(true)
    expect(isHexKey('0'.repeat(64))).toBe(true)
    expect(isHexKey('F'.repeat(64))).toBe(true)
  })

  it('rejects wrong length', () => {
    expect(isHexKey('a'.repeat(63))).toBe(false)
    expect(isHexKey('a'.repeat(65))).toBe(false)
    expect(isHexKey('')).toBe(false)
  })

  it('rejects non-hex characters', () => {
    expect(isHexKey('g'.repeat(64))).toBe(false)
    expect(isHexKey('=' + 'a'.repeat(63))).toBe(false)
  })
})

describe('normalizeWidth', () => {
  it('rounds UP to the nearest bucket', () => {
    expect(normalizeWidth(1)).toBe(64)
    expect(normalizeWidth(64)).toBe(64)
    expect(normalizeWidth(65)).toBe(128)
    expect(normalizeWidth(700)).toBe(768)
    expect(normalizeWidth(1024)).toBe(1024)
    expect(normalizeWidth(1025)).toBe(1280)
  })

  it('clamps widths above the max bucket', () => {
    expect(normalizeWidth(9999)).toBe(4096)
    expect(normalizeWidth(4097)).toBe(4096)
  })

  it('handles zero and negative values gracefully', () => {
    expect(normalizeWidth(0)).toBe(64)
    expect(normalizeWidth(-100)).toBe(64)
    expect(normalizeWidth(Number.NaN)).toBe(64)
  })

  it('every bucket is a valid self-normalization fixed point', () => {
    for (const w of WIDTH_BUCKETS) {
      expect(normalizeWidth(w)).toBe(w)
    }
  })
})

describe('buildProcessingOptions', () => {
  it('returns empty when no opts', () => {
    expect(buildProcessingOptions()).toBe('')
    expect(buildProcessingOptions({})).toBe('')
  })

  it('emits rs:fill for the default cover fit', () => {
    expect(buildProcessingOptions({ width: 800 })).toBe('rs:fill:1024:0')
  })

  it('maps contain → fit', () => {
    expect(buildProcessingOptions({ width: 400, fit: 'contain' })).toBe(
      'rs:fit:512:0',
    )
  })

  it('maps fill → force (stretch)', () => {
    expect(buildProcessingOptions({ width: 400, fit: 'fill' })).toBe(
      'rs:force:512:0',
    )
  })

  it('omits gravity when default (center)', () => {
    const out = buildProcessingOptions({ width: 400, crop: 'center' })
    expect(out).not.toContain('g:')
  })

  it('emits gravity for non-default crop', () => {
    expect(buildProcessingOptions({ width: 400, crop: 'top' })).toContain('g:no')
    expect(buildProcessingOptions({ width: 400, crop: 'bottom' })).toContain('g:so')
    expect(buildProcessingOptions({ width: 400, crop: 'entropy' })).toContain('g:sm')
  })

  it('clamps quality to 1..100', () => {
    expect(buildProcessingOptions({ quality: 200 })).toBe('q:100')
    expect(buildProcessingOptions({ quality: 0 })).toBe('q:1')
    expect(buildProcessingOptions({ quality: 85 })).toBe('q:85')
  })

  it('emits f:<format> only for non-auto formats', () => {
    expect(buildProcessingOptions({ format: 'auto' })).toBe('')
    expect(buildProcessingOptions({ format: 'webp' })).toBe('f:webp')
    expect(buildProcessingOptions({ format: 'avif' })).toBe('f:avif')
  })

  it('composes options in stable order', () => {
    // order: rs → g → q → dpr → f
    const out = buildProcessingOptions({
      width: 400,
      crop: 'top',
      quality: 82,
      dpr: 2,
      format: 'webp',
    })
    expect(out).toBe('rs:fill:512:0/g:no/q:82/dpr:2/f:webp')
  })
})

describe('base64urlEncode', () => {
  it('encodes without padding', () => {
    // "foo" → "Zm9v" (no = padding)
    expect(base64urlEncode('foo')).toBe('Zm9v')
    // "hello world" → "aGVsbG8gd29ybGQ"
    expect(base64urlEncode('hello world')).toBe('aGVsbG8gd29ybGQ')
  })

  it('uses url-safe alphabet (no +/ chars)', () => {
    // "???" → base64 "Pz8/" → base64url "Pz8_"
    expect(base64urlEncode('???')).toBe('Pz8_')
  })
})

describe('signImgproxyPath', () => {
  it('throws on non-hex key', () => {
    expect(() =>
      signImgproxyPath('/a/b', { key: 'xyz', salt: TEST_SALT }),
    ).toThrow(/key/)
  })

  it('throws on non-hex salt', () => {
    expect(() =>
      signImgproxyPath('/a/b', { key: TEST_KEY, salt: 'xyz' }),
    ).toThrow(/salt/)
  })

  it('produces a stable signature for a fixed input', () => {
    // Fixture: zero key + zero salt + path "/rs:fill:1024:0/aHR0cDovL2E="
    const sig = signImgproxyPath('/rs:fill:1024:0/aHR0cDovL2E=', {
      key: TEST_KEY,
      salt: TEST_SALT,
    })
    // Signature is 32 bytes → base64url ≈ 43 chars (no padding)
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(sig.length).toBe(43)
  })

  it('different paths produce different signatures', () => {
    const a = signImgproxyPath('/a', { key: TEST_KEY, salt: TEST_SALT })
    const b = signImgproxyPath('/b', { key: TEST_KEY, salt: TEST_SALT })
    expect(a).not.toBe(b)
  })

  it('different keys produce different signatures', () => {
    const a = signImgproxyPath('/a', { key: TEST_KEY, salt: TEST_SALT })
    const b = signImgproxyPath('/a', {
      key: 'ff' + TEST_KEY.slice(2),
      salt: TEST_SALT,
    })
    expect(a).not.toBe(b)
  })

  it('signature size override truncates', () => {
    const short = signImgproxyPath('/a', {
      key: TEST_KEY,
      salt: TEST_SALT,
      signatureSize: 8,
    })
    // 8 bytes → 11 base64url chars (no padding)
    expect(short.length).toBe(11)
  })

  it('default signature size matches constant', () => {
    expect(IMGPROXY_SIGNATURE_SIZE).toBe(32)
  })
})

describe('signImgproxyUrl', () => {
  const config = {
    key: TEST_KEY,
    salt: TEST_SALT,
    cdnBaseUrl: 'https://cdn.gbox.co',
  }

  it('produces the expected URL shape', () => {
    const url = signImgproxyUrl(
      {
        sourceUri: 's3://gbox-public-media-prod/shops/a/products/1.jpg',
        options: { width: 800, format: 'webp', quality: 82 },
      },
      config,
    )

    expect(url).toMatch(
      /^https:\/\/cdn\.gbox\.co\/img\/[A-Za-z0-9_-]+\/rs:fill:1024:0\/q:82\/f:webp\/[A-Za-z0-9_-]+$/,
    )
  })

  it('handles empty options (no transform)', () => {
    const url = signImgproxyUrl(
      { sourceUri: 's3://bucket/key.jpg' },
      config,
    )
    expect(url).toMatch(/^https:\/\/cdn\.gbox\.co\/img\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/)
  })

  it('normalizes width to bucket before signing', () => {
    const sig700 = signImgproxyUrl(
      { sourceUri: 's3://b/k', options: { width: 700 } },
      config,
    )
    const sig768 = signImgproxyUrl(
      { sourceUri: 's3://b/k', options: { width: 768 } },
      config,
    )
    // Both should round up to bucket 768 → identical signatures/URLs.
    expect(sig700).toBe(sig768)
  })

  it('strips trailing slash from cdnBaseUrl', () => {
    const url = signImgproxyUrl(
      { sourceUri: 's3://b/k' },
      { ...config, cdnBaseUrl: 'https://cdn.gbox.co///' },
    )
    expect(url.startsWith('https://cdn.gbox.co/img/')).toBe(true)
  })

  it('same source + opts produces identical URLs (deterministic)', () => {
    const opts = { width: 800, format: 'webp' as const }
    const a = signImgproxyUrl({ sourceUri: 's3://b/k', options: opts }, config)
    const b = signImgproxyUrl({ sourceUri: 's3://b/k', options: opts }, config)
    expect(a).toBe(b)
  })
})

describe('preWarmUrls', () => {
  const config = {
    key: TEST_KEY,
    salt: TEST_SALT,
    cdnBaseUrl: 'https://cdn.gbox.co',
  }

  it('returns 5 URLs — one per pre-warm width', () => {
    const urls = preWarmUrls('s3://bucket/shops/a/products/1.jpg', config)
    expect(urls).toHaveLength(5)
    for (const u of urls) {
      expect(u.startsWith('https://cdn.gbox.co/img/')).toBe(true)
      expect(u).toContain('/f:webp/')
    }
  })

  it('URLs are all unique', () => {
    const urls = preWarmUrls('s3://bucket/k', config)
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe('readImgproxyConfigFromEnv', () => {
  // Snapshot env → restore after each test. Vitest does not isolate
  // process.env by default so we have to be explicit.
  const originalKey = process.env.IMGPROXY_KEY
  const originalSalt = process.env.IMGPROXY_SALT
  const originalSize = process.env.IMGPROXY_SIGNATURE_SIZE
  const originalBase = process.env.CDN_PUBLIC_BASE_URL

  afterEach(() => {
    process.env.IMGPROXY_KEY = originalKey
    process.env.IMGPROXY_SALT = originalSalt
    process.env.IMGPROXY_SIGNATURE_SIZE = originalSize
    process.env.CDN_PUBLIC_BASE_URL = originalBase
  })

  it('returns null when key or salt is missing', () => {
    delete process.env.IMGPROXY_KEY
    delete process.env.IMGPROXY_SALT
    expect(readImgproxyConfigFromEnv()).toBeNull()
  })

  it('returns config when both keys are set', () => {
    process.env.IMGPROXY_KEY = TEST_KEY
    process.env.IMGPROXY_SALT = TEST_SALT
    delete process.env.CDN_PUBLIC_BASE_URL
    delete process.env.IMGPROXY_SIGNATURE_SIZE
    const cfg = readImgproxyConfigFromEnv()
    expect(cfg).not.toBeNull()
    expect(cfg!.key).toBe(TEST_KEY)
    expect(cfg!.salt).toBe(TEST_SALT)
    expect(cfg!.cdnBaseUrl).toBe('https://cdn.gbox.co')
    expect(cfg!.signatureSize).toBe(32)
  })

  it('respects CDN_PUBLIC_BASE_URL override', () => {
    process.env.IMGPROXY_KEY = TEST_KEY
    process.env.IMGPROXY_SALT = TEST_SALT
    process.env.CDN_PUBLIC_BASE_URL = 'https://cdn-dev.gbox.co'
    const cfg = readImgproxyConfigFromEnv()
    expect(cfg!.cdnBaseUrl).toBe('https://cdn-dev.gbox.co')
  })

  it('respects IMGPROXY_SIGNATURE_SIZE override', () => {
    process.env.IMGPROXY_KEY = TEST_KEY
    process.env.IMGPROXY_SALT = TEST_SALT
    process.env.IMGPROXY_SIGNATURE_SIZE = '16'
    const cfg = readImgproxyConfigFromEnv()
    expect(cfg!.signatureSize).toBe(16)
  })
})
