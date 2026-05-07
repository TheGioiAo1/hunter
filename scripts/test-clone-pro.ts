/**
 * Test Script: Clone Pro Pipeline
 *
 * Usage:
 *   export $(grep -v '^#' .env | xargs)
 *   npx tsx scripts/test-clone-pro.ts <source_url> <shop_id>
 *
 * Example:
 *   npx tsx scripts/test-clone-pro.ts https://bibliobloom.com 8baf2545-d37c-4d57-a6f7-601e0b234b6a
 */

import { createDb, destroyDb } from '@gbox/db'
import { cloneWebsite } from '../packages/core/src/modules/clone-pro/pipeline.js'
import { DEFAULT_CLONE_SCOPE } from '../packages/core/src/modules/clone-pro/types.js'

const sourceUrl = process.argv[2]
const shopId = process.argv[3]

if (!sourceUrl || !shopId) {
  console.error('Usage: npx tsx scripts/test-clone-pro.ts <source_url> <shop_id>')
  process.exit(1)
}

console.log(`\n🚀 Clone Pro Test`)
console.log(`   Source: ${sourceUrl}`)
console.log(`   Shop:   ${shopId}`)
console.log(`   Scope:  products, collections, pages, blog, navigation, theme, seo`)
console.log(`${'─'.repeat(60)}\n`)

const db = createDb()

try {
  const result = await cloneWebsite(
    db,
    {
      sourceUrl,
      shopId,
      scope: {
        ...DEFAULT_CLONE_SCOPE,
        blog: true,  // enable blog (off by default)
      },
      maxProducts: 500,
      maxPages: 30,
      ingestMedia: true,         // v3: download ALL assets locally
      extractBrandKit: true,
      generateTheme: true,
    },
    {
      onProgress: (pct, message) => {
        const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5))
        process.stdout.write(`\r  [${bar}] ${pct.toFixed(0).padStart(3)}% ${message.padEnd(60)}`)
      },
      onStageUpdate: (stage) => {
        if (stage.status === 'succeeded') {
          console.log(`\n  ✅ ${stage.stage} — completed`)
        } else if (stage.status === 'failed') {
          console.log(`\n  ❌ ${stage.stage} — ${stage.message || 'failed'}`)
        } else if (stage.status === 'skipped') {
          console.log(`\n  ⏭️  ${stage.stage} — skipped`)
        }
      },
      onError: (stage, error) => {
        console.error(`\n  ⚠️  ${stage} error: ${error.message}`)
      },
    },
  )

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`\n📊 Clone Result:`)
  console.log(`   Platform:     ${result.result.platform}`)
  console.log(`   Products:     ${result.result.productsImported}`)
  console.log(`   Pages:        ${result.result.pagesImported}`)
  console.log(`   Collections:  ${result.result.collectionsImported}`)
  console.log(`   Pages scraped:${result.result.pagesScraped}`)
  console.log(`   Theme:        ${result.result.themeGenerated ? '✅ Generated' : '❌ Not generated'}`)
  console.log(`   Brand kit:    ${result.result.brandKitApplied ? '✅ Applied' : '❌ Not applied'}`)
  console.log(`   Duration:     ${(result.result.duration_ms / 1000).toFixed(1)}s`)
  if (result.themeId) {
    console.log(`   Theme ID:     ${result.themeId}`)
  }
  console.log()
} catch (err: any) {
  console.error(`\n💥 Pipeline failed: ${err.message}`)
  console.error(err.stack)
} finally {
  await destroyDb(db)
}
