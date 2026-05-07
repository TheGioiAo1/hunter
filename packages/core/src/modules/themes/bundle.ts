/**
 * Gbox Platform — Theme bundle serializer (Stage 5.2)
 *
 * Pure, deterministic export/import of a theme's file tree. The
 * module does NOT know about zip, tar, S3, or the filesystem —
 * all it knows is: a theme is a map of `path → contents` strings,
 * plus a manifest with hashes + metadata.
 *
 *   bundleTheme(files, meta)  → { manifest, files }
 *   parseThemeBundle(manifest, files) → { ok: true, theme }
 *                                     | { ok: false, errors }
 *   hashFileContent(contents) → short hex digest
 *
 * The admin API wraps these with a zip adapter in a later stage —
 * that's the only place bytes actually move. Keeping the bundler
 * pure means the test suite can round-trip every theme in the repo
 * without touching disk.
 *
 * Why a hand-rolled hash instead of `crypto`? Cloudflare Workers
 * friendliness — we stay free of `node:crypto` so the same bundle
 * format ships to every runtime. FNV-1a 64-bit (two-register
 * variant) is strong enough for tamper detection inside a trusted
 * admin boundary; if we ever need real integrity we'll add a
 * SHA-256 step on top, not replace this one.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A theme's file tree — paths are POSIX style (no leading slash). */
export type ThemeBundleFiles = Record<string, string>

export interface ThemeBundleMeta {
  /** Human-readable theme name (e.g. `"Gbox Minimal"`). */
  name: string
  /** Semver version — enforced at bundle time. */
  version: string
  /** Attribution for the Theme Marketplace. */
  author: string
  /** Optional one-line description. */
  description?: string
  /** Optional license identifier (SPDX id, e.g. `"MIT"`). */
  license?: string
}

export interface ThemeBundleFileEntry {
  path: string
  hash: string
  size: number
}

export interface ThemeBundleManifest extends ThemeBundleMeta {
  /** ISO-8601 timestamp stamped at bundle time. */
  createdAt: string
  /**
   * Top-level directories this theme ships. Used by the import
   * path to sanity-check the upload before extracting every file.
   */
  directories: string[]
  /** One entry per file, sorted alphabetically by path. */
  files: ThemeBundleFileEntry[]
}

export type ThemeBundleErrorCode =
  | 'empty_manifest'
  | 'missing_file'
  | 'hash_mismatch'
  | 'invalid_version'
  | 'unsafe_path'

export interface ThemeBundleError {
  path: string
  code: ThemeBundleErrorCode
  message: string
}

export interface ParsedThemeBundle {
  manifest: ThemeBundleManifest
  files: ThemeBundleFiles
  name: string
}

export type ParseThemeBundleResult =
  | { ok: true; theme: ParsedThemeBundle }
  | { ok: false; errors: ThemeBundleError[] }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The set of paths every theme MUST ship. If any of these are
 * missing the bundler refuses to produce a manifest — merchants
 * who omit `layout/theme.liquid` get a clear error, not a silent
 * broken install.
 */
export const REQUIRED_THEME_FILES: readonly string[] = [
  'layout/theme.liquid',
]

/** Semver x.y.z with an optional pre-release tag. No build metadata. */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

// ---------------------------------------------------------------------------
// bundleTheme
// ---------------------------------------------------------------------------

export interface BundleThemeOptions {
  /** Override the `createdAt` stamp — useful for deterministic tests. */
  now?: Date
}

