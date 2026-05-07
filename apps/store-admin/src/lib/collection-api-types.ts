/**
 * collection-api-types.ts
 * Type cho BE CollectionController (Gbox-Product-Service-V2/Models/Lencam/Collection.cs).
 * Tách khỏi Category — đây là collection riêng, schema khác.
 */

export interface CollectionProductItem {
  product_id?: string | null
  product_name?: string | null
  product_image?: string | null
  position?: number | null
}

export interface ShopCollection {
  id?: string | null
  shop_id?: string | null
  name?: string | null
  slug?: string | null
  description?: string | null
  body_html?: string | null
  status?: boolean | null
  published_at?: string | null
  image_url?: string | null
  seo_title?: string | null
  seo_description?: string | null
  /** manual | best_selling | alpha_asc | alpha_desc | price_asc | price_desc | created_desc | created_asc */
  sort_order?: string | null
  tags?: string[] | null
  create_date?: string | null
  update_date?: string | null
  products?: CollectionProductItem[] | null
}

export interface CollectionListFilter {
  page?: number
  limit?: number
  keyword?: string
  productId?: string
  status?: boolean
  tags?: string
  fields?: string
  sortBy?: string
}

export interface CollectionListResponse {
  pagination?: { page: number; limit: number; count: number }
  data: ShopCollection[]
}
