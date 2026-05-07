/**
 * Gbox Platform — Gbox Dawn bundle generator
 *
 * Decision #1 Step 1.17c. Walks the seed directory at
 *
 *     packages/core/src/modules/themes/seed/gbox-dawn/**
 *
 * and emits a TypeScript file
 *
 *     packages/core/src/modules/themes/seed/gbox-dawn-bundle.generated.ts
 *
 * that exports a frozen `Map<string, GboxDawnAsset>` keyed by the
 * theme-relative logical path (`'layout/theme.liquid'`,
 * `'templates/index.json'`, …). Every entry carries the asset's
 * UTF-8 source string + an inferred content type so the install
 * helper can hand it straight to `updateThemeAsset` without re-reading
 * the disk.
 *
 * Why generate-and-commit instead of reading the FS at runtime?
 *
 *   - The bundle has to ship inside Cloudflare Workers, where there
 *     is no `fs`. A static `Map` literal compiles down to a JS object
 *     and bundles fine via esbuild/wrangler.
 *   - The seed is small (~60 files, ~30 KB total source) — duplicating
 *     it into a generated module costs almost nothing.
 *   - Tests don't need a temp fixture: they just import the bundle.
 *
 * Run:
 *
 *     npx tsx scripts/generate-gbox-dawn-bundle.ts
 *
 * The script is idempotent — running it twice produces an identical
 * file (we sort entries by path for stable diffs).
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const SEED_DIR = path.join(
  REPO_ROOT,
  'packages',
  'core',
  'src',
  'modules',
  'themes',
  'seed',
  'gbox-dawn',
)
const OUT_FILE = path.join(
  REPO_ROOT,
  'packages',
  'core',
  'src',
  'modules',
  'themes',
  'seed',
  'gbox-dawn-bundle.generated.ts',
)

interface GeneratedEntry {
  key: string
  source: string
  contentType: string
}

const CONTENT_TYPES: Record<string, string> = {
  '.liquid': 'application/x-liquid',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.html': 'text/html',
  '.txt': 'text/plain',
}

function inferContentType(file: string): string {
  const ext = path.extname(file).toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

async function walk(dir: string, base: string = dir): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walk(full, base)))
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'))
    }
  }
  return out
}

function escapeJsString(value: string): string {
  // Use a JSON encoding then strip the outer quotes — handles every
  // tricky char (backslashes, quotes, control bytes) without us
  // hand-rolling an escape table.
  return JSON.stringify(value)
}

async function main(): Promise<void> {
  // 1. Verify the seed dir exists.
  try {
    const stat = await fs.stat(SEED_DIR)
    if (!stat.isDirectory()) {
      throw new Error(`${SEED_DIR} is not a directory`)
    }
  } catch (err) {
    throw new Error(
      `Seed dir missing: ${SEED_DIR} — run from repo root with the seed checked in.`,
      { cause: err as Error },
    )
  }

  // 2. Walk and collect every file.
  const relPaths = (await walk(SEED_DIR)).sort((a, b) => a.localeCompare(b))

  if (relPaths.length === 0) {
    throw new Error(`Seed dir ${SEED_DIR} is empty — nothing to bundle.`)
  }

  const entries: GeneratedEntry[] = []
  for (const rel of relPaths) {
    const abs = path.join(SEED_DIR, rel)
    const source = await fs.readFile(abs, 'utf8')
    entries.push({
      key: rel,
      source,
      contentType: inferContentType(rel),
    })
  }

  // 3. Emit the generated module.
  const header = `/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Produced by \`scripts/generate-gbox-dawn-bundle.ts\` from the seed
 * directory \`packages/core/src/modules/themes/seed/gbox-dawn/\`.
 *
 * Re-run the generator after editing the seed:
 *
 *     npx tsx scripts/generate-gbox-dawn-bundle.ts
 *
 * Decision #1 Step 1.17c.
 */

export interface GboxDawnAsset {
  /** Theme-relative logical path, e.g. \`'layout/theme.liquid'\`. */
  readonly key: string
  /** UTF-8 source for the asset. */
  readonly source: string
  /** Inferred content type from the file extension. */
  readonly contentType: string
}

export const GBOX_DAWN_BUNDLE_VERSION = '1.0.0'

export const GBOX_DAWN_BUNDLE: ReadonlyMap<string, GboxDawnAsset> = new Map<string, GboxDawnAsset>([
`

  const body = entries
    .map((e) => {
      return `  [${escapeJsString(e.key)}, { key: ${escapeJsString(e.key)}, source: ${escapeJsString(e.source)}, contentType: ${escapeJsString(e.contentType)} }],`
    })
    .join('\n')

  const footer = `
])
`

  const out = header + body + footer
  await fs.writeFile(OUT_FILE, out, 'utf8')

  console.log(
    `[generate-gbox-dawn-bundle] wrote ${entries.length} entries to ${path.relative(REPO_ROOT, OUT_FILE)}`,
  )
}

main().catch((err) => {
  console.error('[generate-gbox-dawn-bundle] failed:', err)
  process.exit(1)
})
