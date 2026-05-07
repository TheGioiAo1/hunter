/**
 * Unit test — currentStep() state machine (Step 2.7 of Decision #2).
 *
 * currentStep() is the central state machine of apps/checkout: given a
 * checkout session, it decides which of the three steps the buyer is on.
 * Getting this wrong means the buyer is bounced to the wrong form at the
 * wrong time, so we cover every branch.
 *
 * Pure function, no DB/Redis/HTTP — runs in milliseconds:
 *
 *   npx tsx apps/checkout/tests/current-step.test.ts
 */

import { currentStep, type ApiCheckout } from '../src/pages/checkout.js'

function assert(cond: any, msg: string): asserts cond {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
}

function fix(overrides: Partial<ApiCheckout> = {}): ApiCheckout {
  return {
    id: 'chk_fixture',
    shop_id: 'shop_fixture',
    email: null,
    line_items: [
      {
        variant_id: 'v1',
        product_id: 'p1',
        title: 'Shirt',
        variant_title: 'Small',
        price: '10.00',
        quantity: 1,
        image_url: null,
        requires_shipping: true,
        taxable: true,
      },
    ],
    shipping_address: null,
    shipping_rate: null,
    subtotal_price: '10.00',
    total_shipping: '0.00',
    total_tax: '0.00',
    total_discounts: '0.00',
    total_price: '10.00',
    currency: 'USD',
    completed_at: null,
    ...overrides,
  }
}

const completeAddress = {
  first_name: 'Alice',
  last_name: 'Example',
  address1: '1 Main St',
  address2: null,
  city: 'Springfield',
  province: 'IL',
  country: 'US',
  country_code: 'US',
  zip: '62701',
  phone: null,
}

// ---- Cases ----

// Case 1 — fresh checkout, nothing filled in → info step
assert(currentStep(fix()) === 'info', 'fresh checkout → info')

// Case 2 — email set but no address → still info (address missing)
assert(
  currentStep(fix({ email: 'a@b.co' })) === 'info',
  'email only → info',
)

// Case 3 — email + partial address (missing city) → info
assert(
  currentStep(
    fix({
      email: 'a@b.co',
      shipping_address: { ...completeAddress, city: null } as any,
    }),
  ) === 'info',
  'partial address (no city) → info',
)

// Case 4 — email + partial address (missing country) → info
assert(
  currentStep(
    fix({
      email: 'a@b.co',
      shipping_address: {
        ...completeAddress,
        country: null,
        country_code: null,
      } as any,
    }),
  ) === 'info',
  'partial address (no country) → info',
)

// Case 5 — email + full address, no rate → shipping step
assert(
  currentStep(
    fix({
      email: 'a@b.co',
      shipping_address: completeAddress as any,
    }),
  ) === 'shipping',
  'full address, no rate → shipping',
)

// Case 6 — email + full address + rate → payment step
assert(
  currentStep(
    fix({
      email: 'a@b.co',
      shipping_address: completeAddress as any,
      shipping_rate: { id: 'r1', name: 'Flat', price: '5.00', type: 'flat' },
    }),
  ) === 'payment',
  'full address + rate → payment',
)

// Case 7 — digital-only cart (no line requires shipping) → email is the
// only prerequisite, jumps straight from info to payment.
const digitalOnly: ApiCheckout = fix({
  line_items: [
    {
      variant_id: 'v1',
      product_id: 'p1',
      title: 'Ebook',
      variant_title: null,
      price: '10.00',
      quantity: 1,
      image_url: null,
      requires_shipping: false,
      taxable: true,
    },
  ],
})
assert(currentStep(digitalOnly) === 'info', 'digital, no email → info')
assert(
  currentStep({ ...digitalOnly, email: 'a@b.co' }) === 'payment',
  'digital + email → payment (skips shipping)',
)

// Case 8 — mixed cart (one physical, one digital): shipping is still
// required because at least one line wants it.
const mixedCart: ApiCheckout = fix({
  email: 'a@b.co',
  shipping_address: completeAddress as any,
  line_items: [
    {
      variant_id: 'v1',
      product_id: 'p1',
      title: 'Ebook',
      variant_title: null,
      price: '10.00',
      quantity: 1,
      image_url: null,
      requires_shipping: false,
      taxable: true,
    },
    {
      variant_id: 'v2',
      product_id: 'p2',
      title: 'Tee',
      variant_title: 'M',
      price: '15.00',
      quantity: 1,
      image_url: null,
      requires_shipping: true,
      taxable: true,
    },
  ],
})
assert(
  currentStep(mixedCart) === 'shipping',
  'mixed cart with address, no rate → shipping (physical dominates)',
)

// Case 9 — address filled with country_code only (no `country` field).
// The check accepts either, so this should still pass to shipping.
assert(
  currentStep(
    fix({
      email: 'a@b.co',
      shipping_address: {
        ...completeAddress,
        country: null,
        country_code: 'US',
      } as any,
    }),
  ) === 'shipping',
  'country_code alone is sufficient → shipping',
)

console.log('PASS — currentStep() state machine (9/9)')
