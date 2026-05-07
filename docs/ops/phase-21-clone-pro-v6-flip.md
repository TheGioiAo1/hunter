# Phase 21 — Clone Pro v6 default flip + rollback

## Default flip (Sprint 5)

`CLONE_PRO_VERSION=v6` is the new default in `.env.example`. To activate v6 in production:

1. Update `/etc/systemd/system/gbox-platform.service` (or the equivalent env file your service reads):
   ```
   Environment="CLONE_PRO_VERSION=v6"
   ```
2. `sudo systemctl daemon-reload && sudo systemctl restart gbox-platform`
3. Verify: `curl https://api.gbox.co/health/clone-pro-version` → `{ "version": "v6" }` (if such endpoint exists; otherwise check logs for the next clone job)

## Pre-flip checklist

Before flipping production from v5 → v6:

- [ ] **PRs #102-108 merged**: Sprint 0-4 deliver Stages 1-12 + BYOK gate
- [ ] **AWS S3 bucket exists**: `gbox-clone-storage` in ap-southeast-1, public-read on objects, CloudFront distribution alias `cdn.gbox.co/clone-storage/*`
- [ ] **Playwright Chromium installed** on worker hosts: `npx playwright install chromium`
- [ ] **Live e2e green** on staging: `npx tsx scripts/smoke-clone-pro-v6-bibliobloom.ts` exits 0 with all 5 spec goals met
- [ ] **AI provider key on test shop**: `shop_ai_config` row exists for the test shop with a valid Anthropic / OpenAI / Google key
- [ ] **Migration 097 + 098 applied**: `npx tsx packages/db/src/migrations/run.ts` shows 095 → 098 applied, no skipped

## Post-flip monitoring (7 days)

- Watch `clone_run_metrics`: median pixel_diff_pct, asset_404_count, grade_letter distribution
- Watch error_code on storefront_clone_jobs: `cap_exceeded`, `ai_quota_exceeded`, source-leak detected
- Watch S3 storage growth: per-shop usage in `clone_assets_map` (cap is 5GB/shop)

## Rollback procedure (if v6 misbehaves)

1. Set `CLONE_PRO_VERSION=v5` in env (or unset; v4 is the implicit default in runner.ts)
2. `systemctl restart gbox-platform`
3. New jobs route back to v5; in-flight v6 jobs finish on v6 code

The rollback is non-destructive — v6 schema (migrations 093-098) stays in place. Data already persisted via v6 (provenance, snapshots) is harmless to v4/v5 (they don't query those columns).

## v4/v5 archive plan (post 30-day soak)

After 30 days at `CLONE_PRO_VERSION=v6` with stable metrics:

1. Move v4 modules to `_archive/clone-pro-v4-v5/`:
   - `pipeline.ts`, `pipeline-v4.ts`, `execution-v4.ts`
   - `design-extractor.ts`, `html-to-liquid.ts`
   - `universal-crawler.ts`
2. Move v5 directory: `git mv packages/core/src/modules/clone-pro/v5 packages/core/src/modules/_archive/clone-pro-v4-v5/v5`
3. Remove v4/v5 branch from `clone-worker.ts` (only v6 dispatch remains)
4. Update vitest config to exclude `_archive/`
5. Submit follow-up PR `chore(phase-21): archive v4/v5 modules after 30-day soak`

Reference: Phase 11 PR3 archival precedent at `_archive/legacy-smokes/`.

## Nginx /clone-assets/ legacy removal (post-flip)

V6 serves all assets via `cdn.gbox.co/clone-storage/*` (CloudFront → S3). The legacy nginx location block at `/clone-assets/*` (which served from local-fs `/home/botesty/gbox-platform/clone-assets/`) becomes dead code post-flip.

Remove from nginx after 30 days:

```nginx
# DELETE THIS BLOCK from /etc/nginx/sites-available/storefront:
location ~ ^/clone-assets/(.*)$ {
  alias /home/botesty/gbox-platform/clone-assets/$1;
  expires 1y;
}
```

Then: `sudo nginx -t && sudo systemctl reload nginx`. Verify cdn.gbox.co serves; verify any stale references in DB columns are zero (run `verifyNoSourceLeaks` against /clone-assets/ pattern as a one-off operator check).

## Open follow-ups (post-PR7)

These are tracked for post-merge:

1. **Real pixel-diff in deps.ts**: `runVerification` currently returns `pixelDiffPct: 0` placeholder. Production should fetch homepage screenshot from S3 + run pixelmatch.
2. **Real sourceUrlCounts in deps.ts**: `runVerification` passes `{ products: 0, ... }` placeholder. Should thread real Stage 1 counts through the orchestrator.
3. **GPT-5-vision soft hint**: `computeGrade` uses `aiVisionScore: 80` placeholder. Real vision integration optional per spec.
4. **AI cost reconciliation**: `runStage12` records `total_ai_cost_usd_cents: 0` placeholder. Sum AI calls' usage tokens × per-token cost.

These are noted in the spec as soft-targets and can ship as smaller follow-up PRs.
