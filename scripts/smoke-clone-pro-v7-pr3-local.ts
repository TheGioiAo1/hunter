/**
 * Local-disk smoke variant for v7-pr3 — bypasses S3, only requires
 * ANTHROPIC_API_KEY + local Playwright Chromium.
 *
 * Stores screenshots in a temp dir, calls Claude vision directly. Lets the
 * developer iterate on prompt quality without provisioning AWS creds. Use
 * the canonical `smoke-clone-pro-v7-pr3.ts` for the full S3+DB smoke.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx scripts/smoke-clone-pro-v7-pr3-local.ts
 *   ANTHROPIC_API_KEY=... SMOKE_SOURCE_URL=https://allbirds.com \
 *     npx tsx scripts/smoke-clone-pro-v7-pr3-local.ts
 */

import 'dotenv/config'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { chromium } from 'playwright'
import {
  captureScreenshots,
  type UploadScreenshotFn,
} from '../packages/core/src/modules/clone-pro/v7/stages/stage13-screenshot.js'
import {
  extractDesignTokens,
  type DownloadS3Fn,
  type VisionCallFn,
} from '../packages/core/src/modules/clone-pro/v7/stages/stage14-design-extract.js'

const VISION_MODEL = process.env.AI_VISION_MODEL ?? 'claude-opus-4-6'

async function main(): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('Skipping — ANTHROPIC_API_KEY not set')
    return 0
  }

  const SOURCE_URL = process.env.SMOKE_SOURCE_URL ?? 'https://bibliobloom.com'
  const SHOP_SLUG = (() => {
    try {
      return new URL(SOURCE_URL).hostname.replace(/^www\./, '').replace(/\..*$/, '') + '-local'
    } catch {
      return 'local'
    }
  })()

  const tmp = mkdtempSync(join(tmpdir(), 'gbox-v7pr3-'))
  console.log(`[smoke-local] tmp dir = ${tmp}`)
  console.log(`[smoke-local] source  = ${SOURCE_URL}`)

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // ---- Stage 13: capture screenshots (local disk) ----------------------
  console.log(`[smoke-local] Stage 13 — capturing 5 pages × 2 viewports`)
  const browser = await chromium.launch({ headless: true })
  let captureResult: Awaited<ReturnType<typeof captureScreenshots>>
  try {
    const upload: UploadScreenshotFn = async (_sourceUrl, key, png) => {
      const path = join(tmp, key.replace(/\//g, '__'))
      writeFileSync(path, png)
      return path
    }

    // For non-Shopify sites the URL pattern may differ; fall back to homepage.
    const u = new URL(SOURCE_URL)
    const base = `${u.protocol}//${u.host}`
    captureResult = await captureScreenshots({
      jobId: `local-${Date.now()}`,
      shopSlug: SHOP_SLUG,
      sourceUrl: SOURCE_URL,
      urlsToCapture: [
        { label: 'home', url: `${base}/` },
        { label: 'plp', url: `${base}/collections/all` },
        { label: 'pdp', url: `${base}/products/the-bell-jar` },
        { label: 'cart', url: `${base}/cart` },
        { label: 'page', url: `${base}/pages/about` },
      ],
      browser,
      uploadScreenshot: upload,
      navigationTimeoutMs: 45_000,
    })
  } finally {
    await browser.close().catch(() => undefined)
  }

  console.log(`[smoke-local] Stage 13 captured ${Object.keys(captureResult.s3Keys).length} screenshots`)
  if (captureResult.warnings.length) {
    console.log(`[smoke-local] Stage 13 warnings:`)
    for (const w of captureResult.warnings) console.log(`  ${w}`)
  }
  if (Object.keys(captureResult.s3Keys).length === 0) {
    console.log('[smoke-local] FAIL — Stage 13 captured zero screenshots')
    return 1
  }

  // ---- Stage 14: vision extraction --------------------------------------
  const downloadS3: DownloadS3Fn = async (path) => {
    if (!existsSync(path)) throw new Error(`local file missing: ${path}`)
    return readFileSync(path)
  }

  const callVision: VisionCallFn = async ({ source, prompt, imageBase64 }) => {
    const isConsolidate = source === 'consolidate'
    const content: Anthropic.MessageParam['content'] = isConsolidate
      ? [{ type: 'text', text: prompt }]
      : [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
          },
          { type: 'text', text: prompt },
        ]

    const r = await anthropic.messages.create({
      model: VISION_MODEL,
      max_tokens: 4000,
      temperature: 0.2,
      messages: [{ role: 'user', content }],
    })

    return r.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
  }

  console.log(`[smoke-local] Stage 14 — vision pipeline (${Object.keys(captureResult.s3Keys).length} describe + 1 consolidate)`)
  const extract = await extractDesignTokens({
    jobId: `local-${Date.now()}`,
    screenshotS3Keys: captureResult.s3Keys,
    downloadS3,
    callVision,
  })

  if (extract.warnings.length) {
    console.log('[smoke-local] Stage 14 warnings:')
    for (const w of extract.warnings) console.log(`  ${w}`)
  }

  // ---- Print + assert ---------------------------------------------------
  if (!extract.tokens) {
    console.log('[smoke-local] FAIL — tokens=null')
    return 1
  }

  const t = extract.tokens
  console.log('[smoke-local] Extracted tokens:')
  console.log(JSON.stringify(t, null, 2))

  // bibliobloom-specific assertions
  const fails: string[] = []
  const isBibliobloom = SOURCE_URL.toLowerCase().includes('bibliobloom')
  if (isBibliobloom) {
    if (!t.fonts.primary.google_font) fails.push('fonts.primary.google_font is null')
    else if (t.fonts.primary.google_font.toLowerCase() === 'inter')
      fails.push(`fonts.primary.google_font='Inter' (bibliobloom is editorial; expect serif)`)
    if (!/^#[0-9a-fA-F]{6}$/.test(t.colors.primary))
      fails.push(`colors.primary not 6-digit hex: ${t.colors.primary}`)
    if (!t.components.product_card.variant?.trim())
      fails.push('components.product_card.variant empty')
    if (t.aesthetic_score < 6)
      fails.push(`aesthetic_score=${t.aesthetic_score} < 6`)
  }

  if (fails.length === 0) {
    console.log('[smoke-local] PASS')
    return 0
  }
  console.log('[smoke-local] FAIL:')
  for (const f of fails) console.log(`  ${f}`)
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[smoke-local] error:', err)
    process.exit(2)
  })
