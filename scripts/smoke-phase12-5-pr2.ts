/**
 * Gbox Platform — Phase 12.5 PR2 smoke
 *
 * Exercises the seller-facing surface that PR2 shipped:
 *
 *   [1..4]   support-widget "G" launcher renders with Messenger-blue
 *            #0084FF, correct href, polling URL, and is seller-safe
 *   [5..7]   seller-layout injects the widget on every page and keeps
 *            nav-support + act-new-ticket in the command palette
 *   [8..11]  support.ts helper surface: category list, status maps,
 *            bubble ownership + alignment
 *   [12..14] CSAT form has 1-5 radios, posts to canonical action, and
 *            escapes the ticket id
 *   [15..16] successFlash + renderStars render cleanly (no leak terms,
 *            correct star counts)
 *   [17..18] Full seller-layout output is seller-safe under a variety
 *            of store slugs (trips LEAK_TERMS_REGEX if something slips)
 *   [19..21] Widget script pauses polling on `document.hidden`, fires
 *            immediately on load, and uses a 3s default interval
 *
 * Runs offline — no DB, no HTTP. Safe to run anywhere with Node >= 20.
 *
 *   npx tsx scripts/smoke-phase12-5-pr2.ts
 */

import {
  LEAK_TERMS_REGEX,
  assertSellerSafe,
} from '@gbox/core/modules/support/index.js'
import { supportWidgetHtml } from '../apps/store-admin/src/components/support-widget.ts'
import { __testables as supportTestables } from '../apps/store-admin/src/pages/support.ts'
import { sellerLayout } from '../apps/store-admin/src/layouts/seller-layout.ts'

type AssertFn = (label: string, ok: boolean, detail?: string) => void

