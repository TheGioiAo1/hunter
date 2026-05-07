/**
 * Default help pages seeded into every store.
 *
 * These are storefront CMS `pages` rows (slug = "fraud-analysis",
 * "prevent-fraud") that the store admin links to from the order detail
 * page's Fraud Analysis modal. Keeping the content inside the merchant's
 * own store (instead of an external help center) means:
 *
 *   1. Every store, even brand-new ones, has merchant guidance available
 *      out of the box without us managing a separate knowledge base.
 *   2. Merchants can edit / localize the content to their own risk
 *      policies and language.
 *   3. The modal links resolve to an admin URL under the merchant's own
 *      `/admin/store/:slug/online-store/pages/:id` route, so they work
 *      offline / on air-gapped test servers.
 *
 * Published = false by default so the pages don't leak onto the public
 * storefront until the merchant chooses to publish them.
 *
 * Content is intentionally modelled after the ShopBase help articles
 * (help.shopbase.com/en/article/fraud-analysis-indicators-19q5w3t &
 *  help.shopbase.com/en/article/fraud-prevention-188vpjb) but rewritten
 * in our own voice.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export interface DefaultHelpPage {
  slug: string
  title: string
  body_html: string
}

export const DEFAULT_HELP_PAGES: DefaultHelpPage[] = [
  {
    slug: 'fraud-analysis',
    title: 'Fraud analysis indicators',
    body_html: `
<h2>Understanding the Fraud Analysis panel</h2>
<p>
  Gbox runs a built-in fraud analysis check on every order so you can
  spot suspicious transactions before you fulfill them. Open any order
  detail page and look at the <strong>Fraud analysis</strong> card in the
  right sidebar, then click <em>View full analysis</em> to see every
  signal we collected for that order.
</p>

<h3>How to read the indicators</h3>
<p>
  Each indicator is color-coded so you can scan the list at a glance:
</p>
<ul>
  <li><strong>Green</strong> — information that typically appears on legitimate orders.</li>
  <li><strong>Red</strong> — information that is commonly associated with fraudulent orders. Investigate before fulfilling.</li>
  <li><strong>Grey</strong> — contextual data that is useful but not decisive on its own.</li>
</ul>

<h3>Indicator reference</h3>
<ol>
  <li>
    <strong>Web proxy / VPN check</strong> — whether the shopper's IP
    address belongs to a known proxy, VPN or datacenter network.
  </li>
  <li>
    <strong>Payment method used</strong> — credit card vs. alternative
    payment method. Card transactions carry chargeback risk;
    alternatives (wallets, bank transfer) usually don't.
  </li>
  <li>
    <strong>Disputed-IP history</strong> — whether this IP has been seen
    on any previously disputed order in your store.
  </li>
  <li>
    <strong>Payment attempts</strong> — how many times the shopper tried
    to pay before the order was accepted. More than a handful of
    attempts is a strong fraud signal.
  </li>
  <li>
    <strong>Billing country vs. IP country</strong> — whether the
    billing address is in the same country as the IP address. A
    mismatch often indicates identity theft.
  </li>
  <li>
    <strong>High-risk internet connection</strong> — whether the IP
    belongs to a hosting provider, Tor exit node or other high-risk
    connection type.
  </li>
  <li>
    <strong>Distance from billing address</strong> — how far the
    shopper's IP location is from the billing address. Short distances
    are normal; distances of hundreds or thousands of kilometers warrant
    a closer look.
  </li>
  <li>
    <strong>Fraud score</strong> — an overall 0&ndash;100 summary where
    lower is safer. Roughly: 0&ndash;29 low risk, 30&ndash;69 medium,
    70+ high risk.
  </li>
</ol>

<h3>Additional Information</h3>
<p>
  Below the indicators we show raw IP intelligence (country, city,
  region, ISP, ASN, hostname, timezone, latitude and longitude) so you
  can cross-reference the shopper's claimed location against their
  actual connection.
</p>

<h3>Important caveats</h3>
<ul>
  <li>
    These indicators can help you assess an order, but they cannot
    conclusively prove that an order is fraudulent. Use them as one
    input in your wider review process.
  </li>
  <li>
    IP geolocation is approximate. Providers give city-level accuracy
    at best, and mobile / corporate networks can appear hundreds of
    kilometers from the actual shopper.
  </li>
  <li>
    For extra safety you can enable manual payment capture in Settings
    &rarr; Payments so that high-risk orders never charge the card
    automatically.
  </li>
</ul>
`.trim(),
  },

  {
    slug: 'prevent-fraud',
    title: 'How to prevent fraud',
    body_html: `
<h2>Preventing fraud in your store</h2>
<p>
  A fraudulent transaction is one that isn't authorized by the real
  cardholder. When the real cardholder notices, they file a chargeback
  with their bank and the funds — plus a dispute fee — come out of your
  account. The best defense is to catch suspicious orders <em>before</em>
  you fulfill them.
</p>
<p>
  Gbox runs an automatic fraud analysis on every order, but you can
  layer additional checks on top. Here is the review playbook we
  recommend for any order that trips a red indicator.
</p>

<h3>1. Verify the IP address</h3>
<p>
  On the order detail page, open the <strong>Fraud analysis</strong>
  modal and check whether the IP location aligns with the billing
  address. Look out for IPs owned by web hosting companies, Tor nodes
  or anonymizing proxies — legitimate shoppers rarely use those.
</p>
<p>
  Useful free tools: <em>WhatIsMyIP</em>, <em>IP2Location</em>, and
  <em>infoSniper</em>.
</p>

<h3>2. Call the phone number</h3>
<p>
  Direct contact is the fastest legitimacy check. If the billing phone
  and address area code don't match, that's a red flag. When you call,
  ask the shopper to confirm their order total, shipping address and
  email. Fraudsters usually hesitate on these details.
</p>

<h3>3. Search the email address</h3>
<p>
  Run the shopper's email through Google and common social networks.
  Legitimate customers usually have some online footprint; disposable
  emails with no trace are a warning sign.
</p>

<h3>4. Compare shipping and billing addresses</h3>
<p>
  A common fraud pattern is a shipping address on one continent with a
  billing address on another. Use Google Maps to visualize the distance
  between the two. Gift orders and relatives are legitimate exceptions,
  but large mismatches deserve a phone call.
</p>

<h3>5. Watch for repeated shipping addresses</h3>
<p>
  If the same shipping address appears on multiple orders with different
  billing names, cards, or cities, that is almost always fraud. Use
  the Customers section to cross-reference.
</p>

<h3>6. Scrutinize high-value orders</h3>
<p>
  Any order significantly larger than your typical basket size should
  get a manual review. Consider asking for a photo ID or a confirmation
  email reply before shipping.
</p>

<h3>Enable manual payment capture</h3>
<p>
  In <strong>Settings &rarr; Payments</strong> you can switch to manual
  capture. Orders will still authorize the card, but the charge only
  settles after you approve it — giving you time to review the fraud
  indicators without the funds leaving the shopper's account in
  between.
</p>

<h3>If you missed it</h3>
<p>
  If a chargeback does come through, gather the order's fraud analysis
  report, tracking number, customer communication and signed delivery
  confirmation and submit them through your payment provider's dispute
  workflow. Gbox keeps the full fraud analysis snapshot on every order
  so you don't have to rebuild it after the fact.
</p>
`.trim(),
  },
]

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Insert the two default help pages into a shop if they don't already
 * exist. Idempotent — safe to call on both new-store provisioning and
 * historical-store backfill.
 *
 * Returns the number of rows inserted (0, 1 or 2).
 */
export async function seedDefaultHelpPages(
  db: Kysely<Database>,
  shopId: string,
): Promise<number> {
  const existing = await db
    .selectFrom('pages')
    .select(['slug'])
    .where('shop_id', '=', shopId)
    .where('slug', 'in', DEFAULT_HELP_PAGES.map(p => p.slug))
    .execute()
    .catch(() => [] as Array<{ slug: string }>)

  const existingSlugs = new Set(existing.map(r => r.slug))
  const toInsert = DEFAULT_HELP_PAGES.filter(p => !existingSlugs.has(p.slug))

  if (toInsert.length === 0) return 0

  await db
    .insertInto('pages')
    .values(toInsert.map(p => ({
      shop_id: shopId,
      title: p.title,
      slug: p.slug,
      body_html: p.body_html,
      author: 'Gbox',
      template_suffix: null,
      published: false,
    })))
    .execute()

  return toInsert.length
}
