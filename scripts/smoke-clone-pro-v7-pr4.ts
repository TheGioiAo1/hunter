/**
 * Smoke — Phase 22 PR4 / Sprint 4: Theme generator + visual verify on bibliobloom.com
 *
 * End-to-end exercise of Sprint 4:
 *   1. Reuse Stage 13 + 14 artefacts (run PR3 smoke first OR pull
 *      tokens from shop_theme_tokens for SMOKE_SHOP_SLUG).
 *   2. Stage 15 generateTheme: render Liquid + bundle theme.zip → S3
 *      + persist theme_files rows + flip is_active=true.
 *   3. Stage 16 visualVerifyWithRetry: capture clone screenshots from
 *      best-store-v7.gbox.co, side-by-side compare via Claude vision,
 *      retry max 3 if score < 7.
 *   4. Assert score >= 7 within 3 retries.
 *
 * Pre-requisites:
 *   - DATABASE_URL set (gbox_platform DB; smoke fetches a shop_id +
 *     reads tokens from shop_theme_tokens)
 *   - ANTHROPIC_API_KEY set (Stage 16 visual diff calls)
 *   - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY set (Stage 15 uploads
 *     theme.zip; Stage 16 captures clone screenshots → S3)
 *   - S3_BUCKET env var (default: 'gbox-clone-storage')
 *   - AWS_REGION env var (default: 'ap-southeast-1')
 *   - Playwright Chromium installed: npx playwright install chromium
 *   - SMOKE_CLONE_URL — URL of the storefront serving the rendered
 *     clone theme (default: 'https://bibliobloom-v7-pr4.gbox.co')
 *   - SMOKE_SHOP_SLUG — used as the S3 prefix (default same as PR3)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *     DATABASE_URL=... npx tsx scripts/smoke-clone-pro-v7-pr4.ts
 *
 * Bibliobloom assertions:
 *   • Stage 15 returns success=true + theme_zip_key set
 *   • Stage 16 final score >= 7
 *   • attempts <= 3 (cap honoured)
 *
 * Exit codes:
 *   0 = all assertions pass
 *   1 = one or more assertions failed (details printed)
 *   2 = unexpected error / pre-req missing
 */

import 'dotenv/config'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import Anthropic from '@anthropic-ai/sdk'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { chromium, type Browser } from 'playwright'
import { generateTheme, type PersistThemeFilesInput } from '../packages/core/src/modules/clone-pro/v7/stages/stage15-theme-generate.js'
import { visualVerifyWithRetry, type RegenerateInput } from '../packages/core/src/modules/clone-pro/v7/stages/stage16-visual-verify.js'
import { visualVerify, type VisionCallInput } from '../packages/core/src/modules/clone-pro/v7/theme-engine/visual-verify.js'
import { captureScreenshots } from '../packages/core/src/modules/clone-pro/v7/stages/stage13-screenshot.js'
import { DesignTokensSchema, type DesignTokens } from '../packages/core/src/modules/clone-pro/v7/theme-engine/token-schema.js'

const VISION_MODEL = process.env.AI_VISION_MODEL ?? 'claude-opus-4-6'

async function loadShopTokens(db: Kysely<any>, slug: string): Promise<{ shopId: string; tokens: DesignTokens; sourceKeys: Record<string, string> }> {
  // Find shop by slug (created during PR3 smoke).
  const shop = await db
    .selectFrom('shops')
    .select(['id'])
    .where('subdomain', '=', slug)
    .executeTakeFirst()
  if (!shop) {
    throw new Error(`No shop with subdomain=${slug}; run smoke-clone-pro-v7-pr3.ts first`)
  }
  const tokensRow = await db
    .selectFrom('shop_theme_tokens')
    .select(['tokens_json', 'screenshots_s3_keys'])
    .where('shop_id', '=', shop.id)
    .executeTakeFirst()
  if (!tokensRow) {
    throw new Error(`No shop_theme_tokens row for shop ${shop.id}; run smoke-clone-pro-v7-pr3.ts first`)
  }
  const tokens = DesignTokensSchema.parse(tokensRow.tokens_json)
  const sourceKeys = (tokensRow.screenshots_s3_keys as Record<string, string>) ?? {}
  return { shopId: shop.id, tokens, sourceKeys }
}

