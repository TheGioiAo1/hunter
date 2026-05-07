/**
 * Phase 8 PR3 — SEO infrastructure live-DB smoke.
 *
 * Unit coverage lives in:
 *   - packages/core/src/modules/seo/seo-settings.test.ts       (26 cases)
 *   - packages/core/src/modules/seo/crawl-policy.test.ts       (9 cases)
 *   - packages/core/src/modules/seo/head-injection.test.ts     (17 cases)
 *   - packages/core/src/modules/seo/scan.test.ts               (70 cases)
 *   - apps/store-admin/src/pages/seo-settings.test.ts          (15 cases)
 *
 * This script verifies the live Postgres path — migration 064 shape +
 * cross-shop tenancy + resolveSettings/setShopSettings round-trip +
 * recordScanReport persistence + computeCrawlPolicy + getShopCrawlPolicy
 * DB-bound resolver + buildHeadTags regex guards + scan service
 * end-to-end with a stub fetcher.
 *
 * Run from server 2 (local Windows box can't reach the 192.168.1.13 PG):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase8-pr3.ts
 *
 * Cleans up every seeded row in finally{} so the script is re-runnable.
 *
 * Coverage (assertions numbered below):
 *   [1]  Migration 064 shape — shops.seo_settings JSONB column exists
 *   [2]  resolveSettings returns defaults for freshly seeded shop (empty blob)
 *   [3]  setShopSettings persists every string field
 *   [4]  setShopSettings persists robots_noindex=true
 *   [5]  setShopSettings round-trips via resolveSettings
 *   [6]  setShopSettings preserves last_scan_at / last_scan_report when caller
 *        passes null (scan fields owned by recordScanReport)
 *   [7]  applyTitleTemplate expands {page_title} and {shop_name}
 *   [8]  applyTitleTemplate leaves unknown tokens intact
 *   [9]  recordScanReport stamps last_scan_at + last_scan_report without
 *        disturbing other settings
 *   [10] recordScanReport overwrites previous scan (latest wins)
 *   [11] Cross-shop settings isolation — shop A's values don't affect shop B
 *   [12] computeCrawlPolicy — active + no noindex → crawlable
 *   [13] computeCrawlPolicy — suspended shop → not crawlable
 *   [14] computeCrawlPolicy — closed shop → not crawlable
 *   [15] computeCrawlPolicy — active + merchant noindex → not crawlable, flag set
 *   [16] getShopCrawlPolicy — unknown shop id → closed variant (defensive)
 *   [17] getShopCrawlPolicy — active shop with empty settings → crawlable
 *   [18] getShopCrawlPolicy — respects persisted robots_noindex
 *   [19] getShopCrawlPolicy — suspended overrides any seo_settings
 *   [20] buildHeadTags — empty settings → empty string
 *   [21] buildHeadTags — robots_noindex=true → meta robots on first line
 *   [22] buildHeadTags — valid GA4 ID → two <script> tags present
 *   [23] buildHeadTags — malformed GA4 ID → dropped (XSS defence)
 *   [24] buildHeadTags — valid GTM ID → bootstrap script present
 *   [25] buildHeadTags — malformed GTM ID → dropped
 *   [26] buildHeadTags — valid site verification → rendered and escaped
 *   [27] buildHeadTags — site verification containing HTML chars dropped
 *   [28] buildBodyOpenTags — valid GTM → noscript iframe
 *   [29] buildBodyOpenTags — no GTM → empty string
 *   [30] buildSeoHeadInjection — bundles head + bodyOpen
 *   [31] analyseScan — clean page set → 100 score, 0 issues
 *   [32] analyseScan — missing title page → error issue
 *   [33] analyseScan — duplicate titles across 2 pages → flags both
 *   [34] analyseScan — score heuristic floors at 0 for many errors
 *   [35] scanShop with stub fetcher — serial, respects maxUrls cap
 *   [36] scanShop end-to-end → recordScanReport round-trip
 *   [37] Iron rule 5 surface audit — neither SeoSettings JSON nor scan
 *        report issue messages mention 'god admin' / 'god_admin'
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  DEFAULT_SEO_SETTINGS,
  applyTitleTemplate,
  recordScanReport,
  resolveSettings,
  setShopSettings,
  type SeoSettings,
  type SeoScanReport,
} from '../packages/core/src/modules/seo/seo-settings.js'
import {
  computeCrawlPolicy,
  getShopCrawlPolicy,
} from '../packages/core/src/modules/seo/crawl-policy.js'
import {
  buildBodyOpenTags,
  buildHeadTags,
  buildSeoHeadInjection,
} from '../packages/core/src/modules/seo/head-injection.js'
import {
  analyseScan,
  scanShop,
  type ScanPageInput,
  type SeoFetcher,
} from '../packages/core/src/modules/seo/scan.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const SHOP_B = randomUUID()
const SHOP_SUSPENDED = randomUUID()
const SHOP_CLOSED = randomUUID()

function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}

let failed = 0
let total = 0
function assert(cond: boolean, msg: string) {
  total++
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

function goodHtml(url: string, title: string): string {
  return `<html><head>
<title>${title}</title>
<meta name="description" content="This description is long enough to satisfy the scanner rules and cross 50 chars.">
<link rel="canonical" href="${url}">
</head><body>
<h1>Heading</h1>
<img src="x.png" alt="good alt">
</body></html>`
}

async function main() {
  log(`\n=== Phase 8 PR3 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed shops
  // -------------------------------------------------------------------------
  log('[0] Seeding shops (active x2, suspended x1, closed x1)')
  await (db as any)
    .insertInto('shops')
    .values([
      {
        id: SHOP_A,
        slug: `smoke-p8-3a-${SUFFIX}`,
        name: 'PR3 Shop A',
        email: `p8-3a-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
      {
        id: SHOP_B,
        slug: `smoke-p8-3b-${SUFFIX}`,
        name: 'PR3 Shop B',
        email: `p8-3b-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
      {
        id: SHOP_SUSPENDED,
        slug: `smoke-p8-3s-${SUFFIX}`,
        name: 'PR3 Suspended',
        email: `p8-3s-${SUFFIX}@example.test`,
        status: 'suspended',
        plan: 'free',
      },
      {
        id: SHOP_CLOSED,
        slug: `smoke-p8-3c-${SUFFIX}`,
        name: 'PR3 Closed',
        email: `p8-3c-${SUFFIX}@example.test`,
        status: 'closed',
        plan: 'free',
      },
    ])
    .execute()

  // -------------------------------------------------------------------------
  // [1] Migration 064 shape
  // -------------------------------------------------------------------------
  log('\n[1] Migration 064 shape')
  const col = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .where('table_name', '=', 'shops')
    .where('column_name', '=', 'seo_settings')
    .select(['data_type', 'is_nullable', 'column_default'])
    .executeTakeFirst()
  assert(
    col?.data_type === 'jsonb',
    `[1] shops.seo_settings is JSONB (got ${col?.data_type})`,
  )

  // -------------------------------------------------------------------------
  // [2] resolveSettings defaults
  // -------------------------------------------------------------------------
  log('\n[2] resolveSettings defaults for a fresh shop')
  {
    const resolved = await resolveSettings(db as any, SHOP_A)
    assert(
      resolved.default_title_template === null &&
        resolved.robots_noindex === false &&
        resolved.last_scan_report === null,
      '[2] fresh shop resolves to defaults',
    )
  }

  // -------------------------------------------------------------------------
  // [3..5] setShopSettings round-trip
  // -------------------------------------------------------------------------
  log('\n[3..5] setShopSettings round-trip')
  {
    const next: SeoSettings = {
      ...DEFAULT_SEO_SETTINGS,
      default_title_template: '{page_title} – {shop_name}',
      default_description: 'A store that sells quality products.',
      default_og_image_url: 'https://cdn.example.com/og.jpg',
      twitter_handle: '@shopA',
      facebook_url: 'https://facebook.com/shopA',
      google_analytics_id: 'G-ABCDEFGHIJ',
      google_tag_manager_id: 'GTM-AABBCC',
      google_site_verification: 'verify-token-123_xyz',
      robots_noindex: true,
      last_scan_at: null,
      last_scan_report: null,
    }
    await setShopSettings(db as any, SHOP_A, next)
    const resolved = await resolveSettings(db as any, SHOP_A)

    assert(
      resolved.default_title_template === next.default_title_template &&
        resolved.twitter_handle === '@shopA' &&
        resolved.google_analytics_id === 'G-ABCDEFGHIJ',
      '[3] every string field persisted',
    )
    assert(resolved.robots_noindex === true, '[4] robots_noindex=true persisted')
    assert(
      resolved.google_tag_manager_id === 'GTM-AABBCC' &&
        resolved.google_site_verification === 'verify-token-123_xyz' &&
        resolved.facebook_url === 'https://facebook.com/shopA',
      '[5] resolveSettings round-trips complete blob',
    )
  }

  // -------------------------------------------------------------------------
  // [6] setShopSettings preserves scan fields when caller omits them
  // -------------------------------------------------------------------------
  log('\n[6] setShopSettings preserves last_scan_at / last_scan_report')
  {
    // Write a scan report first.
    const seededReport: SeoScanReport = {
      pages_scanned: 3,
      score: 88,
      issues: [
        {
          url: 'https://shop.test/a',
          severity: 'warning',
          code: 'missing_canonical',
          message: 'Page has no canonical link tag.',
        },
      ],
    }
    await recordScanReport(db as any, SHOP_A, seededReport)

    // Now save settings WITHOUT touching the scan fields.
    const saved = await resolveSettings(db as any, SHOP_A)
    await setShopSettings(db as any, SHOP_A, {
      ...saved,
      last_scan_at: null,
      last_scan_report: null, // explicit nulls → service preserves current
      twitter_handle: '@shopA_v2',
    })
    const resolved = await resolveSettings(db as any, SHOP_A)
    assert(
      resolved.twitter_handle === '@shopA_v2' &&
        resolved.last_scan_report !== null &&
        resolved.last_scan_report.score === 88 &&
        resolved.last_scan_at !== null,
      '[6] setShopSettings preserves scan fields when caller passes null',
    )
  }

  // -------------------------------------------------------------------------
  // [7..8] applyTitleTemplate
  // -------------------------------------------------------------------------
  log('\n[7..8] applyTitleTemplate token expansion')
  {
    const out = applyTitleTemplate('{page_title} – {shop_name}', {
      page_title: 'Wool Sock',
      shop_name: 'Cozy Co',
    })
    assert(out === 'Wool Sock – Cozy Co', '[7] {page_title} + {shop_name} expanded')

    const leaked = applyTitleTemplate('{unknown_token} | {shop_name}', {
      page_title: 'X',
      shop_name: 'Y',
    })
    assert(
      leaked === '{unknown_token} | Y',
      '[8] unknown tokens left intact so merchants spot typos',
    )
  }

  // -------------------------------------------------------------------------
  // [9..10] recordScanReport
  // -------------------------------------------------------------------------
  log('\n[9..10] recordScanReport')
  {
    // Record a second report — it should overwrite the earlier one.
    const fresh: SeoScanReport = {
      pages_scanned: 7,
      score: 55,
      issues: [
        {
          url: 'https://shop.test/x',
          severity: 'error',
          code: 'missing_title',
          message: 'Page has no <title> tag.',
        },
      ],
    }
    await recordScanReport(db as any, SHOP_A, fresh)
    const resolved = await resolveSettings(db as any, SHOP_A)
    assert(
      resolved.last_scan_report?.score === 55 &&
        resolved.last_scan_report?.pages_scanned === 7,
      '[9] recordScanReport stamps fresh report',
    )
    assert(
      resolved.twitter_handle === '@shopA_v2' &&
        resolved.google_analytics_id === 'G-ABCDEFGHIJ',
      '[10] recordScanReport left other settings untouched',
    )
  }

  // -------------------------------------------------------------------------
  // [11] Cross-shop isolation
  // -------------------------------------------------------------------------
  log('\n[11] Cross-shop settings isolation (shop B should still be default)')
  {
    const shopB = await resolveSettings(db as any, SHOP_B)
    assert(
      shopB.default_title_template === null &&
        shopB.robots_noindex === false &&
        shopB.twitter_handle === null &&
        shopB.last_scan_report === null,
      '[11] shop B sees defaults even though shop A is configured',
    )
  }

  // -------------------------------------------------------------------------
  // [12..15] computeCrawlPolicy (pure)
  // -------------------------------------------------------------------------
  log('\n[12..15] computeCrawlPolicy (pure)')
  {
    const pActive = computeCrawlPolicy({ status: 'active' }, DEFAULT_SEO_SETTINGS)
    assert(pActive.crawlable && !pActive.merchantNoindex, '[12] active → crawlable')

    const pSus = computeCrawlPolicy(
      { status: 'suspended' },
      DEFAULT_SEO_SETTINGS,
    )
    assert(!pSus.crawlable, '[13] suspended → not crawlable')

    const pClosed = computeCrawlPolicy({ status: 'closed' }, DEFAULT_SEO_SETTINGS)
    assert(!pClosed.crawlable, '[14] closed → not crawlable')

    const pNoIndex = computeCrawlPolicy(
      { status: 'active' },
      { ...DEFAULT_SEO_SETTINGS, robots_noindex: true },
    )
    assert(
      !pNoIndex.crawlable && pNoIndex.merchantNoindex,
      '[15] active + merchant noindex → not crawlable, flag set',
    )
  }

  // -------------------------------------------------------------------------
  // [16..19] getShopCrawlPolicy (DB-bound)
  // -------------------------------------------------------------------------
  log('\n[16..19] getShopCrawlPolicy (DB-bound)')
  {
    const unknown = await getShopCrawlPolicy(db as any, randomUUID())
    assert(
      !unknown.crawlable &&
        !unknown.merchantNoindex &&
        !unknown.passwordProtected,
      '[16] unknown shop id → closed variant',
    )

    const shopB = await getShopCrawlPolicy(db as any, SHOP_B)
    assert(shopB.crawlable, '[17] active shop with empty settings → crawlable')

    const shopA = await getShopCrawlPolicy(db as any, SHOP_A)
    // Shop A has robots_noindex=true persisted above ([3..5]).
    assert(
      !shopA.crawlable && shopA.merchantNoindex,
      '[18] persisted robots_noindex=true respected',
    )

    const suspended = await getShopCrawlPolicy(db as any, SHOP_SUSPENDED)
    assert(!suspended.crawlable, '[19] suspended shop → not crawlable')
  }

  // -------------------------------------------------------------------------
  // [20..27] buildHeadTags
  // -------------------------------------------------------------------------
  log('\n[20..27] buildHeadTags')
  {
    assert(buildHeadTags(DEFAULT_SEO_SETTINGS) === '', '[20] empty settings → empty string')

    const noidx = buildHeadTags({ ...DEFAULT_SEO_SETTINGS, robots_noindex: true })
    const noidxFirstLine = noidx.split('\n')[0]
    assert(
      noidxFirstLine === '<meta name="robots" content="noindex, nofollow">',
      '[21] robots noindex on first line',
    )

    const gaOk = buildHeadTags({
      ...DEFAULT_SEO_SETTINGS,
      google_analytics_id: 'G-ABCDEFGHIJ',
    })
    assert(
      gaOk.includes('gtag/js?id=G-ABCDEFGHIJ') &&
        gaOk.includes("gtag('config','G-ABCDEFGHIJ')"),
      '[22] valid GA4 ID emits both script tags',
    )

    const gaBad = buildHeadTags({
      ...DEFAULT_SEO_SETTINGS,
      google_analytics_id: "G-A');alert(1);('",
    })
    assert(gaBad === '', '[23] malformed GA4 ID dropped (XSS defence)')

    const gtmOk = buildHeadTags({
      ...DEFAULT_SEO_SETTINGS,
      google_tag_manager_id: 'GTM-AABBCC',
    })
    assert(
      gtmOk.includes("(window,document,'script','dataLayer','GTM-AABBCC')"),
      '[24] valid GTM ID emits bootstrap',
    )

    const gtmBad = buildHeadTags({
      ...DEFAULT_SEO_SETTINGS,
      google_tag_manager_id: 'XYZ-AABBCC',
    })
    assert(gtmBad === '', '[25] malformed GTM ID dropped')

    const verOk = buildHeadTags({
      ...DEFAULT_SEO_SETTINGS,
      google_site_verification: 'verify-token-123_xyz',
    })
    assert(
      verOk ===
        '<meta name="google-site-verification" content="verify-token-123_xyz">',
      '[26] valid site verification rendered',
    )

    const verBad = buildHeadTags({
      ...DEFAULT_SEO_SETTINGS,
      google_site_verification: '"><script>alert(1)</script>',
    })
    assert(verBad === '', '[27] site verification with HTML chars dropped')
  }

  // -------------------------------------------------------------------------
  // [28..30] buildBodyOpenTags + buildSeoHeadInjection
  // -------------------------------------------------------------------------
  log('\n[28..30] buildBodyOpenTags + buildSeoHeadInjection')
  {
    const openGtm = buildBodyOpenTags({
      ...DEFAULT_SEO_SETTINGS,
      google_tag_manager_id: 'GTM-AABBCC',
    })
    assert(
      openGtm.startsWith('<noscript>') &&
        openGtm.includes('ns.html?id=GTM-AABBCC'),
      '[28] GTM body-open iframe',
    )

    assert(
      buildBodyOpenTags(DEFAULT_SEO_SETTINGS) === '',
      '[29] no GTM → empty body-open',
    )

    const bundle = buildSeoHeadInjection({
      ...DEFAULT_SEO_SETTINGS,
      robots_noindex: true,
      google_tag_manager_id: 'GTM-AABBCC',
    })
    assert(
      bundle.head.includes('robots') &&
        bundle.bodyOpen.includes('GTM-AABBCC'),
      '[30] buildSeoHeadInjection bundles head + bodyOpen',
    )
  }

  // -------------------------------------------------------------------------
  // [31..34] analyseScan
  // -------------------------------------------------------------------------
  log('\n[31..34] analyseScan')
  {
    const clean: ScanPageInput[] = [
      {
        url: 'https://shop.test/a',
        status: 200,
        body: goodHtml('https://shop.test/a', 'Page Alpha Title'),
      },
    ]
    const cleanR = analyseScan(clean)
    assert(
      cleanR.score === 100 && cleanR.issues.length === 0,
      '[31] clean scan → 100 score, 0 issues',
    )

    const missingTitle: ScanPageInput[] = [
      {
        url: 'https://shop.test/x',
        status: 200,
        body: '<html><body><p>No head</p></body></html>',
      },
    ]
    const miss = analyseScan(missingTitle)
    assert(
      miss.issues.some((i) => i.code === 'missing_title' && i.severity === 'error'),
      '[32] missing title emits error issue',
    )

    const dupes: ScanPageInput[] = [
      {
        url: 'https://shop.test/one',
        status: 200,
        body: goodHtml('https://shop.test/one', 'Same Title Here'),
      },
      {
        url: 'https://shop.test/two',
        status: 200,
        body: goodHtml('https://shop.test/two', 'Same Title Here'),
      },
    ]
    const dupR = analyseScan(dupes)
    const dupIssues = dupR.issues.filter((i) => i.code === 'duplicate_title')
    assert(dupIssues.length === 2, '[33] duplicate titles flag every offender')

    const manyErrors: ScanPageInput[] = []
    for (let i = 0; i < 20; i++) {
      manyErrors.push({
        url: `https://shop.test/${i}`,
        status: 500,
        body: 'err',
      })
    }
    assert(analyseScan(manyErrors).score === 0, '[34] score floors at 0')
  }

  // -------------------------------------------------------------------------
  // [35..36] scanShop + recordScanReport end-to-end
  // -------------------------------------------------------------------------
  log('\n[35..36] scanShop + recordScanReport end-to-end')
  {
    let calls = 0
    const seen: string[] = []
    const stubFetcher: SeoFetcher = async (url) => {
      calls++
      seen.push(url)
      return { status: 200, body: goodHtml(url, `Unique Title ${calls}`) }
    }
    const urls: string[] = []
    for (let i = 0; i < 10; i++) urls.push(`https://shop.test/${i}`)
    const report = await scanShop({ urls, fetcher: stubFetcher, maxUrls: 3 })
    assert(
      calls === 3 && seen[0] === 'https://shop.test/0' && report.pages_scanned === 3,
      '[35] scanShop serial + maxUrls cap respected',
    )

    await recordScanReport(db as any, SHOP_B, report)
    const resolved = await resolveSettings(db as any, SHOP_B)
    assert(
      resolved.last_scan_report?.score === report.score &&
        resolved.last_scan_report?.pages_scanned === 3 &&
        resolved.last_scan_at !== null,
      '[36] recordScanReport round-trips through Postgres',
    )
  }

  // -------------------------------------------------------------------------
  // [37] Iron rule 5 surface audit
  // -------------------------------------------------------------------------
  log('\n[37] Iron rule 5 audit across persisted surfaces')
  {
    const forbidden = /god[\s_-]?admin|god_admin_/i
    const shopA = await resolveSettings(db as any, SHOP_A)
    const shopB = await resolveSettings(db as any, SHOP_B)

    const blobA = JSON.stringify(shopA)
    const blobB = JSON.stringify(shopB)
    const issuesA = (shopA.last_scan_report?.issues ?? [])
      .map((i) => `${i.message} ${i.url} ${i.code}`)
      .join('|')
    const issuesB = (shopB.last_scan_report?.issues ?? [])
      .map((i) => `${i.message} ${i.url} ${i.code}`)
      .join('|')
    assert(
      !forbidden.test(blobA) &&
        !forbidden.test(blobB) &&
        !forbidden.test(issuesA) &&
        !forbidden.test(issuesB),
      '[37] no god-admin strings in any persisted SEO surface',
    )
  }

  log(`\n=== Phase 8 PR3 smoke — ${total - failed}/${total} passed ===`)
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('SMOKE CRASHED', err)
    failed = Math.max(failed, 1)
  })
  .finally(async () => {
    log('\n[cleanup] deleting seeded rows')
    try {
      // Settings live on shops.seo_settings so deleting the shops wipes them.
      await (db as any)
        .deleteFrom('shops')
        .where('id', 'in', [SHOP_A, SHOP_B, SHOP_SUSPENDED, SHOP_CLOSED])
        .execute()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('cleanup failed', err)
    }
    await (db as any).destroy()
    process.exit(failed === 0 ? 0 : 1)
  })
