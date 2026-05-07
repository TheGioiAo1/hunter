#!/usr/bin/env -S npx tsx
/**
 * Sprint 1 v7 CLI smoke — bulk crawl a collection page → JSON output.
 *
 * Usage:
 *   npx tsx scripts/clone-pro-crawl.ts \
 *     --url=https://shop.example.com/collections/all \
 *     --limit=10 \
 *     --out=./tmp/sample.json
 *
 * Iron Rule 5: any failure prints diagnostic to stderr but the user-visible
 * stdout summary stays leak-free. CLI is internal tooling but we keep the
 * habit so devs don't accidentally cargo-cult error strings into seller UI.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { crawlSite } from '../packages/core/src/modules/clone-pro/v7-crawler/orchestrator.js'
import { safeMessage } from '../packages/core/src/modules/support/safe-message.js'

interface CliArgs {
  url: string
  limit: number | null
  out: string
  concurrency: number
}

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const arg = argv.find((a) => a.startsWith(`--${name}=`))
    return arg ? arg.slice(name.length + 3) : undefined
  }
  const url = get('url')
  if (!url) {
    process.stderr.write('Usage: clone-pro-crawl --url=<URL> [--limit=N] [--out=PATH] [--concurrency=N]\n')
    process.exit(1)
  }
  const limitRaw = get('limit')
  const limit = limitRaw == null ? null : Number.parseInt(limitRaw, 10)
  const out = get('out') ?? './tmp/clone-pro-crawl.json'
  const concurrencyRaw = get('concurrency')
  const concurrency = concurrencyRaw ? Number.parseInt(concurrencyRaw, 10) : 5
  return { url, limit: Number.isFinite(limit) ? limit : null, out, concurrency }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  process.stdout.write(`crawl start: url=${args.url} limit=${args.limit ?? 'all'} concurrency=${args.concurrency}\n`)
  const t0 = Date.now()

  let result
  try {
    result = await crawlSite(args.url, {
      products_limit: args.limit,
      concurrency: args.concurrency,
    })
  } catch (e) {
    const sm = safeMessage(e)
    process.stderr.write(`crawl failed: ${sm.diagnostic}\n`)
    process.stderr.write(`user-facing: ${sm.safe}\n`)
    process.exit(2)
  }

  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, JSON.stringify(result, null, 2))
  const dur = ((Date.now() - t0) / 1000).toFixed(1)
  process.stdout.write(
    `crawl done: ${result.products.length} products from ${result.platform} in ${dur}s → ${args.out}\n`,
  )
  if (result.warnings.length > 0) {
    process.stdout.write(`warnings: ${result.warnings.length}\n`)
    for (const w of result.warnings) process.stdout.write(`  - ${w}\n`)
  }

  // Quick assertion summary for human readers.
  const withImages = result.products.filter((p) => p.ImageUrls.length > 0).length
  const with3Images = result.products.filter((p) => p.ImageUrls.length >= 3).length
  const withDesc = result.products.filter((p) => (p.Description ?? '').length >= 200).length
  process.stdout.write(
    `quality: ${withImages}/${result.products.length} have any images; ${with3Images}/${result.products.length} have >=3 images; ${withDesc}/${result.products.length} have description >=200 chars\n`,
  )
}

await main()
