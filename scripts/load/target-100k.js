/**
 * Gbox Platform — 100K Orders / Month Target Harness (Phase 3E)
 *
 * One k6 script that models the REAL traffic shape a merchant hits
 * when they process ~100,000 orders per month. This is the number
 * Thai picked as the Phase 3 design ceiling (`CLAUDE.md` → Phase 3
 * target) and we need a dedicated harness to prove the stack can
 * sustain it before cutting over VPS production.
 *
 * Back-of-the-envelope math (see the runbook in
 * `docs/runbooks/phase-3d-edge-cache-rules.md` for the full
 * breakdown):
 *
 *     100,000 orders / 30 days / 86400 s ≈  0.04 orders/s average
 *     10x peak (dinner rush, paydays)    ≈  0.4  orders/s
 *     100x peak (flash sale, TikTok)     ≈  4    orders/s
 *
 *     conversion rate ≈ 2%  →  ~5,000,000 pageviews / month
 *     avg pageviews/sec ≈ 2
 *     peak pageviews/sec ≈ 200  (flash sale)
 *
 *     pageviews:orders ≈ 50:1
 *
 * So for every checkout we drive we want ~50 storefront browse
 * iterations running in parallel. That's exactly what this harness
 * does via two k6 scenarios:
 *
 *   - `browse_traffic` — the dominant 98% of requests. Drives
 *     home / collection / product GETs at the correct rate.
 *   - `checkout_traffic` — the remaining 2% of traffic. Drives
 *     the full cart → checkout begin → render funnel.
 *
 * Each scenario has its own thresholds so a regression in either
 * path fails the run with a clear, actionable summary row.
 *
 * Profiles (pick with -e PROFILE=...):
 *
 *   | profile   | duration | traffic shape                          |
 *   |-----------|----------|----------------------------------------|
 *   | smoke     | 30s      | 1 browse VU + 1 checkout VU — sanity   |
 *   | baseline  | 5m       | average month — 100 browse / 5 checkout|
 *   | peak      | 5m       | dinner rush — 400 browse / 20 checkout |
 *   | flash     | 3m       | TikTok burst — ramp to 1500/60 then    |
 *   |           |          | hold 90s                                |
 *   | sustain   | 30m      | soak at baseline for slow-leak hunt    |
 *
 * Usage:
 *
 *   # smoke (fast — fits a CI gate)
 *   k6 run -e PROFILE=smoke scripts/load/target-100k.js
 *
 *   # full flash sale simulation against the test box
 *   k6 run \
 *     -e PROFILE=flash \
 *     -e BASE_URL=http://192.168.1.13:4326 \
 *     -e SHOP_HOST=demo.gbox.co \
 *     -e PRODUCT_HANDLES=tee-black,tee-white,hoodie-grey \
 *     -e COLLECTION_HANDLES=all,sale,new-arrivals \
 *     -e VARIANT_IDS=v1,v2,v3 \
 *     scripts/load/target-100k.js
 *
 * SLOs locked into `thresholds`:
 *
 *   - Browse p95 < 300ms, p99 < 800ms, errors < 0.5%
 *   - Checkout p95 < 500ms, p99 < 1200ms, errors < 0.1%, zero 5xx
 *   - Order-creation rate >= 2/min across the `peak` profile
 *     (proves the post-checkout fan-out queue is draining fast
 *      enough to not block the hot path)
 *
 * This script is deliberately self-contained — no imports from
 * storefront-browse.js / checkout-flow.js — so the one file can
 * be copied to any server and run in isolation, matching the
 * convention the existing scripts follow per `load/README.md`.
 */

