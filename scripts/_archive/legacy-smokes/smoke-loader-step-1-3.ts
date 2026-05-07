/**
 * Smoke test — Decision #1 Step 1.3 TemplateLoader + StaticLoader.
 *
 * Verifies (against a temp directory built on the fly):
 *   1. StaticLoader can load files from a real Shopify-style theme tree
 *   2. list() returns sorted logical paths
 *   3. Path normalization handles leading slash + Windows backslashes
 *   4. Path traversal (`..`) is rejected
 *   5. Missing files return null (no throw)
 *   6. themePath helpers produce the expected logical paths
 *
 * Run:
 *   npx tsx scripts/smoke-loader-step-1-3.ts
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  StaticLoader,
  themePath,
  normalizeLogicalPath,
} from '../packages/core/src/modules/themes/engine/index.js'

async function main() {
  // Build a tiny theme tree in tmp.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gbox-loader-smoke-'))
  try {
    await fs.mkdir(path.join(tmp, 'layout'), { recursive: true })
    await fs.mkdir(path.join(tmp, 'sections'), { recursive: true })
    await fs.mkdir(path.join(tmp, 'snippets'), { recursive: true })
    await fs.writeFile(
      path.join(tmp, 'layout/theme.liquid'),
      '<html>{{ content_for_layout }}</html>',
      'utf8',
    )
    await fs.writeFile(
      path.join(tmp, 'sections/header.liquid'),
      '<header>{{ shop.name }}</header>',
      'utf8',
    )
    await fs.writeFile(
      path.join(tmp, 'snippets/product-card.liquid'),
      '<div>{{ product.title }}</div>',
      'utf8',
    )

    const loader = new StaticLoader(tmp, { label: 'gbox-smoke' })

    // (1) Round-trip
    const layout = await loader.load(themePath.layout('theme'))
    if (layout !== '<html>{{ content_for_layout }}</html>') {
      throw new Error(`layout load failed: ${layout}`)
    }
    console.log('PASS (1) load layout:', layout)

    const snippet = await loader.load(themePath.snippet('product-card'))
    if (!snippet?.includes('product.title')) {
      throw new Error(`snippet load failed: ${snippet}`)
    }
    console.log('PASS (1b) load snippet:', snippet)

    // (2) list() sorted
    const all = await loader.list()
    if (
      JSON.stringify(all) !==
      JSON.stringify([
        'layout/theme.liquid',
        'sections/header.liquid',
        'snippets/product-card.liquid',
      ])
    ) {
      throw new Error(`list() unexpected: ${JSON.stringify(all)}`)
    }
    console.log('PASS (2) list() sorted:', all)

    // (3a) Leading slash normalization
    const withSlash = await loader.load('/sections/header.liquid')
    if (!withSlash?.includes('shop.name')) {
      throw new Error(`leading slash failed: ${withSlash}`)
    }
    console.log('PASS (3a) leading slash normalized')

    // (3b) Backslash normalization
    const withBs = await loader.load('sections\\header.liquid')
    if (!withBs?.includes('shop.name')) {
      throw new Error(`backslash failed: ${withBs}`)
    }
    console.log('PASS (3b) Windows backslash normalized')

    // (4) Traversal defense
    let threw = false
    try {
      await loader.load('../etc/passwd')
    } catch (e: any) {
      threw = /traversal/.test(e.message)
    }
    if (!threw) throw new Error('expected traversal to be rejected')
    console.log('PASS (4) path traversal rejected')

    // (5) Missing file → null
    const missing = await loader.load('snippets/does-not-exist.liquid')
    if (missing !== null) throw new Error(`expected null, got ${missing}`)
    console.log('PASS (5) missing file → null')

    // (6) themePath helpers
    if (themePath.section('header') !== 'sections/header.liquid') throw new Error('section helper')
    if (themePath.snippet('foo') !== 'snippets/foo.liquid') throw new Error('snippet helper')
    if (themePath.locale('vi') !== 'locales/vi.json') throw new Error('locale helper')
    if (normalizeLogicalPath('/a//b/c') !== 'a/b/c') throw new Error('normalize collapse')
    console.log('PASS (6) themePath helpers + normalize')

    console.log('\nALL PASSED — Step 1.3 TemplateLoader + StaticLoader correctly wired')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
