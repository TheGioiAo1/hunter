/**
 * Gbox Platform — Theme bundle export/import tests (Stage 5.2)
 *
 * The bundle module is a pure serializer. Given a set of theme
 * files (keyed by template path, each a UTF-8 string), it:
 *
 *   • `bundleTheme(files, meta)` → { manifest, files }
 *       produces a manifest with a hash of every file, a summary
 *       of required top-level directories, and the theme's name /
 *       version / author metadata. Callers then stream the files +
 *       manifest into a zip elsewhere.
 *
 *   • `parseThemeBundle(manifest, files)` → { ok, theme } | { ok: false, errors }
 *       the reverse gate: given a manifest + file map (as if just
 *       unzipped), verify every declared file is present, the hash
 *       matches, and the manifest is well-formed.
 *
 * No filesystem, no zip library, no network — the admin API wraps
 * this with a Node `zip`/`unzip` adapter later.
 */

import { describe, it, expect } from 'vitest'
import {
  bundleTheme,
  parseThemeBundle,
  hashFileContent,
  type ThemeBundleManifest,
  type ThemeBundleFiles,
} from './bundle.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const files: ThemeBundleFiles = {
  'layout/theme.liquid': '<!doctype html>{{ content_for_layout }}',
  'templates/index.json': '{"sections":{}}',
  'sections/header.liquid': '<header>{{ shop.name }}</header>',
  'config/settings_schema.json': '[]',
  'assets/theme.css': 'body { color: #000 }',
  'locales/en.default.json': '{"hello":"Hello"}',
}

const meta = {
  name: 'Gbox Minimal',
  version: '1.0.0',
  author: 'Gbox',
}

// ---------------------------------------------------------------------------
// bundleTheme
// ---------------------------------------------------------------------------

describe('bundleTheme', () => {
  it('produces a manifest with every file hashed', () => {
    const out = bundleTheme(files, meta)
    expect(out.manifest.name).toBe('Gbox Minimal')
    expect(out.manifest.version).toBe('1.0.0')
    expect(out.manifest.files).toHaveLength(Object.keys(files).length)
    for (const entry of out.manifest.files) {
      expect(entry.hash).toMatch(/^[0-9a-f]{8,}$/)
      expect(entry.size).toBeGreaterThan(0)
      expect(files[entry.path]).toBeDefined()
    }
  })

  it('is deterministic — same input → byte-identical manifest', () => {
    // Inject a frozen `now` so the createdAt stamp can't span a ms
    // boundary between the two calls — without this, fast CI runners
    // produced 1-in-~5000 flakes where Date.now() ticked between
    // call A and call B (e.g. ...:953Z vs ...:954Z).
    const now = new Date('2026-04-09T12:00:00Z')
    const a = bundleTheme(files, meta, { now })
    const b = bundleTheme(files, meta, { now })
    expect(JSON.stringify(a.manifest)).toBe(JSON.stringify(b.manifest))
  })

  it('sorts the file list by path so diffs stay readable', () => {
    const out = bundleTheme(files, meta)
    const paths = out.manifest.files.map((f) => f.path)
    const sorted = [...paths].sort()
    expect(paths).toEqual(sorted)
  })

  it('stamps a createdAt ISO timestamp on every bundle', () => {
    const out = bundleTheme(files, meta, {
      now: new Date('2026-04-09T12:00:00Z'),
    })
    expect(out.manifest.createdAt).toBe('2026-04-09T12:00:00.000Z')
  })

  it('records which top-level directories the theme ships', () => {
    const out = bundleTheme(files, meta)
    expect(out.manifest.directories.sort()).toEqual(
      ['assets', 'config', 'layout', 'locales', 'sections', 'templates'].sort(),
    )
  })

  it('throws when the file map is empty', () => {
    expect(() => bundleTheme({}, meta)).toThrow(/at least one file/i)
  })

  it('throws when the required layout file is missing', () => {
    const broken: ThemeBundleFiles = {
      'templates/index.json': '{}',
    }
    expect(() => bundleTheme(broken, meta)).toThrow(/layout\/theme\.liquid/i)
  })

  it('rejects an invalid semver version', () => {
    expect(() =>
      bundleTheme(files, { ...meta, version: 'beta' }),
    ).toThrow(/version/i)
  })
})

// ---------------------------------------------------------------------------
// parseThemeBundle
// ---------------------------------------------------------------------------

describe('parseThemeBundle', () => {
  it('round-trips a bundleTheme output', () => {
    const out = bundleTheme(files, meta)
    const parsed = parseThemeBundle(out.manifest, files)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.theme.name).toBe('Gbox Minimal')
    expect(Object.keys(parsed.theme.files).sort()).toEqual(
      Object.keys(files).sort(),
    )
  })

  it('rejects when a declared file is missing from the file map', () => {
    const out = bundleTheme(files, meta)
    const broken = { ...files }
    delete broken['assets/theme.css']
    const parsed = parseThemeBundle(out.manifest, broken)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.some((e) => e.code === 'missing_file')).toBe(true)
  })

  it('rejects when a file hash does not match the manifest', () => {
    const out = bundleTheme(files, meta)
    const tampered = { ...files, 'assets/theme.css': 'body { color: red }' }
    const parsed = parseThemeBundle(out.manifest, tampered)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.some((e) => e.code === 'hash_mismatch')).toBe(true)
  })

  it('rejects a manifest with no files', () => {
    const badManifest: ThemeBundleManifest = {
      name: 'x',
      version: '1.0.0',
      author: 'x',
      createdAt: new Date().toISOString(),
      directories: [],
      files: [],
    }
    const parsed = parseThemeBundle(badManifest, {})
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors[0]!.code).toBe('empty_manifest')
  })

  it('rejects a manifest with a bad version', () => {
    const out = bundleTheme(files, meta)
    const broken: ThemeBundleManifest = { ...out.manifest, version: 'beta' }
    const parsed = parseThemeBundle(broken, files)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.some((e) => e.code === 'invalid_version')).toBe(true)
  })

  it('rejects path traversal attempts in manifest entries', () => {
    const out = bundleTheme(files, meta)
    const broken: ThemeBundleManifest = {
      ...out.manifest,
      files: [
        ...out.manifest.files,
        { path: '../../etc/passwd', hash: 'deadbeef', size: 1 },
      ],
    }
    const parsed = parseThemeBundle(broken, {
      ...files,
      '../../etc/passwd': 'pwned',
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.some((e) => e.code === 'unsafe_path')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hashFileContent
// ---------------------------------------------------------------------------

describe('hashFileContent', () => {
  it('is deterministic for the same input', () => {
    expect(hashFileContent('abc')).toBe(hashFileContent('abc'))
  })

  it('changes when the input changes', () => {
    expect(hashFileContent('abc')).not.toBe(hashFileContent('abd'))
  })

  it('returns only lowercase hex characters', () => {
    expect(hashFileContent('hello world')).toMatch(/^[0-9a-f]+$/)
  })
})
