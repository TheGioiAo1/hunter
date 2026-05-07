/**
 * Types cho Gbox-Shipping-Service. Mirror BE Swagger 2026.
 * Base: API_SHIPPING_BASE_URL / api/{shop_id}/...
 */

export interface ApiShippingMethod {
  name?: string
  description?: string
  type?: string
  first_item_base_cost?: number
  second_item_base_cost?: number
  first_item_price?: number
  second_item_price?: number
  range_type?: string
  min_value?: number
  max_value?: number
  price?: number
  xbase?: number
}

export interface ApiShipping {
  id?: string
  shop_id?: string
  name?: string
  country_codes?: string[]
  country_excluded?: boolean
  ids?: string[]
  entities?: { entity_id?: string; entity_name?: string; entity_image?: string }[]
  entity?: number
  entity_excluded?: boolean
  shipping_methods?: ApiShippingMethod[]
  preferred_rules?: string
  create_date?: string
  update_date?: string
}

export interface ListShippingsOpts {
  field?: string
  keyword?: string
}
