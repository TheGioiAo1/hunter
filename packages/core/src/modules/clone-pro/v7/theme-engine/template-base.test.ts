/**
 * Template-base library compile + frontmatter tests (Sprint 4 Task 4.2).
 *
 * What we're guarding here:
 *   1. Every Liquid file in `template-base/` must compile under LiquidJS
 *      with no syntax errors. A compile failure here = Stage 15 will
 *      crash on every job for every shop.
 *   2. Every section variant must expose a frontmatter comment block
 *      `{% comment %} variant: ... tokens_required: [...] {% endcomment %}`
 *      so component-builder.ts can introspect required tokens before
 *      handing a variant to the renderer.
 *   3. The library covers the 20+ variants the sprint plan calls for:
 *      5 hero, 5 product card, 4 header, 3 footer, 3 nav. Without enough
 *      variants the "1:1 with bibliobloom" goal is impossible — a generic
 *      AI theme is the failure mode we're explicitly trying to avoid.
 */

import { describe, it, expect } from 'vitest'
import { Liquid } from 'liquidjs'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const baseDir = path.join(__dirname, 'template-base')

async function listLiquidFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await listLiquidFiles(full)))
    } else if (e.isFile() && e.name.endsWith('.liquid')) {
      out.push(full)
    }
  }
  return out
}

const liquid = new Liquid({ root: baseDir, extname: '.liquid' })

describe('template-base library — Sprint 4 Task 4.2', () => {
  it('contains the base layout file (theme.liquid)', async () => {
    const layoutDir = path.join(baseDir, 'layout')
    const files = (await fs.readdir(layoutDir)).filter((f) => f.endsWith('.liquid'))
    expect(files).toContain('theme.liquid')
    // We keep layout/ minimal — header/footer variant resolution lives in
    // snippets/, so layout only owns the base HTML shell.
    expect(files.length).toBeGreaterThanOrEqual(1)
  })

  it('contains the 5 required template files (index/product/collection/cart/page)', async () => {
    const tplDir = path.join(baseDir, 'templates')
    const files = (await fs.readdir(tplDir)).filter((f) => f.endsWith('.liquid'))
    expect(files).toContain('index.liquid')
    expect(files).toContain('product.liquid')
    expect(files).toContain('collection.liquid')
    expect(files).toContain('cart.liquid')
    expect(files).toContain('page.liquid')
  })

  it('contains at least 5 hero section variants', async () => {
    const sectionsDir = path.join(baseDir, 'sections')
    const files = (await fs.readdir(sectionsDir)).filter((f) =>
      f.startsWith('hero-') && f.endsWith('.liquid'),
    )
    expect(files.length).toBeGreaterThanOrEqual(5)
  })

  it('contains at least 5 product-card section variants', async () => {
    const sectionsDir = path.join(baseDir, 'sections')
    const files = (await fs.readdir(sectionsDir)).filter((f) =>
      f.startsWith('product-card-') && f.endsWith('.liquid'),
    )
    expect(files.length).toBeGreaterThanOrEqual(5)
  })

  it('contains at least 4 header section variants', async () => {
    const sectionsDir = path.join(baseDir, 'sections')
    const files = (await fs.readdir(sectionsDir)).filter((f) =>
      f.startsWith('header-') && f.endsWith('.liquid'),
    )
    expect(files.length).toBeGreaterThanOrEqual(4)
  })

  it('contains at least 3 footer section variants', async () => {
    const sectionsDir = path.join(baseDir, 'sections')
    const files = (await fs.readdir(sectionsDir)).filter((f) =>
      f.startsWith('footer-') && f.endsWith('.liquid'),
    )
    expect(files.length).toBeGreaterThanOrEqual(3)
  })

  it('contains at least 3 nav section variants', async () => {
    const sectionsDir = path.join(baseDir, 'sections')
    const files = (await fs.readdir(sectionsDir)).filter((f) =>
      f.startsWith('nav-') && f.endsWith('.liquid'),
    )
    expect(files.length).toBeGreaterThanOrEqual(3)
  })

  it('has at least 20 section variants total (5 hero + 5 card + 4 header + 3 footer + 3 nav)', async () => {
    const sectionsDir = path.join(baseDir, 'sections')
    const files = (await fs.readdir(sectionsDir)).filter((f) => f.endsWith('.liquid'))
    expect(files.length).toBeGreaterThanOrEqual(20)
  })

  it('every section file has a frontmatter comment with variant + tokens_required', async () => {
    const sectionsDir = path.join(baseDir, 'sections')
    const files = (await fs.readdir(sectionsDir)).filter((f) => f.endsWith('.liquid'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const src = await fs.readFile(path.join(sectionsDir, f), 'utf8')
      // Frontmatter contract: first non-empty line block is a Liquid
      // comment containing both `variant:` and `tokens_required:`.
      expect(src, `${f} missing frontmatter`).toMatch(/{%\s*comment\s*%}/)
      expect(src, `${f} missing variant key`).toMatch(/variant\s*:/i)
      expect(src, `${f} missing tokens_required key`).toMatch(/tokens_required\s*:/i)
    }
  })

  it('every Liquid file in template-base compiles under LiquidJS', async () => {
    const all = await listLiquidFiles(baseDir)
    expect(all.length).toBeGreaterThan(0)
    for (const file of all) {
      const src = await fs.readFile(file, 'utf8')
      // Just parse — rendering would need a full token context. Parse
      // surfaces every syntax error (mismatched {% %}, unknown tags, etc).
      try {
        liquid.parse(src)
      } catch (err) {
        throw new Error(`Liquid parse failed for ${path.relative(baseDir, file)}: ${(err as Error).message}`)
      }
    }
  })
})
