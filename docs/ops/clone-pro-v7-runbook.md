# Clone Pro v7 — Production Runbook

Phase 22 PR5 / Sprint 5 — operator-facing runbook for the v7 bulk-catalog
clone pipeline. Pairs with `docs/superpowers/specs/2026-04-26-clone-pro-v7-bulk-catalog-spec.md`.

> **Iron Rule 5 reminder.** Every diagnostic in this runbook is for
> god-admin / Thai use. Sellers should never see paths, error
> stacktraces, or remediation steps mentioned here. If you must surface
> a clone failure to a seller, use `safeMessage()` → "Please contact
> Gbox support."

## 1. Pre-flight checklist

Run **before** triggering a v7 clone in production. Tick every box.

### 1.1 Environment variables (Server 2 / API host)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | YES | `gbox_platform` DB. Test with `psql $DATABASE_URL -c 'select 1'`. |
| `ANTHROPIC_API_KEY` | YES | Stage 14 vision + Stage 16 verify. Verify via `curl https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -d '{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'` returns 200. |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | YES | S3 asset upload (Stage 6) + theme bundle (Stage 15). Verify via `aws s3 ls s3://gbox-clone-storage/`. |
| `AWS_REGION` | optional | Default `ap-southeast-1`. |
| `S3_BUCKET` | optional | Default `gbox-clone-storage`. Override per-tenant. |
| `CLONE_PRO_VERSION` | YES | Set to `v7` to route the worker through the v7 pipeline. Default is `v5`. |
| `MAX_CLONE_PRO_V7_USD` | optional | Per-job AI cost cap. Default `5.00`. Set lower for cost-sensitive runs. |
| `THEME_LOADER_VERSION` | optional | Storefront DbLoader default. Stage 11 v7 flips per-shop in `shop_settings`; this env is the platform-wide fallback. Default `v1` for BC. |

### 1.2 Database migrations

Confirm migrations 099-104 applied:

```sql
SELECT name, applied_at FROM _migrations
 WHERE name LIKE '09%_clone_%'
    OR name LIKE '10%_theme_files%'
    OR name LIKE '10%_clone_pro%'
    OR name LIKE '10%_re_clone_%'
 ORDER BY applied_at DESC;
```

Expected rows (in any order):
- `099_clone_jobs_v7_columns`
- `100_clone_crawl_runs`
- `101_theme_files_v7`
- `102_shop_theme_tokens_v7`
- `103_re_clone_overwrite`
- `104_theme_files_path_content`

If any are missing:

```bash
node --import tsx packages/db/src/migrations/run.ts
```

### 1.3 Test shop exists + has `shop_ai_config` row

```sql
SELECT shop_id, provider, verified_at, monthly_cost_usd_cents
  FROM shop_ai_config
 WHERE shop_id = '<TEST_SHOP_UUID>';
```

If `provider='none'` or `verified_at IS NULL`, the `/clone-pro/start`
endpoint returns 409 (Sprint 0 BYOK gate). Configure via the god-admin
UI before continuing.

### 1.4 Server 3 storefront writable

```bash
ssh unbutu1@192.168.1.19 "test -w /var/www/themes && echo OK || echo FAIL"
ssh unbutu1@192.168.1.19 "command -v aws unzip pm2 | wc -l"   # expect 3
```

### 1.5 Playwright Chromium installed (Server 2)

```bash
ssh unbutu1@<server2> "npx playwright install --dry-run chromium 2>&1 | head -3"
```

If "Chromium 12x.x is downloaded" → already installed. Otherwise run
`npx playwright install chromium` on the worker host.

## 2. Trigger a clone

### 2.1 Production (god-admin UI)

1. Open `https://god.gbox.co/god-admin/clone-pro/v7` (god-admin only).
2. Paste the source URL (example: `https://bibliobloom.com`).
3. Toggle **Crawl strategy** = `full` for full catalog (cap-checked
   against `god-admin/settings/clone-pro/max_products`) or `sample`
   for the first 200 products.
4. Click **Start clone**. Note the returned `job_id`.

### 2.2 Direct API (operator scripts)

```bash
JOB_RESP=$(curl -sX POST 'https://api.gbox.co/clone-pro/start' \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $GOD_ADMIN_JWT" \
  -d '{"shop_id":"<SHOP_UUID>","url":"https://bibliobloom.com","crawl_strategy":"full"}')

JOB_ID=$(echo "$JOB_RESP" | jq -r .jobId)
echo "Job: $JOB_ID"
```

### 2.3 Bypass the worker (operator-only smoke)

For a fresh run that doesn't go through BullMQ:

```bash
SMOKE_SHOP_ID=<SHOP_UUID> \
SMOKE_SOURCE_URL=https://bibliobloom.com/collections/all \
CLONE_PRO_VERSION=v7 \
  npx tsx scripts/smoke-clone-pro-v7-pr5-e2e.ts
```

