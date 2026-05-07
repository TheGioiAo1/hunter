/**
 * Clone Pro v6 — Stage 3: Playwright headless render
 *
 * DI-based: caller passes a `Browser` instance (from `playwright.chromium.launch()`
 * or a mock).  This file does NOT import playwright at the top level so it works
 * in unit tests without a real Chromium binary.
 *
 * Concurrency pool: up to `concurrency` (default 10) pages render in parallel.
 * Per-URL failures are isolated — one bad page never kills the rest.
 * Screenshots are handed off to the injected `uploadScreenshot` callback; Sprint 1
 * callers can return a placeholder sha1; Sprint 2B wires real S3 upload.
 */

import type { Browser } from 'playwright'
import type { RenderedPage } from '../types.js'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface RenderUrlsInput {
  browser: Browser
  urls: { id: string; sourceUrl: string }[]
  uploadScreenshot: (sourceUrl: string, png: Buffer) => Promise<string>
  concurrency?: number
  viewport?: { width: number; height: number }
  navigationTimeoutMs?: number
}

export interface RenderUrlsResult extends RenderedPage {
  error?: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function renderUrls(input: RenderUrlsInput): Promise<RenderUrlsResult[]> {
  const concurrency = input.concurrency ?? 10
  const viewport = input.viewport ?? { width: 1280, height: 800 }
  const navTimeout = input.navigationTimeoutMs ?? 30_000

  const out: RenderUrlsResult[] = new Array(input.urls.length)

  // Shared cursor — each worker atomically claims the next index.
  let cursor = 0

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = cursor++
      if (idx >= input.urls.length) return
      const entry = input.urls[idx]

      try {
        const ctx = await input.browser.newContext({ viewport })
        try {
          const page = await ctx.newPage()

          await page.goto(entry.sourceUrl, { waitUntil: 'networkidle', timeout: navTimeout })
          await page.waitForLoadState('domcontentloaded')

          const html = await page.content()
          const png = await page.screenshot({ fullPage: true, type: 'png' })
          const sha1 = await input.uploadScreenshot(entry.sourceUrl, png)

          // Extract all referenced asset URLs (images, stylesheets, scripts, videos,
          // sources, and CSS background-image declarations).
          const assetUrls = await page.evaluate(() => {
            const out: string[] = []
            document
              .querySelectorAll('img[src], link[href], script[src], video[src], source[src]')
              .forEach((el) => {
                const a = el.getAttribute('src') ?? el.getAttribute('href')
                if (a) {
                  try {
                    out.push(new URL(a, location.href).toString())
                  } catch {
                    // Relative URLs that fail to resolve (data:, blob:, etc.) — skip.
                  }
                }
              })
            document.querySelectorAll('*').forEach((el) => {
              const bg = getComputedStyle(el as HTMLElement).backgroundImage
              const m = bg.match(/url\(["']?([^"')]+)["']?\)/)
              if (m) {
                try {
                  out.push(new URL(m[1], location.href).toString())
                } catch {
                  // skip unresolvable
                }
              }
            })
            return out.filter((u, i, arr) => arr.indexOf(u) === i)
          })

          await page.close()

          out[idx] = {
            queueId: entry.id,
            sourceUrl: entry.sourceUrl,
            html,
            screenshotSha1: sha1,
            assetUrls,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
          }
        } finally {
          // Always close context to release browser resources.
          await ctx.close()
        }
      } catch (err) {
        out[idx] = {
          queueId: entry.id,
          sourceUrl: entry.sourceUrl,
          html: '',
          screenshotSha1: null,
          assetUrls: [],
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          error: (err as Error).message,
        }
      }
    }
  })

  await Promise.all(workers)
  return out
}
