/**
 * Type mirrors for the legacy Gbox product/auth swaggers.
 *
 * These are the subset of fields our mapper + push path actually touch —
 * see _tmp/product-swagger.json and _tmp/auth-swagger.json (or
 * https://api-product.gbox.co/swagger/v1/swagger.json) for the full
 * schemas. Everything here is `readonly` because legacy API responses
 * must not be mutated on the way to the wire.
 */

// ───────────────────────────────────────────────────────────
// Outbound — what we POST to /api/{shop_id}
// ───────────────────────────────────────────────────────────

export interface LegacyProductImage {
  readonly position: number
  readonly url: string
  readonly type?: number // DesignType enum on the .NET side
}

export interface LegacyProductOptionValue {
  readonly name: string
  readonly display_value: string
  readonly slug?: string
}

export interface LegacyProductOption {
  readonly name: string
  readonly slug?: string
  readonly values: ReadonlyArray<LegacyProductOptionValue>
  readonly display_type?: string
}

export interface LegacyProductVariant {
  readonly name: string
  readonly sku: string
  readonly price: number
  readonly option_values?: ReadonlyArray<string>
  readonly weight?: number
  readonly mass_unit?: string
}

export interface LegacyProductPayload {
  name: string
  sku?: string
  slug?: string
  vendor?: string
  tags?: string[]
  body_html?: string
  images?: LegacyProductImage[]
  variants?: LegacyProductVariant[]
  options?: LegacyProductOption[]
  seo_title?: string
  seo_description?: string
  published?: boolean
}

// ───────────────────────────────────────────────────────────
// Inbound — login + create product responses
// ───────────────────────────────────────────────────────────

/**
 * The .NET auth service is documented as returning just "Success" in
 * swagger (no typed body). In practice the JWT lands in one of a short
 * list of fields — we probe them in order in client.ts.
 */
export interface LegacyAuthResponseLoose {
  readonly access_token?: string
  readonly token?: string
  readonly data?: {
    readonly access_token?: string
    readonly token?: string
  }
  readonly result?: {
    readonly access_token?: string
    readonly token?: string
  }
}

export interface LegacyCreateProductResult {
  readonly status: number
  readonly ok: boolean
  readonly legacyProductId: string | null
  readonly errorMessage: string | null
  readonly rawBody: unknown
  readonly latencyMs: number
}

/** Typed error codes emitted by `createLegacyProduct` so callers can branch on them. */
export type LegacyPushErrorCode =
  | 'no_config'
  | 'auth_failed'
  | 'network_error'
  | 'http_4xx'
  | 'http_5xx'
  | 'bad_response'
