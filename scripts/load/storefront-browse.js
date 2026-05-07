/**
 * Gbox Platform — Storefront Browse Load Test (Phase 8.4)
 *
 * Drives a realistic shopper-browsing pattern through the storefront:
 * homepage → collection page → product page. Every step is asserted
 * for status + p95 latency so a regression in any layer fails the
 * run.
 *
 * Why these three paths:
 *   - `/`             pings the cached drops loader (active theme,
 *                     nav, shop settings) — Phase 8.1 cache should
 *                     keep this sub-50ms after warm-up.
 *   - `/collections/<handle>`
 *                     forces a paginated product listing — exercises
 *                     the read-replica path from Phase 8.2.
 *   - `/products/<handle>`
 *                     full product detail page — the most expensive
 *                     storefront route, hits product + variant +
 *                     image queries.
 *
 * Usage:
 *
 *   # Smoke (1 VU, 30s) — quickest sanity check, runnable on a laptop.
 *   k6 run -e SCENARIO=smoke scripts/load/storefront-browse.js
 *
 *   # Average (50 VUs, 5min) — daily perf baseline.
 *   k6 run -e SCENARIO=average scripts/load/storefront-browse.js
 *
 *   # Stress (ramp to 500 VUs over 10min) — find the breaking point.
 *   k6 run -e SCENARIO=stress scripts/load/storefront-browse.js
 *
 *   # Soak (100 VUs, 30min) — catch slow leaks + connection-pool
 *   # exhaustion.
 *   k6 run -e SCENARIO=soak scripts/load/storefront-browse.js
 *
 * Override the target with `BASE_URL`, the test shop with
 * `SHOP_HOST`, and the product/collection handles to hit with
 * `COLLECTION_HANDLES` / `PRODUCT_HANDLES` (comma-separated).
 *
 *   k6 run \
 *     -e BASE_URL=https://shop.gbox.test \
 *     -e SHOP_HOST=demo.gbox.co \
 *     -e PRODUCT_HANDLES=tee-black,tee-white,hoodie-grey \
 *     -e COLLECTION_HANDLES=all,sale \
 *     scripts/load/storefront-browse.js
 *
 * SLO targets locked in via `thresholds`:
 *   - p95 < 300ms across all routes
 *   - p99 < 800ms across all routes
 *   - >99% requests return 2xx
 *   - <1% checks failed
 */

import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Rate, Trend } from 'k6/metrics'

// ---------------------------------------------------------------------------
// Config (env-driven)
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4326'
const SHOP_HOST = __ENV.SHOP_HOST || 'demo.gbox.co'

const PRODUCT_HANDLES = (__ENV.PRODUCT_HANDLES || 'sample-product')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const COLLECTION_HANDLES = (__ENV.COLLECTION_HANDLES || 'all')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// ---------------------------------------------------------------------------
// Scenarios — pick one with -e SCENARIO=...
// ---------------------------------------------------------------------------

const SCENARIOS = {
  smoke: {
    executor: 'constant-vus',
    vus: 1,
    duration: '30s',
  },
  average: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 50 },
      { duration: '4m', target: 50 },
      { duration: '30s', target: 0 },
    ],
  },
  stress: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 100 },
      { duration: '2m', target: 250 },
      { duration: '3m', target: 500 },
      { duration: '2m', target: 500 },
      { duration: '1m', target: 0 },
    ],
  },
  soak: {
    executor: 'constant-vus',
    vus: 100,
    duration: '30m',
  },
}

const scenarioName = __ENV.SCENARIO || 'smoke'
const scenarioDef = SCENARIOS[scenarioName]
if (!scenarioDef) {
  throw new Error(
    `Unknown SCENARIO=${scenarioName}. Valid: ${Object.keys(SCENARIOS).join(', ')}`,
  )
}

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const homeLatency = new Trend('home_duration', true)
const collectionLatency = new Trend('collection_duration', true)
const productLatency = new Trend('product_duration', true)
const errorRate = new Rate('errors')

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: { browse: scenarioDef },
  thresholds: {
    // Global SLOs
    http_req_duration: ['p(95)<300', 'p(99)<800'],
    http_req_failed: ['rate<0.01'],
    errors: ['rate<0.01'],
    // Per-route SLOs — surface a regression to one path even if the
    // overall budget hides it.
    home_duration: ['p(95)<200'],
    collection_duration: ['p(95)<400'],
    product_duration: ['p(95)<500'],
  },
  // Quiet stdout: only print summary + failed checks.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADERS = {
  // Tenant routing on the storefront uses X-Forwarded-Host (server.ts
  // sets `trustForwardedHost: true`), so we send it explicitly. The
  // production nginx upstream sets it for us — under k6 we have to.
  'X-Forwarded-Host': SHOP_HOST,
  Host: SHOP_HOST,
  'User-Agent': 'k6-loadtest/storefront-browse',
  'Accept-Language': 'en-US,en;q=0.9',
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ---------------------------------------------------------------------------
// Default function — what each VU does on every iteration
// ---------------------------------------------------------------------------

export default function browseScenario() {
  group('home', () => {
    const res = http.get(`${BASE_URL}/`, { headers: HEADERS, tags: { route: 'home' } })
    homeLatency.add(res.timings.duration)
    const ok = check(res, {
      'home: 200': (r) => r.status === 200,
      'home: HTML body': (r) =>
        typeof r.body === 'string' && r.body.includes('<html'),
    })
    if (!ok) errorRate.add(1)
  })

  // Realistic shopper pause — they read the homepage before clicking
  // through.
  sleep(1)

  group('collection', () => {
    const handle = pickOne(COLLECTION_HANDLES)
    const res = http.get(`${BASE_URL}/collections/${handle}`, {
      headers: HEADERS,
      tags: { route: 'collection' },
    })
    collectionLatency.add(res.timings.duration)
    const ok = check(res, {
      'collection: 200': (r) => r.status === 200,
    })
    if (!ok) errorRate.add(1)
  })

  sleep(1)

  group('product', () => {
    const handle = pickOne(PRODUCT_HANDLES)
    const res = http.get(`${BASE_URL}/products/${handle}`, {
      headers: HEADERS,
      tags: { route: 'product' },
    })
    productLatency.add(res.timings.duration)
    const ok = check(res, {
      'product: 200': (r) => r.status === 200,
    })
    if (!ok) errorRate.add(1)
  })

  sleep(2)
}
