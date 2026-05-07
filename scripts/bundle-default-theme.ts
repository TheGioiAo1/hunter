/**
 * Gbox Platform — Bundle the gbox-theme-editor theme into a single TS module.
 *
 * Sprint 8 PR-A shipped a minimal 11-file inline subset of the Gbox
 * Default theme (header / hero / footer + a couple of templates).
 * That was a stub for the install pipeline to be verifiable; the
 * full 18-section theme lives in a sibling repo (`gbox-theme-editor/`)
 * and was always meant to be vendored back via a build script.
 *
 * This script reads every file under `gbox-theme-editor/theme/` and
 * regenerates `packages/core/src/modules/themes/default-theme-data.ts`
 * as a single TS module that exports `DEFAULT_THEME_FILES` — the same
 * shape `installDefaultTheme()` expects, just with 33 entries instead
 * of 11.
 *
 * Why a code-gen step instead of reading files at runtime:
 *   - `installDefaultTheme()` runs during seller signup and on demand
 *     from the Theme Library page; latency matters. Reading 33 files
 *     off disk every call is wasteful + adds an FS dependency to a
 *     hot path that today is pure-DB.
 *   - The platform server (`gbox-platform`) and the editor source
 *     (`gbox-theme-editor`) are separate repos. Vendoring via build
 *     means the platform repo can install Gbox Default with no
 *     runtime dependency on the editor repo's filesystem layout.
 *   - The bundled output is content-addressable + reviewable in
 *     a normal git diff (no hidden binary artefacts).
 *
 * Run:
 *
 *   node --import tsx scripts/bundle-default-theme.ts
 *
 * The script overwrites `default-theme-data.ts` in place. After running,
 * commit the change. The install-default tests will need their file-count
 * assertion bumped from 11 to whatever `BUNDLED.length` reports at the end.
 *
 * Inputs:
 *   - GBOX_THEME_EDITOR_PATH: optional override of the editor repo path.
 *     Defaults to `<workspace>/../../gbox-theme-editor` (sibling of
 *     gbox-platform).
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── Config ─────────────────────────────────────────────────────────────

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')

// Repo layout (typical dev workstation):
//   <vibecode>/
//   ├── gbox-platform/             ← REPO_ROOT (or REPO_ROOT/worktree/<branch>/)
//   ├── gbox-theme-editor/         ← sibling repo we vendor from
// Walk up from REPO_ROOT until we find a sibling named gbox-theme-editor.
// Override via GBOX_THEME_EDITOR_PATH if running in CI or a custom layout.
function findEditorPath(start: string): string {
  let cur = start
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(cur, 'gbox-theme-editor')
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      /* keep walking */
    }
    const parent = resolve(cur, '..')
    if (parent === cur) break
    cur = parent
  }
  // Fallback to the original guess so the error message points at a real path.
  return resolve(start, '..', '..', 'gbox-theme-editor')
}

const EDITOR_PATH = process.env.GBOX_THEME_EDITOR_PATH ?? findEditorPath(REPO_ROOT)
const THEME_DIR = join(EDITOR_PATH, 'theme')
const OUTPUT_FILE = resolve(
  REPO_ROOT,
  'packages/core/src/modules/themes/default-theme-data.ts',
)

// Whitelist of directories we vendor. Keep this aligned with the
// importer + Shopify Online Store 2.0 spec — anything outside these
// roots silently dropped to avoid pulling in build artefacts (.bak,
// .test, node_modules, etc).
const ALLOWED_DIRS = [
  'layout',
  'templates',
  'sections',
  'snippets',
  'assets',
  'config',
  'locales',
] as const

const EXT_TO_LANGUAGE: Record<string, 'liquid' | 'css' | 'js' | 'json'> = {
  '.liquid': 'liquid',
  '.css': 'css',
  '.js': 'js',
  '.json': 'json',
}

// ─── File walker ────────────────────────────────────────────────────────

interface VendorFile {
  /** Path relative to the theme root, posix style: "sections/header.liquid". */
  path: string
  language: 'liquid' | 'css' | 'js' | 'json'
  content: string
}

