/**
 * buildCreateOrderPayload — Gbox order → Lenful createOrder payload.
 *
 * Enforces Rule 4 (iron law): every pushed order carries enough Gbox
 * metadata in `order_number` + `note` that Lenful operators (and us,
 * later) can trace back to the exact shop + seller + order UUID.
 *
 * Throws `BuildError` with a code string when any required data is
 * missing — push-order.ts turns that into a queued-status last_error.
 */

import type {
  LenfulCreateOrderItem,
  LenfulCreateOrderPayload,
  LenfulDesignPayload,
  PrintPosition,
  ShippingMethodCode,
} from './types.ts'

// ─── Errors ────────────────────────────────────────────────────

export type BuildErrorCode =
  | 'MISSING_CUSTOMER'
  | 'MISSING_ADDRESS'
  | 'MISSING_LINE_ITEMS'
  | 'MISSING_LENFUL_MAP'
  | 'MISSING_ARTWORK'
  | 'INVALID_SHIPPING'
  | 'INVALID_QUANTITY'

export class BuildError extends Error {
  constructor(
    public readonly code: BuildErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BuildError'
  }
}

// ─── Input shapes (what push-order.ts assembles) ───────────────

export interface GboxOrderForBuilder {
  readonly id: string
  readonly order_number: number | string
  readonly email: string | null
  readonly phone: string | null
  readonly shipping_address: {
    readonly first_name?: string | null
    readonly last_name?: string | null
    readonly address1?: string | null
    readonly address2?: string | null
    readonly city?: string | null
    readonly province?: string | null
    readonly province_code?: string | null
    readonly country?: string | null
    readonly country_code?: string | null
    readonly zip?: string | null
    readonly phone?: string | null
  } | null
}

export interface GboxLineItemForBuilder {
  readonly id: string
  readonly quantity: number
  readonly title: string
  readonly sku: string | null
  readonly variant_id: string | null
  readonly product_id: string | null
}

export interface LenfulMappingForBuilder {
  readonly gbox_variant_id: string | null
  readonly gbox_product_id: string
  readonly lenful_product_sku: string
  readonly default_shipping_priority: ReadonlyArray<number>
  readonly default_print_position: number
}

export interface PodArtworkForBuilder {
  readonly line_item_id: string
  readonly design_sku?: string
  readonly position: PrintPosition
  readonly link: string
  readonly link_blueprint?: string
  readonly mockup_urls?: ReadonlyArray<string>
}

export interface ShopForBuilder {
  readonly id: string
  readonly slug: string
  readonly name: string
}

export interface SellerForBuilder {
  readonly id: string
  readonly email: string
}

export interface BuildInput {
  readonly shop: ShopForBuilder
  readonly seller: SellerForBuilder
  readonly order: GboxOrderForBuilder
  readonly lineItems: ReadonlyArray<GboxLineItemForBuilder>
  readonly mappings: ReadonlyMap<string, LenfulMappingForBuilder> // key: line_item.id
  readonly artworks: ReadonlyMap<string, PodArtworkForBuilder> // key: line_item.id
  /** Platform-level default if no mapping override. */
  readonly fallbackShippingPriority?: ReadonlyArray<ShippingMethodCode>
}

// ─── Helpers ───────────────────────────────────────────────────

function coerceShippingPriority(
  values: ReadonlyArray<number>,
): ShippingMethodCode[] {
  const cleaned: ShippingMethodCode[] = []
  for (const v of values) {
    if (v >= 0 && v <= 8 && Number.isInteger(v)) {
      cleaned.push(v as ShippingMethodCode)
    }
  }
  if (cleaned.length === 0) return [0, 1, 2] as ShippingMethodCode[]
  return cleaned
}