function makeAsserter(): {
  assert: AssertFn
  summary: () => { total: number; passed: number }
} {
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

async function main() {
  console.log('=== Phase 12.5 PR2 smoke — seller support UI ===\n')
  const { assert, summary } = makeAsserter()

  // -------------------------------------------------------------------------
  // [1..4] support-widget launcher
  // -------------------------------------------------------------------------
  console.log('[1..4] Seller support widget ("G" launcher)')
  const widgetHtml = supportWidgetHtml({ base: '/admin/store/test-shop' })
  assert(
    'widget uses Messenger-blue #0084FF',
    widgetHtml.includes('#0084FF'),
  )
  assert(
    'widget deep-links to /admin/store/test-shop/support',
    widgetHtml.includes('href="/admin/store/test-shop/support"'),
  )
  assert(
    'widget polls /support/api/unread (same base)',
    widgetHtml.includes('/support/api/unread') &&
      widgetHtml.includes('"/admin/store/test-shop"'),
  )
  assert(
    'widget is free of leak-terms (Iron Rule 5)',
    assertSellerSafe(widgetHtml),
    widgetHtml.match(LEAK_TERMS_REGEX)?.[0],
  )

  // -------------------------------------------------------------------------
  // [5..7] seller-layout integration
  // -------------------------------------------------------------------------
  console.log('\n[5..7] seller-layout integration')
  const layoutHtml = sellerLayout({
    title: 'Home',
    storeName: 'Test Shop',
    storeSlug: 'test-shop',
    userName: 'Thai',
    userEmail: 'thai@example.com',
    userRole: 'owner',
    storeRole: 'owner',
    activePage: 'home',
    content: '<p>hi</p>',
    theme: 'dark',
  })
  assert(
    'seller-layout injects the "G" launcher',
    layoutHtml.includes('gbox-support-launcher') &&
      layoutHtml.includes('class="gbox-support-btn"'),
  )
  assert(
    'command palette includes nav-support entry',
    layoutHtml.includes("id: 'nav-support'") ||
      layoutHtml.includes('Support') && layoutHtml.includes('/admin/store/test-shop/support'),
  )
  assert(
    'command palette includes act-new-ticket entry',
    layoutHtml.includes('/admin/store/test-shop/support/new'),
  )

  // -------------------------------------------------------------------------
  // [8..11] support.ts pure helpers
  // -------------------------------------------------------------------------
  console.log('\n[8..11] support.ts helper surface')
  const { CATEGORY_OPTIONS, STATUS_LABEL, STATUS_COLOR, renderMessageBubble } = supportTestables
  assert(
    'CATEGORY_OPTIONS covers every support_ticket_category enum value',
    ['payment', 'technical', 'onboarding', 'account', 'product_order', 'other'].every((v) =>
      CATEGORY_OPTIONS.some((c) => c.value === v),
    ),
  )
  assert(
    'STATUS_LABEL has 6 canonical statuses',
    Object.keys(STATUS_LABEL).sort().join(',') ===
      ['closed', 'merged', 'open', 'pending_agent', 'pending_seller', 'resolved'].join(','),
  )
  assert(
    'STATUS_COLOR matches STATUS_LABEL keys 1:1',
    Object.keys(STATUS_COLOR).sort().join(',') === Object.keys(STATUS_LABEL).sort().join(','),
  )
  const sellerBubble = renderMessageBubble({
    id: 'm1',
    ticketId: 't1',
    senderType: 'seller',
    senderDisplayName: 'Thai',
    body: 'hello',
    isOwn: true,
    createdAt: '2026-04-22T10:00:00.000Z',
  })
  assert(
    'seller bubble renders right-aligned with #0084FF',
    sellerBubble.includes('flex-end') && sellerBubble.includes('#0084FF'),
  )

  // -------------------------------------------------------------------------
  // [12..14] CSAT form rendering
  // -------------------------------------------------------------------------
  console.log('\n[12..14] CSAT form rendering')
  const csatHtml = supportTestables.renderCsatForm(
    '/admin/store/test-shop',
    'tkt-abc',
    '<input type="hidden" name="csrf_token" value="t">',
  )
  assert(
    'CSAT form has 5 rating radios',
    (csatHtml.match(/name="rating"/g) ?? []).length === 5,
  )
  assert(
    'CSAT form posts to /admin/store/test-shop/support/tkt-abc/csat',
    csatHtml.includes('action="/admin/store/test-shop/support/tkt-abc/csat"'),
  )
  // Ticket-id escape test.
  const csatEscaped = supportTestables.renderCsatForm(
    '/admin/store/test-shop',
    'tkt"evil',
    '',
  )
  assert(
    'CSAT form escapes ticket id',
    csatEscaped.includes('tkt&quot;evil'),
  )

  // -------------------------------------------------------------------------
  // [15..16] flash + stars
  // -------------------------------------------------------------------------
  console.log('\n[15..16] Flash banner + stars')
  const flash = supportTestables.successFlash('<Ticket submitted>')
  assert(
    'successFlash escapes the message',
    flash.includes('&lt;Ticket submitted&gt;'),
  )
  const stars = supportTestables.renderStars(3)
  assert(
    'renderStars(3) gold-paints 3 stars and dims 2',
    (stars.match(/#f59e0b/g) ?? []).length === 3 &&
      (stars.match(/&#9733;/g) ?? []).length === 5,
  )

  // -------------------------------------------------------------------------
  // [17..18] Full seller-layout safety
  // -------------------------------------------------------------------------
  console.log('\n[17..18] Full-layout Iron Rule 5 enforcement')
  // A layout with a suspicious store slug shouldn't leak — we never
  // interpolate anything that looks like `/god-admin/` anyway, but the
  // test exists so any future regressing edit trips on CI.
  const layouts = [
    sellerLayout({
      title: 'Support',
      storeName: 'Test Shop',
      storeSlug: 'shop-xyz',
      userName: 'Thai',
      userEmail: 'thai@example.com',
      userRole: 'owner',
      storeRole: 'owner',
      activePage: 'support',
      content: '<p>content</p>',
      theme: 'dark',
    }),
    sellerLayout({
      title: 'Home',
      storeName: 'Another Shop',
      storeSlug: 'another-shop',
      userName: 'Minh',
      userEmail: 'minh@example.com',
      userRole: 'admin',
      storeRole: 'admin',
      activePage: 'home',
      content: '<p>content</p>',
      theme: 'light',
    }),
  ]
  assert(
    'seller-layout (dark, support active) is seller-safe',
    assertSellerSafe(layouts[0]!),
    layouts[0]!.match(LEAK_TERMS_REGEX)?.[0],
  )
  assert(
    'seller-layout (light, home active) is seller-safe',
    assertSellerSafe(layouts[1]!),
    layouts[1]!.match(LEAK_TERMS_REGEX)?.[0],
  )

  // -------------------------------------------------------------------------
  // [19..21] Widget polling script behavior
  // -------------------------------------------------------------------------
  console.log('\n[19..21] Widget polling script')
  assert(
    'polls every 3000ms by default',
    widgetHtml.includes('var pollMs = 3000;'),
  )
  assert(
    'pauses on document.hidden + restarts on visibilitychange',
    widgetHtml.includes('document.hidden') && widgetHtml.includes('visibilitychange'),
  )
  assert(
    'fires once immediately before first interval tick',
    widgetHtml.includes('DOMContentLoaded'),
  )

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const { total, passed } = summary()
  console.log(`\n=== PR2 smoke summary ===\npassed: ${passed}/${total}`)
  if (passed !== total) process.exit(1)
}

main().catch((err) => {
  console.error('[smoke-phase12-5-pr2] fatal', err)
  process.exit(1)
})
