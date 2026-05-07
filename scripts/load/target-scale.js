/**
 * Gbox Platform — Multi-Tier Scaling Harness (Phase 3F)
 *
 * Successor to `target-100k.js`. Same dual-scenario shape (browse +
 * checkout with realistic 50:1 ratio) but the VU counts scale with
 * a `TIER` env var so the same script exercises:
 *
 *   TIER=100k → 100,000 orders/month  (Phase 3 initial ceiling)
 *   TIER=1m   → 1,000,000 orders/month (10x — requires Phase 3G/H/I)
 *   TIER=10m  → 10,000,000 orders/month (100x — requires Phase 3J)
 *
 * The math behind each tier is a mirror of
 * `packages/core/src/modules/scaling/tiers.ts` so this script can
 * run on a vanilla k6 install (goja, no imports) without losing
 * consistency with the TypeScript capacity-planning module.
 *
 * --- ARE YOU SURE YOU WANT TO RUN THIS? -------------------------
 *
 * `TIER=100k`   is safe from a dev laptop.
 * `TIER=1m`     is safe from a bare-metal server on the same LAN.
 * `TIER=10m`    REQUIRES a distributed k6 runner (k6 Operator or
 *               a multi-node cluster). A single k6 process on one
 *               box will run out of file descriptors / ports long
 *               before it can generate ~100,000 concurrent browse
 *               VUs for the flash profile. Use this tier as a
 *               _specification_ of what the stack is sized for,
 *               not as a push-button smoke test.
 *
 * --- USAGE ------------------------------------------------------
 *
 *   # Smoke from a laptop — fastest way to prove the script works
 *   k6 run -e TIER=100k -e PROFILE=smoke scripts/load/target-scale.js
 *
 *   # Baseline for 1M-orders/month design
 *   k6 run \
 *     -e TIER=1m \
 *     -e PROFILE=baseline \
 *     -e BASE_URL=http://192.168.1.13:4326 \
 *     -e SHOP_HOST=demo.gbox.co \
 *     -e PRODUCT_HANDLES=tee-black,tee-white,hoodie-grey \
 *     -e COLLECTION_HANDLES=all,sale,new-arrivals \
 *     -e VARIANT_IDS=v1,v2,v3 \
 *     scripts/load/target-scale.js
 *
 *   # Flash sale for 10M tier — DO NOT run this from a laptop
 *   k6 run -e TIER=10m -e PROFILE=flash scripts/load/target-scale.js
 *
 * --- PROFILES ---------------------------------------------------
 *
 *   smoke    — 1 browse + 1 checkout VU for 30s (tier-agnostic)
 *   baseline — average month load, 5 minute hold
 *   peak     — dinner-rush load (10x average), 5 minute hold
 *   flash    — TikTok viral load (100x average), 3 minute run
 *   sustain  — baseline held for 30 minutes for leak detection
 *
 * --- THRESHOLDS -------------------------------------------------
 *
 * Same SLOs as `target-100k.js` — scaling up orders/month does not
 * loosen the per-request latency budget. If the stack can only meet
 * p95 < 300ms on browse up to 1M/month, then the 10M tier will FAIL
 * the threshold and we find out _in testing_ rather than in prod.
 */

import http from 'k6/http'
import { check, group, sleep } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'

// ---------------------------------------------------------------------------
// Tier math — mirror of packages/core/src/modules/scaling/tiers.ts.
// Keeping it literal here so a vanilla `k6 run` has zero imports.
// ---------------------------------------------------------------------------

const CONVERSION_RATE = 0.02
const SESSION_DURATION_SEC = 5
const CHECKOUT_DURATION_SEC = 5
const SECONDS_PER_MONTH = 30 * 86_400
const PEAK_MULT = 10
const FLASH_MULT = 100

