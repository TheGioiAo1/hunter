# Clone Pro v7 Bulk Catalog Implementation Plan — Overview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Spec:** `docs/superpowers/specs/2026-04-26-clone-pro-v7-bulk-catalog-spec.md` (locked 2026-04-26)
>
> **Branch base:** `master` (Phase 21 v6 đã merged)
> **Branch root:** `feat/clone-pro-v7-bulk-catalog` (đã tạo)

**Goal:** Tool clone hoàn chỉnh: input 1 URL → output 1 store (theme 1:1 + full catalog) zero manual.

**Architecture:** 16-stage pipeline. Stages 1-3 + 5-12 reuse từ v6. Stage 4 mới (Lonspy XPath
bulk crawler). Stage 13-16 mới (theme builder screenshot-driven).

**Tech Stack:**
- Crawler: cheerio + xpath-html (port HtmlAgilityPack), got, p-limit, p-retry
- AI: Claude Sonnet 4.6 (fallback) + Claude Vision (design tokens)
- Theme: LiquidJS (Gbox storefront compatible)
- DB: Kysely + Postgres (migrations 099-103)
- S3: AWS SDK v3 (đã có v6)
- Test: Vitest + live Postgres smoke

---

## 6 Sprints — Mostly sequential, 19 days total (Sprint 2b parallel)

| # | Sprint | Days | Phase File | PR Branch | Status |
|---|--------|------|------------|-----------|--------|
| 1 | Lonspy Core Port | 5 | [phase-01-lonspy-core.md](./phase-01-lonspy-core.md) | `feat/v7-pr1-lonspy-core` | pending |
| 2 | Pipeline Integration | 3 | [phase-02-pipeline-integration.md](./phase-02-pipeline-integration.md) | `feat/v7-pr2-pipeline-integration` | pending |
| **2b** | **God Admin Caps (Q6)** | **1** | [phase-02b-god-admin-limits.md](./phase-02b-god-admin-limits.md) | `feat/v7-pr2b-god-admin-limits` | **pending** |
| 3 | Theme Capture + Tokens | 3 | [phase-03-theme-capture.md](./phase-03-theme-capture.md) | `feat/v7-pr3-theme-capture-tokens` | pending |
| 4 | Theme Generator | 5 | [phase-04-theme-generator.md](./phase-04-theme-generator.md) | `feat/v7-pr4-theme-generator` | pending |
| 5 | Storefront E2E | 2 | [phase-05-storefront-e2e.md](./phase-05-storefront-e2e.md) | `feat/v7-pr5-storefront-e2e` | pending |

**Sprint 2b standalone, có thể chạy parallel với Sprint 1+3 (không overlap files).**

## Locked decisions (Thai 2026-04-26)

- **Q1**: `products_limit` option khi paste URL. Default 200. Threshold pass = 95%.
- **Q2**: Concurrency 5 + delay 2000ms + 3 retry exponential backoff.
- **Q3**: Variants không giới hạn (full).
- **Q4**: Re-clone OVERWRITE — soft-delete products có orders, hard-delete khác.
- **Q5**: Sequential 6 sprint (5 chính + 1 god-admin), không pause.
- **Q6**: God Admin caps — 3 platform settings (max_per_job=5000, max_per_shop=50000, max_concurrent=3). API tự động cap + 429 nếu exceed.

## Sprint dependencies

```
Sprint 1 (crawler core) ──┐
                          ├──> Sprint 2 (integrate v6) ──> Sprint 3 (theme capture)
                          │                                       │
                          │                                       v
                          │                                  Sprint 4 (theme generator)
                          │                                       │
                          │                                       v
                          └──────────────────────────────> Sprint 5 (E2E live)
```

Sprint 1 self-contained → ship trước, anh có thể test crawler standalone.
Sprint 2 cần Sprint 1 done → bulk import vào DB.
Sprint 3 độc lập với 1+2 (chỉ cần URL source) → có thể chạy parallel với Sprint 2.
Sprint 4 cần Sprint 3 done (cần tokens) → generate theme.
Sprint 5 cần Sprint 2+4 done → wire all + live test.

## Test strategy

- **Unit (vitest)**: 50+ test cho mỗi sprint, ≥85% coverage cho module mới
- **Integration (live Postgres)**: smoke `scripts/smoke-clone-pro-v7-prN.ts` mỗi PR
- **Live E2E**: Sprint 2 acceptance + Sprint 5 acceptance dùng bibliobloom.com thật
- **Visual verify**: Sprint 4 + 5 dùng Claude vision side-by-side score

## Rollback plan

Mỗi sprint là 1 PR độc lập + có feature flag riêng:
- Sprint 1: chỉ port code, không activate
- Sprint 2: env `CLONE_PRO_VERSION=v7` activate Stage 4 v7. Rollback: `=v6`
- Sprint 3+4: env `THEME_BUILDER_ENABLED=true`. Rollback: `=false` skip Stage 13-16
- Sprint 5: env `THEME_LOADER_VERSION=v2` activate new DbLoader. Rollback: `=v1`

Mọi PR ship ra master + đè được lên config nếu cần rollback.

## Success criteria — End of Sprint 5

```
$ curl -X POST https://platform.gbox.co/api/clone-pro/start \
    -H "Authorization: Bearer <seller_token>" \
    -d '{"url": "https://bibliobloom.com", "products_limit": null}'

→ 200 { ok: true, job_id: "..." }

# 30 phút sau:
$ curl https://best-store.gbox.co/
→ render homepage 1:1 với bibliobloom.com (visual diff ≥ 7/10)

$ curl https://best-store.gbox.co/products/<handle>
→ 1100+ products đầy đủ description + multi-images + variants

$ curl https://best-store.gbox.co/collections/<handle>
→ all collections với product cards rendered đúng theme tokens
```

Anh test trực quan xác nhận 1:1 → tool hoàn chỉnh, ship.

## Rules áp dụng cho mọi sprint

1. **TDD**: failing test → minimal impl → green → commit (kit's primary-workflow)
2. **YAGNI/KISS/DRY**: không over-engineer, không premature abstraction
3. **Iron Rule 5**: mọi error qua `safeMessage()`, không leak god-admin path
4. **Files <300 lines**, kebab-case, type-safe (no `any`)
5. **Commit format**: `feat(v7-prN): <task>` / `test(v7-prN): <task>` / `fix(v7-prN): <issue>`
6. **Reports**: subagent reports vào `plans/.../reports/YYMMDD-from-X-to-Y-task.md`
