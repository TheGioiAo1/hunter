/**
 * Gbox Platform — Phase 10 PR4 smoke
 *
 * PR4 is a cross-cutting polish pass that ties off Phase 10 by making
 * everything we built in PR1/PR2/PR3 discoverable and fast:
 *
 *   - Sidebar: "Reviews" surfaced under Products (was orphaned)
 *   - Settings hub: new Reviews card → /products/reviews/settings
 *   - Command palette: nav-reviews + nav-review-settings entries
 *   - Perf: migration 072 adds `idx_product_reviews_shop_status_created`
 *     covering the moderation queue's hot query shape
 *   - A11y: aria-labelledby / aria-describedby on the Phase 10 PR3
 *     review-settings page + `.sr-only` utility in the seller layout
 *
 * Run against live Postgres from server 2:
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     STORE_ADMIN_PORT=0 \
 *     npx tsx scripts/smoke-phase10-pr4.ts
 *
 * Iron rule 5: the Phase 10 PR3 admin sources are source-scanned for
 * "god admin" leaks (PR3 smoke already did this for review-settings.ts;
 * here we re-cover + extend to include the public `reviews.ts` page).
 */

import { createDb, destroyDb } from '@gbox/db'
import { sql } from 'kysely'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM doesn't expose __dirname; derive it the Node 18+ way so the same
// code works under tsx (which uses ESM under the hood) and node --loader.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')

type AssertFn = (label: string, ok: boolean, detail?: string) => void

function makeAsserter(): { assert: AssertFn; summary: () => { total: number; passed: number } } {
  let total = 0
  let passed = 0
  const assert: AssertFn = (label, ok, detail) => {
    total++
    if (ok) {
      passed++
      console.log(`  OK   [${total}] ${label}`)
    } else {
      console.error(`  FAIL [${total}] ${label}${detail ? ` — ${detail}` : ''}`)
    }
  }
  return {
    assert,
    summary: () => ({ total, passed }),
  }
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
}

