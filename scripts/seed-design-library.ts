/**
 * Gbox Platform — Seed the Design Library from an upstream mirror.
 *
 * Phase D1 / Design Library integration. Clones (or refreshes) the
 * upstream mirror into a temp directory, walks every brand folder
 * under `design-md/`, parses DESIGN.md + preview.html +
 * preview-dark.html, and upserts one row per brand into
 * `design_library_entries`.
 *
 * Idempotent — re-running the script is safe. Existing rows are
 * updated in place via `upsertSeedEntry` (ON CONFLICT on the partial
 * unique index `idx_design_library_seed_slug`).
 *
 * Environment:
 *
 *   - DESIGN_LIB_ORG    — optional. GitHub org/user. Default 'VoltAgent'.
 *   - DESIGN_LIB_REPO   — optional. Repo name. Default 'awesome-design-md'.
 *   - DESIGN_LIB_REF    — optional. Git ref (tag, branch, or sha).
 *                         Default 'HEAD' (= the default branch tip).
 *   - GITHUB_TOKEN      — optional. Required ONLY when the source repo
 *                         is private (e.g. internal forks). Public repos
 *                         clone anonymously over HTTPS without a token.
 *   - DESIGN_LIB_DRYRUN — optional. When truthy, the CLI parses every
 *                         brand but skips DB writes. Useful for verifying
 *                         the category map against a new upstream commit.
 *
 * Usage (public repo, default):
 *
 *   node --import tsx scripts/seed-design-library.ts
 *
 * Usage (private fork with PAT):
 *
 *   DESIGN_LIB_ORG=xaozayta DESIGN_LIB_REPO=awesome-design-md \
 *     GITHUB_TOKEN=ghp_… node --import tsx scripts/seed-design-library.ts
 *
 * Exit codes:
 *
 *   0 — all brands synced successfully.
 *   1 — clone failed, or a required file is missing.
 *   2 — one or more brands failed during upsert. Completed brands
 *       remain committed; re-running will pick up the rest.
 */

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, destroyDb } from '../packages/db/src/index.ts'
import { upsertSeedEntry } from '../packages/core/src/modules/design-library/upsert.ts'
import {
  BRAND_CATEGORY_MAP,
  categoryFor,
} from '../packages/core/src/modules/design-library/category-map.ts'
import { extractTitleAndSummary } from '../packages/core/src/modules/design-library/parse-design-md.ts'
import type { SeedDesignInput } from '../packages/core/src/modules/design-library/types.ts'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// 2026-04-27 — defaulted to the public VoltAgent mirror so anyone can
// run the seed without a PAT. Override via DESIGN_LIB_ORG / _REPO env
// vars when pulling from a private fork.
const DEFAULT_ORG = 'VoltAgent'
const DEFAULT_REPO = 'awesome-design-md'
const MIRROR_ORG = process.env.DESIGN_LIB_ORG?.trim() || DEFAULT_ORG
const MIRROR_REPO = process.env.DESIGN_LIB_REPO?.trim() || DEFAULT_REPO
const DEFAULT_REF = 'HEAD' // default-branch tip — works for public clones
const BRANDS_DIR = 'design-md'

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Token is optional now — public repos clone anonymously. We only
  // pass it through when set so private forks (e.g. xaozayta/) keep
  // working unchanged.
  const token = process.env.GITHUB_TOKEN ?? ''
  const ref = process.env.DESIGN_LIB_REF?.trim() || DEFAULT_REF
  const dryRun = truthy(process.env.DESIGN_LIB_DRYRUN)

  console.log('Gbox Platform — Design Library Seed')
  console.log('-'.repeat(50))
  console.log(`Mirror : ${MIRROR_ORG}/${MIRROR_REPO}`)
  console.log(`Ref    : ${ref}`)
  console.log(`Auth   : ${token ? 'PAT (private)' : 'anonymous (public)'}`)
  console.log(`Mode   : ${dryRun ? 'DRY-RUN (no DB writes)' : 'UPSERT'}`)
  console.log('-'.repeat(50))

  // Clone into a temp dir — deleted on exit regardless of success.
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gbox-design-seed-'))
  const repoDir = join(tmpRoot, MIRROR_REPO)
  let cleanupFailed = false

  try {
    cloneMirror(token, ref, repoDir)
    const actualSha = resolveSha(repoDir, ref)
    console.log(`[ok]   Cloned ${MIRROR_ORG}/${MIRROR_REPO} @ ${actualSha}`)

    const entries = parseAllBrands(repoDir, actualSha)
    console.log(`[ok]   Parsed ${entries.length} brands`)

    if (dryRun) {
      console.log('[skip] Dry run — skipping DB writes')
      for (const e of entries) {
        console.log(
          `  ${e.slug.padEnd(20)} ${e.category.padEnd(10)} ${e.title}`,
        )
      }
      return
    }

    const db = createDb()
    let ok = 0
    let failed = 0

    try {
      for (const e of entries) {
        try {
          const row = await upsertSeedEntry(db, e)
          console.log(
            `  [+] ${e.slug.padEnd(20)} ${e.category.padEnd(10)} → ${row.id}`,
          )
          ok++
        } catch (err: any) {
          console.error(
            `  [!] ${e.slug.padEnd(20)} FAILED: ${err.message}`,
          )
          failed++
        }
      }
    } finally {
      await destroyDb()
    }

    console.log('-'.repeat(50))
    console.log(`Done: ${ok} upserted, ${failed} failed`)
    if (failed > 0) process.exit(2)
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch (err: any) {
      // Non-fatal — Windows sometimes keeps git pack files open briefly.
      cleanupFailed = true
      console.warn(`[warn] Temp cleanup failed (${err.message}) — ${tmpRoot}`)
    }
    if (cleanupFailed) {
      console.warn(`        You can delete ${tmpRoot} manually later.`)
    }
  }
}

