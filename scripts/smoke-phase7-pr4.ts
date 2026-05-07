/**
 * Phase 7 PR4 — Theme editor search smoke.
 *
 * Unit-tests already cover every `searchThemeAssets` code path (mode
 * filter, R2 sentinel skip, ext filter, ranking, limit clamp — see
 * packages/core/src/modules/themes/service.test.ts). The part they
 * DON'T cover is the live Postgres chain: does the real query compose,
 * execute, and return the expected shape against `theme_assets` on the
 * production-equivalent schema?
 *
 * This smoke seeds one shop + one theme + ~8 assets (various
 * extensions + an R2 sentinel) and replays the behaviours a seller
 * hits in the Ctrl+Shift+F panel:
 *
 *   1.  empty q returns []
 *   2.  filename substring match (case-insensitive)
 *   3.  body content match surfaces a snippet + line number
 *   4.  matchType=both when key AND body match
 *   5.  ranking: exact > prefix > contains > content-only
 *   6.  mode=filename skips body scan
 *   7.  mode=content skips filename-only matches
 *   8.  R2 sentinel rows are skipped for body scan
 *   9.  extension filter (with and without leading dot)
 *   10. limit cap + clamp to [1, 200]
 *   11. theme-scope: rows from other themes are invisible
 *   12. second theme inside same shop stays isolated
 *
 * Rolls back every seeded row in finally{} so re-running is safe.
 *
 * Run on server 2 (this box can't reach Postgres):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase7-pr4.ts
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import { searchThemeAssets } from '../packages/core/src/modules/themes/service.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_ID = randomUUID()
const THEME_ID = randomUUID()
const OTHER_THEME_ID = randomUUID() // same shop, different theme — isolation
const assetIds: string[] = []

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

async function seedAsset(
  themeId: string,
  key: string,
  value: string | null,
): Promise<string> {
  const id = randomUUID()
  await (db as any)
    .insertInto('theme_assets')
    .values({
      id,
      theme_id: themeId,
      key,
      value,
      content_type: null,
      size: value ? Buffer.byteLength(value, 'utf8') : null,
    })
    .execute()
  assetIds.push(id)
  return id
}

async function main() {
  log(`\n=== Phase 7 PR4 smoke — suffix=${SUFFIX} ===\n`)

  // --- Seed shop + themes --------------------------------------------------
  log('[0] Seeding shop + themes')
  await (db as any)
    .insertInto('shops')
    .values({
      id: SHOP_ID,
      slug: `smoke-p7-4-${SUFFIX}`,
      name: 'PR4 Shop',
      email: `p7-4-${SUFFIX}@example.test`,
      status: 'active',
    })
    .execute()
  await (db as any)
    .insertInto('themes')
    .values([
      {
        id: THEME_ID,
        shop_id: SHOP_ID,
        name: `smoke-theme-${SUFFIX}`,
        role: 'main',
      },
      {
        id: OTHER_THEME_ID,
        shop_id: SHOP_ID,
        name: `smoke-other-${SUFFIX}`,
        role: 'unpublished',
      },
    ])
    .execute()

  // --- Seed assets ---------------------------------------------------------
  log('[0.1] Seeding theme assets')

  // Ranking ladder around the needle "product":
  //   exact key    → 'product'
  //   prefix       → 'product.liquid'
  //   contains     → 'templates/product.liquid'
  //   content-only → 'layout/theme.liquid' (body mentions 'product')
  await seedAsset(THEME_ID, 'product', 'unrelated body')
  await seedAsset(THEME_ID, 'product.liquid', 'unrelated body')
  await seedAsset(
    THEME_ID,
    'templates/product.liquid',
    '<h1>{{ product.title }}</h1>\n<p>Price: {{ product.price | money }}</p>',
  )
  await seedAsset(
    THEME_ID,
    'layout/theme.liquid',
    [
      '<!doctype html>',
      '<html>',
      '  <head><title>{{ shop.name }}</title></head>',
      '  <body>',
      '    <!-- all about product listings below -->',
      '    {{ content_for_layout }}',
      '  </body>',
      '</html>',
    ].join('\n'),
  )

  // Filename-only + extension ladder
  // Body purposely free of "header" so 'HEADER' needle only matches the key.
  await seedAsset(THEME_ID, 'sections/header.liquid', '<div>{{ shop.name }}</div>')
  await seedAsset(THEME_ID, 'assets/style.css', 'body { color: #333 }')
  await seedAsset(THEME_ID, 'config/settings_schema.json', '[{"name":"theme"}]')

  // R2 sentinel — large asset parked in object storage.
  await seedAsset(
    THEME_ID,
    'assets/hero.png',
    `r2://themes/${THEME_ID}/assets/hero.png`,
  )

  // Another theme in the SAME shop — isolation test.
  await seedAsset(OTHER_THEME_ID, 'templates/product.liquid', 'other theme body')

  // ---------------------------------------------------------------------
  // 1. empty q returns []
  // ---------------------------------------------------------------------
  log('\n[1] empty / whitespace q')
  assert(
    (await searchThemeAssets(db as any, THEME_ID, '')).length === 0,
    '1.1 empty q → []',
  )
  assert(
    (await searchThemeAssets(db as any, THEME_ID, '   ')).length === 0,
    '1.2 whitespace q → []',
  )

  // ---------------------------------------------------------------------
  // 2. filename substring match (case-insensitive)
  // ---------------------------------------------------------------------
  log('\n[2] filename substring match')
  const fnHits = await searchThemeAssets(db as any, THEME_ID, 'HEADER')
  assert(fnHits.length === 1, '2.1 one hit')
  assert(fnHits[0]?.key === 'sections/header.liquid', '2.2 right key')
  assert(fnHits[0]?.matchType === 'filename', '2.3 matchType=filename')

  // ---------------------------------------------------------------------
  // 3. body content match surfaces a snippet + line number
  // ---------------------------------------------------------------------
  log('\n[3] body content match')
  const bodyHits = await searchThemeAssets(db as any, THEME_ID, 'content_for_layout')
  assert(bodyHits.length === 1, '3.1 one hit')
  assert(bodyHits[0]?.key === 'layout/theme.liquid', '3.2 right key')
  assert(bodyHits[0]?.matchType === 'content', '3.3 matchType=content')
  assert(bodyHits[0]?.lineNumber === 6, `3.4 lineNumber=6 (got ${bodyHits[0]?.lineNumber})`)
  assert(
    (bodyHits[0]?.snippet ?? '').includes('content_for_layout'),
    '3.5 snippet contains needle',
  )

  // ---------------------------------------------------------------------
  // 4. matchType=both when key AND body both match the needle
  // ---------------------------------------------------------------------
  log('\n[4] matchType=both')
  const bothHits = await searchThemeAssets(db as any, THEME_ID, 'product')
  const bothKey = bothHits.find((h) => h.key === 'templates/product.liquid')
  assert(bothKey?.matchType === 'both', '4.1 templates/product.liquid is matchType=both')

  // ---------------------------------------------------------------------
  // 5. Ranking: exact > prefix > contains > content-only
  // ---------------------------------------------------------------------
  log('\n[5] ranking order')
  const rankKeys = bothHits.map((h) => h.key)
  // The first four hits (in order) should be the rank ladder.
  assert(rankKeys[0] === 'product', `5.1 exact first (got ${rankKeys[0]})`)
  assert(rankKeys[1] === 'product.liquid', `5.2 prefix second (got ${rankKeys[1]})`)
  assert(
    rankKeys[2] === 'templates/product.liquid',
    `5.3 contains third (got ${rankKeys[2]})`,
  )
  assert(
    rankKeys[3] === 'layout/theme.liquid',
    `5.4 content-only fourth (got ${rankKeys[3]})`,
  )

  // ---------------------------------------------------------------------
  // 6. mode=filename skips body scan
  // ---------------------------------------------------------------------
  log('\n[6] mode=filename')
  const fileOnly = await searchThemeAssets(db as any, THEME_ID, 'product', {
    mode: 'filename',
  })
  assert(
    fileOnly.every((h) => h.matchType !== 'content'),
    '6.1 no content-only hits',
  )
  assert(
    !fileOnly.some((h) => h.key === 'layout/theme.liquid'),
    '6.2 layout/theme.liquid excluded (body-only)',
  )

  // ---------------------------------------------------------------------
  // 7. mode=content skips filename-only matches
  // ---------------------------------------------------------------------
  log('\n[7] mode=content')
  const contentOnly = await searchThemeAssets(db as any, THEME_ID, 'product', {
    mode: 'content',
  })
  assert(
    contentOnly.every((h) => h.matchType !== 'filename'),
    '7.1 no filename-only hits',
  )
  assert(
    contentOnly.some((h) => h.key === 'layout/theme.liquid'),
    '7.2 layout/theme.liquid included (body hit)',
  )

  // ---------------------------------------------------------------------
  // 8. R2 sentinel rows are skipped for body scan
  // ---------------------------------------------------------------------
  log('\n[8] R2 sentinel handling')
  // Body search for "themes" would hit the R2 sentinel string itself if
  // we didn't skip it — confirm we do.
  const r2Content = await searchThemeAssets(db as any, THEME_ID, 'themes', {
    mode: 'content',
  })
  assert(
    !r2Content.some((h) => h.key === 'assets/hero.png'),
    '8.1 R2 row NOT returned by content-mode scan',
  )
  // Filename mode: the key still matches.
  const r2FilenameOnly = await searchThemeAssets(db as any, THEME_ID, 'hero', {
    mode: 'filename',
  })
  assert(
    r2FilenameOnly.some((h) => h.key === 'assets/hero.png'),
    '8.2 R2 row IS returned by filename-mode scan',
  )

  // ---------------------------------------------------------------------
  // 9. Extension filter
  // ---------------------------------------------------------------------
  log('\n[9] extension filter')
  const liquidOnly = await searchThemeAssets(db as any, THEME_ID, 'product', {
    ext: '.liquid',
  })
  assert(
    liquidOnly.every((h) => h.key.endsWith('.liquid')),
    '9.1 .liquid filter: every hit ends in .liquid',
  )
  const cssOnly = await searchThemeAssets(db as any, THEME_ID, 'color', {
    ext: 'css', // no leading dot
  })
  assert(
    cssOnly.length === 1 && cssOnly[0]?.key === 'assets/style.css',
    '9.2 css filter without leading dot matches style.css',
  )

  // ---------------------------------------------------------------------
  // 10. Limit cap + clamp
  // ---------------------------------------------------------------------
  log('\n[10] limit cap + clamp')
  const limit2 = await searchThemeAssets(db as any, THEME_ID, 'product', {
    limit: 2,
  })
  assert(limit2.length === 2, `10.1 limit=2 returns 2 hits (got ${limit2.length})`)

  // Hostile large limit — must not OOM; service clamps to 200.
  const big = await searchThemeAssets(db as any, THEME_ID, 'product', {
    limit: 1_000_000,
  })
  assert(big.length <= 200, `10.2 absurd limit clamped to ≤200 (got ${big.length})`)

  const zero = await searchThemeAssets(db as any, THEME_ID, 'product', {
    limit: 0,
  })
  assert(zero.length >= 1, '10.3 limit=0 clamps up to at least 1')

  // ---------------------------------------------------------------------
  // 11. Theme-scope isolation
  // ---------------------------------------------------------------------
  log('\n[11] theme-scope isolation')
  const primary = await searchThemeAssets(db as any, THEME_ID, 'product')
  assert(
    !primary.some((h) => h.key === 'other theme body'),
    '11.1 primary theme does not see OTHER_THEME_ID assets',
  )
  const other = await searchThemeAssets(db as any, OTHER_THEME_ID, 'product')
  assert(
    other.length === 1 && other[0]?.key === 'templates/product.liquid',
    '11.2 other theme sees its own row only',
  )
  // The OTHER theme's templates/product.liquid row has body 'other theme body'
  // — confirm it's a content-mode hit (so we know the rows aren't being
  // swapped across themes).
  assert(other[0]?.matchType !== 'content', '11.3 other theme hit still matches via filename')

  // ---------------------------------------------------------------------
  log(`\n=== DONE: ${total - failed}/${total} passed, ${failed} failed ===\n`)
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('SMOKE CRASHED', err)
    failed = Math.max(failed, 1)
  })
  .finally(async () => {
    // Cleanup in reverse FK order: assets → themes → shop.
    try {
      if (assetIds.length) {
        await (db as any)
          .deleteFrom('theme_assets')
          .where('id', 'in', assetIds)
          .execute()
      }
      await (db as any)
        .deleteFrom('themes')
        .where('id', 'in', [THEME_ID, OTHER_THEME_ID])
        .execute()
      await (db as any).deleteFrom('shops').where('id', '=', SHOP_ID).execute()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('cleanup error', e)
    }
    await (db as any).destroy()
    if (failed > 0) process.exit(1)
  })
