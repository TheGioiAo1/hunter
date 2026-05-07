/**
 * Smoke — Phase 22 PR3 / Sprint 3: Theme capture + design extract on bibliobloom.com
 *
 * End-to-end exercise of Stage 13 (Playwright screenshots → S3) + Stage 14
 * (Claude vision → DesignTokens) against a real editorial e-commerce site.
 *
 * Pre-requisites:
 *   - DATABASE_URL set (gbox_platform DB; smoke fetches a shop_id)
 *   - ANTHROPIC_API_KEY set (Claude vision is the whole pipeline)
 *   - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY set (Stage 13 uploads PNGs)
 *   - S3_BUCKET env var (default: 'gbox-clone-storage')
 *   - AWS_REGION env var (default: 'ap-southeast-1')
 *   - Playwright Chromium installed: npx playwright install chromium
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *     DATABASE_URL=... npx tsx scripts/smoke-clone-pro-v7-pr3.ts
 *
 * Bibliobloom assertions (spec §3.6):
 *   • design-tokens.fonts.primary.google_font ≠ null AND ≠ 'Inter'
 *   • colors.primary is a valid 6-digit hex
 *   • components.product_card.variant is a non-empty string
 *   • aesthetic_score ≥ 6 (bibliobloom is a polished editorial site)
 *
 * Exit codes:
 *   0 = all assertions pass
 *   1 = one or more assertions failed (details printed)
 *   2 = unexpected error / pre-req missing
 */

import 'dotenv/config'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import Anthropic from '@anthropic-ai/sdk'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
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
  // ---- Pre-req checks ---------------------------------------------------
  const missing: string[] = []
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL')
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY')
  if (!process.env.AWS_ACCESS_KEY_ID) missing.push('AWS_ACCESS_KEY_ID')
  if (!process.env.AWS_SECRET_ACCESS_KEY) missing.push('AWS_SECRET_ACCESS_KEY')
  if (missing.length) {
    console.log(`Skipping — missing env: ${missing.join(', ')}`)
    return 0
  }

  const SOURCE_URL = process.env.SMOKE_SOURCE_URL ?? 'https://bibliobloom.com'
  const SHOP_SLUG = process.env.SMOKE_SHOP_SLUG ?? 'bibliobloom-v7-pr3'
  const BUCKET = process.env.S3_BUCKET ?? 'gbox-clone-storage'
  const REGION = process.env.AWS_REGION ?? 'ap-southeast-1'

  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }),
  })

  const s3 = new S3Client({ region: REGION })
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // ---- Stage 13: capture screenshots -----------------------------------
  console.log(`[smoke] Stage 13 — launching Playwright + capturing 5 pages × 2 viewports of ${SOURCE_URL}`)
  const browser = await chromium.launch({ headless: true })
  let captureResult: Awaited<ReturnType<typeof captureScreenshots>>
  try {
    const upload: UploadScreenshotFn = async (_sourceUrl, key, png) => {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: png, ContentType: 'image/png',
      }))
      return key
    }

    captureResult = await captureScreenshots({
      jobId: `smoke-${Date.now()}`,
      shopSlug: SHOP_SLUG,
      sourceUrl: SOURCE_URL,
      urlsToCapture: [
        { label: 'home', url: `${SOURCE_URL}/` },
        { label: 'plp', url: `${SOURCE_URL}/collections/all` },
        { label: 'pdp', url: `${SOURCE_URL}/products/the-bell-jar` },
        { label: 'cart', url: `${SOURCE_URL}/cart` },
        { label: 'page', url: `${SOURCE_URL}/pages/about` },
      ],
      browser,
      uploadScreenshot: upload,
    })
  } finally {
    await browser.close().catch(() => undefined)
  }

  console.log(`[smoke] Stage 13 captured ${Object.keys(captureResult.s3Keys).length} screenshots`)
  if (captureResult.warnings.length) {
    console.log(`[smoke] Stage 13 warnings:`)
    for (const w of captureResult.warnings) console.log(`  ${w}`)
  }
  if (Object.keys(captureResult.s3Keys).length === 0) {
    console.log('[smoke] FAIL — Stage 13 captured zero screenshots')
    await db.destroy()
    return 1
  }

  // ---- Stage 14: vision extraction --------------------------------------
  const downloadS3: DownloadS3Fn = async (key) => {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const stream = r.Body as NodeJS.ReadableStream
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
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

    const text = r.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    return text
  }

  console.log(`[smoke] Stage 14 — running vision pipeline (${Object.keys(captureResult.s3Keys).length} describe + 1 consolidate)`)
  const extract = await extractDesignTokens({
    jobId: `smoke-${Date.now()}`,
    screenshotS3Keys: captureResult.s3Keys,
    downloadS3,
    callVision,
  })

  if (extract.warnings.length) {
    console.log('[smoke] Stage 14 warnings:')
    for (const w of extract.warnings) console.log(`  ${w}`)
  }

  // ---- Assertions -------------------------------------------------------
  const fails: string[] = []
  if (!extract.tokens) {
    fails.push('Stage 14 returned tokens=null (extract failed)')
  } else {
    const t = extract.tokens
    console.log('[smoke] Extracted tokens summary:')
    console.log(`  fonts.primary       = ${t.fonts.primary.family} (google_font=${t.fonts.primary.google_font})`)
    console.log(`  fonts.secondary     = ${t.fonts.secondary?.family ?? '(none)'}`)
    console.log(`  colors.primary      = ${t.colors.primary}`)
    console.log(`  colors.secondary    = ${t.colors.secondary}`)
    console.log(`  colors.accent       = ${t.colors.accent}`)
    console.log(`  colors.background   = ${t.colors.background}`)
    console.log(`  product_card.variant= ${t.components.product_card.variant}`)
    console.log(`  hero_pattern        = ${t.layout.hero_pattern}`)
    console.log(`  aesthetic_score     = ${t.aesthetic_score}`)
    console.log(`  style_keywords      = ${t.style_keywords.join(', ')}`)

    // Assertion 1: google_font predicted, not Inter
    if (!t.fonts.primary.google_font) {
      fails.push('fonts.primary.google_font is null (expected non-null prediction)')
    } else if (t.fonts.primary.google_font.trim().toLowerCase() === 'inter') {
      fails.push(`fonts.primary.google_font='Inter' — bibliobloom is editorial; expect a serif (Cormorant/Playfair/Lora/etc.)`)
    }

    // Assertion 2: hex colors valid
    if (!/^#[0-9a-fA-F]{6}$/.test(t.colors.primary)) {
      fails.push(`colors.primary not 6-digit hex: ${t.colors.primary}`)
    }

    // Assertion 3: product_card.variant is non-empty descriptive string
    if (!t.components.product_card.variant || t.components.product_card.variant.trim().length === 0) {
      fails.push('components.product_card.variant is empty')
    }

    // Assertion 4: aesthetic_score >= 6 (bibliobloom is polished)
    if (t.aesthetic_score < 6) {
      fails.push(`aesthetic_score=${t.aesthetic_score} < 6 (bibliobloom should score ≥ 6)`)
    }
  }

  await db.destroy()

  if (fails.length === 0) {
    console.log('[smoke] PASS — all 4 assertions met')
    return 0
  }
  console.log('[smoke] FAIL — assertions:')
  for (const f of fails) console.log(`  ${f}`)
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[smoke] unexpected error:', err)
    process.exit(2)
  })
