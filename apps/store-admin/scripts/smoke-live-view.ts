/**
 * Smoke test for the Live View rewrite.
 * Directly invokes getLiveView with a mocked req/res and asserts the
 * rendered HTML contains all the screenshot elements:
 *   - Header (Live View + as-of timestamp)
 *   - 4 KPI cards (Visitors right now, Total sessions, Total sales, Total orders)
 *   - World map (SVG + legend + range label + zoom buttons)
 *   - Pageviews chart
 *   - Customer behavior bars (Browsing, Active carts, Checking out, Purchased)
 *   - Top pages panel (M2)
 *   - Traffic sources panel (M2)
 *   - Store switcher dropdown
 *   - Auto-refresh + SSE scaffolding
 *
 * Runs two phases:
 *   - single-store: default scope (28 checks)
 *   - all-stores:   scope=all with a god-admin user (33 checks)
 *
 * Usage: tsx scripts/smoke-live-view.ts [storeSlug]
 */

import { createDb, destroyDb } from '@gbox/db'
import { getLiveView } from '../src/pages/live-view.ts'

interface MockResponse {
  statusCode: number
  body: string
  headers: Record<string, string>
}

function makeMockRes(): MockResponse & {
  status: (code: number) => any
  send: (body: string) => any
  redirect: (loc: string) => any
  setHeader: (k: string, v: string) => any
} {
  const res: any = {
    statusCode: 200,
    body: '',
    headers: {},
    status(code: number) {
      this.statusCode = code
      return this
    },
    send(body: string) {
      this.body = body
      return this
    },
    redirect(loc: string) {
      this.statusCode = 302
      this.headers['Location'] = loc
      return this
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v
      return this
    },
  }
  return res
}