function deriveTier(ordersPerMonth) {
  const ordersPerSecAvg = ordersPerMonth / SECONDS_PER_MONTH
  const pageviewsPerSecAvg = ordersPerMonth / CONVERSION_RATE / SECONDS_PER_MONTH

  const browseBaseline = Math.max(
    1,
    Math.ceil(pageviewsPerSecAvg * SESSION_DURATION_SEC),
  )
  const browsePeak = Math.max(
    1,
    Math.ceil(pageviewsPerSecAvg * PEAK_MULT * SESSION_DURATION_SEC),
  )
  const browseFlash = Math.max(
    1,
    Math.ceil(pageviewsPerSecAvg * FLASH_MULT * SESSION_DURATION_SEC),
  )
  const checkoutBaseline = Math.max(
    1,
    Math.ceil(ordersPerSecAvg * CHECKOUT_DURATION_SEC),
  )
  const checkoutPeak = Math.max(
    1,
    Math.ceil(ordersPerSecAvg * PEAK_MULT * CHECKOUT_DURATION_SEC),
  )
  const checkoutFlash = Math.max(
    1,
    Math.ceil(ordersPerSecAvg * FLASH_MULT * CHECKOUT_DURATION_SEC),
  )
  return {
    ordersPerMonth,
    browseBaseline,
    browsePeak,
    browseFlash,
    checkoutBaseline,
    checkoutPeak,
    checkoutFlash,
  }
}

const TIER_NAME_ALIASES = {
  '100k': '100k',
  t100k: '100k',
  '1m': '1m',
  t1m: '1m',
  '10m': '10m',
  t10m: '10m',
}

const TIER_SIZES = {
  '100k': deriveTier(100_000),
  '1m': deriveTier(1_000_000),
  '10m': deriveTier(10_000_000),
}

const rawTierName = (__ENV.TIER || '100k').toLowerCase()
const tierKey = TIER_NAME_ALIASES[rawTierName]
if (!tierKey) {
  throw new Error(
    `Unknown TIER=${rawTierName}. Valid: 100k, 1m, 10m (aliases: t100k, t1m, t10m)`,
  )
}
const TIER = TIER_SIZES[tierKey]

// ---------------------------------------------------------------------------
// Env wiring — shared with every other script in this dir
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
// Profiles — shape is identical across tiers, VU counts come from TIER
// ---------------------------------------------------------------------------

const profileName = (__ENV.PROFILE || 'smoke').toLowerCase()

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
  baseline: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: TIER.browseBaseline },
        { duration: '4m', target: TIER.browseBaseline },
        { duration: '30s', target: 0 },
      ],
      exec: 'browseIteration',
    },
    checkout: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: TIER.checkoutBaseline },
        { duration: '4m', target: TIER.checkoutBaseline },
        { duration: '30s', target: 0 },
      ],
      exec: 'checkoutIteration',
      startTime: '0s',
    },
  },
  peak: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: TIER.browsePeak },
        { duration: '3m', target: TIER.browsePeak },
        { duration: '1m', target: 0 },
      ],
      exec: 'browseIteration',
    },
    checkout: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: TIER.checkoutPeak },
        { duration: '3m', target: TIER.checkoutPeak },
        { duration: '1m', target: 0 },
      ],
      exec: 'checkoutIteration',
      startTime: '0s',
    },
  },
  flash: {
    browse: {
      executor: 'ramping-vus',
      startVUs: Math.max(1, Math.floor(TIER.browseBaseline / 10)),
      stages: [
        { duration: '30s', target: TIER.browseFlash },
        { duration: '90s', target: TIER.browseFlash },
        { duration: '30s', target: Math.max(1, Math.floor(TIER.browseBaseline / 10)) },
      ],
      exec: 'browseIteration',
    },
    checkout: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: TIER.checkoutFlash },
        { duration: '90s', target: TIER.checkoutFlash },
        { duration: '30s', target: 1 },
      ],
      exec: 'checkoutIteration',
      startTime: '0s',
    },
  },
  sustain: {
    browse: {
      executor: 'constant-vus',
      vus: TIER.browseBaseline,
      duration: '30m',
      exec: 'browseIteration',
    },
    checkout: {
      executor: 'constant-vus',
      vus: TIER.checkoutBaseline,
      duration: '30m',
      exec: 'checkoutIteration',
      startTime: '0s',
    },
  },
}

const profileDef = PROFILES[profileName]
if (!profileDef) {
  throw new Error(
    `Unknown PROFILE=${profileName}. Valid: ${Object.keys(PROFILES).join(', ')}`,
  )
}

// ---------------------------------------------------------------------------
// Metrics (tier-aware via tags so one Prometheus series per tier)
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
// k6 options — SLOs are the same regardless of tier
// ---------------------------------------------------------------------------