export function bundleTheme(
  files: ThemeBundleFiles,
  meta: ThemeBundleMeta,
  opts: BundleThemeOptions = {},
): { manifest: ThemeBundleManifest; files: ThemeBundleFiles } {
  const paths = Object.keys(files)
  if (paths.length === 0) {
    throw new Error('bundleTheme: need at least one file')
  }
  for (const required of REQUIRED_THEME_FILES) {
    if (!(required in files)) {
      throw new Error(`bundleTheme: missing required file ${required}`)
    }
  }
  if (!SEMVER_RE.test(meta.version)) {
    throw new Error(
      `bundleTheme: version ${meta.version} is not valid semver (expected x.y.z)`,
    )
  }

  const sorted = [...paths].sort()
  const entries: ThemeBundleFileEntry[] = sorted.map((path) => {
    const contents = files[path]!
    return {
      path,
      hash: hashFileContent(contents),
      size: byteLength(contents),
    }
  })

  const directories = uniqueTopLevelDirs(sorted)

  const manifest: ThemeBundleManifest = {
    name: meta.name,
    version: meta.version,
    author: meta.author,
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.license ? { license: meta.license } : {}),
    createdAt: (opts.now ?? new Date()).toISOString(),
    directories,
    files: entries,
  }

  // Output the file map as-is — we don't rewrite contents, we only
  // hash them. The caller streams both into a zip.
  return { manifest, files: { ...files } }
}

// ---------------------------------------------------------------------------
// parseThemeBundle
// ---------------------------------------------------------------------------

export function parseThemeBundle(
  manifest: ThemeBundleManifest,
  files: ThemeBundleFiles,
): ParseThemeBundleResult {
  const errors: ThemeBundleError[] = []

  if (!manifest.files || manifest.files.length === 0) {
    errors.push({
      path: '',
      code: 'empty_manifest',
      message: 'manifest declares no files',
    })
    return { ok: false, errors }
  }

  if (!SEMVER_RE.test(manifest.version)) {
    errors.push({
      path: '',
      code: 'invalid_version',
      message: `version ${manifest.version} is not valid semver`,
    })
  }

  // Walk every declared entry in order so error ordering is stable.
  const resultFiles: ThemeBundleFiles = {}
  for (const entry of manifest.files) {
    if (!isSafePath(entry.path)) {
      errors.push({
        path: entry.path,
        code: 'unsafe_path',
        message: `path ${entry.path} is outside the bundle root`,
      })
      continue
    }
    if (!(entry.path in files)) {
      errors.push({
        path: entry.path,
        code: 'missing_file',
        message: `declared file ${entry.path} not present in upload`,
      })
      continue
    }
    const contents = files[entry.path]!
    const actual = hashFileContent(contents)
    if (actual !== entry.hash) {
      errors.push({
        path: entry.path,
        code: 'hash_mismatch',
        message: `expected hash ${entry.hash}, got ${actual}`,
      })
      continue
    }
    resultFiles[entry.path] = contents
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    theme: {
      manifest,
      files: resultFiles,
      name: manifest.name,
    },
  }
}

// ---------------------------------------------------------------------------
// hashFileContent
// ---------------------------------------------------------------------------

/**
 * Deterministic short digest for a UTF-8 file body. Uses a 64-bit
 * FNV-1a variant (two 32-bit registers mixed) so collisions are
 * unlikely inside a single theme (a few hundred files at most).
 *
 * Returned as a 16-char lowercase hex string so it fits neatly in
 * JSON and diff output.
 */
export function hashFileContent(input: string): string {
  let h1 = 0x811c9dc5 >>> 0
  let h2 = 0x01000193 >>> 0
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 ^= c
    h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0
    h2 ^= (c << 3) | (c >>> 5)
    h2 = (h2 + ((h2 << 2) + (h2 << 5) + (h2 << 11) + (h2 << 17))) >>> 0
  }
  return (
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0')
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function byteLength(s: string): number {
  // Approximate UTF-8 length without pulling in `Buffer`.
  let len = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) len += 1
    else if (c < 0x800) len += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      // Surrogate pair — 4 bytes in UTF-8.
      len += 4
      i += 1
    } else len += 3
  }
  return len
}

function uniqueTopLevelDirs(paths: string[]): string[] {
  const set = new Set<string>()
  for (const p of paths) {
    const slash = p.indexOf('/')
    if (slash === -1) continue
    set.add(p.slice(0, slash))
  }
  return [...set].sort()
}

function isSafePath(path: string): boolean {
  if (!path || path.startsWith('/')) return false
  if (path.includes('\\')) return false
  const segments = path.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false
  }
  return true
}