Output lands at `tmp/e2e-result.json` for side-by-side review.

## 3. Monitor a running clone

### 3.1 PM2 logs (worker)

```bash
ssh unbutu1@<server2> "pm2 logs gbox-clone-worker --lines 200 --nostream"
```

Look for:
- `[v7-stage4_lonspy_bulk] succeeded products=… quality=…` — Stage 4 OK
- `[v7-stage15] persistThemeFiles for shop …` — theme bundle persisted
- `[v7-stage16] verify attempt …` — visual loop firing
- `[v7-stage11] deployTheme failed for shop …` — bundle failed to land

### 3.2 DB queries (job status)

```sql
SELECT id, status, progress_pct, current_message, published_at,
       error_message
  FROM storefront_clone_jobs
 WHERE id = '<JOB_ID>';
```

Status state machine (v7):
```
pending → running → published    (happy path)
pending → running → completed    (grade F or auto-publish disabled)
pending → running → failed       (Stage 1 / Stage 4 / Stage 8 grep / etc.)
```

### 3.3 Per-stage metrics

```sql
-- Stage 4 (Lonspy bulk crawl) audit
SELECT platform, config_used, rows_harvested, rows_failed,
       quality_score, duration_ms
  FROM clone_crawl_runs WHERE job_id = '<JOB_ID>';

-- Stage 9 verify + Stage 10 grade
SELECT pixel_diff_pct, asset_404_count, ai_vision_score,
       grade_letter, grade_score, total_ai_cost_usd_cents
  FROM clone_run_metrics WHERE job_id = '<JOB_ID>';

-- Persisted catalog count
SELECT
  (SELECT count(*) FROM products    WHERE shop_id = '<SHOP_UUID>')  AS products,
  (SELECT count(*) FROM collections WHERE shop_id = '<SHOP_UUID>')  AS collections,
  (SELECT count(*) FROM pages       WHERE shop_id = '<SHOP_UUID>')  AS pages;

-- Active theme bundle (Sprint 5)
SELECT theme_id, version, count(*) AS file_count, max(updated_at) AS updated
  FROM theme_files
 WHERE shop_id = '<SHOP_UUID>' AND is_active = true
 GROUP BY theme_id, version;
```

### 3.4 S3 inventory

```bash
# Asset bytes consumed (Stage 6)
aws s3 ls s3://gbox-clone-storage/clone-storage/<SHOP_UUID>/ --recursive --summarize | tail -3

# Theme bundle (Stage 15)
aws s3 ls s3://gbox-clone-storage/themes/<SHOP_UUID>/ --recursive
```

## 4. Rollback procedures

### 4.1 Quick rollback (bad theme deployed, catalog OK)

```bash
# Server 3
ssh unbutu1@192.168.1.19 "
  rm -rf /var/www/themes/<SHOP_UUID>
  mv /var/www/themes/<SHOP_UUID>.bak /var/www/themes/<SHOP_UUID>
  pm2 reload gbox-storefront
"
```

Then flip the loader version back:

```sql
UPDATE shop_settings
   SET value = '"v1"'::jsonb
 WHERE shop_id = '<SHOP_UUID>'
   AND key = 'theme_loader_version';
```

The storefront serves the previous theme on the next request.

### 4.2 Full unpublish (catalog rollback)

```sql
-- 1. Mark the job as rolled back
UPDATE storefront_clone_jobs
   SET status = 'rolled_back',
       error_message = 'manual rollback at ' || now()
 WHERE id = '<JOB_ID>';

-- 2. Archive every product + collection + page from this job
UPDATE products    SET status = 'archived' WHERE clone_job_id = '<JOB_ID>';
UPDATE collections SET status = 'archived' WHERE clone_job_id = '<JOB_ID>';
UPDATE pages       SET status = 'archived' WHERE clone_job_id = '<JOB_ID>';

-- 3. Deactivate the v7 theme (back to platform default)
UPDATE theme_files SET is_active = false
 WHERE shop_id = '<SHOP_UUID>' AND is_active = true;
```

> Migration 103's `clone_pro_overwrite_products(shop_id)` will run again
> on the next clone attempt, archiving any products that picked up
> orders during the brief uptime.

### 4.3 BullMQ stuck job

```bash
ssh unbutu1@<server2> "redis-cli LLEN bull:clone-jobs:waiting"
ssh unbutu1@<server2> "redis-cli LLEN bull:clone-jobs:active"

# If a job is wedged in 'active' (worker died mid-run), force it back:
ssh unbutu1@<server2> "node --import tsx scripts/ops/clone-job-requeue.ts <JOB_ID>"
```

## 5. Common errors + fixes

