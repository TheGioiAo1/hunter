/**
 * Design Library — handcrafted brand → category map (Phase D1).
 *
 * The upstream mirror at xaozayta/awesome-design-md (fork of
 * VoltAgent/awesome-design-md) ships 58 brand folders under `design-md/`
 * with no consistent category taxonomy in the README. We build one
 * by hand here.
 *
 * Principles:
 *
 *   1. Each brand maps to its DOMINANT function. Stripe has devtool
 *      docs and a brand site but the brand is "payments" → finance.
 *   2. Missing from the upstream list → the sync-seed CLI logs a
 *      warning and drops the row rather than picking a random bucket.
 *   3. When the upstream repo adds new brands (re-sync), add them to
 *      this map first. The CI check in sync-seed.test.ts asserts that
 *      every upstream brand has a category.
 *
 * Counts (as of 2026-04-18 sync, upstream commit 80bbbc2 = 58 brands):
 *   - ai:         13 (AI model providers + agent tooling)
 *   - devtool:    22 (infra, IDEs, design tools, DBs, observability, + Clay)
 *   - saas:        6 (productivity, CRM, scheduling; semrush dropped upstream)
 *   - media:       1 (Spotify is the only audio/video brand)
 *   - finance:     5 (crypto exchanges + payments + neobanks)
 *   - social:      1 (Pinterest)
 *   - travel:      2 (Airbnb + Uber)
 *   - lifestyle:   8 (auto + consumer hardware + enterprise brand sites)
 *   - ecom:        0 — kept in the enum for future additions (shop brands)
 *   -------------------
 *   total:       58 (matches upstream folder count at 80bbbc2)
 */

import type { DesignLibraryCategory } from './types.js'

/**
 * Keys match the upstream folder name under `design-md/` EXACTLY
 * (lowercase, hyphens and dots preserved). The sync-seed CLI uses the
 * folder name verbatim as `slug` so the two sides stay aligned.
 */
export const BRAND_CATEGORY_MAP: Readonly<Record<string, DesignLibraryCategory>> = {
  // ── AI & Machine Learning (13) ───────────────────────────────────
  claude: 'ai',
  cohere: 'ai',
  elevenlabs: 'ai',
  lovable: 'ai',
  minimax: 'ai',
  'mistral.ai': 'ai',
  ollama: 'ai',
  'opencode.ai': 'ai',
  replicate: 'ai',
  runwayml: 'ai',
  'together.ai': 'ai',
  voltagent: 'ai',
  'x.ai': 'ai',

  // ── Developer Tools & Infra (22) ─────────────────────────────────
  airtable: 'devtool',
  clay: 'devtool', // B2B data enrichment / sales-ops tool
  clickhouse: 'devtool',
  composio: 'devtool',
  cursor: 'devtool',
  expo: 'devtool',
  figma: 'devtool',
  framer: 'devtool',
  hashicorp: 'devtool',
  'linear.app': 'devtool',
  mintlify: 'devtool',
  mongodb: 'devtool',
  nvidia: 'devtool',
  posthog: 'devtool',
  raycast: 'devtool',
  resend: 'devtool',
  sanity: 'devtool',
  sentry: 'devtool',
  supabase: 'devtool',
  vercel: 'devtool',
  warp: 'devtool',
  webflow: 'devtool',

  // ── SaaS & Productivity (7) ──────────────────────────────────────
  // 2026-04-27 — switched upstream from xaozayta/awesome-design-md (private)
  // to VoltAgent/awesome-design-md (public). VoltAgent ships semrush so
  // it's back in the map.
  cal: 'saas',
  intercom: 'saas',
  miro: 'saas',
  notion: 'saas',
  semrush: 'saas',
  superhuman: 'saas',
  zapier: 'saas',

  // ── Media & Content (1) ──────────────────────────────────────────
  spotify: 'media',

  // ── Finance & Fintech (5) ────────────────────────────────────────
  coinbase: 'finance',
  kraken: 'finance',
  revolut: 'finance',
  stripe: 'finance',
  wise: 'finance',

  // ── Social & Community (1) ───────────────────────────────────────
  pinterest: 'social',

  // ── Travel & Hospitality (2) ─────────────────────────────────────
  airbnb: 'travel',
  uber: 'travel',

  // ── Lifestyle & Consumer Brands (8) ──────────────────────────────
  apple: 'lifestyle',
  bmw: 'lifestyle',
  ferrari: 'lifestyle',
  ibm: 'lifestyle',
  lamborghini: 'lifestyle',
  renault: 'lifestyle',
  spacex: 'lifestyle',
  tesla: 'lifestyle',
}

/**
 * Look up the category for an upstream brand slug. Returns `null` when
 * the slug is not in the map so the caller can log + skip (rather than
 * silently miscategorise). The sync-seed CLI treats this as a hard
 * error in strict mode and a warning in best-effort mode.
 */
export function categoryFor(
  slug: string,
): DesignLibraryCategory | null {
  // Normalise casing — upstream has been consistent with lowercase but
  // we guard anyway since new contributions might not be.
  const key = slug.toLowerCase()
  return BRAND_CATEGORY_MAP[key] ?? null
}

/**
 * All known brand slugs. Used by the sync-seed test to diff the map
 * against the upstream folder listing and catch drift.
 */
export const KNOWN_BRAND_SLUGS: readonly string[] = Object.keys(BRAND_CATEGORY_MAP)
  .slice()
  .sort()
