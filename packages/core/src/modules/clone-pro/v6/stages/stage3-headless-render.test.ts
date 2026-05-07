import { describe, it, expect, vi } from 'vitest'
import { renderUrls } from './stage3-headless-render.js'

const stubPage = (htmlBody: string, assets: string[]) => ({
  goto: vi.fn().mockResolvedValue(undefined),
  waitForLoadState: vi.fn().mockResolvedValue(undefined),
  content: vi.fn().mockResolvedValue(htmlBody),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  evaluate: vi.fn().mockResolvedValue(assets),
  close: vi.fn().mockResolvedValue(undefined),
  setViewportSize: vi.fn().mockResolvedValue(undefined),
})

describe('Stage 3 — headless render', () => {
  it('renders an URL via injected browser, returns RenderedPage', async () => {
    const stub = stubPage('<html><body>hi</body></html>', ['https://cdn.example/x.jpg'])
    const fakeBrowser = {
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue(stub),
        close: vi.fn(),
      }),
      close: vi.fn(),
    }
    const r = await renderUrls({
      browser: fakeBrowser as any,
      urls: [{ id: 'q1', sourceUrl: 'https://example.com/' }],
      uploadScreenshot: async () => 'sha1abc',
    })
    expect(r).toHaveLength(1)
    expect(r[0].html).toContain('hi')
    expect(r[0].screenshotSha1).toBe('sha1abc')
    expect(r[0].assetUrls).toContain('https://cdn.example/x.jpg')
  })

  it('continues on per-URL failures', async () => {
    const goodStub = stubPage('<html>good</html>', [])
    const badStub = {
      ...stubPage('', []),
      goto: vi.fn().mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED')),
    }
    let n = 0
    const fakeBrowser = {
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockImplementation(() => Promise.resolve(n++ === 0 ? goodStub : badStub)),
        close: vi.fn(),
      }),
      close: vi.fn(),
    }
    const r = await renderUrls({
      browser: fakeBrowser as any,
      urls: [
        { id: 'q1', sourceUrl: 'https://good.com/' },
        { id: 'q2', sourceUrl: 'https://bad.com/' },
      ],
      uploadScreenshot: async () => 'sha',
    })
    expect(r).toHaveLength(2)
    // At least one should have content + at least one should have an error
    const hasGood = r.some((x) => x.html?.includes('good'))
    const hasError = r.some((x) => x.error)
    expect(hasGood).toBe(true)
    expect(hasError).toBe(true)
  })
})
