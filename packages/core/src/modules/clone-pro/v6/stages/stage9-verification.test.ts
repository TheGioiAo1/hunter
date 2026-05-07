import { describe, it, expect, vi } from 'vitest'
import { runStage9 } from './stage9-verification.js'
import { PNG } from 'pngjs'

function makePng(fill: [number, number, number, number]): Buffer {
  const png = new PNG({ width: 50, height: 50 })
  for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) {
    const idx = (y * 50 + x) * 4
    png.data[idx] = fill[0]; png.data[idx + 1] = fill[1]; png.data[idx + 2] = fill[2]; png.data[idx + 3] = fill[3]
  }
  return PNG.sync.write(png)
}

describe('Stage 9 — verification', () => {
  it('composes pixel + cardinality + reachability', async () => {
    const fakeDb = {
      selectFrom: (_table: string) => ({
        where: () => ({ select: () => ({ executeTakeFirst: async () => ({ n: 99 }) }) }),
      }),
    }
    // Mock global fetch for reachability
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as any
    try {
      const r = await runStage9({
        db: fakeDb as any, shopId: 's', jobId: 'j',
        sourceHomepageScreenshot: makePng([255, 0, 0, 255]),
        clonedHomepageScreenshot: makePng([255, 0, 0, 255]),
        clonedHomepageHtml: '<img src="https://cdn.gbox.co/a.jpg">',
        sourceUrlCounts: { products: 100, collections: 10, pages: 5, blogPosts: 4 },
      })
      expect(r.pixelDiffPct).toBe(0)
      expect(r.reachability.totalAssets).toBe(1)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
