import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

export interface PixelDiffResult {
  diffPct: number
  diffPixels: number
  totalPixels: number
}

export async function computePixelDiff(pngA: Buffer, pngB: Buffer): Promise<PixelDiffResult> {
  const a = PNG.sync.read(pngA)
  const b = PNG.sync.read(pngB)
  if (a.width !== b.width || a.height !== b.height) {
    const minW = Math.min(a.width, b.width)
    const minH = Math.min(a.height, b.height)
    const ca = clip(a, minW, minH); const cb = clip(b, minW, minH)
    return runDiff(ca, cb)
  }
  return runDiff(a, b)
}

function clip(img: PNG, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inIdx = (y * img.width + x) * 4
      const outIdx = (y * w + x) * 4
      out.data[outIdx] = img.data[inIdx]
      out.data[outIdx + 1] = img.data[inIdx + 1]
      out.data[outIdx + 2] = img.data[inIdx + 2]
      out.data[outIdx + 3] = img.data[inIdx + 3]
    }
  }
  return out
}

function runDiff(a: PNG, b: PNG): PixelDiffResult {
  const diffPng = new PNG({ width: a.width, height: a.height })
  const diffPixels = pixelmatch(a.data, b.data, diffPng.data, a.width, a.height, { threshold: 0.1 })
  const totalPixels = a.width * a.height
  return { diffPct: +(100 * diffPixels / totalPixels).toFixed(2), diffPixels, totalPixels }
}
