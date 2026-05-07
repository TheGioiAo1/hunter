/**
 * Gbox Platform — Product Service
 *
 * Shopify-equivalent product management: products, variants, images,
 * options, and inventory.
 */

import { ProductApi } from '@gbox/api-client';
// Note: emitIfEnabled might still need a DB if it's not yet refactored.
// For now, I'll mock it or pass null.
import { emitIfEnabled } from '../automations/feature-flag.js';

type Product = ProductApi.Product;

// ---------------------------------------------------------------------------
// Types (Kept for external compatibility)
// ---------------------------------------------------------------------------

export interface CreateProductInput {
  title: string
  slug: string
  body_html?: string | null
  vendor?: string | null
  product_type?: string | null
  status?: string
  tags?: string[] | null
  template_suffix?: string | null
  published_at?: string | null
  variants?: CreateVariantInput[]
  options?: CreateOptionInput[]
  images?: CreateImageInput[]
}

export interface UpdateProductInput {
  title?: string
  slug?: string
  body_html?: string | null
  vendor?: string | null
  product_type?: string | null
  status?: string
  tags?: string[] | null
  template_suffix?: string | null
  published_at?: string | null
}

export interface CreateVariantInput {
  title: string
  price?: string
  compare_at_price?: string | null
  cost?: string | null
  sku?: string | null
  barcode?: string | null
  inventory_quantity?: number
  weight?: string | null
  weight_unit?: string
  option1?: string | null
  option2?: string | null
  option3?: string | null
  position?: number
  image_url?: string | null
  requires_shipping?: boolean
  taxable?: boolean
}

export interface UpdateVariantInput {
  title?: string
  price?: string
  compare_at_price?: string | null
  cost?: string | null
  sku?: string | null
  barcode?: string | null
  weight?: string | null
  weight_unit?: string
  option1?: string | null
  option2?: string | null
  option3?: string | null
  position?: number
  image_url?: string | null
  requires_shipping?: boolean
  taxable?: boolean
}

export interface CreateOptionInput {
  name: string
  position?: number
  values: string[]
}

export interface CreateImageInput {
  src: string
  alt?: string | null
  position?: number
  width?: number | null
  height?: number | null
}

export interface ProductFilters {
  status?: string
  vendor?: string
  product_type?: string
  search?: string
  collection_id?: string
  ids?: string[]
}

export interface Pagination {
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a product with optional inline variants, options, and images.
 */
export async function createProduct(
  _db: any,
  shopId: string,
  data: CreateProductInput,
) {
  // Mapping logic: local input -> API model
  const apiProduct: Product = {
    title: data.title,
    // Add other fields...
  };

  return await ProductApi.ProductService.postApi({
    shopId,
    requestBody: apiProduct as any,
  });
}

/**
 * Get a single product with all associated data.
 */
export async function getProduct(
  _db: any,
  shopId: string,
  id: string,
) {
  return await ProductApi.ProductService.getApi1({
    shopId,
    idOrSlug: id,
  });
}

/**
 * Update product fields.
 */
export async function updateProduct(
  _db: any,
  shopId: string,
  id: string,
  data: UpdateProductInput,
) {
  return await ProductApi.ProductService.putApi({
    shopId,
    productId: id,
    requestBody: data as any,
  });
}

/**
 * Delete a product.
 */
export async function deleteProduct(
  _db: any,
  shopId: string,
  id: string,
): Promise<void> {
  await ProductApi.ProductService.deleteApi1({
    shopId,
    productId: id,
  });
}

/**
 * List products with filters and pagination.
 */
export async function listProducts(
  _db: any,
  shopId: string,
  filters: ProductFilters = {},
  pagination: Pagination = {},
) {
  const { limit = 50, offset = 0 } = pagination;
  const page = Math.floor(offset / limit) + 1;

  const response = await ProductApi.ProductService.getApi({
    shopId,
    page,
    limit,
    keyword: filters.search,
    // Map other filters...
  });

  return { 
    products: response.items || response.products || [], 
    total: response.total || 0 
  };
}

/**
 * PHASE 4.3.1 — List products WITH variants + images.
 */
export async function listProductsWithDetails(
  _db: any,
  shopId: string,
  filters: ProductFilters = {},
  pagination: Pagination = {},
): Promise<{
  products: Array<Record<string, unknown>>
  total: number
}> {
  // The new API list might already return details by default or via fields query
  const response = await listProducts(_db, shopId, filters, pagination);
  return response;
}

/**
 * Create a new variant on an existing product.
 */
export async function createVariant(
  _db: any,
  productId: string,
  data: CreateVariantInput,
) {
  // API call to add variant
  // Assuming ProductService.postApiVariants handles this
  return await ProductApi.ProductService.postApiVariants({
    shopId: 'N/A', // Need shopId if API requires it
    requestBody: { id: productId, ...data } as any,
  });
}

/**
 * Update an existing variant.
 */
export async function updateVariant(
  _db: any,
  variantId: string,
  data: UpdateVariantInput,
) {
  // API call to update variant
  // This might be part of ProductService.putApi with specific structure
  return { id: variantId, ...data }; // Placeholder
}

/**
 * Adjust the inventory level for a variant.
 */
export async function updateInventory(
  _db: any,
  variantId: string,
  _locationId: string,
  adjustment: number,
) {
  // Use ProductService.putApiBulkUpdateInventory
  // Note: API takes shopId
  return await ProductApi.ProductService.putApiBulkUpdateInventory({
    shopId: 'N/A', 
    requestBody: { [variantId]: adjustment },
  });
}