function commonChecks(body: string, statusCode: number): Array<[string, boolean]> {
  return [
    ['status 200', statusCode === 200],
    ['Live View header', /Live View/.test(body)],
    ['Live pulse dot', /class="lv-live-dot"/.test(body)],
    ['As-of timestamp', /id="lvAsOf"/.test(body) && /\b(AM|PM)\b/.test(body)],
    ['KPI grid present', /class="lv-kpi-grid"/.test(body)],
    ['Visitors right now card', /Visitors right now/.test(body)],
    ['Total sessions card', /Total sessions/.test(body)],
    ['Total sales card', /Total sales/.test(body)],
    ['Total orders card', /Total orders/.test(body)],
    ['World map SVG', /class="lv-map-svg"/.test(body)],
    ['Map continents group', /id="lvMapViewport"/.test(body)],
    // Real country paths from world-atlas 110m. The lv-countries group
    // must be present AND contain at least ~150 <path> elements so we
    // catch a regression where the import silently drops.
    ['Real country paths group', /class="lv-countries"/.test(body)],
    [
      'Real country paths count (>150)',
      (body.match(/<path data-c="/g) || []).length > 150,
    ],
    ['Known country Russia present', /data-n="Russia"/.test(body)],
    ['Known country Vietnam present', /data-n="Vietnam"/.test(body)],
    [
      'Known country United States present',
      /data-n="United States of America"/.test(body),
    ],
    // No stale hand-drawn blobs (catches a revert).
    [
      'No hand-drawn Central America comment',
      !/<!-- Central America -->/.test(body),
    ],
    ['Map range label "Last 10 mins"', /Last 10 mins/.test(body)],
    ['Map zoom + button', /aria-label="Zoom in"/.test(body)],
    ['Map zoom − button', /aria-label="Zoom out"/.test(body)],
    ['Map legend (Order)', /class="lv-legend-order"/.test(body)],
    ['Map legend (Visitor)', /class="lv-legend-visitor"/.test(body)],
    ['Pageviews chart section', /Pageviews/.test(body)],
    ['Pageviews chart SVG', /class="lv-chart-svg"/.test(body)],
    ['Customer behavior section', /Customer behavior/.test(body)],
    ['Browsing bar (M2)', /Browsing/.test(body)],
    ['Active carts bar', /Active carts/.test(body)],
    ['Checking out bar', /Checking out/.test(body)],
    ['Purchased bar', /Purchased/.test(body)],
    // M2: Top pages panel
    ['Top pages section (M2)', /Top pages/.test(body)],
    ['Top pages container (M2)', /id="lvTopPages"/.test(body)],
    // M2: Traffic sources panel
    ['Traffic sources section (M2)', /Traffic sources/.test(body)],
    ['Traffic sources container (M2)', /id="lvTrafficSources"/.test(body)],
    // M2: Updated KPI tooltip
    ['Visitors tooltip references page views (M2)', /Unique visitors.*page views/.test(body)],
    // M2: No stale checkout_sessions tooltip for pageviews chart
    ['Pageviews tooltip references storefront (M2)', /Page views per minute from storefront/.test(body)],
    ['Store switcher dropdown', /id="lvStoreMenu"/.test(body)],
    ['toggleMenu JS present', /function toggleMenu/.test(body)],
    ['lvZoom JS present', /window\.lvZoom/.test(body)],
    ['SSE EventSource scaffold', /new EventSource/.test(body)],
    ['Auto-refresh label', /Auto-refreshing|Auto-refresh/.test(body)],
  ]
}

async function main() {
  const storeSlug = process.argv[2] || 'gbox-test'

  console.log(`[smoke] Testing Live View for store: ${storeSlug}`)
  const db = createDb()

  // Look up store ID to bypass the middleware lookup
  const row = await db
    .selectFrom('shops' as any)
    .select(['id', 'name', 'slug', 'domain', 'plan', 'status', 'currency'] as any)
    .where('slug' as any, '=', storeSlug)
    .executeTakeFirst()

  if (!row) {
    console.error(`[FAIL] Store not found: ${storeSlug}`)
    await destroyDb()
    process.exit(1)
  }
  const store = row as any
  console.log(`[ok]   Found store: ${store.name} (${store.id})`)

  let failures = 0

  // ── PHASE 1: single-store mode ───────────────────────────────────
  console.log('\n[phase 1] single-store mode')
  const regularUser = {
    id: '00000000-0000-0000-0000-000000000000',
    name: 'Smoke Test',
    email: 'smoke@test.local',
    role: 'owner',
    storeRole: 'owner',
  }

  const req: any = {
    params: { slug: storeSlug },
    query: {},
    originalUrl: `/admin/store/${storeSlug}/analytics/live`,
    store: store,
    storeUser: regularUser,
    theme: 'dark',
  }
  const res = makeMockRes()

  try {
    await getLiveView(req, res as any, db as any)
    const body = res.body || ''
    const checks = commonChecks(body, res.statusCode)
    const allPass = checks.every(([, p]) => p)
    if (allPass) {
      console.log(`[ok]   single-store rendered ${body.length} bytes (${checks.length} checks)`)
    } else {
      failures++
      console.error(`[FAIL] single-store status=${res.statusCode} size=${body.length}`)
      for (const [name, pass] of checks) {
        console.error(`       ${pass ? '  ok ' : 'FAIL'}  ${name}`)
      }
    }
  } catch (err: any) {
    failures++
    console.error(`[FAIL] single-store threw: ${err.message}`)
    console.error(err.stack)
  }

  // ── PHASE 2: all-stores mode ────────────────────────────────────
  console.log('\n[phase 2] all-stores mode (scope=all)')
  const godAdmin = await db
    .selectFrom('users' as any)
    .select(['id', 'name', 'email', 'role'])
    .where('is_default_admin' as any, '=', true)
    .executeTakeFirst()

  if (!godAdmin) {
    console.log('[skip] No god-admin user in DB — skipping all-stores phase')
  } else {
    console.log(`[ok]   Using god-admin: ${(godAdmin as any).email}`)
    const godUser = {
      id: (godAdmin as any).id,
      name: (godAdmin as any).name || 'God Admin',
      email: (godAdmin as any).email,
      role: (godAdmin as any).role || 'god_admin',
      storeRole: 'owner',
    }

    const req2: any = {
      params: { slug: storeSlug },
      query: { scope: 'all' },
      originalUrl: `/admin/store/${storeSlug}/analytics/live?scope=all`,
      store: store,
      storeUser: godUser,
      theme: 'dark',
    }
    const res2 = makeMockRes()

    try {
      await getLiveView(req2, res2 as any, db as any)
      const body = res2.body || ''
      const baseChecks = commonChecks(body, res2.statusCode)
      const scopeChecks: Array<[string, boolean]> = [
        ['lv-store-pill-all class applied', /lv-store-pill-all/.test(body)],
        ['"All stores" label in pill', /All stores <strong>\(\d+\)<\/strong>/.test(body)],
        ['Scope dropdown section', /Scope<\/div>/.test(body)],
        ['scope=all link in dropdown', /href="[^"]*analytics\/live\?scope=all"/.test(body)],
        ['SSE URL preserves scope=all', /\/analytics\/live\/stream\?scope=all/.test(body)],
      ]
      const allChecks = [...baseChecks, ...scopeChecks]
      const allPass = allChecks.every(([, p]) => p)
      if (allPass) {
        console.log(`[ok]   scope=all rendered ${body.length} bytes (${allChecks.length} checks)`)
      } else {
        failures++
        console.error(`[FAIL] scope=all status=${res2.statusCode} size=${body.length}`)
        for (const [name, pass] of allChecks) {
          console.error(`       ${pass ? '  ok ' : 'FAIL'}  ${name}`)
        }
      }
    } catch (err: any) {
      failures++
      console.error(`[FAIL] scope=all threw: ${err.message}`)
      console.error(err.stack)
    }
  }

  await destroyDb()

  if (failures > 0) {
    console.error(`\n[FAIL] ${failures} check group(s) failed`)
    process.exit(1)
  }
  console.log(`\n[ok]   All checks passed`)
}

main().catch((err) => {
  console.error('[FAIL] Smoke test crashed:', err)
  process.exit(1)
})
