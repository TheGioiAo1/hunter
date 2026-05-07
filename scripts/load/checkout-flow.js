/**
 * Gbox Platform — Checkout Flow Load Test (Phase 8.4)
 *
 * Models the highest-stakes path on the platform: the merchant's
 * conversion funnel. Drops a fresh shopper through:
 *
 *   1. Product page          (warm the cart cookie)
 *   2. POST /cart/add        (add a variant)
 *   3. GET  /cart            (totals + shipping preview)
 *   4. POST /checkout/begin  (creates a checkout session)
 *   5. GET  /checkout/<id>   (renders step 1 of the funnel)
 *
 * If any of these regress, the merchant immediately loses revenue —
 * so the SLOs here are tighter than the generic browse path.
 *
 * Usage:
 *
 *   k6 run -e SCENARIO=smoke   scripts/load/checkout-flow.js
 *   k6 run -e SCENARIO=peak    scripts/load/checkout-flow.js
 *   k6 run -e SCENARIO=spike   scripts/load/checkout-flow.js
 *
 *   k6 run \
 *     -e BASE_URL=https://shop.gbox.test \
 *     -e SHOP_HOST=demo.gbox.co \
 *     -e PRODUCT_HANDLES=tee-black,hoodie-grey \
 *     -e VARIANT_IDS=v1,v2 \
 *     scripts/load/checkout-flow.js
 *
 * SLO targets:
 *   - p95 add-to-cart  < 250ms
 *   - p95 begin-checkout < 400ms
 *   - p99 across all steps < 1s
 *   - 0 5xx allowed
 */

import http from 'k6/http'
import { check, sleep, group, fail } from 'k6'
import { Rate, Trend, Counter } from 'k6/metrics'

// ---------------------------------------------------------------------------
// Config (env-driven)
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4326'
const SHOP_HOST = __ENV.SHOP_HOST || 'demo.gbox.co'

const PRODUCT_HANDLES = (__ENV.PRODUCT_HANDLES || 'sample-product')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const VARIANT_IDS = (__ENV.VARIANT_IDS || 'v1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SCENARIOS = {
  smoke: {
    executor: 'constant-vus',
    vus: 1,
    duration: '30s',
  },
  // "Peak" approximates a high-traffic merchant during a normal hour:
  // ~30 concurrent shoppers each completing a checkout every ~10s.
  peak: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: 30 },
      { duration: '5m', target: 30 },
      { duration: '30s', target: 0 },
    ],
  },
  // "Spike" is the worst-case: a flash sale or a TikTok-driven burst.
  // 5 → 200 VUs in 30s, hold for 2min, ramp down. The point is to
  // catch lock contention + cold-cache stampedes, not steady-state
  // throughput.
  spike: {
    executor: 'ramping-vus',
    startVUs: 5,
    stages: [
      { duration: '30s', target: 200 },
      { duration: '2m', target: 200 },
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

const cartAddLatency = new Trend('cart_add_duration', true)
const cartViewLatency = new Trend('cart_view_duration', true)
const beginLatency = new Trend('checkout_begin_duration', true)
const renderLatency = new Trend('checkout_render_duration', true)
const errorRate = new Rate('errors')
const completedFunnels = new Counter('checkout_funnels_completed')

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: { checkout: scenarioDef },
  thresholds: {
    http_req_duration: ['p(99)<1000'],
    // Zero 5xx tolerance — checkout 5xx is a revenue incident.
    'http_req_failed{status:5xx}': ['rate==0'],
    errors: ['rate<0.01'],
    cart_add_duration: ['p(95)<250'],
    checkout_begin_duration: ['p(95)<400'],
    checkout_render_duration: ['p(95)<500'],
    // We expect at least 1 funnel completion per VU per scenario;
    // anything less means the funnel is broken end-to-end.
    checkout_funnels_completed: ['count>0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonHeaders() {
  return {
    'X-Forwarded-Host': SHOP_HOST,
    Host: SHOP_HOST,
    'User-Agent': 'k6-loadtest/checkout-flow',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
}

function htmlHeaders() {
  return {
    'X-Forwarded-Host': SHOP_HOST,
    Host: SHOP_HOST,
    'User-Agent': 'k6-loadtest/checkout-flow',
    Accept: 'text/html',
  }
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ---------------------------------------------------------------------------
// Default function — single end-to-end funnel attempt per VU iteration
// ---------------------------------------------------------------------------

export default function checkoutFunnel() {
  // k6's http module persists cookies per VU, so a single VU acts as
  // one shopper across all 5 steps without manual cookie plumbing.
  const productHandle = pickOne(PRODUCT_HANDLES)
  const variantId = pickOne(VARIANT_IDS)

  group('1. product page', () => {
    const res = http.get(`${BASE_URL}/products/${productHandle}`, {
      headers: htmlHeaders(),
      tags: { step: 'product' },
    })
    if (
      !check(res, {
        'product: 200': (r) => r.status === 200,
      })
    ) {
      errorRate.add(1)
      fail('product page did not 200, aborting funnel')
    }
  })

  sleep(0.5)

  group('2. add to cart', () => {
    const res = http.post(
      `${BASE_URL}/cart/add`,
      JSON.stringify({ variantId, quantity: 1 }),
      { headers: jsonHeaders(), tags: { step: 'cart_add' } },
    )
    cartAddLatency.add(res.timings.duration)
    if (
      !check(res, {
        'cart/add: 2xx': (r) => r.status >= 200 && r.status < 300,
      })
    ) {
      errorRate.add(1)
      fail('cart/add failed, aborting funnel')
    }
  })

  group('3. view cart', () => {
    const res = http.get(`${BASE_URL}/cart`, {
      headers: htmlHeaders(),
      tags: { step: 'cart_view' },
    })
    cartViewLatency.add(res.timings.duration)
    if (
      !check(res, {
        'cart: 200': (r) => r.status === 200,
      })
    ) {
      errorRate.add(1)
    }
  })

  sleep(1)

  let checkoutId = null

  group('4. begin checkout', () => {
    const res = http.post(`${BASE_URL}/checkout/begin`, '{}', {
      headers: jsonHeaders(),
      tags: { step: 'checkout_begin' },
    })
    beginLatency.add(res.timings.duration)
    const ok = check(res, {
      'checkout/begin: 2xx': (r) => r.status >= 200 && r.status < 300,
      'checkout/begin: returns id': (r) => {
        try {
          const body = r.json()
          checkoutId = body && (body.id || body.checkoutId)
          return typeof checkoutId === 'string' && checkoutId.length > 0
        } catch (_e) {
          return false
        }
      },
    })
    if (!ok) {
      errorRate.add(1)
      fail('checkout/begin failed, aborting funnel')
    }
  })

  group('5. render checkout step 1', () => {
    const res = http.get(`${BASE_URL}/checkout/${checkoutId}`, {
      headers: htmlHeaders(),
      tags: { step: 'checkout_render' },
    })
    renderLatency.add(res.timings.duration)
    if (
      !check(res, {
        'checkout/<id>: 200': (r) => r.status === 200,
      })
    ) {
      errorRate.add(1)
    } else {
      completedFunnels.add(1)
    }
  })

  sleep(2)
}