function walkTheme(rootDir: string): VendorFile[] {
  const out: VendorFile[] = []
  for (const dir of ALLOWED_DIRS) {
    const abs = join(rootDir, dir)
    let entries: string[]
    try {
      entries = readdirSync(abs)
    } catch {
      continue // dir doesn't exist — skip silently
    }
    walkDir(abs, abs, dir, out)
  }
  return out
}

function walkDir(absRoot: string, abs: string, relPosix: string, out: VendorFile[]): void {
  const entries = readdirSync(abs)
  for (const name of entries) {
    const full = join(abs, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walkDir(absRoot, full, `${relPosix}/${name}`, out)
      continue
    }
    const lower = name.toLowerCase()
    const dot = lower.lastIndexOf('.')
    if (dot < 0) continue
    const ext = lower.slice(dot)
    const lang = EXT_TO_LANGUAGE[ext]
    if (!lang) continue
    const content = readFileSync(full, 'utf8')
    const path = `${relPosix}/${name}`
    out.push({ path, language: lang, content })
  }
}

// ─── Code generator ─────────────────────────────────────────────────────

function jsonString(s: string): string {
  // Use JSON.stringify so newlines, quotes, backslashes are escaped
  // safely. The result is always wrapped in double quotes — valid TS
  // string literal. Long lines are fine; modern TS compilers don't
  // care about line length.
  return JSON.stringify(s)
}

function generateModule(files: VendorFile[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  const entries = sorted
    .map((f) =>
      [
        '  {',
        `    path: ${jsonString(f.path)},`,
        `    language: ${jsonString(f.language)},`,
        `    content: ${jsonString(f.content)},`,
        '  },',
      ].join('\n'),
    )
    .join('\n')

  const header = `/**
 * default-theme-data.ts — auto-generated by scripts/bundle-default-theme.ts.
 *
 * DO NOT EDIT BY HAND. Re-run the bundler whenever the gbox-theme-editor
 * source changes. The bundler reads every file under that repo's
 * \`theme/\` directory (layout, templates, sections, snippets, assets,
 * config, locales) and emits this module as a flat array of
 * { path, language, content } records.
 *
 * Files: ${sorted.length}
 * Bundled at: ${new Date().toISOString()}
 *
 * Consumers:
 *   - \`installDefaultTheme()\` in install-default.ts inserts each
 *     entry into theme_files + materialises theme_page_sections from
 *     the templates/*.json entries.
 *   - The Theme Library "Use Gbox Default" CTA hits this module
 *     transitively via that handler.
 *
 * Why we vendor instead of read at runtime: see scripts/bundle-default-theme.ts
 * module header. Short version: faster cold start, no FS dependency
 * in the install hot path, separate-repo source-of-truth stays clean.
 */

export interface DefaultThemeFile {
  path: string
  content: string
  language: 'liquid' | 'css' | 'js' | 'json'
}

export const DEFAULT_THEME_NAME = 'Gbox Default'

export const DEFAULT_THEME_FILES: readonly DefaultThemeFile[] = [
${entries}
] as const
`

  return header
}

// ─── Entry point ────────────────────────────────────────────────────────

function main(): void {
  console.log(`[bundle-default-theme] reading ${THEME_DIR}`)
  const files = walkTheme(THEME_DIR)
  if (files.length === 0) {
    console.error(`[bundle-default-theme] no files found under ${THEME_DIR}`)
    process.exit(1)
  }

  console.log(`[bundle-default-theme] vendored ${files.length} files:`)
  for (const f of files) {
    console.log(`  ${f.path} (${f.language}, ${f.content.length} bytes)`)
  }

  const module_ = generateModule(files)
  writeFileSync(OUTPUT_FILE, module_, 'utf8')
  const out = relative(REPO_ROOT, OUTPUT_FILE)
  console.log(`\n[bundle-default-theme] wrote ${out} (${module_.length} bytes)`)
  console.log(`\nNext: bump test assertion 'filesWritten === 11' to ${files.length}.`)
}

main()
