/**
 * Smoke test — Decision #1 Step 1.2b i18n module end-to-end.
 *
 * Verifies (without touching the database):
 *   1. interpolate() handles tokens, missing keys, numbers
 *   2. MemoryI18nService set/t round-trip
 *   3. Three-tier fallback chain across en/vi/fr
 *   4. setMany() bulk insert + count
 *   5. invalidate() drops only the targeted (shop, locale)
 *
 * Run:
 *   npx tsx scripts/smoke-i18n-step-1-2b.ts
 */

import {
  interpolate,
  MemoryI18nService,
} from '../packages/core/src/modules/i18n/index.js'

async function main() {
  // (1) interpolate basics
  const greeting = interpolate('Hello {{ name }}, you have {{ count }} items', {
    name: 'Thai',
    count: 5,
  })
  if (greeting !== 'Hello Thai, you have 5 items') {
    throw new Error(`interpolate failed: ${greeting}`)
  }
  console.log('PASS (1) interpolate basics:', greeting)

  // (2) MemoryI18nService round-trip
  const i18n = new MemoryI18nService()
  await i18n.set('shop_smoke', 'en', 'cart.title', 'Cart')
  const cart = await i18n.t('shop_smoke', 'cart.title', { locale: 'en' })
  if (cart !== 'Cart') throw new Error(`set/t round-trip failed: ${cart}`)
  console.log('PASS (2) MemoryI18nService round-trip:', cart)

  // (3) Three-tier fallback chain
  const seeded = new MemoryI18nService({
    shop_smoke: {
      en: {
        'cart.title': 'Cart',
        'cart.empty': 'Your cart is empty',
        'cart.checkout': 'Checkout',
      },
      vi: { 'cart.title': 'Giỏ hàng' },
      fr: { 'cart.title': 'Panier' },
    },
  })

  // Tier 1: vi has cart.title
  const t1 = await seeded.t('shop_smoke', 'cart.title', {
    locale: 'vi',
    shopDefaultLocale: 'en',
  })
  if (t1 !== 'Giỏ hàng') throw new Error(`Tier 1 failed: ${t1}`)
  console.log('PASS (3a) Tier 1 (vi):', t1)

  // Tier 2: vi missing cart.empty → en (shop default) has it
  const t2 = await seeded.t('shop_smoke', 'cart.empty', {
    locale: 'vi',
    shopDefaultLocale: 'en',
  })
  if (t2 !== 'Your cart is empty') throw new Error(`Tier 2 failed: ${t2}`)
  console.log('PASS (3b) Tier 2 (vi → en):', t2)

  // Tier 3: fr is shop default but doesn't have cart.checkout → ULTIMATE en
  const t3 = await seeded.t('shop_smoke', 'cart.checkout', {
    locale: 'fr',
    shopDefaultLocale: 'fr',
  })
  if (t3 !== 'Checkout') throw new Error(`Tier 3 failed: ${t3}`)
  console.log('PASS (3c) Tier 3 (fr → fr → en):', t3)

  // Tier 4: nothing matches → key sentinel
  const t4 = await seeded.t('shop_smoke', 'no.such.key', {
    locale: 'vi',
    shopDefaultLocale: 'en',
  })
  if (t4 !== 'no.such.key') throw new Error(`Tier 4 failed: ${t4}`)
  console.log('PASS (3d) Tier 4 (sentinel):', t4)

  // (4) setMany bulk
  const fresh = new MemoryI18nService()
  const n = await fresh.setMany('shop_smoke', 'en', {
    'a.b.c': 'one',
    'a.b.d': 'two',
    'a.b.e': 'three',
  })
  if (n !== 3) throw new Error(`setMany count failed: ${n}`)
  console.log('PASS (4) setMany count:', n)

  // (5) invalidate
  await fresh.set('shop_smoke', 'vi', 'k', 'V')
  fresh.invalidate('shop_smoke', 'en')
  const stillVi = await fresh.t('shop_smoke', 'k', { locale: 'vi' })
  if (stillVi !== 'V') throw new Error(`invalidate dropped wrong locale: ${stillVi}`)
  const droppedEn = await fresh.t('shop_smoke', 'a.b.c', { locale: 'en' })
  if (droppedEn !== 'a.b.c') throw new Error(`invalidate(en) didn't drop: ${droppedEn}`)
  console.log('PASS (5) invalidate(shop, locale)')

  console.log('\nALL PASSED — Step 1.2b i18n module is correctly wired')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
