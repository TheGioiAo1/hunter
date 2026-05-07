# Sprint 4 — Theme Generator + Visual Verify — Report

**From:** Sprint 4 implementer
**To:** Thai
**Date:** 2026-04-26
**PR:** https://github.com/GBox-Company/gbox-platform/pull/117
**Branch:** `feat/v7-pr4-theme-generator` (8 commits, base `org/feat/v7-pr3-theme-capture-tokens`)

## Status

**8/8 tasks shipped, 75 Sprint-4 unit tests pass (119/119 across all v7 + migration 101).**

| # | Task | Tests | Status | Note |
|---|------|-------|--------|------|
| 4.1 | Migration 101 — `theme_files` versioning columns | 7 | OK | theme_id + version + is_active + partial UNIQUE one-active-per-shop |
| 4.2 | Template base library (5 layouts + 20 component variants) | 10 | OK | exactly 20 sections delivered (5+5+4+3+3) |
| 4.3 | Token applier (DesignTokens → CSS vars + Liquid vars) | 9 | OK | covers all 12 DesignTokensSchema sections |
| 4.4 | Component builder (variant translation tables, fail-soft) | 10 | OK | Claude vocab normalised; unknown → sane defaults |
| 4.5 | Theme renderer + bundler (LiquidJS + JSZip → S3) | 12 | OK | only selected variants in zip (size/security) |
| 4.6 | Stage 15 orchestrator (wire all + persist + version flip) | 6 | OK | deactivate-before-activate ordering |
| 4.7 | Stage 16 visual verify + retry max 3 | 13+8 | OK | plan acceptance scenario [5,5,8]→attempts=3 passed=true tested |
| 4.8 | Live smoke `scripts/smoke-clone-pro-v7-pr4.ts` | n/a | OK | needs server 2 to actually run (Windows can't reach prod PG) |

## Variants delivered: 20 / 20 target (5+5+4+3+3)

```
sections/
├── hero-{fullbleed,split,editorial,minimal,video-bg}.liquid          (5)
├── product-card-{classic,editorial,minimal,overlay,list}.liquid      (5)
├── header-{minimal,classic,split,sticky-transparent}.liquid          (4)
├── footer-{classic,minimal,editorial}.liquid                         (3)
└── nav-{horizontal,mega,drawer}.liquid                               (3)
```

Every section has frontmatter `{% comment %} variant: ... tokens_required: [...] {% endcomment %}` so component-builder.ts can introspect required tokens before handing a variant to the renderer.

## Stage 16 retry loop verification

The critical mock test from the sprint plan acceptance criteria:

```typescript
verify.mockResolvedValueOnce({score: 5, ...})  // attempt 1: fail
       .mockResolvedValueOnce({score: 5, ...})  // attempt 2: fail (regen + retry)
       .mockResolvedValueOnce({score: 8, ...})  // attempt 3: pass

await visualVerifyWithRetry(...)
// → attempts=3, passed=true, score=8 ✓
```

Other retry loop tests passing:
- Pass on first attempt → no regenerate calls (cost-saving guarantee).
- Cap at 3 fails → returns best-effort with last score, regenerate called only twice (between attempts, not after the last failure).
- `maxRetries=1` honoured for cost-bounded runs.
- Feedback from attempt N flows into both attempt N+1 verify call AND regenerate call.
- Regenerate failure → loop aborts immediately (no point measuring same theme).
- `attempts_history[]` exposes per-attempt scores for cost analysis.

## Quality gates

- **TypeScript**: `cd packages/core && npx tsc --noEmit | grep "v7/(theme-engine|stages)"` → only `playwright` module decl error (pre-existing from Sprint 3, unrelated to my code).
- **File sizes**: largest file is `visual-verify.ts` at 251 lines (< 300 cap).
- **`any` types**: zero in production code.
- **Iron rule 5**: zero `god-admin` / `/god-admin/` leaks; every error path through `safeMessage()`. Live verified via Grep across `packages/core/src/modules/clone-pro/v7/`.
- **Migration ledger**: `_ledger-live.test.ts` 3/3 pass — migration 101 properly registered (import + array entry).

## Acceptance criteria (Sprint 4 done) — all green

- [x] Migration 101 applied (registered in run.ts; idempotent ALTER TABLE … ADD COLUMN IF NOT EXISTS).
- [x] **75 unit tests pass** — exceeds the 60+ target.
- [x] All 8 tasks committed individually (8 commits with task-specific messages).
- [x] No TypeScript errors in v7/theme-engine + v7/stages (only the inherited playwright issue).
- [x] **20 Liquid component variants** in `template-base/sections/`.
- [x] Stage 16 retry loop verified via the [5,5,8] mock test (acceptance scenario from plan).
- [x] PR opened (#117).

## Deviations from plan + reasoning

1. **Removed dead `layout/_header.liquid` + `layout/_footer.liquid`** during Task 4.5. The base template uses `{% include 'snippets/header' %}` directly; the layout shells were a redundant indirection. Updated test to expect `>=1` layout file instead of `>=2`. Reasoning: simpler is better; YAGNI.

2. **All dynamic includes use `{% assign x = ... %}{% include x %}` pattern** instead of `{% include 'sections/header-' | append: var %}`. LiquidJS evaluates the literal `'sections/header-'` BEFORE applying `| append`, so the direct form fails with "Failed to lookup 'sections/header-'". Discovered during Task 4.5 rendering tests. Applied across snippets/header.liquid, snippets/footer.liquid, all 4 header variants (which include nav), and 2 templates (index.liquid, collection.liquid).

3. **`pickFooter` uses `style_keywords` because `footer` isn't a token field.** DesignTokensSchema has no footer slot — Claude vision rarely sees enough footer detail to extract tokens. Component-builder picks from `style_keywords`: `editorial`/`serif-typography`/`literary` → footer-editorial; `minimal`/`sparse`/`modern-minimal` → footer-minimal; default footer-classic. Documented as a "skip" in token-applier (the schema coverage table calls this out).

4. **Hex case is preserved (not normalised)**. Test confirms `#ABCDEF` stays uppercase. Reasoning: Claude sometimes returns mixed-case hexes; if we normalise, Stage 16 visual diff would flag a meaningless change between iterations. Caller's responsibility to feed consistent case.

5. **Component-builder has `header: 'editorial' → 'minimal'` translation.** No editorial header variant in the 4-file catalog; "editorial header" look is best approximated by minimal layout with serif fonts. Updated the corresponding test expectation.

## Open questions for Thai

1. **Live smoke vs mock** — Sprint 4 unit tests cover everything in isolation (DI throughout). For the full bibliobloom-grade live verification we need: PR3 smoke run first, then storefront actually serving the theme.zip from S3 at `https://bibliobloom-v7-pr4.gbox.co`. **Sprint 5 work** wires the storefront. Should I gate the PR on that or open a follow-up issue?

2. **AI cost projection** — Stage 16 calls Claude vision once per page (5 pages typical), each with 2 PNG attachments + the diff prompt (~1.5K tokens). Per-attempt cost ≈ $0.30. Worst case (3 retries × 5 pages) = ~$4.50 per failing job. Plus regenerate costs nothing extra (Stage 15 doesn't call Claude). **OK?** If we want a hard $/job cap, I can add `MAX_CLONE_PRO_V7_USD` env gate that aborts mid-loop.

3. **Footer variant choice** — Currently picked from `style_keywords` array. Bibliobloom's keywords are `['editorial', 'warm']` → footer-editorial, which seems right. But if Claude misses the keyword, default footer-classic might look wrong on a serif site. Should I add a fallback that copies header variant style? E.g. `header.variant === 'minimal'` → `footer-minimal`?

4. **Theme.zip persisted as one big blob OR per-file rows?** Stage 15 currently does both: `theme.zip` to S3 (for storefront deploy) AND one `theme_files` row per file (with `s3_key = <shopId>/theme/v<N>/<path>`). The per-file rows enable seller-side theme editing without re-rendering. But we never actually upload per-file PNGs — they're just metadata. Is that intentional or should I drop the per-file S3 keys?

5. **`bundle.feedback_applied` flow** — currently the renderer accepts `previousFeedback` and stores it in the bundle, but it doesn't actually CHANGE rendering based on the feedback. The intended flow per the prompt is: Stage 16 feeds feedback back to Stage 15 → Stage 15 regenerates with feedback adjusting component selection or token interpretation. **Not implemented yet** — the renderer is deterministic given tokens. To make feedback actionable, we'd need to ALSO mutate tokens (e.g. "header too short" → bump `header.height`) before re-rendering. Should that mutation happen in Stage 15 (next sprint) or did you want it in Sprint 4?

## Files (absolute paths)

- Migration: `packages/db/src/migrations/101_theme_files_v7.ts` (+ `.test.ts`)
- Token schema (inherited Sprint 3): `packages/core/src/modules/clone-pro/v7/theme-engine/token-schema.ts`
- Token applier: `packages/core/src/modules/clone-pro/v7/theme-engine/token-applier.ts` (+ `.test.ts`)
- Component builder: `packages/core/src/modules/clone-pro/v7/theme-engine/component-builder.ts` (+ `.test.ts`)
- Theme renderer + bundler: `packages/core/src/modules/clone-pro/v7/theme-engine/theme-renderer.ts` (+ `.test.ts`)
- Visual verify (single pass): `packages/core/src/modules/clone-pro/v7/theme-engine/visual-verify.ts` (+ `.test.ts`)
- Stage 15 orchestrator: `packages/core/src/modules/clone-pro/v7/stages/stage15-theme-generate.ts` (+ `.test.ts`)
- Stage 16 retry loop: `packages/core/src/modules/clone-pro/v7/stages/stage16-visual-verify.ts` (+ `.test.ts`)
- Template base: `packages/core/src/modules/clone-pro/v7/theme-engine/template-base/` (30 files: 1 layout + 5 templates + 20 sections + 2 snippets + 2 assets)
- Live smoke: `scripts/smoke-clone-pro-v7-pr4.ts`