async function main(): Promise<number> {
  const missing: string[] = []
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL')
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY')
  if (!process.env.AWS_ACCESS_KEY_ID) missing.push('AWS_ACCESS_KEY_ID')
  if (!process.env.AWS_SECRET_ACCESS_KEY) missing.push('AWS_SECRET_ACCESS_KEY')
  if (missing.length) {
    console.log(`Skipping — missing env: ${missing.join(', ')}`)
    return 0
  }

  const SHOP_SLUG = process.env.SMOKE_SHOP_SLUG ?? 'bibliobloom-v7-pr3'
  const CLONE_URL = process.env.SMOKE_CLONE_URL ?? 'https://bibliobloom-v7-pr4.gbox.co'
  const BUCKET = process.env.S3_BUCKET ?? 'gbox-clone-storage'
  const REGION = process.env.AWS_REGION ?? 'ap-southeast-1'

  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }),
  })

  const s3 = new S3Client({ region: REGION })
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // ---- Load shop + tokens from PR3 smoke output ------------------------
  console.log(`[smoke] Loading tokens for ${SHOP_SLUG}...`)
  let shopId: string
  let tokens: DesignTokens
  let sourceKeys: Record<string, string>
  try {
    const r = await loadShopTokens(db, SHOP_SLUG)
    shopId = r.shopId
    tokens = r.tokens
    sourceKeys = r.sourceKeys
  } catch (err) {
    console.error(`[smoke] FAIL — ${(err as Error).message}`)
    await db.destroy()
    return 2
  }
  console.log(`[smoke] tokens.fonts.primary.google_font = ${tokens.fonts.primary.google_font}`)
  console.log(`[smoke] source screenshot count = ${Object.keys(sourceKeys).length}`)

  // ---- Stage 15: render + bundle + persist -----------------------------
  console.log(`[smoke] Stage 15 — render + bundle + upload theme.zip + persist theme_files`)

  const upload = async (input: { key: string; body: Buffer; contentType: string }) => {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: input.key, Body: input.body, ContentType: input.contentType,
    }))
  }

  const persistThemeFiles = async (p: PersistThemeFilesInput) => {
    // Insert one theme_files row per file, keyed by theme_id + shop.
    for (const file of p.files) {
      await db.insertInto('theme_files').values({
        shop_id: p.shopId,
        kind: file.path.split('/')[0],     // 'layout' / 'templates' / 'sections' / 'snippets' / 'assets'
        source_url: `template-base/${file.path}`,
        s3_key: `${p.shopId}/theme/v${p.version}/${file.path}`,
        cdn_url: '',
        byte_size: Buffer.byteLength(file.content, 'utf8'),
        source: 'clone-pro-v7',
        clone_snapshot: { theme_id: p.themeId, version: p.version },
        theme_id: p.themeId,
        version: p.version,
        is_active: p.isActive,
      }).onConflict((oc: any) => oc.columns(['shop_id', 'source_url']).doUpdateSet((eb: any) => ({
        s3_key: eb.ref('excluded.s3_key'),
        byte_size: eb.ref('excluded.byte_size'),
        clone_snapshot: eb.ref('excluded.clone_snapshot'),
        theme_id: eb.ref('excluded.theme_id'),
        version: eb.ref('excluded.version'),
        is_active: eb.ref('excluded.is_active'),
        updated_at: sql`now()`,
      }))).execute()
    }
  }

  const deactivatePreviousActive = async ({ shopId: sid }: { shopId: string }): Promise<number> => {
    const r = await db
      .updateTable('theme_files')
      .set({ is_active: false, updated_at: sql`now()` } as any)
      .where('shop_id', '=', sid)
      .where('is_active', '=', true)
      .executeTakeFirst()
    return Number(r?.numUpdatedRows ?? 0)
  }

  const stage15 = await generateTheme({
    jobId: `smoke-${Date.now()}`,
    shopId,
    tokens,
    upload,
    persistThemeFiles,
    deactivatePreviousActive,
  })
  console.log(`[smoke] Stage 15 result: success=${stage15.success}, theme_id=${stage15.theme_id}, version=${stage15.version}, zip=${stage15.theme_zip_key}`)
  if (stage15.warnings.length) {
    console.log(`[smoke] Stage 15 warnings: ${JSON.stringify(stage15.warnings)}`)
  }

  if (!stage15.success) {
    console.error('[smoke] FAIL — Stage 15 did not succeed')
    await db.destroy()
    return 1
  }

  // ---- Stage 16: visualVerifyWithRetry ---------------------------------
  // Note: this assumes someone has deployed theme.zip into the storefront
  // serving CLONE_URL. In a real prod run this happens via cron / worker;
  // for the smoke we expect operations to handle that handoff manually,
  // OR the smoke can be run with --skip-stage16 in dry-run mode.
  if (process.env.SMOKE_SKIP_STAGE16 === '1') {
    console.log('[smoke] SKIPPED Stage 16 (SMOKE_SKIP_STAGE16=1)')
    await db.destroy()
    return 0
  }

  console.log(`[smoke] Stage 16 — visual verify with retry against ${CLONE_URL}`)

  const browser: Browser = await chromium.launch({ headless: true })
  try {
    const captureClone = async ({ cloneUrl, shopSlug }: { cloneUrl: string; shopSlug: string }) => {
      const cap = await captureScreenshots({
        jobId: `smoke-clone-${Date.now()}`,
        shopSlug,
        sourceUrl: cloneUrl,
        urlsToCapture: [
          { label: 'home', url: `${cloneUrl}/` },
          { label: 'plp', url: `${cloneUrl}/collections/all` },
          { label: 'pdp', url: `${cloneUrl}/products/the-bell-jar` },
          { label: 'cart', url: `${cloneUrl}/cart` },
        ],
        browser,
        uploadScreenshot: async (_u, key, png) => {
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: png, ContentType: 'image/png' }))
          return key
        },
      })
      return cap.s3Keys
    }

    const downloadS3 = async (key: string): Promise<Buffer> => {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
      const stream = r.Body as NodeJS.ReadableStream
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks)
    }

    const callVision = async (input: VisionCallInput): Promise<string> => {
      const r = await anthropic.messages.create({
        model: VISION_MODEL,
        max_tokens: 2000,
        temperature: 0.2,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: input.sourceImageBase64 } },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: input.cloneImageBase64 } },
            { type: 'text', text: input.prompt },
          ],
        }],
      })
      const text = r.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      return text
    }

    const runVerify = (verifyInput: any) => visualVerify({
      ...verifyInput,
      captureClone,
      downloadS3,
      callVision,
    })

    const runRegenerate = async (regenInput: RegenerateInput) => {
      return generateTheme({
        jobId: regenInput.jobId,
        shopId: regenInput.shopId,
        tokens: regenInput.tokens,
        version: regenInput.version,
        previousFeedback: regenInput.previousFeedback,
        upload,
        persistThemeFiles,
        deactivatePreviousActive,
      })
    }

    const stage16 = await visualVerifyWithRetry({
      jobId: `smoke-${Date.now()}`,
      shopId,
      shopSlug: SHOP_SLUG,
      cloneUrl: CLONE_URL,
      sourceScreenshotS3Keys: sourceKeys,
      tokens,
      runVerify,
      runRegenerate,
    })

    console.log(`[smoke] Stage 16 result: passed=${stage16.passed}, score=${stage16.score}, attempts=${stage16.attempts}`)
    console.log(`[smoke] attempts_history: ${JSON.stringify(stage16.attempts_history.map((a) => ({ attempt: a.attempt, score: a.score })))}`)
    if (stage16.feedback.length) {
      console.log(`[smoke] final feedback: ${JSON.stringify(stage16.feedback)}`)
    }
    if (stage16.warnings.length) {
      console.log(`[smoke] warnings: ${JSON.stringify(stage16.warnings)}`)
    }

    if (!stage16.passed) {
      console.error('[smoke] FAIL — Stage 16 did not pass within 3 retries')
      return 1
    }
    if (stage16.attempts > 3) {
      console.error('[smoke] FAIL — Stage 16 exceeded 3 retries (cap broken)')
      return 1
    }
  } finally {
    await browser.close().catch(() => undefined)
    await db.destroy()
  }

  console.log('[smoke] PASS — Sprint 4 (Stage 15 + 16) green on bibliobloom')
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err)
    process.exit(2)
  })