async function main() {
  const suffix = Date.now().toString()
  console.log(`=== Phase 10 PR4 smoke — suffix=${suffix} ===\n`)

  const db = createDb()
  const { assert, summary } = makeAsserter()

  // ---------------------------------------------------------------------------
  // [1..2] Migration 072 — moderation queue index
  // ---------------------------------------------------------------------------
  console.log('[1..2] Migration 072 index')
  try {
    const ledger = await db
      .selectFrom('_migrations' as any)
      .select(['name' as any])
      .where('name' as any, '=', '072_phase10_perf_indexes')
      .executeTakeFirst()
    assert('_migrations ledger has 072_phase10_perf_indexes', !!ledger)

    const idx = await sql<{
      indexname: string
    }>`
      SELECT indexname
        FROM pg_indexes
       WHERE tablename = 'product_reviews'
         AND indexname = 'idx_product_reviews_shop_status_created'
    `.execute(db)
    assert(
      'idx_product_reviews_shop_status_created exists on product_reviews',
      idx.rows.length === 1,
    )
  } catch (err) {
    assert('migration 072 introspection', false, String(err))
  }

  // ---------------------------------------------------------------------------
  // [3..4] Settings hub + sidebar source audit
  //
  // NOTE: we intentionally read settings.ts / seller-layout.ts as source
  // files rather than importing them. The admin server graph pulls in
  // ai-copywriter → @anthropic-ai/sdk which isn't installed on the smoke
  // box (same constraint as PR3). Static source assertions are enough
  // here because what we're validating is config shape, not render output.
  // ---------------------------------------------------------------------------
  console.log('\n[3..4] Discoverability audit (static source scan)')
  try {
    const settingsSrc = readSrc('apps/store-admin/src/pages/settings.ts')
    assert(
      'settings.ts hub exposes Reviews card → /products/reviews/settings',
      /title:\s*'Reviews'/.test(settingsSrc) &&
        /\$\{base\}\/products\/reviews\/settings/.test(settingsSrc),
    )

    const layoutSrc = readSrc('apps/store-admin/src/layouts/seller-layout.ts')
    assert(
      'sidebar Products group contains Reviews child → /products/reviews',
      /label:\s*'Reviews'/.test(layoutSrc) &&
        /href:\s*`\$\{base\}\/products\/reviews`/.test(layoutSrc),
    )
  } catch (err) {
    assert('[3..4] hub + sidebar audit', false, String(err))
  }

  // ---------------------------------------------------------------------------
  // [5..6] Command palette exposes nav-reviews + nav-review-settings
  // ---------------------------------------------------------------------------
  console.log('\n[5..6] Command palette audit')
  try {
    const layoutSrc = readSrc('apps/store-admin/src/layouts/seller-layout.ts')
    assert(
      "command palette entry id='nav-reviews'",
      /id:\s*'nav-reviews'/.test(layoutSrc),
    )
    assert(
      "command palette entry id='nav-review-settings' with profanity keyword",
      /id:\s*'nav-review-settings'/.test(layoutSrc) && /profanity/.test(layoutSrc),
    )
  } catch (err) {
    assert('[5..6] command palette', false, String(err))
  }

  // ---------------------------------------------------------------------------
  // [7..10] Review settings page a11y + render
  //
  // review-settings.ts is dep-free (its imports are: express types,
  // kysely types, seller-layout esc, csrf helper, @gbox/core reviews
  // settings, and the dep-free flash lib). So we can import it here
  // without pulling ai-copywriter.
  // ---------------------------------------------------------------------------
  console.log('\n[7..10] Review-settings a11y + render')
  const shopId = randomUUID()
  try {
    const slug = `pr4-rs-${suffix}`
    await db
      .insertInto('shops' as any)
      .values({
        id: shopId,
        name: 'PR4 RS',
        slug,
        email: `${slug}@example.test`,
        domain: `${slug}.example.com`,
        plan: 'starter',
        status: 'active',
        currency: 'USD',
      } as any)
      .execute()

    const mod = await import('../apps/store-admin/src/pages/review-settings.ts')
    const captured = { body: '', redirect: '' }
    const req: any = {
      store: { id: shopId, name: 'PR4 RS', slug, domain: `${slug}.example.com` },
      storeUser: { id: randomUUID(), name: 'Smoke', email: 'smoke@gbox.local', role: 'owner' },
      params: { slug },
      query: {},
      body: {},
      theme: 'dark',
      csrfToken: 'smoke-csrf',
    }
    const res: any = {
      send: (body: string) => {
        captured.body = body
      },
      redirect: (url: string) => {
        captured.redirect = url
      },
      status: () => res,
    }
    await mod.getReviewSettings(req, res, db as any)
    const base = `/admin/store/${slug}`

    assert('page renders (body > 500 chars)', captured.body.length > 500)
    assert(
      'moderation form posts to .../settings/moderation',
      captured.body.includes(`action="${base}/products/reviews/settings/moderation"`),
    )
    assert(
      'notifications form posts to .../settings/notifications',
      captured.body.includes(`action="${base}/products/reviews/settings/notifications"`),
    )
    assert(
      'aria hooks present (aria-labelledby + aria-describedby)',
      captured.body.includes('aria-labelledby="moderation-heading"') &&
        captured.body.includes('aria-describedby="profanity_extra_terms_help"'),
    )
  } catch (err) {
    assert('[7..10] review-settings', false, String(err))
  } finally {
    try {
      await db.deleteFrom('shops' as any).where('id' as any, '=', shopId).execute()
    } catch {
      /* best effort */
    }
  }

  // ---------------------------------------------------------------------------
  // [11..13] .sr-only utility + iron rule 5 audit on Phase 10 admin pages
  // ---------------------------------------------------------------------------
  console.log('\n[11..13] sr-only utility + iron rule 5 audit')
  try {
    const layoutSrc = readSrc('apps/store-admin/src/layouts/seller-layout.ts')
    assert(
      '.sr-only CSS utility defined in seller-layout',
      /\.sr-only\s*\{/.test(layoutSrc),
    )

    // Iron rule 5: scan the 3 PR-era admin pages for literal "god admin"
    const files = [
      'apps/store-admin/src/pages/review-settings.ts',
      'apps/store-admin/src/pages/reviews.ts',
      'apps/store-admin/src/lib/review-settings-flash.ts',
    ]
    let leak = ''
    for (const rel of files) {
      const src = readSrc(rel).toLowerCase()
      if (src.includes('god admin') || src.includes('god-admin') || src.includes('god_admin')) {
        leak = rel
        break
      }
    }
    assert(
      'Phase 10 PR3/PR4 admin src files never mention "god admin"',
      leak === '',
      leak ? `leak in ${leak}` : undefined,
    )

    const flashMod = await import('../apps/store-admin/src/lib/review-settings-flash.ts')
    const fallback = flashMod.safeReviewSettingsMessage({} as any)
    assert(
      'safeReviewSettingsMessage default → "Please contact Gbox support."',
      fallback === 'Please contact Gbox support.',
    )
  } catch (err) {
    assert('[11..13] sr-only + iron rule 5', false, String(err))
  }

  // ---------------------------------------------------------------------------
  // Wrap-up
  // ---------------------------------------------------------------------------
  const { total, passed } = summary()
  console.log('\n===============================')
  console.log(`   ${passed}/${total} assertions passed`)
  console.log('===============================\n')

  await destroyDb()

  if (passed !== total) {
    process.exit(1)
  }
}

main().catch(async (err) => {
  console.error('[FAIL] PR4 smoke crashed:', err)
  try {
    await destroyDb()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
