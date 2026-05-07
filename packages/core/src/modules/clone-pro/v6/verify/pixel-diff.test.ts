import { describe, it, expect } from 'vitest'
import { computePixelDiff } from './pixel-diff.js'
import { PNG } from 'pngjs'

function makePng(w: number, h: number, fill: [number, number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4
      png.data[idx] = fill[0]; png.data[idx + 1] = fill[1]; png.data[idx + 2] = fill[2]; png.data[idx + 3] = fill[3]
    }
  }
  return PNG.sync.write(png)
}

describe('computePixelDiff', () => {
  it('returns 0% diff for identical images', async () => {
    const a = makePng(100, 100, [255, 0, 0, 255])
    const b = makePng(100, 100, [255, 0, 0, 255])
    const r = await computePixelDiff(a, b)
    expect(r.diffPct).toBe(0)
  })

  it('returns 100% diff for fully different images', async () => {
    const a = makePng(100, 100, [255, 0, 0, 255])
    const b = makePng(100, 100, [0, 255, 0, 255])
    const r = await computePixelDiff(a, b)
    expect(r.diffPct).toBe(100)
  })

  it('returns mid-range for partial diff', async () => {
    const a = makePng(100, 100, [255, 0, 0, 255])
    const png = new PNG({ width: 100, height: 100 })
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
      const idx = (y * 100 + x) * 4
      png.data[idx] = x < 50 ? 255 : 0
      png.data[idx + 1] = 0
      png.data[idx + 2] = x < 50 ? 0 : 255
      png.data[idx + 3] = 255
    }
    const b = PNG.sync.write(png)
    const r = await computePixelDiff(a, b)
    expect(r.diffPct).toBeGreaterThan(40)
    expect(r.diffPct).toBeLessThan(60)
  })
})
