/**
 * Gbox Platform — AssetUrlBuilder unit tests
 *
 * Decision #1 Step 1.8.
 *
 * Groups:
 *   1. parseSizeToken — string → ImageSize
 *   2. applySizeSuffix — URL + ImageSize → URL
 *   3. resolveImageUrl — drop unwrapping
 *   4. joinUrl — base + path helper
 *   5. DefaultAssetUrlBuilder — end-to-end URL building
 *   6. Cache-bust token behaviour
 *   7. Custom base URLs + absolute URL passthrough
 */

import { describe, it, expect } from 'vitest'
import {
  DefaultAssetUrlBuilder,
  parseSizeToken,
  applySizeSuffix,
  resolveImageUrl,
  joinUrl,
} from './asset-url-builder.js'

// ---------------------------------------------------------------------------
// parseSizeToken
// ---------------------------------------------------------------------------

describe('parseSizeToken', () => {
  it('returns undefined for empty input', () => {
    expect(parseSizeToken(undefined)).toBeUndefined()
    expect(parseSizeToken('')).toBeUndefined()
  })

  it('parses named sizes to width+height', () => {
    expect(parseSizeToken('pico')).toEqual({ width: 16, height: 16 })
    expect(parseSizeToken('medium')).toEqual({ width: 240, height: 240 })
    expect(parseSizeToken('grande')).toEqual({ width: 600, height: 600 })
  })

  it('named "master"/"original" return empty (no transform)', () => {
    expect(parseSizeToken('master')).toEqual({})
    expect(parseSizeToken('original')).toEqual({})
  })

  it('parses width-only (300x)', () => {
    expect(parseSizeToken('300x')).toEqual({ width: 300 })
  })

  it('parses height-only (x400)', () => {
    expect(parseSizeToken('x400')).toEqual({ height: 400 })
  })

  it('parses both (300x400)', () => {
    expect(parseSizeToken('300x400')).toEqual({ width: 300, height: 400 })
  })

  it('parses crop modifier', () => {
    expect(parseSizeToken('300x400_crop_center')).toEqual({
      width: 300,
      height: 400,
      crop: 'center',
    })
  })

  it('all crop modes are accepted', () => {
    for (const crop of ['center', 'top', 'bottom', 'left', 'right'] as const) {
      expect(parseSizeToken(`100x100_crop_${crop}`)).toEqual({
        width: 100,
        height: 100,
        crop,
      })
    }
  })

  it('rejects unknown crop modes', () => {
    expect(parseSizeToken('100x100_crop_diagonal')).toBeUndefined()
  })

  it('rejects garbage input', () => {
    expect(parseSizeToken('not-a-size')).toBeUndefined()
    expect(parseSizeToken('xx')).toBeUndefined()
    expect(parseSizeToken('abc123')).toBeUndefined()
  })

  it('rejects empty WxH (x alone)', () => {
    expect(parseSizeToken('x')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// applySizeSuffix
// ---------------------------------------------------------------------------

describe('applySizeSuffix', () => {
  it('inserts _WxH before the extension', () => {
    expect(applySizeSuffix('shirt.jpg', { width: 300 })).toBe('shirt_300x.jpg')
    expect(applySizeSuffix('shirt.jpg', { height: 400 })).toBe('shirt_x400.jpg')
    expect(applySizeSuffix('shirt.jpg', { width: 300, height: 400 })).toBe(
      'shirt_300x400.jpg',
    )
  })

  it('appends crop modifier', () => {
    expect(
      applySizeSuffix('shirt.jpg', { width: 300, height: 400, crop: 'center' }),
    ).toBe('shirt_300x400_crop_center.jpg')
  })

  it('preserves directory segments', () => {
    expect(
      applySizeSuffix('/cdn/files/shirt.jpg', { width: 300 }),
    ).toBe('/cdn/files/shirt_300x.jpg')
  })

  it('preserves query string', () => {
    expect(
      applySizeSuffix('/shirt.jpg?v=123', { width: 300 }),
    ).toBe('/shirt_300x.jpg?v=123')
  })

  it('preserves fragment', () => {
    expect(applySizeSuffix('/shirt.jpg#main', { width: 300 })).toBe(
      '/shirt_300x.jpg#main',
    )
  })

  it('returns original when URL has no extension', () => {
    expect(applySizeSuffix('/api/resize', { width: 300 })).toBe('/api/resize')
  })

  it('returns original when size is empty', () => {
    expect(applySizeSuffix('shirt.jpg', {})).toBe('shirt.jpg')
  })

  it('dot-in-directory does not get mistaken for an extension', () => {
    expect(
      applySizeSuffix('/files/v1.0/shirt.jpg', { width: 300 }),
    ).toBe('/files/v1.0/shirt_300x.jpg')
  })
})

// ---------------------------------------------------------------------------
// resolveImageUrl
// ---------------------------------------------------------------------------

describe('resolveImageUrl', () => {
  it('returns empty string for null/undefined', () => {
    expect(resolveImageUrl(null)).toBe('')
    expect(resolveImageUrl(undefined)).toBe('')
  })

  it('returns string input as-is', () => {
    expect(resolveImageUrl('/shirt.jpg')).toBe('/shirt.jpg')
  })

  it('unwraps .src first', () => {
    expect(resolveImageUrl({ src: '/a.jpg', url: '/b.jpg' })).toBe('/a.jpg')
  })

  it('falls back to .url when no src', () => {
    expect(resolveImageUrl({ url: '/b.jpg' })).toBe('/b.jpg')
  })

  it('falls back to .image_url', () => {
    expect(resolveImageUrl({ image_url: '/c.jpg' })).toBe('/c.jpg')
  })

  it('recurses into .image', () => {
    expect(resolveImageUrl({ image: { src: '/d.jpg' } })).toBe('/d.jpg')
  })

  it('recurses into .featured_image (product drop pattern)', () => {
    expect(
      resolveImageUrl({ featured_image: { src: '/hero.jpg' } } as never),
    ).toBe('/hero.jpg')
  })

  it('featured_image string shortcut', () => {
    expect(resolveImageUrl({ featured_image: '/hero.jpg' } as never)).toBe(
      '/hero.jpg',
    )
  })

  it('returns empty when no field matches', () => {
    expect(resolveImageUrl({ title: 'x' } as never)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// joinUrl
// ---------------------------------------------------------------------------

describe('joinUrl', () => {
  it('joins base and path with a single slash', () => {
    expect(joinUrl('/assets', 'theme.css')).toBe('/assets/theme.css')
  })

  it('normalizes double slashes', () => {
    expect(joinUrl('/assets/', '/theme.css')).toBe('/assets/theme.css')
  })

  it('returns absolute http URLs unchanged', () => {
    expect(joinUrl('/assets', 'https://cdn.x.y/foo.css')).toBe(
      'https://cdn.x.y/foo.css',
    )
  })

  it('returns protocol-relative URLs unchanged', () => {
    expect(joinUrl('/assets', '//cdn.x.y/foo.css')).toBe('//cdn.x.y/foo.css')
  })

  it('absolute CDN base is preserved', () => {
    expect(joinUrl('https://cdn.gbox.co/assets', 'theme.css')).toBe(
      'https://cdn.gbox.co/assets/theme.css',
    )
  })

  it('empty base yields /-rooted path', () => {
    expect(joinUrl('', 'theme.css')).toBe('/theme.css')
  })
})

// ---------------------------------------------------------------------------
// DefaultAssetUrlBuilder
// ---------------------------------------------------------------------------

describe('DefaultAssetUrlBuilder — defaults', () => {
  const b = new DefaultAssetUrlBuilder()

  it('assetUrl uses /assets', () => {
    expect(b.assetUrl('theme.css')).toBe('/assets/theme.css')
  })

  it('globalAssetUrl uses /global', () => {
    expect(b.globalAssetUrl('fonts.css')).toBe('/global/fonts.css')
  })

  it('fileUrl uses /cdn/files', () => {
    expect(b.fileUrl('logo.svg')).toBe('/cdn/files/logo.svg')
  })

  it('imgUrl unwraps object and applies size', () => {
    expect(b.imgUrl({ src: '/cdn/files/shirt.jpg' }, '300x')).toBe(
      '/cdn/files/shirt_300x.jpg',
    )
  })

  it('imgUrl with string and named size', () => {
    expect(b.imgUrl('/cdn/files/hero.png', 'medium')).toBe(
      '/cdn/files/hero_240x240.png',
    )
  })

  it('imgUrl with no size returns raw URL', () => {
    expect(b.imgUrl('/hero.jpg')).toBe('/hero.jpg')
  })

  it('imgUrl returns empty string for missing input', () => {
    expect(b.imgUrl(null)).toBe('')
    expect(b.imgUrl(undefined)).toBe('')
    expect(b.imgUrl({})).toBe('')
  })

  it('imgUrl with master/original returns untouched URL', () => {
    expect(b.imgUrl('/shirt.jpg', 'master')).toBe('/shirt.jpg')
    expect(b.imgUrl('/shirt.jpg', 'original')).toBe('/shirt.jpg')
  })

  it('imgUrl with structured ImageSize', () => {
    expect(
      b.imgUrl('/shirt.jpg', { width: 200, height: 300, crop: 'center' }),
    ).toBe('/shirt_200x300_crop_center.jpg')
  })

  it('assetImgUrl combines base + sizing', () => {
    expect(b.assetImgUrl('hero.png', '400x')).toBe('/assets/hero_400x.png')
  })

  it('fileImgUrl combines base + sizing', () => {
    expect(b.fileImgUrl('products/shirt.jpg', 'medium')).toBe(
      '/cdn/files/products/shirt_240x240.jpg',
    )
  })
})

// ---------------------------------------------------------------------------
// Cache-bust token
// ---------------------------------------------------------------------------

describe('DefaultAssetUrlBuilder — cache-bust', () => {
  const b = new DefaultAssetUrlBuilder({
    cacheBustToken: '2026-04-09T00:00:00.000Z',
  })

  it('appends ?v= query on bare URL', () => {
    expect(b.assetUrl('theme.css')).toBe(
      '/assets/theme.css?v=2026-04-09T00%3A00%3A00.000Z',
    )
  })

  it('URL-encodes the token', () => {
    const b2 = new DefaultAssetUrlBuilder({ cacheBustToken: 'a b+c' })
    expect(b2.assetUrl('x.css')).toBe('/assets/x.css?v=a%20b%2Bc')
  })

  it('merges onto existing query with &', () => {
    // Structured size with query — rare but the existing query should
    // be preserved.
    const b3 = new DefaultAssetUrlBuilder({ cacheBustToken: '1' })
    // imgUrl will insert size before .jpg, no existing query on the
    // result, so cache bust appends cleanly.
    expect(b3.imgUrl('/shirt.jpg', '300x')).toBe('/shirt_300x.jpg?v=1')
  })

  it('skips when URL already has a v= query param', () => {
    const b4 = new DefaultAssetUrlBuilder({ cacheBustToken: '1' })
    expect(b4.imgUrl('/shirt.jpg?v=999')).toBe('/shirt.jpg?v=999')
  })
})

// ---------------------------------------------------------------------------
// Custom bases + absolute URL passthrough
// ---------------------------------------------------------------------------

describe('DefaultAssetUrlBuilder — custom bases', () => {
  const b = new DefaultAssetUrlBuilder({
    themeAssetBase: 'https://cdn.gbox.co/assets',
    fileBase: 'https://cdn.gbox.co/files',
    globalAssetBase: 'https://cdn.gbox.co/global',
  })

  it('theme asset uses absolute CDN base', () => {
    expect(b.assetUrl('theme.css')).toBe('https://cdn.gbox.co/assets/theme.css')
  })

  it('file asset uses absolute CDN base', () => {
    expect(b.fileUrl('hero.jpg')).toBe('https://cdn.gbox.co/files/hero.jpg')
  })

  it('global asset uses absolute CDN base', () => {
    expect(b.globalAssetUrl('runtime.js')).toBe(
      'https://cdn.gbox.co/global/runtime.js',
    )
  })

  it('absolute src in imgUrl is preserved', () => {
    expect(
      b.imgUrl({ src: 'https://img.unsplash.com/photo.jpg' }, '300x'),
    ).toBe('https://img.unsplash.com/photo_300x.jpg')
  })

  it('external absolute URL does NOT get cache-bust appended', () => {
    // Merchants can paste `<img src="https://unsplash.com/...">` into
    // theme settings; our cache-bust token is meaningless to a 3rd-
    // party host and can break signed-URL CDNs, so we skip it.
    const cdnWithBust = new DefaultAssetUrlBuilder({
      themeAssetBase: 'https://cdn.gbox.co/assets',
      fileBase: 'https://cdn.gbox.co/files',
      globalAssetBase: 'https://cdn.gbox.co/global',
      cacheBustToken: '2026-04-09',
    })
    expect(
      cdnWithBust.imgUrl({ src: 'https://img.unsplash.com/photo.jpg' }, '300x'),
    ).toBe('https://img.unsplash.com/photo_300x.jpg')
  })

  it('own absolute URL DOES get cache-bust appended', () => {
    const cdnWithBust = new DefaultAssetUrlBuilder({
      themeAssetBase: 'https://cdn.gbox.co/assets',
      fileBase: 'https://cdn.gbox.co/files',
      globalAssetBase: 'https://cdn.gbox.co/global',
      cacheBustToken: '2026-04-09',
    })
    expect(
      cdnWithBust.imgUrl(
        { src: 'https://cdn.gbox.co/files/hero.jpg' },
        '300x',
      ),
    ).toBe('https://cdn.gbox.co/files/hero_300x.jpg?v=2026-04-09')
  })

  it('trailing slash on base is normalized', () => {
    const b2 = new DefaultAssetUrlBuilder({ themeAssetBase: '/assets/' })
    expect(b2.assetUrl('theme.css')).toBe('/assets/theme.css')
  })
})
