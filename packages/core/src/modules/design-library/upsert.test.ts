/**
 * Design Library — upsert helpers (Phase D1).
 *
 * The full DB behaviour (ON CONFLICT against the partial unique index,
 * updated_at trigger firing, check-constraint rejection of bad source
 * rows) is validated against live Postgres during the smoke run —
 * mocking Kysely's raw-sql executor provider is too fragile for that
 * purpose and tests a layer we don't own.
 *
 * These tests lock the pieces we DO want to guard at unit level:
 *
 *   1. The SQL string we send contains the invariants that Postgres
 *      won't catch if we typo them (wrong ON CONFLICT target, wrong
 *      column list, wrong partial-index WHERE clause).
 *   2. Public types + input shapes don't drift.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { CloneDesignInput, SeedDesignInput } from './types.js'

const UPSERT_SRC = readFileSync(
  new URL('./upsert.ts', import.meta.url),
  'utf8',
)

// ---------------------------------------------------------------------------
// Source-level invariants for the INSERT SQL (seeds)
// ---------------------------------------------------------------------------

describe('upsertSeedEntry — SQL source', () => {
  it('targets the design_library_entries table', () => {
    expect(UPSERT_SRC).toMatch(/INSERT INTO design_library_entries/i)
  })

  it('sets source = \'seed\' on the INSERT (not configurable)', () => {
    expect(UPSERT_SRC).toMatch(/source:\s*'seed'\s+as\s+const/)
  })

  it('leaves shop_id null for seeds (check constraint invariant)', () => {
    expect(UPSERT_SRC).toMatch(/shop_id:\s*null/)
  })

  it('uses ON CONFLICT (slug) WHERE source = \'seed\' for the partial index', () => {
    // The partial unique index `idx_design_library_seed_slug` has a
    // WHERE clause, so ON CONFLICT must repeat it verbatim or
    // Postgres won't match the index and the upsert falls over.
    expect(UPSERT_SRC).toMatch(
      /ON CONFLICT\s*\(\s*slug\s*\)\s*WHERE\s+source\s*=\s*'seed'/i,
    )
  })

  it('updates the mutable columns on conflict (title, summary, category, md, previews, sha)', () => {
    const onConflictBlock = UPSERT_SRC
      .split(/DO UPDATE SET/i)[1]
      ?.split(/`/)[0] ?? ''
    expect(onConflictBlock).toMatch(/title\s*=\s*EXCLUDED\.title/)
    expect(onConflictBlock).toMatch(/summary\s*=\s*EXCLUDED\.summary/)
    expect(onConflictBlock).toMatch(/category\s*=\s*EXCLUDED\.category/)
    expect(onConflictBlock).toMatch(/design_md\s*=\s*EXCLUDED\.design_md/)
    expect(onConflictBlock).toMatch(/preview_html\s*=\s*EXCLUDED\.preview_html/)
    expect(onConflictBlock).toMatch(
      /preview_dark_html\s*=\s*EXCLUDED\.preview_dark_html/,
    )
    expect(onConflictBlock).toMatch(/upstream_sha\s*=\s*EXCLUDED\.upstream_sha/)
    expect(onConflictBlock).toMatch(/updated_at\s*=\s*EXCLUDED\.updated_at/)
  })

  it('does NOT overwrite D3/D5-owned columns on conflict (preview URLs, thumbnail, storage_tier)', () => {
    const onConflictBlock = UPSERT_SRC
      .split(/DO UPDATE SET/i)[1]
      ?.split(/`/)[0] ?? ''
    // These columns are owned by the S3 migrator (D3) and the thumbnail
    // worker (D5). A seed re-sync must not clobber them or a cold-tier
    // row gets promoted back to hot with stale TEXT.
    expect(onConflictBlock).not.toMatch(/preview_html_url\s*=/)
    expect(onConflictBlock).not.toMatch(/preview_dark_html_url\s*=/)
    expect(onConflictBlock).not.toMatch(/thumbnail_url\s*=/)
    expect(onConflictBlock).not.toMatch(/storage_tier\s*=/)
  })
})

// ---------------------------------------------------------------------------
// Input type stability (regression guard)
// ---------------------------------------------------------------------------

describe('upsertSeedEntry — input type', () => {
  it('SeedDesignInput accepts the exact 8-field shape', () => {
    const input: SeedDesignInput = {
      slug: 'airbnb',
      title: 'Airbnb',
      summary: 'Belong anywhere.',
      category: 'travel',
      designMd: '# Airbnb',
      previewHtml: '<html></html>',
      previewDarkHtml: null,
      upstreamSha: '80bbbc2',
    }
    // Type-level regression — if anyone adds a required field without
    // updating the sync CLI, this stops compiling.
    expect(input.slug).toBe('airbnb')
  })
})

describe('insertCloneEntry — input type', () => {
  it('CloneDesignInput requires shopId + sourceCloneJobId', () => {
    const input: CloneDesignInput = {
      slug: 'clone-abc12345',
      shopId: 'shop-1',
      title: "Merchant's Store",
      summary: null,
      designMd: '# Store',
      previewHtml: null,
      previewDarkHtml: null,
      sourceThemeId: 'theme-1',
      sourceCloneJobId: 'job-1',
    }
    expect(input.slug.startsWith('clone-')).toBe(true)
  })
})
