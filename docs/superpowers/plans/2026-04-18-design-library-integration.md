# Design Library Integration Plan

**Date:** 2026-04-18
**Owner:** Thai Bui
**Status:** ✅ All 5 decisions confirmed — ready to implement D1
**Related:** Phase 4 clone-library, Phase 6 clone-pro

## Owner decisions (2026-04-18)

1. **Gallery rollout** — ✅ Option A: public day-1. All merchants see 58 seed brand cards the moment D4 deploys. "Clone →" button is hidden for seed entries until D5 lands (then auto-appears). Good for demo/marketing from day-one.
2. **Clone-from-seed** — ✅ IN SCOPE for D5 (clone-pro already is AI design; feeding a DESIGN.md spec into the existing `theme-gen` pipeline reuses 90% of the code)
3. **Taxonomy** — ✅ use upstream's 9 categories verbatim (E-commerce bumped to position 1 in UI)
4. **Route** — ✅ keep BOTH `/clone-library` and `/design-library` as permanent aliases; canonical link in sidebar is `/design-library`; no 301
5. **Storage** — ✅ tiered: hot (Postgres TEXT if `<200 KB`) / cold (**AWS S3 real** signed URL otherwise); `design_md` always hot for full-text search; CloudFront distribution in front of S3 to cap egress cost

---

## Problem

The current "clone library" lists finished clone jobs as opaque cards. Merchants
can apply a cloned theme or push products to another shop, but they cannot:

- Live-preview the cloned theme before applying it (light or dark).
- Copy a structured design spec to share with an AI agent.
- Browse a curated gallery of well-known brand design systems for inspiration.
- Re-clone a design to a brand-new storefront from a single click.

The owner wants a **Design Library** where every clone — and every curated
brand system — is a first-class entry with **Live Preview + Copy DESIGN.md +
Clone-to-store** actions.

---

## Seed corpus

Mirrored from upstream into a private repo:

- Upstream: https://github.com/VoltAgent/awesome-design-md (MIT, 58k+ stars)
- Mirror: **https://github.com/xaozayta/awesome-design-md** (private)
- 58 brand directories under `design-md/<brand>/`
- Each pre-migration brand folder holds:
  - `DESIGN.md` (~14 KB, 9 canonical sections)
  - `preview.html` (~18 KB, light theme visual catalog)
  - `preview-dark.html` (~18 KB, dark theme visual catalog)
  - `README.md` (~1 KB brand blurb)

The upstream migrated the actual content to `getdesign.md/<brand>/design-md`,
but our mirror preserves the full git history — commit `80bbbc2` (2026-04-06)
and earlier still has all four files per brand. The loader pins that ref so
we get full content, not empty pointer READMEs.

---

## Target data model

### New table: `design_library_entries`

One row per entry, unifies seed + clone sources behind one query.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `slug` | text unique | `airbnb`, `stripe`, `clone-<jobId>` |
| `source` | text | `'seed'` or `'clone'` |
| `title` | text | `Airbnb` or cloned store name |
| `category` | text nullable | `ai`, `devtool`, `ecom`, `productivity`, ... (taxonomy from upstream categories, NULL for clones) |
| `summary` | text | one-line description |
| `design_md` | text | the 9-section markdown, UTF-8 |
| `preview_html` | text | light theme preview |
| `preview_dark_html` | text | dark theme preview |
| `preview_html` | text nullable | inline light preview when `<200 KB` |
| `preview_html_url` | text nullable | R2 URL when `≥200 KB` (hot→cold tier) |
| `preview_dark_html` | text nullable | inline dark preview when `<200 KB` |
| `preview_dark_html_url` | text nullable | R2 URL when `≥200 KB` |
| `thumbnail_url` | text nullable | R2 URL (always cold, D5) |
| `storage_tier` | text not null | `'hot'` or `'cold'` — set by insert logic |
| `source_theme_id` | uuid nullable FK → `themes.id` | NULL for seed |
| `source_clone_job_id` | uuid nullable FK → `storefront_clone_jobs.id` | NULL for seed |
| `shop_id` | uuid nullable FK → `shops.id` | NULL for seed (global gallery); set for clones so only the owning shop sees them |
| `upstream_sha` | text nullable | commit sha of the upstream mirror the seed was loaded from (for refresh diffs) |
| `created_at` | timestamptz default now | |
| `updated_at` | timestamptz default now | |

