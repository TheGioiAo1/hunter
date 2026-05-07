/**
 * Re-export DTO types từ generated api-client + custom filter types
 * cho store-admin handlers. Tách module để handler không import sâu
 * vào packages/api-client/src/product/models — đổi 1 chỗ khi codegen
 * regen path.
 */

export type { Category } from '../../../../packages/api-client/src/product/models/Category.ts'
export type { Product } from '../../../../packages/api-client/src/product/models/Product.ts'
export type { ProductVariant } from '../../../../packages/api-client/src/product/models/ProductVariant.ts'
export type { ProductImage } from '../../../../packages/api-client/src/product/models/ProductImage.ts'
export type { ProductOption } from '../../../../packages/api-client/src/product/models/ProductOption.ts'

// ---------------------------------------------------------------------------
// Filter / response shapes (handler-friendly — flatten generated `any`)
// ---------------------------------------------------------------------------

export interface CategoryListFilter {
  keyword?: string
  page?: number
  limit?: number
  status?: boolean
  executeIds?: string
  sortBy?: string
  fields?: string
}

export interface ProductListFilter {
  keyword?: string
  page?: number
  limit?: number
  published?: boolean
  categorySlug?: string
  categoryIds?: string
  tags?: string
  productSku?: string
  productIds?: string
  excludeCategoryIds?: string
  minPrice?: number
  maxPrice?: number
  sortBy?: string
  fields?: string
  isCache?: boolean
}

export interface PaginationMeta {
  page: number
  limit: number
  count: number
}

export interface CategoryListResponse {
  pagination: PaginationMeta
  data: import('../../../../packages/api-client/src/product/models/Category.ts').Category[]
}

export interface ProductListResponse {
  pagination: PaginationMeta
  data: {
    products?: import('../../../../packages/api-client/src/product/models/Product.ts').Product[]
    [key: string]: unknown
  }
}

export type BulkInventoryUpdate = Record<string, number>