function firstString(...vals: (string | null | undefined)[]): string {
  for (const v of vals) {
    if (v && typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return ''
}

// ─── Main builder ──────────────────────────────────────────────

export interface BuildResult {
  readonly payload: LenfulCreateOrderPayload
  readonly orderNumberSent: string
  readonly noteSent: string
  readonly shippingMethodUsed: ShippingMethodCode
}

export function buildCreateOrderPayload(input: BuildInput): BuildResult {
  const { shop, seller, order, lineItems, mappings, artworks } = input

  // 1. Validate customer & address
  if (!order.email) {
    throw new BuildError('MISSING_CUSTOMER', 'Order has no customer email')
  }
  const addr = order.shipping_address
  if (!addr) {
    throw new BuildError('MISSING_ADDRESS', 'Order has no shipping address')
  }
  if (!firstString(addr.country_code, addr.country)) {
    throw new BuildError('MISSING_ADDRESS', 'Shipping address missing country code')
  }
  if (!firstString(addr.address1)) {
    throw new BuildError('MISSING_ADDRESS', 'Shipping address missing address line 1')
  }
  if (!firstString(addr.city)) {
    throw new BuildError('MISSING_ADDRESS', 'Shipping address missing city')
  }

  // 2. Validate line items
  if (!lineItems || lineItems.length === 0) {
    throw new BuildError('MISSING_LINE_ITEMS', 'Order has no line items')
  }

  // 3. Build items[]
  const items: LenfulCreateOrderItem[] = []
  const firstMappingPriority: number[] = []
  for (const li of lineItems) {
    if (!li.quantity || li.quantity < 1) {
      throw new BuildError('INVALID_QUANTITY', `Line item ${li.id} has quantity < 1`)
    }
    const map = mappings.get(li.id)
    if (!map) {
      throw new BuildError(
        'MISSING_LENFUL_MAP',
        `Line item ${li.id} (${li.title}) has no Lenful product mapping`,
      )
    }
    const artwork = artworks.get(li.id)
    if (!artwork) {
      throw new BuildError(
        'MISSING_ARTWORK',
        `Line item ${li.id} (${li.title}) has no POD artwork uploaded`,
      )
    }

    const shippings = coerceShippingPriority(map.default_shipping_priority)
    if (firstMappingPriority.length === 0) {
      firstMappingPriority.push(...shippings)
    }

    const design: LenfulDesignPayload = {
      position: (artwork.position ?? map.default_print_position ?? 1) as PrintPosition,
      link: artwork.link,
      ...(artwork.link_blueprint ? { link_blueprint: artwork.link_blueprint } : {}),
    }

    const item: LenfulCreateOrderItem = {
      product_sku: map.lenful_product_sku,
      quantity: li.quantity,
      shippings,
      designs: [design],
      mockups: artwork.mockup_urls && artwork.mockup_urls.length > 0
        ? Array.from(artwork.mockup_urls)
        : [artwork.link],
      ...(artwork.design_sku ? { design_sku: artwork.design_sku } : {}),
      request_clone: false,
    }
    items.push(item)
  }

  // 4. Construct Rule 4 tracing fields
  //    order_number = `GBOX-{shopSlug}-{orderNumber}`
  //    note         = `[GBOX] shop={name}({id}) seller={email}({uid}) order={uuid}`
  const orderNumberSent = `GBOX-${shop.slug}-${order.order_number}`
  const noteSent =
    `[GBOX] shop=${shop.name}(${shop.id}) ` +
    `seller=${seller.email}(${seller.id}) ` +
    `order=${order.id}`

  // 5. Assemble Lenful payload
  const payload: LenfulCreateOrderPayload = {
    order_number: orderNumberSent,
    first_name: firstString(addr.first_name) || 'Customer',
    last_name: firstString(addr.last_name) || '-',
    email: order.email,
    phone: firstString(addr.phone, order.phone),
    country_code: firstString(addr.country_code, addr.country).toUpperCase(),
    province: firstString(addr.province_code, addr.province),
    city: firstString(addr.city),
    zip: firstString(addr.zip),
    address_1: firstString(addr.address1),
    address_2: firstString(addr.address2),
    note: noteSent,
    items,
  }

  const shippingMethodUsed: ShippingMethodCode =
    (firstMappingPriority[0] as ShippingMethodCode | undefined) ?? 0

  return { payload, orderNumberSent, noteSent, shippingMethodUsed }
}
