/**
 * Design Library — write helpers (Phase D1).
 *
 * Two write paths, one table:
 *
 *   - `upsertSeedEntry(db, input)` — the sync-seed CLI calls this once
 *     per upstream brand. Idempotent (upsert on `slug` via the partial
 *     unique index `idx_design_library_seed_slug`). A re-sync after
 *     upstream bumps the DESIGN.md for a brand will update the row in
 *     place and bump `updated_at`.
 *
 *   - `insertCloneEntry(db, input)` — the clone-pro pipeline calls this
 *     once per successful run (D2 hook). Not an upsert — each clone
 *     job is unique by design, so duplicate slugs would indicate a
 *     caller bug and we want the DB's unique constraint to surface it.
 *
 * Storage tier is ALWAYS 'hot' at write time. The D3 S3 migrator
 * promotes rows to 'cold' asynchronously when preview HTML crosses
 * ~200 KB; write code never needs to worry about that path.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type {
  CloneDesignInput,
  DesignLibraryEntry,
  SeedDesignInput,
} from './types.js'
import { getEntryBySlug } from './queries.js'

// ---------------------------------------------------------------------------
// Seed upsert
// ---------------------------------------------------------------------------

/**
 * Insert-or-update one SEED entry. Keyed on (slug) via the partial
 * unique index — the DB enforces that seed slugs are globally unique.
 *
 * Fields that change on re-sync:
 *   - title, summary, category (upstream README rewrites)
 *   - design_md (the whole point of a re-sync)
 *   - preview_html / preview_dark_html (re-rendered from new markdown)
 *   - upstream_sha (stamp the current mirror sha)
 *   - updated_at (bumped by the 019 trigger)
 *
 * Fields that are NEVER changed on re-sync:
 *   - id, created_at — preserves the uuid so external refs don't break
 *   - shop_id — always null for seeds (enforced by check constraint)
 *   - source — always 'seed' for this entry path
 *   - storage_tier — D3 owns this column; sync never touches it
 *   - preview_html_url / preview_dark_html_url / thumbnail_url — D3/D5
 *     own these (sync would clobber them otherwise)
 *   - source_theme_id / source_clone_job_id — irrelevant for seeds
 *
 * Returns the row after the write (post-trigger, post-default-fill).
 */
export async function upsertSeedEntry(
  db: Kysely<Database>,
  input: SeedDesignInput,
): Promise<DesignLibraryEntry> {
  const now = new Date().toISOString()
  const insertRow = {
    slug: input.slug,
    source: 'seed' as const,
    shop_id: null,
    title: input.title,
    summary: input.summary,
    category: input.category,
    design_md: input.designMd,
    preview_html: input.previewHtml,
    preview_dark_html: input.previewDarkHtml,
    // URL + tier + lineage columns are left at their defaults / null.
    // D3 and D5 are the only writers for those.
    storage_tier: 'hot',
    upstream_sha: input.upstreamSha,
    created_at: now,
    updated_at: now,
  }

  // Upsert via the partial unique index on (slug WHERE source='seed').
  // Postgres needs the WHERE clause on the conflict target to use a
  // PARTIAL index — otherwise it can't prove the index matches the
  // constraint set. `ON CONFLICT (slug) WHERE source = 'seed'` is the
  // correct form.
  await sql`
    INSERT INTO design_library_entries (
      slug, source, shop_id, title, summary, category,
      design_md, preview_html, preview_dark_html,
      storage_tier, upstream_sha, created_at, updated_at
    )
    VALUES (
      ${insertRow.slug}, ${insertRow.source}, ${insertRow.shop_id},
      ${insertRow.title}, ${insertRow.summary}, ${insertRow.category},
      ${insertRow.design_md}, ${insertRow.preview_html}, ${insertRow.preview_dark_html},
      ${insertRow.storage_tier}, ${insertRow.upstream_sha},
      ${insertRow.created_at}, ${insertRow.updated_at}
    )
    ON CONFLICT (slug) WHERE source = 'seed'
    DO UPDATE SET
      title             = EXCLUDED.title,
      summary           = EXCLUDED.summary,
      category          = EXCLUDED.category,
      design_md         = EXCLUDED.design_md,
      preview_html      = EXCLUDED.preview_html,
      preview_dark_html = EXCLUDED.preview_dark_html,
      upstream_sha      = EXCLUDED.upstream_sha,
      updated_at        = EXCLUDED.updated_at
  `.execute(db)

  // Read back — the insert doesn't return the post-trigger row and
  // the sync CLI wants to log the id for each brand.
  const row = await getEntryBySlug(db, { slug: input.slug, source: 'seed' })
  if (!row) {
    // Should be impossible — we just inserted it. Surface loudly.
    throw new Error(
      `upsertSeedEntry: row not found after upsert for slug=${input.slug}`,
    )
  }
  return row
}

