import { describe, it, expect, vi } from 'vitest'
import { captureScreenshots, DEFAULT_VIEWPORTS, type CaptureInput } from './stage13-screenshot.js'

const stubPage = () => ({
  goto: vi.fn().mockResolvedValue(undefined),
  waitForLoadState: vi.fn().mockResolvedValue(undefined),
  setViewportSize: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  close: vi.fn().mockResolvedValue(undefined),
})

const stubBrowser = (pageFactory: () => any) => {
  return {
    newContext: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockImplementation(async () => pageFactory()),
      close: vi.fn(),
    }),
    close: vi.fn(),
  } as any
}

describe('Stage 13 — screenshot capture', () => {
  it('captures one screenshot per page × viewport (5×2 = 10)', async () => {
    const browser = stubBrowser(stubPage)
    const upload = vi.fn().mockImplementation(async (_url, key, _png) => key)
    const input: CaptureInput = {
      jobId: 'job-1',
      shopSlug: 'bibliobloom',
      sourceUrl: 'https://bibliobloom.com',
      urlsToCapture: [
        { label: 'home', url: 'https://bibliobloom.com/' },
        { label: 'plp', url: 'https://bibliobloom.com/collections/all' },
        { label: 'pdp', url: 'https://bibliobloom.com/products/sample' },
        { label: 'cart', url: 'https://bibliobloom.com/cart' },
        { label: 'page', url: 'https://bibliobloom.com/pages/about' },
      ],
      browser,
      uploadScreenshot: upload,
    }
    const r = await captureScreenshots(input)
    expect(Object.keys(r.s3Keys)).toHaveLength(10)
    expect(r.s3Keys['home-desktop']).toMatch(/^bibliobloom\/theme\/screenshots\/source\/home-desktop\.png$/)
    expect(r.s3Keys['home-mobile']).toMatch(/^bibliobloom\/theme\/screenshots\/source\/home-mobile\.png$/)
    expect(upload).toHaveBeenCalledTimes(10)
  })

  it('uses desktop viewport 1440x900 + mobile 390x844 by default', () => {
    expect(DEFAULT_VIEWPORTS.desktop).toEqual({ width: 1440, height: 900 })
    expect(DEFAULT_VIEWPORTS.mobile).toEqual({ width: 390, height: 844 })
  })

  it('returns warnings for failed pages instead of throwing', async () => {
    let n = 0
    const browser = stubBrowser(() => {
      const p = stubPage()
      if (n++ === 0) p.goto = vi.fn().mockRejectedValue(new Error('net::ERR_TIMEOUT'))
      return p
    })
    const upload = vi.fn().mockImplementation(async (_u, k) => k)
    const r = await captureScreenshots({
      jobId: 'j', shopSlug: 's', sourceUrl: 'https://s.com',
      urlsToCapture: [{ label: 'home', url: 'https://s.com/' }],
      browser,
      uploadScreenshot: upload,
    })
    expect(r.warnings.length).toBeGreaterThanOrEqual(1)
    // 2 viewport attempts, one fails → at most 1 succeeds
    expect(Object.keys(r.s3Keys).length).toBeLessThanOrEqual(1)
  })

  it('honours custom viewport overrides', async () => {
    const browser = stubBrowser(stubPage)
    const upload = vi.fn().mockImplementation(async (_u, k) => k)
    await captureScreenshots({
      jobId: 'j', shopSlug: 's', sourceUrl: 'https://s.com',
      urlsToCapture: [{ label: 'home', url: 'https://s.com/' }],
      browser,
      uploadScreenshot: upload,
      viewports: { desktop: { width: 1920, height: 1080 }, mobile: { width: 375, height: 667 } },
    })
    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({
      viewport: { width: 1920, height: 1080 },
    }))
    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({
      viewport: { width: 375, height: 667 },
    }))
  })

  it('builds s3 keys deterministically: <slug>/theme/screenshots/source/<page>-<viewport>.png', async () => {
    const browser = stubBrowser(stubPage)
    const captured: string[] = []
    const upload = vi.fn().mockImplementation(async (_u, k) => {
      captured.push(k)
      return k
    })
    await captureScreenshots({
      jobId: 'j', shopSlug: 'allbirds', sourceUrl: 'https://a.com',
      urlsToCapture: [{ label: 'pdp', url: 'https://a.com/p/1' }],
      browser,
      uploadScreenshot: upload,
    })
    expect(captured).toContain('allbirds/theme/screenshots/source/pdp-desktop.png')
    expect(captured).toContain('allbirds/theme/screenshots/source/pdp-mobile.png')
  })

  it('survives upload error on one viewport, captures the other', async () => {
    const browser = stubBrowser(stubPage)
    let calls = 0
    const upload = vi.fn().mockImplementation(async (_u, k) => {
      if (calls++ === 0) throw new Error('S3 5xx')
      return k
    })
    const r = await captureScreenshots({
      jobId: 'j', shopSlug: 's', sourceUrl: 'https://s.com',
      urlsToCapture: [{ label: 'home', url: 'https://s.com/' }],
      browser,
      uploadScreenshot: upload,
    })
    expect(Object.keys(r.s3Keys)).toHaveLength(1)
    expect(r.warnings).toHaveLength(1)
  })
})