// ---------------------------------------------------------------------------
// Git clone
// ---------------------------------------------------------------------------

/**
 * Clone the mirror (blob-filtered) and checkout the target ref.
 *
 * `--filter=blob:none --no-checkout` gives us a metadata-only clone —
 * all commits and trees, but blobs fetch lazily on checkout. That's
 * ~1 % of a full clone's bytes and is enough to resolve any sha.
 *
 * We deliberately do NOT use `--depth 1 <sha>` on fetch: GitHub
 * rejects depth-1 fetches of arbitrary shas unless the ref is a
 * branch/tag tip. An unfiltered pull of the small ref history after
 * the blob-filtered clone is cheap and lets any sha resolve.
 *
 * We use `execFileSync` rather than passing the URL through a shell so
 * the PAT never hits a shell history or gets quoted wrong.
 */
function cloneMirror(token: string, ref: string, destDir: string): void {
  // Token-prefixed URL only when a PAT is supplied (private forks);
  // public clones use anonymous HTTPS so the URL doesn't leak to
  // shell history or git refs as a credential string.
  const cloneUrl = token
    ? `https://x-access-token:${token}@github.com/${MIRROR_ORG}/${MIRROR_REPO}.git`
    : `https://github.com/${MIRROR_ORG}/${MIRROR_REPO}.git`
  execFileSync(
    'git',
    [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      cloneUrl,
      destDir,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
  // Fetch all refs (still blob-filtered so network cost stays tiny).
  // This guarantees whatever sha/tag/branch the caller pinned resolves.
  // Skip when ref is HEAD — the initial clone already checked out the
  // default branch tip and a second fetch is wasted bandwidth.
  if (ref !== 'HEAD') {
    execFileSync('git', ['fetch', '--filter=blob:none', 'origin'], {
      cwd: destDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    execFileSync('git', ['checkout', ref], {
      cwd: destDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
  } else {
    // For HEAD just check out whatever the default branch resolves to.
    execFileSync('git', ['checkout', 'HEAD'], {
      cwd: destDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
  }
}

/** Resolve the full sha that the working tree is pointed at. */
function resolveSha(repoDir: string, ref: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.toString('utf8').trim()
  } catch {
    return ref
  }
}

// ---------------------------------------------------------------------------
// Parsing brand folders
// ---------------------------------------------------------------------------

function parseAllBrands(repoDir: string, upstreamSha: string): SeedDesignInput[] {
  const brandsRoot = join(repoDir, BRANDS_DIR)
  let folders: string[]
  try {
    folders = readdirSync(brandsRoot)
      .filter((name) => {
        // Skip hidden files and non-directories
        if (name.startsWith('.')) return false
        try {
          return statSync(join(brandsRoot, name)).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
  } catch (err: any) {
    console.error(
      `[FAIL] Could not read ${brandsRoot} — is the ref correct?`,
    )
    throw err
  }

  const out: SeedDesignInput[] = []
  const skipped: Array<{ slug: string; reason: string }> = []

  for (const folder of folders) {
    const slug = folder.toLowerCase()
    const category = categoryFor(slug)
    if (!category) {
      skipped.push({ slug, reason: 'no category mapping' })
      continue
    }

    const brandDir = join(brandsRoot, folder)
    const designMd = tryReadFile(join(brandDir, 'DESIGN.md'))
    if (!designMd) {
      skipped.push({ slug, reason: 'DESIGN.md missing' })
      continue
    }

    const previewHtml = tryReadFile(join(brandDir, 'preview.html'))
    const previewDarkHtml = tryReadFile(join(brandDir, 'preview-dark.html'))

    const { title, summary } = extractTitleAndSummary(designMd, slug)

    out.push({
      slug,
      title,
      summary,
      category,
      designMd,
      previewHtml,
      previewDarkHtml,
      upstreamSha,
    })
  }

  if (skipped.length > 0) {
    console.log('-'.repeat(50))
    console.log(`[warn] Skipped ${skipped.length} folders:`)
    for (const s of skipped) {
      console.log(`  - ${s.slug.padEnd(20)} (${s.reason})`)
    }
    console.log('-'.repeat(50))
  }

  // Diff check: every brand in the category map should exist upstream.
  // If the map has entries upstream doesn't, that's drift — log a warning.
  const seen = new Set(out.map((e) => e.slug))
  const missing = Object.keys(BRAND_CATEGORY_MAP).filter((s) => !seen.has(s))
  if (missing.length > 0) {
    console.log(`[warn] ${missing.length} mapped brands not found upstream:`)
    for (const s of missing) console.log(`  - ${s}`)
    console.log('-'.repeat(50))
  }

  return out
}

function tryReadFile(path: string): string | null {
  try {
    const buf = readFileSync(path)
    return buf.toString('utf8')
  } catch {
    return null
  }
}

function truthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('[FATAL]', err)
  process.exit(1)
})
