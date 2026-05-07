/**
 * Design Library — shared types (Phase D1).
 *
 * All reads and writes in this module speak these shapes, not the raw
 * Kysely row types. That keeps route/UI code free of DB-specific
 * Generated<T> wrappers and nullable-for-insert quirks.
 *
 * The row model unifies TWO different entry flavours:
 *
 *   - 'seed'  — curated upstream brand design system, synced from the
 *               private mirror at xaozayta/awesome-design-md by the
 *               sync-seed CLI. Global (shop_id = null).
 *   - 'clone' — per-merchant row stamped by every successful clone-pro
 *               run (D2 wiring). Shop-scoped (shop_id != null).
 *
 * The TABLE invariant enforced by check constraint
 * `design_library_source_shop_consistent` is that seed rows have
 * shop_id NULL and clone rows have shop_id NOT NULL. The helpers in
 * this module assume that invariant.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Where an entry came from. Matches CHECK(source IN ('seed','clone')). */
export type DesignLibrarySource = 'seed' | 'clone'

/**
 * Storage tier. Hot = inlined TEXT columns; cold = S3-backed with a
 * CDN URL. The D3 S3 migrator flips rows to 'cold' when preview HTML
 * crosses ~200 KB — keeps hot list queries narrow and avoids TOAST
 * fetches on the gallery grid.
 */
export type DesignLibraryStorageTier = 'hot' | 'cold'

/**
 * Gallery categories for SEED entries. 9 buckets copied verbatim from
 * the upstream awesome-design-md README (Thai locked the list in Q3).
 *
 * Position 1 is E-commerce because Gbox is an e-commerce platform; the
 * other 8 keep their upstream ordering. CLONE entries ignore this
 * enum — their category column is NULL.
 */
export const DESIGN_LIBRARY_CATEGORIES = [
  'ecom',      // E-commerce & Marketplaces (position 1 — promoted)
  'ai',        // AI & Machine Learning
  'devtool',   // Developer Tools & Infra
  'saas',      // SaaS & Productivity
  'media',     // Media & Content
  'finance',   // Finance & Fintech
  'social',    // Social & Community
  'travel',    // Travel & Hospitality
  'lifestyle', // Lifestyle & Fashion (catch-all for brand/consumer sites)
] as const

export type DesignLibraryCategory = (typeof DESIGN_LIBRARY_CATEGORIES)[number]

/** Human-readable labels for the category chips — rendered by D4 UI. */
export const DESIGN_LIBRARY_CATEGORY_LABELS: Record<DesignLibraryCategory, string> = {
  ecom: 'E-commerce',
  ai: 'AI',
  devtool: 'Developer Tools',
  saas: 'SaaS',
  media: 'Media',
  finance: 'Finance',
  social: 'Social',
  travel: 'Travel',
  lifestyle: 'Lifestyle',
}

// ---------------------------------------------------------------------------
// Row shape returned by read helpers
// ---------------------------------------------------------------------------

/**
 * The denormalised shape the UI consumes. Every field matches the
 * `design_library_entries` column 1-to-1 except `createdAt` / `updatedAt`
 * which are camelCased for the TS-side UI layer.
 */
export interface DesignLibraryEntry {
  readonly id: string
  readonly slug: string
  readonly source: DesignLibrarySource
  readonly shopId: string | null
  readonly title: string
  readonly summary: string | null
  readonly category: DesignLibraryCategory | null
  readonly designMd: string
  readonly previewHtml: string | null
  readonly previewDarkHtml: string | null
  readonly previewHtmlUrl: string | null
  readonly previewDarkHtmlUrl: string | null
  readonly thumbnailUrl: string | null
  readonly storageTier: DesignLibraryStorageTier
  readonly sourceThemeId: string | null
  readonly sourceCloneJobId: string | null
  readonly upstreamSha: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * The narrow shape used by gallery/my-clones LIST queries — omits the
 * big preview HTML and DESIGN.md bodies so the grid can render 60+
 * cards without dragging MBs of text over the wire.
 */
export interface DesignLibraryCard {
  readonly id: string
  readonly slug: string
  readonly source: DesignLibrarySource
  readonly shopId: string | null
  readonly title: string
  readonly summary: string | null
  readonly category: DesignLibraryCategory | null
  readonly thumbnailUrl: string | null
  readonly storageTier: DesignLibraryStorageTier
  readonly createdAt: string
  readonly updatedAt: string
}

// ---------------------------------------------------------------------------
// Write-side input shapes
// ---------------------------------------------------------------------------

/**
 * One upstream brand parsed out of the mirror repo by the sync-seed CLI.
 * `slug` is the directory name (lowercase-hyphenated), everything else
 * is parsed from DESIGN.md + preview.html + preview-dark.html.
 *
 * `designMd` is the full markdown body (9 sections). `previewHtml`
 * / `previewDarkHtml` are the sibling HTML files. The category is
 * handcrafted via category-map.ts — the upstream README doesn't tag
 * brands consistently enough to auto-infer.
 */
export interface SeedDesignInput {
  readonly slug: string
  readonly title: string
  readonly summary: string | null
  readonly category: DesignLibraryCategory
  readonly designMd: string
  readonly previewHtml: string | null
  readonly previewDarkHtml: string | null
  /** Git sha of the mirror at parse time — stamped for diff-on-refresh. */
  readonly upstreamSha: string
}

/**
 * Input for a CLONE row, emitted by the clone-pro pipeline at the end
 * of a successful run (D2). One call per clone job. `shopId`,
 * `sourceThemeId`, `sourceCloneJobId` are all required — the check
 * constraint rejects clone rows that are missing shopId.
 */
export interface CloneDesignInput {
  readonly slug: string                    // 'clone-<job-id-prefix>' convention
  readonly shopId: string
  readonly title: string
  readonly summary: string | null
  readonly designMd: string
  readonly previewHtml: string | null
  readonly previewDarkHtml: string | null
  readonly sourceThemeId: string | null
  readonly sourceCloneJobId: string
}
