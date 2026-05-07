import { describe, it, expect } from 'vitest'
import { buildAssetGraph, categorizeByUrl } from './stage5-asset-graph.js'

describe('Stage 5 — asset graph', () => {
  it('dedupes asset URLs across pages', () => {
    const r = buildAssetGraph({
      pages: [
        { queueId: 'q1', sourceUrl: 'https://x.com/', html: '', screenshotSha1: null, assetUrls: ['https://x.com/img/a.jpg', 'https://x.com/css/main.css'], viewportWidth: 1280, viewportHeight: 800, classification: 'page' },
        { queueId: 'q2', sourceUrl: 'https://x.com/products/y', html: '', screenshotSha1: null, assetUrls: ['https://x.com/img/a.jpg', 'https://x.com/img/b.jpg'], viewportWidth: 1280, viewportHeight: 800, classification: 'product' },
      ] as any,
    })
    expect(r).toHaveLength(3)
    const a = r.find((x) => x.sourceUrl === 'https://x.com/img/a.jpg')!
    expect(a.referencedFrom).toEqual(['q1', 'q2'])
  })

  it('categorizes by URL pattern', () => {
    expect(categorizeByUrl('https://x.com/img/hero.jpg')).toBe('generic-image')
    expect(categorizeByUrl('https://x.com/fonts/inter.woff2')).toBe('font')
    expect(categorizeByUrl('https://x.com/css/main.css')).toBe('css')
    expect(categorizeByUrl('https://x.com/scripts/app.js')).toBe('js')
    expect(categorizeByUrl('https://x.com/video/intro.mp4')).toBe('video')
  })
})