| Symptom | Root cause | Fix |
|---|---|---|
| `Cloudflare 429` during Stage 4 | Rate-limited at source | Bump delay env: `LONSPY_REQUEST_DELAY_MS=4000` (default 2000) and re-trigger. |
| `Stage 14: vision call failed` | `ANTHROPIC_API_KEY` rotated / quota | Re-issue key, restart worker (`pm2 restart gbox-clone-worker`). |
| `Stage 6 aborted — failure threshold` | Source CDN dropping >5% requests | Check `clone_assets_map` for the failed `source_url`s; whitelist known-good hosts only. |
| `Stage 8 grep gate found N source-domain leaks` | A scraper missed a hard-coded URL | Don't ship — open a ticket for the scraper module that emitted the leak. Aborting is intentional. |
| `S3 access denied` on theme bundle | IAM policy missing `s3:PutObject` for `themes/` prefix | Update IAM, retry job. |
| `CostBudgetExceededError` | Stage 16 retry loop ran 3 times at $0.30+ each | Bump `MAX_CLONE_PRO_V7_USD=10` for THIS job, OR set `CLONE_PRO_V7_DISABLE_RETRY=1` to ship best-effort. |
| `theme_loader_version flip failed` | `shop_settings` row insert raced | Catalog is still live; flip manually:<br>`INSERT INTO shop_settings (shop_id, key, value) VALUES ('<UUID>', 'theme_loader_version', '"v2"'::jsonb) ON CONFLICT (shop_id, key) DO UPDATE SET value = excluded.value;` |
| Storefront returns 502 after deploy | pm2 didn't pick up the new theme | `ssh unbutu1@<server3> "pm2 reload gbox-storefront --update-env"`. |
| `no clone_run_metrics row` | Stage 12 finalize failed silently | Check pm2 logs for the worker; rerun finalize manually via `scripts/ops/finalize-clone-job.ts <JOB_ID>`. |

## 6. Cost reconciliation

Per-job AI spend is captured at:

- `clone_run_metrics.total_ai_cost_usd_cents` — single row per job, populated at Stage 12 finalize.
- `support_ai_usage` — append-only ledger of every Anthropic call. Filter by `metadata->>'job_id'`.
- `shop_ai_config.monthly_cost_usd_cents` — rolling 30-day total per shop (Sprint 0 BYOK).

```sql
-- Total cost for a single job
SELECT total_ai_cost_usd_cents / 100.0 AS total_usd
  FROM clone_run_metrics WHERE job_id = '<JOB_ID>';

-- Per-stage breakdown
SELECT
  metadata->>'stage' AS stage,
  count(*) AS calls,
  sum(input_tokens) AS in_tokens,
  sum(output_tokens) AS out_tokens,
  sum(cost_usd_cents) / 100.0 AS cost_usd
FROM support_ai_usage
WHERE metadata->>'job_id' = '<JOB_ID>'
GROUP BY 1
ORDER BY cost_usd DESC;

-- Reconcile against Anthropic invoice (monthly)
SELECT date_trunc('day', created_at) AS day,
       sum(cost_usd_cents) / 100.0 AS daily_usd
FROM support_ai_usage
WHERE metadata->>'pipeline' = 'clone-pro-v7'
  AND created_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC;
```

If the ledger total differs from the Anthropic invoice by more than 5%,
file a ticket — usually a missing `support_ai_usage` insert in a
hot-path scraper or vision call.

## 7. Acceptance gate (before declaring "v7 GA")

Run the live E2E from a clean test shop on Server 2:

```bash
# Server 2
SMOKE_SHOP_ID=<UUID> \
SMOKE_SOURCE_URL=https://bibliobloom.com \
SMOKE_PRODUCTS_LIMIT=1100 \
SMOKE_MIN_VISUAL_SCORE=7 \
CLONE_PRO_VERSION=v7 \
  npx tsx scripts/smoke-clone-pro-v7-pr5-e2e.ts
```

Expected:
- Exit code 0
- `tmp/e2e-result.json` has `fails: []`
- `productsLanded >= 1100`
- `themeBundle.isActive == true` and `fileCount > 20`
- `storefrontHealth.rootStatus == 200`
- `visualVerifyScore >= 7`

Then open `https://best-store-v7-final.gbox.co/` and visually compare
against `https://bibliobloom.com/`. If the comparison passes Thai's
side-by-side review, mark the sprint shipped.

## 8. Where to file issues

- Pipeline bug → GitHub issue `[clone-pro-v7]` prefix in the title.
- Scraper miss / theme generator regress → attach the source URL +
  `tmp/e2e-result.json` + a screenshot diff.
- Cost overrun → attach the `support_ai_usage` rows for the offending
  `job_id` + the Anthropic dashboard usage screenshot.
