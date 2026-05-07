/**
 * Lenful V6 API type definitions.
 *
 * Derived from Postman collection 2s8Yt1rouq (publicly documented).
 * Only the fields Gbox actually touches are typed — unknown extras
 * land in `raw_payload` jsonb columns.
 */

export const LENFUL_DEFAULT_BASE = 'https://s-lencam.lenful.com'
export const LENFUL_V3_BASE = 'https://s-lencam-v3.lenful.com'
export const LENFUL_WALLET_BASE = 'https://s-wallet.lenful.com'
export const LENFUL_STORE_BASE = 'https://s-store.lenful.com'
export const LENFUL_DESIGN_BASE = 'https://s-design.lenful.com'
export const LENFUL_CUSTOMER_BASE = 'https://s-customer.lenful.com'

/** Shipping method code → name (Lenful documents these ints). */
export const SHIPPING_METHODS = {
  0: 'Standard Shipping',
  1: 'Ground Shipping',
  2: 'Express Shipping',
  3: '3 Days Shipping',
  4: 'Special Shipping',
  5: 'US Island',
  6: 'WW Standard Shipping',
  7: 'Shipping By Platform',
  8: 'Shipping By Seller',
} as const

export type ShippingMethodCode = keyof typeof SHIPPING_METHODS

/** Print position code → description. */
export const PRINT_POSITIONS = {
  0: 'Full',
  1: 'Front',
  2: 'Back',
  3: 'Left Chest',
  4: 'Right Chest',
  5: 'Left Sleeve',
  6: 'Right Sleeve',
  7: 'Neck',
  8: 'Full 3D',
} as const

export type PrintPosition = keyof typeof PRINT_POSITIONS

// ─── Auth ────────────────────────────────────────────────────────

export interface LenfulLoginResponse {
  readonly access_token?: string
  readonly token?: string
  readonly token_type?: string
  readonly expires_in?: number
  readonly seller_id?: string
  readonly id?: string
  readonly user_name?: string
  readonly email?: string
  readonly name?: string
  readonly [k: string]: unknown
}

export interface LenfulMeResponse {
  readonly id?: string
  readonly user_name?: string
  readonly email?: string
  readonly stores?: ReadonlyArray<{ id?: string; name?: string }>
  readonly [k: string]: unknown
}

// ─── Order creation payload ──────────────────────────────────────

export interface LenfulDesignPayload {
  /** 0/1/2/3/4/5/6/7/8 — see PRINT_POSITIONS */
  readonly position: PrintPosition
  readonly link: string
  readonly link_blueprint?: string
}

export interface LenfulEmbroideredPayload {
  readonly position: number
  readonly link: string
}

export interface LenfulCreateOrderItem {
  /** Reuses an existing design_sku if present; otherwise Lenful creates one. */
  readonly design_sku?: string
  /** Required — product variant SKU taken from Lenful catalog. */
  readonly product_sku: string
  readonly quantity: number
  readonly mockups?: ReadonlyArray<string>
  readonly designs?: ReadonlyArray<LenfulDesignPayload>
  readonly embroidereds?: ReadonlyArray<LenfulEmbroideredPayload>
  readonly request_clone?: boolean
  /** Shipping priority, left→right. Must include code 7 if platform_label set. */
  readonly shippings: ReadonlyArray<ShippingMethodCode>
}

export interface LenfulCreateOrderPayload {
  /** Gbox origin tag: `GBOX-{shopSlug}-{gboxOrderNumber}`. */
  readonly order_number: string
  readonly first_name: string
  readonly last_name: string
  readonly email: string
  readonly phone: string
  readonly country_code: string
  readonly province: string
  readonly city: string
  readonly zip: string
  readonly address_1: string
  readonly address_2?: string
  /** `[GBOX] shop=… seller=… order=…` — used as Gbox trace tag. */
  readonly note: string
  readonly platform_label?: string
  readonly items: ReadonlyArray<LenfulCreateOrderItem>
}

export interface LenfulCreateOrderResponse {
  readonly id?: string
  readonly order_id?: string
  readonly order_number?: string
  readonly status?: string
  readonly total_price?: number
  readonly items?: ReadonlyArray<{
    readonly id?: string
    readonly product_sku?: string
    readonly design_sku?: string
  }>
  readonly [k: string]: unknown
}

// ─── Wallet ──────────────────────────────────────────────────────

export interface LenfulWalletResponse {
  readonly balance?: number | string
  readonly currency?: string
  readonly [k: string]: unknown
}

// ─── Catalog (F1) ────────────────────────────────────────────────

/** Normalized shape emitted by LenfulClient.listProducts. */
export interface LenfulCatalogProduct {
  readonly id: string | null
  readonly product_sku: string | null
  readonly sku: string | null
  readonly title: string | null
  readonly category: string | null
  readonly thumbnail: string | null
  readonly price: number | string | null
  readonly raw: unknown
}

/** Normalized shape emitted by LenfulClient.listDesigns. */
export interface LenfulCatalogDesign {
  readonly id?: string
  readonly design_sku?: string
  readonly title?: string
  readonly preview_url?: string
  readonly front_link?: string
  readonly back_link?: string
  readonly left_chest_link?: string
  readonly right_chest_link?: string
  readonly left_sleeve_link?: string
  readonly right_sleeve_link?: string
  readonly neck_link?: string
  readonly [k: string]: unknown
}

// ─── Tracking ────────────────────────────────────────────────────

export interface LenfulTrackingItem {
  readonly id?: string
  readonly order_short_id?: string
  readonly order_id?: string
  readonly tracking_number?: string
  readonly tracking_carrier?: string
  readonly tracking_company?: string
  readonly tracking_url?: string
  readonly tracking_status?: string
  readonly shipped_at?: string
  readonly delivered_at?: string
  readonly [k: string]: unknown
}