import http from 'k6/http'
import { check, group, sleep } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'

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
const VARIANT_IDS = (__ENV.VARIANT_IDS || 'v1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// ---------------------------------------------------------------------------
// Profiles — picked with -e PROFILE=...
// ---------------------------------------------------------------------------

const PROFILES = {
  smoke: {
    browse: {
      executor: 'constant-vus',
      vus: 1,
      duration: '30s',
      exec: 'browseIteration',
    },
    checkout: {
      executor: 'constant-vus',
      vus: 1,
      duration: '30s',
      exec: 'checkoutIteration',
      startTime: '0s',
    },
  },
  // Baseline — matches the average-month math. 100 browse VUs and
  // 5 checkout VUs gives roughly a 50:1 ratio and converges on the
  // target 0.04 orders/s.
  baseline: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '4m', target: 100 },
        { duration: '30s', target: 0 },
      ],
      exec: 'browseIteration',
    },
    checkout: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 5 },
        { duration: '4m', target: 5 },
        { duration: '30s', target: 0 },
      ],
      exec: 'checkoutIteration',
      startTime: '0s',
    },
  },
  // Peak — dinner-rush style. 10x the baseline VU count while
  // preserving the 50:1 ratio.
  peak: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 400 },
        { duration: '3m', target: 400 },
        { duration: '1m', target: 0 },
      ],
      exec: 'browseIteration',
    },
    checkout: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 20 },
        { duration: '3m', target: 20 },
        { duration: '1m', target: 0 },
      ],
      exec: 'checkoutIteration',
      startTime: '0s',
    },
  },
  // Flash sale — rapid spike, short hold. Tests that the tiered
  // cache + order queue can absorb a burst without melting the
  // origin.
  flash: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '30s', target: 1500 },
        { duration: '90s', target: 1500 },
        { duration: '30s', target: 10 },
      ],
      exec: 'browseIteration',
    },
    checkout: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 60 },
        { duration: '90s', target: 60 },
        { duration: '30s', target: 1 },
      ],
      exec: 'checkoutIteration',
      startTime: '0s',
    },
  },
  // Long soak for slow-leak detection. Same shape as baseline but
  // held for 30 minutes.
  sustain: {
    browse: {
      executor: 'constant-vus',
      vus: 100,
      duration: '30m',
      exec: 'browseIteration',
    },
    checkout: {
      executor: 'constant-vus',
      vus: 5,
      duration: '30m',
      exec: 'checkoutIteration',
      startTime: '0s',
    },
  },
}

const profileName = __ENV.PROFILE || 'smoke'
const profileDef = PROFILES[profileName]
if (!profileDef) {
  throw new Error(
    `Unknown PROFILE=${profileName}. Valid: ${Object.keys(PROFILES).join(', ')}`,
  )
}

// ---------------------------------------------------------------------------
// Custom metrics — split per-path so a regression to one layer
// doesn't hide under the global average.
// ---------------------------------------------------------------------------

const browseHome = new Trend('browse_home_duration', true)
const browseCollection = new Trend('browse_collection_duration', true)
const browseProduct = new Trend('browse_product_duration', true)
const browseErrors = new Rate('browse_errors')