// ---------------------------------------------------------------------------
// Clone insert
// ---------------------------------------------------------------------------

/**
 * Insert one CLONE entry. Not an upsert — each clone job is unique, so
 * a duplicate slug would be a caller bug (e.g. the D2 hook firing
 * twice). Let the partial unique index
 * `idx_design_library_clone_slug` (shop_id, slug WHERE source='clone')
 * raise the error.
 *
 * The row starts in the 'hot' tier with the preview HTML inlined. D3
 * will promote it to 'cold' if the HTML exceeds the threshold.
 */
export async function insertCloneEntry(
  db: Kysely<Database>,
  input: CloneDesignInput,
): Promise<DesignLibraryEntry> {
  const now = new Date().toISOString()
  const row = await db
    .insertInto('design_library_entries')
    .values({
      slug: input.slug,
      source: 'clone',
      shop_id: input.shopId,
      title: input.title,
      summary: input.summary,
      // Clones have no category — they're the merchant's own site, not
      // a curated brand. UI renders a generic "My Clone" chip instead.
      category: null,
      design_md: input.designMd,
      preview_html: input.previewHtml,
      preview_dark_html: input.previewDarkHtml,
      storage_tier: 'hot',
      source_theme_id: input.sourceThemeId,
      source_clone_job_id: input.sourceCloneJobId,
      upstream_sha: null,
      created_at: now,
      updated_at: now,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()

  return {
    id: String(row.id),
    slug: String(row.slug),
    source: 'clone',
    shopId: row.shop_id as string,
    title: String(row.title),
    summary: (row.summary as string | null) ?? null,
    category: null,
    designMd: String(row.design_md ?? ''),
    previewHtml: (row.preview_html as string | null) ?? null,
    previewDarkHtml: (row.preview_dark_html as string | null) ?? null,
    previewHtmlUrl: (row.preview_html_url as string | null) ?? null,
    previewDarkHtmlUrl: (row.preview_dark_html_url as string | null) ?? null,
    thumbnailUrl: (row.thumbnail_url as string | null) ?? null,
    storageTier: (row.storage_tier as 'hot' | 'cold') ?? 'hot',
    sourceThemeId: (row.source_theme_id as string | null) ?? null,
    sourceCloneJobId: (row.source_clone_job_id as string | null) ?? null,
    upstreamSha: null,
    createdAt: toIso(row.created_at as string | Date),
    updatedAt: toIso(row.updated_at as string | Date),
  }
}

// ---------------------------------------------------------------------------
// Clone delete
// ---------------------------------------------------------------------------

/**
 * Remove one CLONE entry from the library. Scoped to (shopId, slug) so
 * a caller with access to shop A can never wipe shop B's rows, even if
 * a slug happens to collide across shops (the partial unique index on
 * (shop_id, slug) guarantees the pair is unique per shop).
 *
 * SEED entries are NEVER deletable via this path — the `source='clone'`
 * predicate on the delete makes it a no-op if someone passes a seed
 * slug by accident.
 *
 * Important: this does NOT delete the theme row that was produced by
 * the clone run. The seller may have already applied the theme to
 * another store via Clone Library (Phase 4). Deleting here only
 * removes the Design Library surface; the underlying theme keeps
 * standing.
 *
 * Returns `true` if a row was deleted, `false` if nothing matched.
 */
export async function deleteCloneEntry(
  db: Kysely<Database>,
  input: { readonly shopId: string; readonly slug: string },
): Promise<boolean> {
  const result = await db
    .deleteFrom('design_library_entries')
    .where('source', '=', 'clone')
    .where('shop_id', '=', input.shopId)
    .where('slug', '=', input.slug)
    .executeTakeFirst()

  // Kysely returns numDeletedRows as a bigint on Postgres; coerce.
  return Number(result.numDeletedRows ?? 0) > 0
}

function toIso(v: string | Date): string {
  if (v instanceof Date) return v.toISOString()
  return v
}
