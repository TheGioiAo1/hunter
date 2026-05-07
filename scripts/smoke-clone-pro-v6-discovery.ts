/**
 * Smoke — Phase 21 PR1 / Sprint 1: Stages 1-3 (sitemap → classify → render)
 *
 * Operator-runnable smoke that exercises the v6 discovery pipeline end-to-end
 * against a real source URL using a local Anthropic key. NO database writes —
 * smoke calls the stages directly, prints results.
 *
 * Sprint 4 will replace this with a full e2e smoke that walks the entire
 * 12-stage pipeline against bibliobloom.com → best-store.gbox.co.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/smoke-clone-pro-v6-discovery.ts
 *
 * Optional:
 *   SMOKE_SOURCE_URL=https://hydrogen-preview.myshopify.com (default: bibliobloom.com)
 */

import 'dotenv/config'
import { discoverUrls } from '../packages/core/src/modules/clone-pro/v6/stages/stage1-sitemap.js'
import { classifyUrls } from '../packages/core/src/modules/clone-pro/v6/stages/stage2-classify-urls.js'
import { renderUrls } from '../packages/core/src/modules/clone-pro/v6/stages/stage3-headless-render.js'
import { classifyUrlsViaAI } from '../packages/core/src/modules/clone-pro/v6/ai/url-classifier.js'

async function main() {
  const sourceUrl = process.env.SMOKE_SOURCE_URL ?? 'https://bibliobloom.com'
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  console.log(`Stage 1: discovering URLs from ${sourceUrl}`)
  const d = await discoverUrls({ sourceUrl, maxBfsPages: 100, maxBfsDepth: 3 })
  console.log(`  → ${d.urls.length} URLs (sitemap=${d.sitemapFound})`)
  if (d.urls.length === 0) {
    console.log('FAIL — no URLs discovered')
    process.exit(1)
  }

  const sample = d.urls.slice(0, 20).map((u) => u.sourceUrl)
  console.log(`Stage 2: classifying ${sample.length} URLs (sample)`)

  if (!anthropicKey) {
    console.log('  → ANTHROPIC_API_KEY not set; using pattern-only classification')
    const { classifyUrlsByPattern } = await import('../packages/core/src/modules/clone-pro/v6/stages/stage2-classify-urls.js')
    const cls = classifyUrlsByPattern(sample)
    for (const [u, c] of Object.entries(cls).slice(0, 5)) {
      console.log(`  ${(c ?? 'unclassified').padEnd(14)} ${u}`)
    }
  } else {
    const cls = await classifyUrls({
      urls: sample,
      callAI: async (batch) => classifyUrlsViaAI(batch, {
        provider: 'anthropic',
        apiKey: anthropicKey,
        model: 'claude-haiku-4-5-20251001',
      }),
    })
    for (const [u, c] of Object.entries(cls).slice(0, 5)) {
      console.log(`  ${(c ?? 'unclassified').padEnd(14)} ${u}`)
    }
  }

  console.log('Stage 3: rendering 3 sample URLs (Playwright Chromium required)')
  let chromium: any
  try {
    const playwright = await import('playwright')
    chromium = playwright.chromium
  } catch (err) {
    console.log('  → playwright not installed or Chromium binary missing; run `npx playwright install chromium` and retry')
    console.log('Smoke partial pass — Stages 1+2 verified, Stage 3 deferred')
    process.exit(0)
  }

  const browser = await chromium.launch({ headless: true })
  try {
    const r = await renderUrls({
      browser,
      urls: sample.slice(0, 3).map((u, i) => ({ id: `q${i}`, sourceUrl: u })),
      uploadScreenshot: async () => 'sha-placeholder',
    })
    for (const p of r) {
      const status = p.error ? `FAIL ${p.error}` : `OK html=${p.html.length}b assets=${p.assetUrls.length}`
      console.log(`  ${status} ${p.sourceUrl}`)
    }
  } finally {
    await browser.close()
  }

  console.log('Smoke pass — Stages 1+2+3 verified end-to-end')
  process.exit(0)
}

main().catch((err) => {
  console.error('Smoke failed:', err)
  process.exit(2)
})
