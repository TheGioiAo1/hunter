# Phase 05 — Sprint 5: Storefront Wire + Live E2E

**Date:** 2026-05-12 → 2026-05-14 (2 days, sprint cuối)
**Priority:** CRITICAL — anh test trực quan tại đây
**Branch:** `feat/v7-pr5-storefront-e2e`
**Depends on:** Sprint 1-4 merged

## Goal

Refactor storefront DbLoader đọc `theme_files` (mới) thay `theme_assets` (cũ).
Live E2E: 1 lệnh `POST /clone-pro/start { url: bibliobloom.com }` → 30 phút sau
best-store.gbox.co live 1:1.

## Files

```
packages/core/src/modules/themes/engine/loaders/
└── db-loader.ts                    # MODIFY: read theme_files thay theme_assets

apps/storefront/src/lib/
└── theme-loader.ts                 # MODIFY: env flag THEME_LOADER_VERSION

scripts/
├── deploy-theme-v7.sh              # Extract theme.zip vào /var/www/themes/<shop>/
├── smoke-clone-pro-v7-pr5-e2e.ts   # End-to-end test
└── ops/clone-pro-v7-runbook.md     # Production runbook
```

## Tasks

- [ ] **5.1** Storefront DbLoader v2
  - Modify `packages/core/src/modules/themes/engine/loaders/db-loader.ts`:
    - Detect `THEME_LOADER_VERSION` env: `v1` (theme_assets) vs `v2` (theme_files)
    - v2 query: `SELECT path, content FROM theme_files WHERE shop_id = $1 AND is_active = true`
    - Return same shape DbLoader expects (path → content map)
  - Test: 6 cases v1 vs v2 routing
  - Commit: `feat(v7-pr5): db-loader v2 reads theme_files (env flag)`

- [ ] **5.2** Theme deploy script
  - `scripts/deploy-theme-v7.sh`:
    ```bash
    #!/bin/bash
    SHOP_ID=$1
    THEME_ZIP_S3_KEY=$2
    DEST=/var/www/themes/${SHOP_ID}
    mkdir -p $DEST
    aws s3 cp s3://gbox-clone-storage/${THEME_ZIP_S3_KEY} /tmp/theme-${SHOP_ID}.zip
    rm -rf $DEST.bak
    [ -d $DEST ] && mv $DEST $DEST.bak
    mkdir -p $DEST
    unzip -q /tmp/theme-${SHOP_ID}.zip -d $DEST
    chown -R unbutu1:unbutu1 $DEST
    pm2 reload gbox-storefront
    echo "✓ Deployed theme to $DEST"
    ```
  - Reuse cho Sprint 4 + Sprint 5
  - Commit: `feat(v7-pr5): deploy-theme-v7.sh — extract zip + pm2 reload`

- [ ] **5.3** Stage 11 auto-publish v7 update
  - Modify `clone-pro/v7/stages/stage11-auto-publish.ts`:
    - Sau publish products + collections, trigger theme deploy:
      `await execDeployTheme({ shopId, themeZipKey })`
    - Set `THEME_LOADER_VERSION=v2` cho shop trong `shop_settings` table
  - Test: 4 cases
  - Commit: `feat(v7-pr5): stage11 trigger theme deploy + flip loader version`

- [ ] **5.4** Live E2E smoke (most important)
  - Script: `scripts/smoke-clone-pro-v7-pr5-e2e.ts`
  - Steps:
    1. Setup fresh shop `best-store-v7-final` trên server 1 + 3
    2. POST /clone-pro/start với url=bibliobloom.com, products_limit=null (full)
    3. Poll job status mỗi 30s
    4. Wait until job.status = 'completed' (max 60 phút)
    5. Assert:
       - products count ≥ 1100
       - theme deployed: `curl /var/www/themes/<shop>/templates/index.liquid` exists
       - storefront responds 200 cho /, /products/<handle>, /collections/<handle>
       - visual_verify_score ≥ 7
    6. Output: `tmp/e2e-result.json` với metrics + URLs cho Thai test trực quan
  - Commit: `test(v7-pr5): live E2E bibliobloom → best-store-v7-final 1:1`

- [ ] **5.5** Production runbook
  - File: `docs/ops/clone-pro-v7-runbook.md`
  - Sections:
    - Pre-flight checks (env vars, DB migrations 099-103, S3 access, Anthropic key)
    - Trigger clone (API curl example, dashboard UI link)
    - Monitor (PM2 logs, DB queries cho job status, S3 listing)
    - Rollback (THEME_LOADER_VERSION=v1, archive theme_files rows)
    - Common errors + fix (Cloudflare 429, AI timeout, S3 access denied)
    - Cost reconciliation (AI tokens used, S3 storage GB)
  - Commit: `docs(v7-pr5): production runbook clone-pro-v7`

- [ ] **5.6** Final acceptance test
  - Chạy:
    ```bash
    npx tsx scripts/smoke-clone-pro-v7-pr5-e2e.ts
    ```
  - Đợi 30-60 phút
  - Anh mở `https://best-store-v7-final.gbox.co/` test trực quan side-by-side với bibliobloom.com

## Acceptance Criteria

- [ ] DbLoader v2 hoạt động (test cả v1 + v2 paths)
- [ ] Theme deploy script extract đúng vào `/var/www/themes/<shop>/`
- [ ] E2E test: 1 lệnh POST → 30 phút sau best-store-v7-final live
- [ ] best-store-v7-final hiển thị 1100+ products full data
- [ ] Visual diff với bibliobloom score ≥ 7/10
- [ ] **Anh test trực quan confirm 1:1** ← acceptance gate cuối

## Risk

- DbLoader refactor break shops v6 cũ (không có theme_files rows). Mitigation: env flag mặc
  định v1, chỉ shop có Sprint 5 deploy mới flip v2.
- E2E timeout >60 phút. Mitigation: pre-warm Playwright, increase concurrency safe (Q2 says
  5+2000ms — có thể bump 8+1500ms nếu bibliobloom không ban)
- Visual score 6.5/10 — borderline. Mitigation: ship + Thai manual review; nếu OK → relax
  threshold; nếu không → Sprint 4 retry-loop tăng max retry lên 5.

## Post-merge

Sprint 5 PR merged → tool clone v7 hoàn chỉnh.
Anh có thể demo cho seller / khách hàng:
- Paste URL → 30 phút sau có store đầy đủ
- Theme 1:1 source visual
- Catalog đầy đủ products + variants + collections + pages

Phase tiếp theo (sau v7 ship): tối ưu cost AI, support nhiều platform mới, theme variant marketplace.