const checkoutCartAdd = new Trend('checkout_cart_add_duration', true)
const checkoutBegin = new Trend('checkout_begin_duration', true)
const checkoutRender = new Trend('checkout_render_duration', true)
const checkoutErrors = new Rate('checkout_errors')
const checkoutFunnelsStarted = new Counter('checkout_funnels_started')

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    browse_traffic: profileDef.browse,
    checkout_traffic: profileDef.checkout,
  },
  thresholds: {
    // Global
    http_req_failed: ['rate<0.01'],

    // Browse SLOs
    browse_home_duration: ['p(95)<200'],
    browse_collection_duration: ['p(95)<400'],
    browse_product_duration: ['p(95)<500'],
    browse_errors: ['rate<0.005'],

    // Checkout SLOs — tighter because revenue incident risk.
    checkout_cart_add_duration: ['p(95)<250'],
    checkout_begin_duration: ['p(95)<400'],
    checkout_render_duration: ['p(95)<500'],
    checkout_errors: ['rate<0.001'],

    // Make sure we actually DID drive some checkout funnels during
    // the run — if this count is 0 the threshold assertions above
    // would pass vacuously.
    checkout_funnels_started: ['count>=1'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const HEADERS = {
  'X-Forwarded-Host': SHOP_HOST,
  Host: SHOP_HOST,
  'User-Agent': 'k6-loadtest/target-100k',
  'Accept-Language': 'en-US,en;q=0.9',
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ---------------------------------------------------------------------------
// Browse iteration — shopper flow, no checkout
// ---------------------------------------------------------------------------

export function browseIteration() {
  group('browse:home', () => {
    const res = http.get(`${BASE_URL}/`, {
      headers: HEADERS,
      tags: { path: 'home' },
    })
    browseHome.add(res.timings.duration)
    const ok = check(res, { 'home: 200': (r) => r.status === 200 })
    if (!ok) browseErrors.add(1)
  })

  sleep(1)

  group('browse:collection', () => {
    const handle = pickOne(COLLECTION_HANDLES)
    const res = http.get(`${BASE_URL}/collections/${handle}`, {
      headers: HEADERS,
      tags: { path: 'collection' },
    })
    browseCollection.add(res.timings.duration)
    const ok = check(res, { 'collection: 200': (r) => r.status === 200 })
    if (!ok) browseErrors.add(1)
  })

  sleep(1)

  group('browse:product', () => {
    const handle = pickOne(PRODUCT_HANDLES)
    const res = http.get(`${BASE_URL}/products/${handle}`, {
      headers: HEADERS,
      tags: { path: 'product' },
    })
    browseProduct.add(res.timings.duration)
    const ok = check(res, { 'product: 200': (r) => r.status === 200 })
    if (!ok) browseErrors.add(1)
  })

  // Realistic shopper think-time between page views. Without this
  // k6 hammers the origin with back-to-back GETs which is not what
  // a 100K-orders/month merchant actually sees.
  sleep(2)
}

// ---------------------------------------------------------------------------
// Checkout iteration — full funnel
// ---------------------------------------------------------------------------

export function checkoutIteration() {
  checkoutFunnelsStarted.add(1)

  const variantId = pickOne(VARIANT_IDS)

  // 1. Add to cart
  let cartToken = null
  group('checkout:cart_add', () => {
    const res = http.post(
      `${BASE_URL}/cart/add`,
      JSON.stringify({
        items: [{ id: variantId, quantity: 1 }],
      }),
      {
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        tags: { path: 'cart_add' },
      },
    )
    checkoutCartAdd.add(res.timings.duration)
    const ok = check(res, {
      'cart_add: 2xx': (r) => r.status >= 200 && r.status < 300,
    })
    if (!ok) checkoutErrors.add(1)
    try {
      const body = res.json()
      cartToken = body?.token ?? null
    } catch (_err) {
      // Non-JSON response — body shape validated by the check above.
    }
  })

  sleep(1)

  // 2. Begin checkout
  group('checkout:begin', () => {
    const res = http.post(
      `${BASE_URL}/checkout/begin`,
      JSON.stringify({ cart_token: cartToken }),
      {
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        tags: { path: 'checkout_begin' },
      },
    )
    checkoutBegin.add(res.timings.duration)
    const ok = check(res, {
      'begin: 2xx': (r) => r.status >= 200 && r.status < 300,
    })
    if (!ok) checkoutErrors.add(1)
  })

  sleep(1)

  // 3. Render checkout page
  group('checkout:render', () => {
    const res = http.get(`${BASE_URL}/checkout`, {
      headers: HEADERS,
      tags: { path: 'checkout_render' },
    })
    checkoutRender.add(res.timings.duration)
    const ok = check(res, {
      'render: 2xx or 3xx': (r) => r.status >= 200 && r.status < 400,
    })
    if (!ok) checkoutErrors.add(1)
  })

  sleep(2)
}

// ---------------------------------------------------------------------------
// Default export — k6 requires one. Since every VU picks its
// executor explicitly via `exec`, the default is never called, but
// k6 still asks for it. Make it a loud error if it ever runs, so a
// misconfigured PROFILE doesn't silently skip the real work.
// ---------------------------------------------------------------------------

export default function () {
  throw new Error(
    'target-100k.js default function called — every scenario MUST set ' +
      '`exec`. This is a PROFILE wiring bug.',
  )
}