Indexes: `(shop_id, source)`, `(slug)`, `(category)`.

**Why one table, not two?** The UI wants a single tabbed grid with consistent
actions. Queries stay simple: `WHERE source='seed' OR shop_id = :my_shop_id`.

### Alternative considered (rejected)

Storing `docs/DESIGN.md` + `docs/preview.html` as `theme_assets` rows keyed
by path. Cleaner for "it travels with the theme" semantics, but seed entries
have no theme (no `theme_assets` FK), so we'd need two code paths. Reject.

---

## Content pipeline

### Path A — seed loader (one-time + periodic)

New CLI: `pnpm seed:design-library` (lives at
`packages/core/src/modules/design-library/sync-seed.ts`).

Steps per run:

1. `git clone --depth=1 https://github.com/xaozayta/awesome-design-md.git`
   to a temp dir (uses the `gh` CLI's stored token for private access).
2. For each `design-md/<brand>/` directory:
   - Read `DESIGN.md`, `preview.html`, `preview-dark.html`, `README.md`.
   - Derive `summary` from the first paragraph of README.
   - Classify `category` from a handcrafted brand→category map seeded from the
     upstream README's 9 categories.
   - Upsert into `design_library_entries` keyed by `(source='seed', slug=<brand>)`.
3. Stamp `upstream_sha` with `git rev-parse HEAD`.
4. Purge rows where `source='seed'` and `slug` no longer exists upstream.

The CLI runs on deploy (hook into the existing deploy script) and on a weekly
cron so brand updates trickle through.

### Path B — clone pipeline emits DESIGN.md

Extend `packages/core/src/modules/clone-pro/`:

1. **`design-extractor.ts`** already parses colors/fonts/layout hints. Add
   `serializeDesignMd(extracted: ExtractedDesign): string` that emits the
   9-section format:
   1. Visual Theme & Atmosphere
   2. Color Palette & Roles
   3. Typography Rules
   4. Component Stylings
   5. Layout Principles
   6. Depth & Elevation
   7. Do's and Don'ts (seeded from heuristics: "Don't use more than N fonts", etc.)
   8. Responsive Behavior (from observed breakpoints in cloned CSS)
   9. Agent Prompt Guide (one-paragraph instruction for AI agents)

2. **New** `packages/core/src/modules/clone-pro/preview-render.ts` — given a
   cloned theme's `theme_assets`, render two static HTML snapshots:
   - `preview.html` — component catalog (Buttons, Cards, Forms, Nav, Typography)
     rendered with the light palette.
   - `preview-dark.html` — same catalog rendered against the dark palette.
   The renderer reuses the storefront's Liquid engine in a sandboxed mode
   (no DB calls; hardcoded sample products/collections).

3. **`clone-pro/pipeline.ts`** — after `persistDynamicTheme` lands the theme,
   emit a `design_library_entries` row:
   ```ts
   await insertLibraryEntry(db, {
     source: 'clone',
     slug: `clone-${jobId.slice(0, 8)}`,
     title: job.label ?? job.canonical_domain,
     category: null,
     summary: `Cloned from ${job.canonical_domain}`,
     design_md: serializeDesignMd(extracted),
     preview_html: renderPreview(theme, 'light'),
     preview_dark_html: renderPreview(theme, 'dark'),
     source_theme_id: theme.id,
     source_clone_job_id: jobId,
     shop_id: job.shop_id,
   })
   ```

---

## UI

### Route

- `GET /admin/store/:slug/design-library` (replaces the existing
  `/admin/store/:slug/clone-library` route; add a 301 for backwards links).
  Tabs: **Gallery** (seed) | **My Clones** (clone).
- `GET /admin/store/:slug/design-library/:slug/preview` — full-page iframe
  preview (light). `?theme=dark` toggles to the dark variant.
- `GET /admin/store/:slug/design-library/:slug/design.md` — serves the raw
  markdown with `content-type: text/markdown; charset=utf-8` for "Copy link"
  or `curl | pbcopy`.

### Card anatomy

```
┌───────────────────────────────────┐
│ [thumbnail 16:9]                  │
│                                   │
│ Airbnb                    [ecom]  │
│ Warm coral, photography-driven    │
│                                   │
│ [Live preview] [Copy] [Clone →]   │
└───────────────────────────────────┘
```

- **Live preview** — opens a modal with an `iframe srcdoc="<preview_html>"`;
  header toggle for light/dark; `Esc` closes.
- **Copy** — JS `navigator.clipboard.writeText(design_md)`; toast "Copied
  DESIGN.md — paste into your AI agent."
- **Clone →** — opens the existing "Apply theme" wizard. For seed entries,
  the wizard routes through a new `cloneFromDesignMd(targetShopId, designMd)`
  service that (phase 2) asks an AI agent to synthesize a theme from the spec.
  For `source='clone'` entries, it reuses today's `cloneThemeToShop()`.

### Filters + search

- Search box over `title + summary`.
- Category chips (9 from upstream taxonomy).
- Sort: recent / alphabetical.

---

## Integration mechanism with upstream mirror

Three options considered:

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Git submodule under `packages/core/design-library-seed/` | Content is always present; no runtime network call | Repo bloat, submodule friction, stale unless bumped | Reject |
| **CLI sync → DB** | Content lives in DB, queryable, no network at render time | Needs a cron/CI job to stay fresh | **Chosen** |
| Runtime fetch from `gh api` at each render | Always fresh | Latency, rate-limit, fails offline | Reject |

The chosen path matches the project's existing "import once, serve from DB"
pattern (same as themes, products, fonts).

---

## Phased rollout

- **D1 — Schema + seed loader** (~1–2 days)
  - Migration: `049_design_library_entries`
  - Module: `packages/core/src/modules/design-library/{schema,sync-seed,queries}.ts`
  - CLI: `pnpm seed:design-library` runs end-to-end
  - Tests: fake gh fetch, fixture 2 brands, assert upsert + cleanup

- **D2 — DESIGN.md generator in clone pipeline** (~2 days)
  - `design-extractor.ts` + new `serializeDesignMd()`
  - Plumb into `pipeline.ts`, write row on success
  - Tests: extract+serialize golden test against a fixture HTML/CSS pair

- **D3 — preview.html renderer** (~2 days)
  - `preview-render.ts` using Liquid engine in sandbox mode
  - Component catalog Liquid template under
    `packages/core/src/modules/design-library/preview-template.liquid`
  - Tests: render produces valid HTML, dark variant swaps palette

- **D4 — Design Library UI** (~2 days)
  - New route + tabs + card grid + search + filters
  - Preview modal with iframe + light/dark toggle + keyboard nav
  - Copy button with toast
  - Clone wizard reuses existing apply-theme flow for clone entries
  - 301 from old `/clone-library`

- **D5 — Polish + Clone-from-seed** (~3 days, optional stretch)
  - Thumbnails: pre-rendered from preview.html via headless Chromium into
    `clone-assets/` on seed ingestion
  - `cloneFromDesignMd()` — AI agent builds a theme from a spec (uses the
    existing clone-pro `theme-gen/` pipeline, fed with synthetic HTML derived
    from DESIGN.md)

**Skeleton total: 7 days without D5, 10 days with D5.**

---

## Storage projections (decided)

Hot/cold tier with a 200 KB per-field threshold:

| Source | Size per entry | Rows | Postgres (hot) | R2 (cold) |
|---|---|---|---|---|
| Seed (58 brands) | ~52 KB each | 58 | ~3 MB | ~2.3 MB thumbnails |
| Y1 beta clones (100 merchants × 5) | ~150 KB | 500 | ~75 MB | 0 |
| Y2 scale (1k × 5) | ~150 KB | 5,000 | ~750 MB | overflow only |
| Y3 production (10k × 3) | ~150 KB | 30,000 | ~4.5 GB | overflow only |
| Y5 mature (50k × 2) | ~150 KB | 100,000 | ~15 GB | overflow only |

**Hot-to-cold migration job** (cron, monthly): scans rows where `storage_tier =
'hot' AND (length(preview_html) > 200000 OR length(preview_dark_html) > 200000)`,
uploads to R2, nulls the TEXT column, sets `_url`, flips `storage_tier = 'cold'`.

### Cold storage: AWS S3 (real) + CloudFront

- Bucket: `gbox-design-library` in `ap-southeast-1` (Singapore — closest to VN
  merchants + VPS locations)
- Block public access: ON. Objects served via CloudFront signed URLs or
  short-lived presigned URLs (15-min TTL for preview modals).
- Path scheme:
  ```
  s3://gbox-design-library/
    seed/<brand>/design.md
    seed/<brand>/preview.html
    seed/<brand>/preview-dark.html
    seed/<brand>/thumbnail.jpg
    clones/<shop_id>/<entry_id>/preview.html
    clones/<shop_id>/<entry_id>/preview-dark.html
  ```
- CloudFront distribution `d-design.gbox.co` (or reuse existing distribution)
  in front of the bucket. Serving HTML previews via CDN cuts S3 egress cost
  ~95% on repeat views and keeps latency low for global merchants.
- IAM: dedicated role `gbox-design-library-rw` with least-privilege policy
  scoped to the bucket. Credentials live in env vars
  `AWS_DESIGN_LIBRARY_ACCESS_KEY_ID` + `AWS_DESIGN_LIBRARY_SECRET_ACCESS_KEY`.
- SDK: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (already a
  workspace candidate — check existing S3 usage before adding).

### Cost ceiling (worst case, Y5 mature)

- 15 GB stored × $0.023/GB = **$0.35/month** S3 standard storage
- Without CloudFront: 15 GB × 20 reads/month × $0.09/GB egress = $27/mo
- With CloudFront caching (95% hit rate): ~$1.35/mo egress + ~$0.085/GB CF
  charge ≈ **$2-3/month total**
- Essentially rounding error at platform scale.

Read path always checks `preview_html ?? presignAndFetch(preview_html_url)`
so migrations are transparent to the UI.

### S3 decisions still to confirm (Thai)

- **Region**: `ap-southeast-1` (Singapore) is my pick. Alternatives: `us-east-1`
  (cheapest + biggest feature set), `ap-northeast-1` (Tokyo, VN latency
  ~similar to Singapore). **Default ap-southeast-1 unless you object.**
- **CloudFront domain**: reuse an existing `*.gbox.co` distribution or create
  a new one? I'll default to creating `design-cdn.gbox.co` unless you point me
  at an existing distro.

---

## Acceptance criteria

- Seed loader syncs 58 brand entries from xaozayta/awesome-design-md into the
  DB in under 60 s on first run.
- Each seed card renders a Live Preview modal in light + dark.
- "Copy DESIGN.md" writes the full 9-section markdown to the clipboard.
- Every finished clone job creates a "My Clones" entry with its own DESIGN.md
  and both preview HTMLs.
- "Clone →" from a clone-source entry produces an identical theme in the
  target shop via the existing `cloneThemeToShop` path.
- Old `/clone-library` URL redirects to `/design-library`.
- No regression in the existing apply-theme / push-products flows.

---

## Out of scope (call out)

- Metafields (deferred from Phase C).
- AI-generated theme from a seed DESIGN.md (D5 stretch, may be its own phase).
- Marketplace / paid templates.
- Figma import.
