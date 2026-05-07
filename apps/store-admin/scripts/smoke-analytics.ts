/**
 * Smoke test for Overview dashboard rewrite.
 * Directly invokes getAnalyticsDashboard with a mocked req/res and asserts
 * the rendered HTML contains the 9 cards + AI Analytics section.
 *
 * Runs two phases:
 *   - single-store: default scope, 5 periods (19 checks each)
 *   - all-stores:   scope=all with a god-admin user, 1 period (5 extra checks)
 *
 * Usage: tsx scripts/smoke-analytics.ts [storeSlug]
 */

import { createDb, destroyDb } from '@gbox/db'
import { getAnalyticsDashboard } from '../src/pages/analytics.ts'

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
    ['Overview dashboard header', /Overview dashboard/.test(body)],
    ['Total sales card', /Total sales/.test(body)],
    ['Online store conversion rate', /Online store conversion rate/.test(body)],
    ['Total orders card', /Total orders/.test(body)],
    ['Average order value', /Average order value/.test(body)],
    ['Average order items', /Average order items/.test(body)],
    ['Abandoned checkouts recovery', /Abandoned checkouts recovery/.test(body)],
    ['First-time vs returning', /First-time vs returning/.test(body)],
    ['Returning customer rate', /Returning customer rate/.test(body)],
    ['Top countries', /Top countries/.test(body)],
    ['AI Analytics section preserved', /AI Analytics/.test(body)],
    ['ov-grid present', /class="ov-grid"/.test(body)],
    ['ov-toolbar present', /class="ov-toolbar"/.test(body)],
    ['Date picker arrows', /ov-date-arrow/.test(body)],
    ['Auto refresh toggle', /ovRefreshToggle/.test(body)],
    ['Sparkline SVG', /<svg[^>]*class="ov-spark-svg"/.test(body)],
    ['No broken link', !/marketing\/email-reminders/.test(body)],
    ['Abandoned link correct', /marketing\/abandoned/.test(body)],
    ['Store switcher dropdown', /id="ovStoreMenu"/.test(body)],
    ['Store switcher is menu-wrap', /class="menu-wrap ov-store-switcher"/.test(body)],
    ['toggleMenu JS present', /function toggleMenu/.test(body)],
    ['menu-dropdown CSS present', /\.menu-dropdown\.open/.test(body)],
  ]
}

async function main() {
  const storeSlug = process.argv[2] || 'gbox-test'
  const periods = ['today', 'yesterday', '7d', '30d', '90d']

  console.log(`[smoke] Testing Overview dashboard for store: ${storeSlug}`)
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

  // ── PHASE 1: single-store mode ───────────────────────────────────
  // Use a non-admin fake user so listAccessibleStores returns []
  // (no user_shops join matches) — this is the standard merchant view.
  const regularUser = {
    id: '00000000-0000-0000-0000-000000000000',
    name: 'Smoke Test',
    email: 'smoke@test.local',
    role: 'owner',
    storeRole: 'owner',
  }

  console.log('\n[phase 1] single-store mode')
  let failures = 0
  for (const period of periods) {
    const req: any = {
      params: { slug: storeSlug },
      query: { period },
      originalUrl: `/admin/store/${storeSlug}/analytics?period=${period}`,
      store: store,
      storeUser: regularUser,
      theme: 'dark',
    }
    const res = makeMockRes()

    try {
      await getAnalyticsDashboard(req, res as any, db as any)
      const body = res.body || ''
      const checks = commonChecks(body, res.statusCode)
      const allPass = checks.every(([, p]) => p)
      if (allPass) {
        console.log(
          `[ok]   period=${period.padEnd(9)} rendered ${body.length} bytes (${checks.length} checks)`,
        )
      } else {
        failures++
        console.error(`[FAIL] period=${period} status=${res.statusCode} size=${body.length}`)
        for (const [name, pass] of checks) {
          console.error(`       ${pass ? '  ok ' : 'FAIL'}  ${name}`)
        }
      }
    } catch (err: any) {
      failures++
      console.error(`[FAIL] period=${period} threw: ${err.message}`)
      console.error(err.stack)
    }
  }

  // ── PHASE 2: all-stores mode ────────────────────────────────────
  // Find a real god-admin user — listAccessibleStores recognises
  // is_default_admin=true and returns every store, which activates
  // scope=all in the dashboard.
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

    const req: any = {
      params: { slug: storeSlug },
      query: { period: '7d', scope: 'all' },
      originalUrl: `/admin/store/${storeSlug}/analytics?period=7d&scope=all`,
      store: store,
      storeUser: godUser,
      theme: 'dark',
    }
    const res = makeMockRes()

    try {
      await getAnalyticsDashboard(req, res as any, db as any)
      const body = res.body || ''
      const baseChecks = commonChecks(body, res.statusCode)
      const scopeChecks: Array<[string, boolean]> = [
        ['ov-store-pill-all class applied', /ov-store-pill-all/.test(body)],
        ['"All stores" label in pill', /All stores <strong>\(\d+\)<\/strong>/.test(body)],
        ['Scope dropdown section', /Scope<\/div>/.test(body)],
        ['scope=all link in dropdown', /href="[^"]*analytics\?period=[^"]*&scope=all"/.test(body)],
        ['period picker preserves scope=all', /<a href="[^"]*analytics\?period=[a-z0-9]+&scope=all"[^>]*class="ov-date-arrow"/.test(body)],
      ]
      const allChecks = [...baseChecks, ...scopeChecks]
      const allPass = allChecks.every(([, p]) => p)
      if (allPass) {
        console.log(
          `[ok]   scope=all period=7d rendered ${body.length} bytes (${allChecks.length} checks)`,
        )
      } else {
        failures++
        console.error(`[FAIL] scope=all period=7d status=${res.statusCode} size=${body.length}`)
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
