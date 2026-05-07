/**
 * Gbox Platform — Storefront event recorders (Stage 3E.1)
 *
 * Write-path counterpart to `analytics/service.ts`. The analytics
 * module aggregates rows from the `events` table; this module is
 * how those rows get there.
 *
 * Design:
 *
 *   1. **Fire-and-forget semantics.** Every recorder swallows DB
 *      errors and returns `Promise<void>`. The storefront uses
 *      these on the hot path (page render, cart mutation), and
 *      a transient Postgres blip must NEVER 500 the buyer. Lost
 *      events are acceptable; lost page views are not.
 *
 *   2. **Narrow input shapes.** Callers pass plain JS objects with
 *      the exact fields the recorder needs. No coupling to drops,
 *      no coupling to HTTP, no coupling to Kysely query builders.
 *      The request context (path, user agent, session id) is the
 *      caller's responsibility to gather.
 *
 *   3. **JSON body is a string.** The `events` table column is
 *      `jsonb`, but Kysely's JsonB type expects the string form
 *      when writing through `insertInto().values()`. Encoding here
 *      means tests and callers never have to think about it.
 *
 *   4. **Verb allowlist re-exported.** `STOREFRONT_EVENT_VERBS`
 *      is the single source of truth. The beacon route uses it
 *      to reject unknown event types; the analytics funnel uses
 *      the same list in `getConversionFunnel`.
 *
 *   5. **User agent hard-capped at 512 chars.** Adversarial clients
 *      send multi-kilobyte UA strings to blow up log pipelines.
 *      The cap is defensive — Chrome's real UA is ~130 chars.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STOREFRONT_EVENT_VERBS = [
  'page_view',
  'add_to_cart',
  'checkout_start',
  'purchase',
] as const

export type StorefrontEventVerb = (typeof STOREFRONT_EVENT_VERBS)[number]

const UA_MAX_LEN = 512

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface PageViewInput {
  path: string
  referrer: string | null
  userAgent: string
  sessionId: string
  customerId?: string | null
}

export interface AddToCartInput {
  variantId: string
  productId: string
  quantity: number
  price: string
  currency: string
  sessionId: string
  customerId?: string | null
}

export interface CheckoutStartInput {
  checkoutId: string
  total: string
  currency: string
  itemCount: number
  sessionId: string
  customerId?: string | null
}

export interface PurchaseInput {
  orderId: string
  total: string
  currency: string
  itemCount: number
  sessionId: string
  customerId?: string | null
}

// ---------------------------------------------------------------------------
// Recorders
// ---------------------------------------------------------------------------

export async function recordPageView(
  db: Kysely<Database>,
  shopId: string,
  input: PageViewInput,
): Promise<void> {
  const body: Record<string, unknown> = {
    session_id: input.sessionId,
    user_agent: truncate(input.userAgent, UA_MAX_LEN),
  }
  if (input.referrer) body.referrer = input.referrer
  if (input.customerId) body.customer_id = input.customerId

  await insertEvent(db, {
    shop_id: shopId,
    subject_type: 'page',
    subject_id: input.path,
    verb: 'page_view',
    body: JSON.stringify(body),
  })
}

export async function recordAddToCart(
  db: Kysely<Database>,
  shopId: string,
  input: AddToCartInput,
): Promise<void> {
  const body: Record<string, unknown> = {
    product_id: input.productId,
    quantity: input.quantity,
    price: input.price,
    currency: input.currency,
    session_id: input.sessionId,
  }
  if (input.customerId) body.customer_id = input.customerId

  await insertEvent(db, {
    shop_id: shopId,
    subject_type: 'variant',
    subject_id: input.variantId,
    verb: 'add_to_cart',
    body: JSON.stringify(body),
  })
}

export async function recordCheckoutStart(
  db: Kysely<Database>,
  shopId: string,
  input: CheckoutStartInput,
): Promise<void> {
  const body: Record<string, unknown> = {
    total: input.total,
    currency: input.currency,
    item_count: input.itemCount,
    session_id: input.sessionId,
  }
  if (input.customerId) body.customer_id = input.customerId

  await insertEvent(db, {
    shop_id: shopId,
    subject_type: 'checkout',
    subject_id: input.checkoutId,
    verb: 'checkout_start',
    body: JSON.stringify(body),
  })
}

export async function recordPurchase(
  db: Kysely<Database>,
  shopId: string,
  input: PurchaseInput,
): Promise<void> {
  const body: Record<string, unknown> = {
    total: input.total,
    currency: input.currency,
    item_count: input.itemCount,
    session_id: input.sessionId,
  }
  if (input.customerId) body.customer_id = input.customerId

  await insertEvent(db, {
    shop_id: shopId,
    subject_type: 'order',
    subject_id: input.orderId,
    verb: 'purchase',
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

interface EventRow {
  shop_id: string
  subject_type: string
  subject_id: string
  verb: StorefrontEventVerb
  body: string
}

async function insertEvent(db: Kysely<Database>, row: EventRow): Promise<void> {
  try {
    await (db as unknown as {
      insertInto: (t: 'events') => {
        values: (r: EventRow) => { execute: () => Promise<unknown> }
      }
    })
      .insertInto('events')
      .values(row)
      .execute()
  } catch {
    // Intentionally swallowed — see module header, fire-and-forget.
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max)
}
