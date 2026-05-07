# Review — commit 95f2d8f (efficiency)

Scope: 8 files, 991 insertions. Customer-Service API client wiring + segment customers page + customers API-mode fallback.

## Verdict
Ship with low/medium fixes. No critical perf bugs.

## Findings

### Medium

**M1 — Double fetch for segment header name**
File: `apps/store-admin/src/pages/customer-segment-customers.ts:55-58`
Smell: `apiGetSegment` + `apiApplySegment` parallel just so render header has `segment.name`. BE `applySegment` only returns `{pagination, data}`. 2 RTTs per page load.
Fix: extend BE `/segments/{id}/customers` response to include `segment: {id, name}` envelope. Drop `apiGetSegment`. Saves 1 round trip per request. Acceptable as-is because `Promise.allSettled` runs them parallel — not sequential blocking.

**M2 — Unbounded segments list (limit:250 + render all)**
File: `apps/store-admin/src/pages/customer-segments.ts:151`
Smell: `apiListSegments(ctx, { limit: 250 })` fetches up to 250 segments, render loop at line 290 does `customSegments.map(...)` without pagination. Large shops (100+ segments) → wasteful payload + DOM bloat.
Fix: paginate BE call (limit 25-50), add page nav OR show top-N + "View all" link to dedicated paginated page.

**M3 — DEFAULT_CUSTOMER_FIELDS over-fetch**
File: `apps/store-admin/src/lib/customer-api-client.ts:208`
Smell: 11 fields ship by default. `customers-api-list.ts` row uses 7 (id, full_name|first|last, email, phone, city, country_code, created_at). `shop_id`, `country_name`, `province` ignored.
Fix: caller passes explicit slim `fields` opt — `id,first_name,last_name,full_name,email,phone,city,country_code,created_at`. ~30% payload trim at scale.

### Low

**L1 — Intl.NumberFormat per-row construction**
File: `apps/store-admin/src/pages/customer-segment-customers.ts:174,196` (`formatMoney`)
Smell: `new Intl.NumberFormat('en-US', {...currency...})` constructed inside `renderRow`. 50 rows = 50 formatter instances per render.
Fix: cache formatter by currency in module scope (`Map<string, Intl.NumberFormat>`).

**L2 — `esc(store.slug)` in `base` recomputed each call**
File: `customer-segment-customers.ts:30`, `customers-api-list.ts:28`
Smell: cosmetic, negligible.

## Done well

- `Promise.allSettled` for list/summary — independent failures don't kill render.
- `AbortSignal.timeout(8000)` consistent across all API calls.
- API mode page (`customers-api-list.ts`) split as separate module — keeps `customers.ts` (80KB) from bloating.
- `?? 0` coalesce for BE `[DataMember(EmitDefaultValue=false)]` serialization quirk.
- 404 handled gracefully (`getSegment` returns null, caller redirects).
- Route ordering in `server.ts:1289` (segmentId/customers BEFORE bare /:segmentId) — correct.

## Q1-Q9 answered

1. Skip getSegment if apply returns metadata? → BE doesn't currently. Worth BE change; client-side already parallel via allSettled, so secondary.
2. Sequential not parallel? → None. listSegments + segmentSummary already parallel. Editor preview/save are inherently sequential (user action driven).
3. Hot-path bloat? → Inline templates OK, matches shop-admin pattern.
4. No-op updates? → N/A SSR.
5. Duplicate hasDb guards? → No, single guard at `customers.ts:81`.
6. Render memory? → ~10KB HTML per request. No cache, OK for SSR.
7. limit:250 unbounded? → **YES** (M2 above).
8. AbortSignal.timeout? → 8s, OK.
9. DEFAULT_CUSTOMER_FIELDS over-fetch? → **YES** (M3 above).

## Action items (priority)
1. (M2) Paginate `apiListSegments` — biggest scalability win.
2. (M3) Caller-controlled `fields` slim list.
3. (L1) Cache `Intl.NumberFormat` per currency.
4. (M1, future BE work) Include segment metadata in apply response.

## Unresolved Qs

- Có plan add segment filter cho `customers-api-list.ts` không? (Banner ở line 80-84 nói "auto segment requires CustomerStats sync" — consistent với BE limitation.)
- BE `/segments/summary` — mỗi page load có cache layer ở BE side không, hay hit DB mỗi lần? (Performance concern at scale, ngoài scope client review.)
