# Phase 3D — Edge Cache & CDN Rules

This runbook is the canonical reference for how Gbox responses flow
through Cloudflare → nginx → Node and which headers each layer
honours. The implementation lives in
`packages/core/src/modules/cache/edge-headers.ts` (helpers + presets)
and the unit tests in `edge-headers.test.ts` lock the exact string
output.

## 1. Response classes

Every response the platform emits falls into one of six preset
classes. The preset name is the single source of truth — add new
classes to `CACHE_PRESETS` rather than hand-rolling headers at a
call site.

| Preset | Used for | Browser TTL | Edge TTL | SWR | `Vary` |
| --- | --- | --- | --- | --- | --- |
| `theme_asset_immutable` | Fingerprinted CSS / JS / fonts / images served from S3 or CloudFront | 1 year, immutable | 1 year | — | — |
| `storefront_html_swr` | Non-personalised storefront HTML (home, product, collection) | 0, must-revalidate | 60 s | 600 s SWR, 24 h stale-if-error | Accept-Language, Cookie |
| `api_short` | JSON endpoints for hot read data (product list, collection) | 30 s | 60 s | 300 s SWR, 24 h stale-if-error | Accept-Language |
| `api_long` | JSON endpoints for near-static data (shop settings, nav tree) | 300 s | 600 s | 3600 s SWR, 24 h stale-if-error | Accept-Language |
| `personalised_private` | Cart JSON, customer drop, order history | 0 | not cached at edge | — | Cookie |
| `no_store` | Admin dashboard, checkout forms, auth callbacks | not stored | not stored | — | Cookie |

## 2. Header layers

Every cached preset stamps three headers. Hand-written responses
that bypass `applyCachePolicy` must emit all three or risk policy
drift between Cloudflare and the browser.

| Header | Read by | Notes |
| --- | --- | --- |
| `Cache-Control` | Browser, generic proxies | Uses `max-age` for the browser TTL. Includes `must-revalidate` for strict SWR. |
| `CDN-Cache-Control` | Cloudflare (preferred) | Uses `s-maxage` as the edge TTL. `private` → `no-store` so the CDN never stores a private response. |
| `Surrogate-Control` | Legacy CDNs / Varnish | Same value as `CDN-Cache-Control`. |

## 3. Cloudflare cache rules

Configure in the Cloudflare dashboard under **Caching → Cache Rules**.
These rules translate the preset classes into edge behaviour for
the two domains we care about (`*.gbox.co` and every custom
merchant domain). The `CDN-Cache-Control` header from Node is the
authoritative source — these rules only bootstrap sane defaults for
routes that forgot to set the header.

1. **Theme assets — `*.gbox.co/assets/*`, `cdn.gbox.co/*`**
   - Cache eligibility: **Eligible for cache**
   - Edge TTL: **Respect origin** (honours our `max-age=31536000`)
   - Browser TTL: **Respect origin**
   - Serve stale on error: **Enabled**

2. **Storefront HTML — everything else on merchant domains**
   - Cache eligibility: **Eligible for cache** but only for `GET`
     + `HEAD` with `Content-Type: text/html`
   - Edge TTL: **Respect origin** (our preset emits 60 s)
   - Browser TTL: **Respect origin**
   - Serve stale on error: **Enabled**
   - **Bypass cache on cookie**: match any of
     `gbox_session`, `gbox_customer_session`, `gbox_cart`
     (prevents personalised HTML from poisoning the edge cache)

3. **JSON API — `*.gbox.co/api/*`**
   - Cache eligibility: **Eligible for cache** for `GET` only
   - Edge TTL: **Respect origin**
   - Cache key: include the `Accept-Language` header so locales stay
     separated (matches the `Vary` we emit)
   - **Bypass on cookie**: `gbox_session`, `gbox_customer_session`

4. **Admin dashboard — `admin.gbox.co/*`**
   - Cache eligibility: **Bypass cache** (we already emit `no-store`
     but this is defence in depth)

5. **Static marketing — `www.gbox.co/*`, `gbox.co/*`**
   - Cache eligibility: **Eligible for cache**
   - Edge TTL: **1 hour** as the fallback for any route that does
     not set a header
   - Browser TTL: **5 minutes**

## 4. nginx rules (upstream layer)

nginx sits between Cloudflare and the PM2 cluster. It does NOT do
content caching (Cloudflare already does), but it does rewrite
Cache-Control on a few paths so a bug in Node cannot surface a
`Cache-Control: public, max-age=0` that defeats the CDN.

```nginx
# apps/storefront/deploy/nginx/gbox-storefront.conf (excerpt)

# Theme asset routes MUST be immutable.
location ~* ^/assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    add_header CDN-Cache-Control "public, max-age=31536000, immutable" always;
    proxy_pass http://storefront_upstream;
}

# Admin + checkout MUST NEVER be cached.
location ~* ^/(admin|checkout|auth)/ {
    add_header Cache-Control "no-store" always;
    add_header CDN-Cache-Control "no-store" always;
    proxy_pass http://api_upstream;
}
```

## 5. Common failure modes

- **Wrong language at the edge** — means the route emitted an
  `api_short` / `storefront_html_swr` preset but nginx stripped
  `Vary: Accept-Language`. Fix by adding `proxy_pass_header Vary;`
  to the affected nginx location.
- **Stale admin page after logout** — means a route emitted a
  preset other than `no_store` on a logged-in response. The
  back-button shows the cached page. Fix by switching the preset
  at the call site, never by adding per-request cache busters.
- **CDN returning stale after an invalidation** — cache-aside
  invalidation (`CachedStorefrontDataSource.invalidateProduct`)
  only blows our Redis cache; the Cloudflare edge still holds the
  old response until its own TTL expires. For instant
  invalidations, call `curl -X POST "https://api.cloudflare.com/.../purge_cache"`
  with the affected URLs. Runbook for that command lives in
  `phase-6-production-hardening.md`.

## 6. Testing matrix

When changing a preset, run all three of these before merging:

1. `npx vitest run packages/core/src/modules/cache/edge-headers.test.ts`
   — pure unit tests for the string builder.
2. Hit a staging URL with `curl -I` and diff the full header set
   against the previous release. Cache-Control diffs at the edge
   are the most common regression class.
3. Verify the Cloudflare dashboard shows the expected HIT / MISS
   ratio for the route within 10 minutes.