export const options = {
  tags: {
    tier: tierKey,
    profile: profileName,
  },
  scenarios: {
    browse_traffic: profileDef.browse,
    checkout_traffic: profileDef.checkout,
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],

    browse_home_duration: ['p(95)<200'],
    browse_collection_duration: ['p(95)<400'],
    browse_product_duration: ['p(95)<500'],
    browse_errors: ['rate<0.005'],

    checkout_cart_add_duration: ['p(95)<250'],
    checkout_begin_duration: ['p(95)<400'],
    checkout_render_duration: ['p(95)<500'],
    checkout_errors: ['rate<0.001'],

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
  'User-Agent': `k6-loadtest/target-scale/${tierKey}`,
  'Accept-Language': 'en-US,en;q=0.9',
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ---------------------------------------------------------------------------
// Browse iteration
// ---------------------------------------------------------------------------

export function browseIteration() {
  group('browse:home', () => {
    const res = http.get(`${BASE_URL}/`, {
      headers: HEADERS,
      tags: { path: 'home', tier: tierKey },
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
      tags: { path: 'collection', tier: tierKey },
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
      tags: { path: 'product', tier: tierKey },
    })
    browseProduct.add(res.timings.duration)
    const ok = check(res, { 'product: 200': (r) => r.status === 200 })
    if (!ok) browseErrors.add(1)
  })

  // Shopper think-time — keeps the iteration duration close to the
  // SESSION_DURATION_SEC the tier math was built on.
  sleep(2)
}

// ---------------------------------------------------------------------------
// Checkout iteration
// ---------------------------------------------------------------------------

export function checkoutIteration() {
  checkoutFunnelsStarted.add(1)

  const variantId = pickOne(VARIANT_IDS)

  let cartToken = null
  group('checkout:cart_add', () => {
    const res = http.post(
      `${BASE_URL}/cart/add`,
      JSON.stringify({ items: [{ id: variantId, quantity: 1 }] }),
      {
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        tags: { path: 'cart_add', tier: tierKey },
      },
    )
    checkoutCartAdd.add(res.timings.duration)
    const ok = check(res, {
      'cart_add: 2xx': (r) => r.status >= 200 && r.status < 300,
    })
    if (!ok) checkoutErrors.add(1)
    try {
      const body = res.json()
      cartToken = body && body.token ? body.token : null
    } catch (_err) {
      // Non-JSON body — check() above catches the real failure.
    }
  })

  sleep(1)

  group('checkout:begin', () => {
    const res = http.post(
      `${BASE_URL}/checkout/begin`,
      JSON.stringify({ cart_token: cartToken }),
      {
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        tags: { path: 'checkout_begin', tier: tierKey },
      },
    )
    checkoutBegin.add(res.timings.duration)
    const ok = check(res, {
      'begin: 2xx': (r) => r.status >= 200 && r.status < 300,
    })
    if (!ok) checkoutErrors.add(1)
  })

  sleep(1)

  group('checkout:render', () => {
    const res = http.get(`${BASE_URL}/checkout`, {
      headers: HEADERS,
      tags: { path: 'checkout_render', tier: tierKey },
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
// Banner — printed at startup so the operator sees the VU counts
// for the chosen tier BEFORE the run actually melts their laptop.
// ---------------------------------------------------------------------------

export function setup() {
  console.log(`=================================================`)
  console.log(`Gbox scaling harness`)
  console.log(`=================================================`)
  console.log(`tier            : ${tierKey} (${TIER.ordersPerMonth.toLocaleString()} orders/month)`)
  console.log(`profile         : ${profileName}`)
  console.log(`base url        : ${BASE_URL}`)
  console.log(`shop host       : ${SHOP_HOST}`)
  console.log(`VU targets      :`)
  console.log(`  browse   base=${TIER.browseBaseline}  peak=${TIER.browsePeak}  flash=${TIER.browseFlash}`)
  console.log(`  checkout base=${TIER.checkoutBaseline}  peak=${TIER.checkoutPeak}  flash=${TIER.checkoutFlash}`)
  if (tierKey === '10m' && profileName === 'flash') {
    console.log(``)
    console.log(`*** WARNING: 10m/flash requires a distributed k6 runner. ***`)
    console.log(`*** A single process cannot physically emit the target   ***`)
    console.log(`*** VU count. See scripts/load/README.md for details.    ***`)
  }
  console.log(`=================================================`)
  return {}
}

// ---------------------------------------------------------------------------
// Default export — every scenario sets `exec`, so default should never
// fire. Make it loud so a misconfigured PROFILE doesn't pass silently.
// ---------------------------------------------------------------------------

export default function () {
  throw new Error(
    'target-scale.js default function called — every scenario MUST set ' +
      '`exec`. This is a PROFILE wiring bug.',
  )
}
