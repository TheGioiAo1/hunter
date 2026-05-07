/**
 * Gbox Platform — StaticLoader unit tests
 *
 * Decision #1 Step 1.3 — End-to-end tests of the filesystem-backed
 * loader against a real temp directory. Avoids fixture file commits
 * by building + tearing down the tree per `beforeAll`/`afterAll`.
 *
 * Coverage:
 *   - load() round-trip for layout/section/snippet/locale paths
 *   - load() returns null on missing path (does NOT throw)
 *   - loadWithMeta() returns source + updatedAt
 *   - exists() true/false
 *   - list() with no prefix → every file under baseDir
 *   - list() with prefix → only matching dir
 *   - list() with non-existent prefix → empty array (no throw)
 *   - Path traversal: load('../secret') is rejected
 *   - Constructor throws on missing baseDir
 *   - name getter reflects baseDir basename
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StaticLoader } from './static-loader.js'

let tmpDir: string
let loader: StaticLoader

beforeAll(async () => {
  // Create a unique temp directory for this test file.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gbox-staticloader-'))

  // Build a Shopify-style theme tree:
  //
  //   tmpDir/
  //   ├── layout/theme.liquid
  //   ├── sections/header.liquid
  //   ├── sections/footer.liquid
  //   ├── snippets/product-card.liquid
  //   ├── snippets/nested/breadcrumbs.liquid
  //   ├── templates/index.liquid
  //   ├── templates/product.liquid
  //   ├── templates/customers/login.liquid
  //   ├── locales/en.default.json
  //   └── config/settings_data.json
  //
  await fs.mkdir(path.join(tmpDir, 'layout'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'sections'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'snippets/nested'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'templates/customers'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'locales'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'config'), { recursive: true })

  await fs.writeFile(
    path.join(tmpDir, 'layout/theme.liquid'),
    '<html>{{ content_for_layout }}</html>',
    'utf8',
  )
  await fs.writeFile(
    path.join(tmpDir, 'sections/header.liquid'),
    '<header>{{ shop.name }}</header>',
    'utf8',
  )
  await fs.writeFile(
    path.join(tmpDir, 'sections/footer.liquid'),
    '<footer>© {{ shop.name }}</footer>',
    'utf8',
  )
  await fs.writeFile(
    path.join(tmpDir, 'snippets/product-card.liquid'),
    '<div class="card">{{ product.title }}</div>',
    'utf8',
  )
  await fs.writeFile(
    path.join(tmpDir, 'snippets/nested/breadcrumbs.liquid'),
    '<nav>{{ crumbs }}</nav>',
    'utf8',
  )
  await fs.writeFile(
    path.join(tmpDir, 'templates/index.liquid'),
    '{% section "header" %}',
    'utf8',
  )
  await fs.writeFile(
    path.join(tmpDir, 'templates/product.liquid'),
    '{{ product.title }}',
    'utf8',
  )
  await fs.writeFile(
    path.join(tmpDir, 'templates/customers/login.liquid'),
    'Login form',
    'utf8',
  )
  await fs.writeFile(
    path.join(tmpDir, 'locales/en.default.json'),
    '{"hello":"world"}',
    'utf8',
  )
  await fs.writeFile(
    path.join(tmpDir, 'config/settings_data.json'),
    '{}',
    'utf8',
  )

  // Create a "secret" file ABOVE tmpDir to test path traversal defense.
  // We don't actually create something dangerous — just a probe file
  // adjacent to the temp dir we'd never want a malicious template to read.
  // (We don't write outside system temp; we just confirm the loader
  // refuses to escape the baseDir.)
  loader = new StaticLoader(tmpDir, { label: 'gbox-test-theme' })
})

afterAll(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('StaticLoader — constructor', () => {
  it('throws when baseDir is empty', () => {
    expect(() => new StaticLoader('')).toThrow(/baseDir/)
  })

  it('name getter uses the label option', () => {
    const l = new StaticLoader(tmpDir, { label: 'gbox-test-theme' })
    expect(l.name).toBe('static:gbox-test-theme')
  })

  it('name getter falls back to basename', () => {
    const l = new StaticLoader(tmpDir)
    // basename of mkdtemp is `gbox-staticloader-XXXXXX`
    expect(l.name.startsWith('static:gbox-staticloader-')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

describe('StaticLoader — load()', () => {
  it('reads layout/theme.liquid', async () => {
    const src = await loader.load('layout/theme.liquid')
    expect(src).toBe('<html>{{ content_for_layout }}</html>')
  })

  it('reads sections/header.liquid', async () => {
    const src = await loader.load('sections/header.liquid')
    expect(src).toBe('<header>{{ shop.name }}</header>')
  })

  it('reads nested snippet path', async () => {
    const src = await loader.load('snippets/nested/breadcrumbs.liquid')
    expect(src).toBe('<nav>{{ crumbs }}</nav>')
  })

  it('reads templates/customers/login.liquid', async () => {
    const src = await loader.load('templates/customers/login.liquid')
    expect(src).toBe('Login form')
  })

  it('reads JSON locale file as a string', async () => {
    const src = await loader.load('locales/en.default.json')
    expect(src).toBe('{"hello":"world"}')
  })

  it('returns null on missing file (does NOT throw)', async () => {
    const src = await loader.load('snippets/does-not-exist.liquid')
    expect(src).toBeNull()
  })

  it('returns null when path points at a directory', async () => {
    const src = await loader.load('snippets')
    expect(src).toBeNull()
  })

  it('normalizes leading slash', async () => {
    const src = await loader.load('/layout/theme.liquid')
    expect(src).toBe('<html>{{ content_for_layout }}</html>')
  })

  it('normalizes Windows backslashes', async () => {
    const src = await loader.load('layout\\theme.liquid')
    expect(src).toBe('<html>{{ content_for_layout }}</html>')
  })
})

// ---------------------------------------------------------------------------
// loadWithMeta
// ---------------------------------------------------------------------------

describe('StaticLoader — loadWithMeta()', () => {
  it('returns source + updatedAt for an existing file', async () => {
    const meta = await loader.loadWithMeta('sections/header.liquid')
    expect(meta).not.toBeNull()
    expect(meta!.source).toBe('<header>{{ shop.name }}</header>')
    expect(meta!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns null on missing path', async () => {
    expect(await loader.loadWithMeta('snippets/missing.liquid')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// exists
// ---------------------------------------------------------------------------

describe('StaticLoader — exists()', () => {
  it('returns true for an existing file', async () => {
    expect(await loader.exists('templates/product.liquid')).toBe(true)
  })

  it('returns false for a missing file', async () => {
    expect(await loader.exists('templates/nope.liquid')).toBe(false)
  })

  it('returns false for a directory path', async () => {
    expect(await loader.exists('snippets')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('StaticLoader — list()', () => {
  it('list() with no prefix returns every file (sorted)', async () => {
    const all = await loader.list()
    expect(all).toEqual([
      'config/settings_data.json',
      'layout/theme.liquid',
      'locales/en.default.json',
      'sections/footer.liquid',
      'sections/header.liquid',
      'snippets/nested/breadcrumbs.liquid',
      'snippets/product-card.liquid',
      'templates/customers/login.liquid',
      'templates/index.liquid',
      'templates/product.liquid',
    ])
  })

  it('list("snippets") returns only the snippets subtree', async () => {
    const out = await loader.list('snippets')
    expect(out).toEqual([
      'snippets/nested/breadcrumbs.liquid',
      'snippets/product-card.liquid',
    ])
  })

  it('list("snippets/") tolerates a trailing slash', async () => {
    const out = await loader.list('snippets/')
    expect(out.length).toBe(2)
    expect(out[0]).toBe('snippets/nested/breadcrumbs.liquid')
  })

  it('list("templates/customers") drills into deeper nesting', async () => {
    const out = await loader.list('templates/customers')
    expect(out).toEqual(['templates/customers/login.liquid'])
  })

  it('list() on a non-existent prefix returns [] (no throw)', async () => {
    expect(await loader.list('does-not-exist')).toEqual([])
  })

  it('list() pointed at a single file returns [that file]', async () => {
    const out = await loader.list('layout/theme.liquid')
    expect(out).toEqual(['layout/theme.liquid'])
  })
})

// ---------------------------------------------------------------------------
// Security — path traversal
// ---------------------------------------------------------------------------

describe('StaticLoader — path traversal defense', () => {
  it('load("../something") throws via normalizeLogicalPath', async () => {
    await expect(loader.load('../etc/passwd')).rejects.toThrow(/traversal/)
  })

  it('load("snippets/../../something") throws', async () => {
    await expect(loader.load('snippets/../../secret')).rejects.toThrow(/traversal/)
  })

  it('load(".") throws', async () => {
    await expect(loader.load('.')).rejects.toThrow(/traversal/)
  })

  it('exists("..") throws', async () => {
    await expect(loader.exists('..')).rejects.toThrow(/traversal/)
  })

  it('list("..") throws', async () => {
    await expect(loader.list('..')).rejects.toThrow(/traversal/)
  })
})
