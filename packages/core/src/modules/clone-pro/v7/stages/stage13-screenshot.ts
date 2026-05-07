/**
 * Clone Pro v7 — Stage 13: theme screenshot capture
 *
 * Captures 5 page types × 2 viewports (desktop 1440×900 / mobile 390×844)
 * → uploads PNG to S3 keyed by `<slug>/theme/screenshots/source/<page>-<viewport>.png`.
 *
 * DI-based: caller passes a `Browser` and an `uploadScreenshot` function.
 * No top-level Playwright/S3 import so the unit tests run without a real
 * Chromium binary or AWS credentials.
 *
 * Per-(page, viewport) failures are isolated:
 *   - Render error (timeout / DNS / nav abort) → warning + skip the slot
 *   - Upload error (S3 5xx) → warning + skip the slot, do NOT abort other slots
 *
 * Concurrency: each viewport gets its own browser context (Playwright's
 * recommended way to swap viewport — `setViewportSize` is unreliable across
 * `page.goto` boundaries on some sites). 10 sequential captures fits well
 * inside the 5-min Stage 14 budget.
 */

import type { Browser } from 'playwright'
import { safeMessage } from '../../../support/safe-message.js'

export interface Viewport {
  width: number
  height: number
}

export const DEFAULT_VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const

/**
 * Caller's S3 upload contract.
 *   sourceUrl  — original page URL (logging only)
 *   key        — predetermined S3 key (Stage 13 owns the path scheme)
 *   png        — buffer of the captured screenshot
 *   returns    — final S3 key (caller may rewrite, e.g. to add CDN prefix)
 */
export type UploadScreenshotFn = (
  sourceUrl: string,
  key: string,
  png: Buffer,
) => Promise<string>

export interface UrlToCapture {
  /** Logical page label used in the S3 key. e.g. 'home', 'plp', 'pdp', 'cart', 'page'. */
  label: string
  url: string
}

export interface CaptureInput {
  jobId: string
  /** Shop slug used as the S3 prefix root. */
  shopSlug: string
  /** Source store homepage URL — logging only, not captured. */
  sourceUrl: string
  urlsToCapture: UrlToCapture[]
  browser: Browser
  uploadScreenshot: UploadScreenshotFn
  /** Override default 1440×900 / 390×844 viewports. */
  viewports?: { desktop: Viewport; mobile: Viewport }
  /** Per-page nav timeout. Default 30s. */
  navigationTimeoutMs?: number
}

export interface CaptureResult {
  /** Map of `<label>-<viewport>` → S3 key. Missing slots = capture/upload failure. */
  s3Keys: Record<string, string>
  /** Human-readable warnings (Iron rule 5: pre-scrubbed via `safeMessage`). */
  warnings: string[]
}

/**
 * Build the canonical S3 key for a captured screenshot.
 * Exported so Stage 14 can recompute keys for download.
 */
export function buildScreenshotKey(shopSlug: string, label: string, viewport: 'desktop' | 'mobile'): string {
  return `${shopSlug}/theme/screenshots/source/${label}-${viewport}.png`
}

export async function captureScreenshots(input: CaptureInput): Promise<CaptureResult> {
  const viewports = input.viewports ?? DEFAULT_VIEWPORTS
  const navTimeout = input.navigationTimeoutMs ?? 30_000
  const s3Keys: Record<string, string> = {}
  const warnings: string[] = []

  for (const url of input.urlsToCapture) {
    for (const variant of ['desktop', 'mobile'] as const) {
      const viewport = viewports[variant]
      const key = buildScreenshotKey(input.shopSlug, url.label, variant)

      let png: Buffer | null = null
      try {
        const ctx = await input.browser.newContext({ viewport })
        try {
          const page = await ctx.newPage()
          try {
            await page.goto(url.url, { waitUntil: 'networkidle', timeout: navTimeout })
            await page.waitForLoadState('domcontentloaded')
            png = (await page.screenshot({ fullPage: true, type: 'png' })) as Buffer
          } finally {
            // Wrap in try/catch since the close() result may not always be a promise
            // (test stubs return undefined; real Playwright returns Promise<void>).
            try {
              await page.close()
            } catch {
              // ignore
            }
          }
        } finally {
          try {
            await ctx.close()
          } catch {
            // ignore
          }
        }
      } catch (err) {
        const { diagnostic } = safeMessage(err)
        warnings.push(`stage13: capture failed for ${url.label}-${variant}: ${diagnostic}`)
        continue
      }

      if (!png) {
        warnings.push(`stage13: empty screenshot for ${url.label}-${variant}`)
        continue
      }

      try {
        const finalKey = await input.uploadScreenshot(url.url, key, png)
        s3Keys[`${url.label}-${variant}`] = finalKey
      } catch (err) {
        const { diagnostic } = safeMessage(err)
        warnings.push(`stage13: upload failed for ${url.label}-${variant}: ${diagnostic}`)
      }
    }
  }

  return { s3Keys, warnings }
}
