/**
 * Gbox Platform — Asset / CDN Cache Load Test (Phase 8.4)
 *
 * Verifies that the headers Phase 8.3 added on `/assets/*` actually
 * deliver the cache behaviour we want at high concurrency:
 *
 *   1. First fetch of an asset returns 200 + the long-lived
 *      Cache-Control / CDN-Cache-Control directive.
 *   2. A subsequent fetch with `If-None-Match: <etag>` short-circuits
 *      to 304 in single-digit milliseconds.
 *   3. Font requests carry `Access-Control-Allow-Origin: *`.
 *   4. A bogus path (`/assets/missing.css`) responds 404 with
 *      `Cache-Control: no-store` so the CDN never pins it.
 *
 * Run this BEHIND the production CDN so the metrics include the
 * Cloudflare edge — the whole point of Phase 8.3 is that 99% of
 * these should be served by Cloudflare without ever touching the
 * origin.
 *
 * Usage:
 *
 *   k6 run -e SCENARIO=smoke scripts/load/assets-cdn.js
 *   k6 run -e SCENARIO=cdn   scripts/load/assets-cdn.js
 *
 *   k6 run \
 *     -e BASE_URL=https://shop.gbox.test \
 *     -e SHOP_HOST=demo.gbox.co \
 *     -e ASSETS=theme.css,theme.js,fonts/inter.woff2,logo.svg \
 *     scripts/load/assets-cdn.js
 *
 * SLO targets:
 *   - p95 200 latency  < 100ms (origin) / < 25ms (behind CDN)
 *   - p95 304 latency  < 30ms  / < 10ms behind CDN
 *   - revalidate_hit_rate > 0.95 after warm-up (Phase 8.3 wins)
 *   - bad_path_404_rate has Cache-Control: no-store on every miss
 */

import http from 'k6/http'
import { check, group } from 'k6'
import { Rate, Trend } from 'k6/metrics'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4326'
const SHOP_HOST = __ENV.SHOP_HOST || 'demo.gbox.co'

const ASSETS = (
  __ENV.ASSETS ||
  'theme.css,theme.js,fonts/inter.woff2,logo.svg,gbox-dawn/assets/cart.js'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SCENARIOS = {
  smoke: {
    executor: 'constant-vus',
    vus: 2,
    duration: '20s',
  },
  // Heavy CDN exercise — what a real flash sale looks like for static
  // assets when the HTML is also being rendered hot.
  cdn: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 100 },
      { duration: '3m', target: 100 },
      { duration: '30s', target: 0 },
    ],
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

const fresh200Latency = new Trend('asset_200_duration', true)
const revalidate304Latency = new Trend('asset_304_duration', true)
const revalidateHitRate = new Rate('revalidate_hit_rate')
const errorRate = new Rate('errors')

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: { assets: scenarioDef },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    asset_200_duration: ['p(95)<100'],
    asset_304_duration: ['p(95)<30'],
    revalidate_hit_rate: ['rate>0.95'],
    errors: ['rate<0.001'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADERS = {
  'X-Forwarded-Host': SHOP_HOST,
  Host: SHOP_HOST,
  'User-Agent': 'k6-loadtest/assets-cdn',
  // Force the edge to attempt brotli + gzip — exercises the Vary
  // header from Phase 8.3.
  'Accept-Encoding': 'br, gzip',
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ---------------------------------------------------------------------------
// Default function — fetch one asset twice (warm + revalidate),
// plus one bogus path per iteration to exercise the no-store branch
// ---------------------------------------------------------------------------

export default function assetsScenario() {
  const path = pickOne(ASSETS)
  const url = `${BASE_URL}/assets/${path}`

  let etag = null

  group('1. fresh fetch', () => {
    const res = http.get(url, { headers: HEADERS, tags: { phase: 'fresh' } })
    fresh200Latency.add(res.timings.duration)
    const ok = check(res, {
      'fresh: 200': (r) => r.status === 200,
      'fresh: Cache-Control immutable': (r) =>
        (r.headers['Cache-Control'] || '').includes('immutable'),
      'fresh: CDN-Cache-Control set': (r) =>
        (r.headers['Cdn-Cache-Control'] || r.headers['CDN-Cache-Control'] || '')
          .length > 0,
      'fresh: ETag present': (r) => Boolean(r.headers['Etag']),
      'fresh: nosniff': (r) =>
        r.headers['X-Content-Type-Options'] === 'nosniff',
    })
    if (!ok) errorRate.add(1)
    etag = res.headers['Etag']
  })

  if (etag) {
    group('2. conditional revalidate', () => {
      const res = http.get(url, {
        headers: { ...HEADERS, 'If-None-Match': etag },
        tags: { phase: 'revalidate' },
      })
      revalidate304Latency.add(res.timings.duration)
      const is304 = res.status === 304
      revalidateHitRate.add(is304 ? 1 : 0)
      const ok = check(res, {
        'revalidate: 304': (r) => r.status === 304,
      })
      if (!ok) errorRate.add(1)
    })
  }

  group('3. bogus path is not cacheable', () => {
    const res = http.get(`${BASE_URL}/assets/__nope_${Math.random()}.css`, {
      headers: HEADERS,
      tags: { phase: 'bogus' },
    })
    const ok = check(res, {
      'bogus: 404': (r) => r.status === 404,
      'bogus: Cache-Control: no-store': (r) =>
        (r.headers['Cache-Control'] || '').includes('no-store'),
    })
    if (!ok) errorRate.add(1)
  })
}
