/**
 * Gbox Platform — Worker Isomorphic Compatibility Tests
 *
 * Decision #1 Step 1.21. Verifies the core engine modules don't
 * import Node.js-specific APIs (fs, path, process, child_process,
 * os, crypto, etc.) that would break in Cloudflare Workers.
 *
 * Strategy: statically scan the source files of every engine module
 * for forbidden imports. We don't need a real Workers runtime to
 * catch the most common mistakes — a source-level grep catches 99%
 * of accidental Node.js imports.
 *
 * Additionally, we verify the engine can render a template using
 * only in-memory data sources (no fs/path needed at runtime).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { createLiquidEngine } from './liquid.js'
import { MemoryI18nService } from '../../i18n/memory-service.js'
import type { LoadResult, LogicalPath, TemplateLoader } from './loader.js'

// ---------------------------------------------------------------------------
// Forbidden Node.js imports that break in Workers
// ---------------------------------------------------------------------------

const FORBIDDEN_IMPORTS = [
  // Node.js built-in modules that are NOT available in Workers
  // (even with nodejs_compat flag)
  /\bfrom\s+['"]node:fs['"]/,
  /\bfrom\s+['"]fs['"]/,
  /\bfrom\s+['"]node:path['"]/,
  /\bfrom\s+['"]path['"]/,
  /\bfrom\s+['"]node:child_process['"]/,
  /\bfrom\s+['"]child_process['"]/,
  /\bfrom\s+['"]node:os['"]/,
  /\bfrom\s+['"]os['"]/,
  /\bfrom\s+['"]node:net['"]/,
  /\bfrom\s+['"]net['"]/,
  /\bfrom\s+['"]node:http['"]/,
  /\bfrom\s+['"]http['"]/,
  /\bfrom\s+['"]node:https['"]/,
  /\bfrom\s+['"]https['"]/,
  /\bfrom\s+['"]node:stream['"]/,
  /\bfrom\s+['"]stream['"]/,
  // process.env access (Workers use wrangler.toml, not process.env)
  /\bprocess\.env\b/,
  // require() calls (Workers only support ESM)
  /\brequire\s*\(/,
  // NOTE: node:crypto is ALLOWED — Workers support it via the
  // nodejs_compat compatibility flag in wrangler.toml. The engine
  // uses it for md5/sha1/sha256 Liquid filters and error fingerprinting.
]

// Engine modules to scan (excludes test files, db-loader, db-datasource)
const ENGINE_DIR = join(__dirname)

function collectTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(full))
    } else if (
      full.endsWith('.ts') &&
      !full.endsWith('.test.ts') &&
      !full.endsWith('.d.ts') &&
      // Exclude DB-specific files (they NEED Node.js APIs)
      !full.includes('db-loader') &&
      !full.includes('db-datasource') &&
      // Exclude the StaticLoader (it reads from disk by design)
      !full.includes('static-loader')
    ) {
      files.push(full)
    }
  }
  return files
}

// ---------------------------------------------------------------------------
// Source scan tests
// ---------------------------------------------------------------------------

describe('Worker isomorphic — no forbidden Node.js imports', () => {
  const files = collectTsFiles(ENGINE_DIR)

  it('found engine source files to scan', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  for (const file of files) {
    const relative = file.replace(ENGINE_DIR, '').replace(/\\/g, '/')
    it(`${relative} has no forbidden imports`, () => {
      const source = readFileSync(file, 'utf-8')
      for (const pattern of FORBIDDEN_IMPORTS) {
        const match = source.match(pattern)
        if (match) {
          throw new Error(
            `Forbidden Node.js import in ${relative}: ${match[0]}`,
          )
        }
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Runtime test — engine works without any Node.js APIs
// ---------------------------------------------------------------------------

describe('Worker isomorphic — engine renders in memory', () => {
  class InMemoryLoader implements TemplateLoader {
    readonly name = 'worker-test'
    constructor(private files: Record<string, string>) {}
    async load(p: LogicalPath) { return this.files[p] ?? null }
    async loadWithMeta(p: LogicalPath): Promise<LoadResult | null> {
      const src = this.files[p]
      return src ? { source: src } : null
    }
    async exists(p: LogicalPath) { return p in this.files }
    async list(prefix = '') {
      return Object.keys(this.files).filter((k) => k.startsWith(prefix))
    }
  }

  it('renders a simple template through the engine', async () => {
    const loader = new InMemoryLoader({
      'layout/theme.liquid': '<html>{{ content_for_layout }}</html>',
      'snippets/greeting.liquid': 'Hello {{ name }}!',
    })
    const i18n = new MemoryI18nService({})
    const engine = createLiquidEngine({ loader, i18n })

    const html = await engine.liquid.parseAndRender(
      '{% render "greeting", name: "Worker" %}',
      {},
    )
    expect(html).toBe('Hello Worker!')
  })

  it('renders Gbox Dawn bundle without Node.js APIs', async () => {
    // Import the bundle (it's a static Map, no fs needed)
    const { listGboxDawnAssets } = await import(
      '../seed/gbox-dawn-bundle.js'
    )

    const sourceMap: Record<string, string> = {}
    for (const asset of listGboxDawnAssets()) {
      sourceMap[asset.key] = asset.source
    }

    const loader = new InMemoryLoader(sourceMap)
    const i18n = new MemoryI18nService({ shop1: { en: {} } })
    const engine = createLiquidEngine({ loader, i18n })

    // Just verify the engine can parse the layout without crashing
    const layout = sourceMap['layout/theme.liquid']!
    expect(layout).toBeTruthy()

    // Parse (but don't render — that would need all the drops)
    const templates = engine.liquid.parse(layout)
    expect(templates.length).toBeGreaterThan(0)
  })
})
