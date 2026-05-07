/**
 * Gbox Platform — Product API Routes
 *
 * Shopify-compatible REST endpoints for products and variants.
 * Each handler takes (request, db, shopId) and returns a Response.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import * as ProductService from '@gbox/core/modules/products/service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(message: string, status: number): Response {
  return json({ errors: [message] }, status)
}

function parsePagination(url: URL) {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 250)
  const page = Math.max(Number(url.searchParams.get('page') ?? 1), 1)
  return { limit, offset: (page - 1) * limit }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/products.json
// ---------------------------------------------------------------------------

export async function listProducts(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const pagination = parsePagination(url)

    const filters: ProductService.ProductFilters = {}
    const status = url.searchParams.get('status')
    if (status) filters.status = status
    const vendor = url.searchParams.get('vendor')
    if (vendor) filters.vendor = vendor
    const productType = url.searchParams.get('product_type')
    if (productType) filters.product_type = productType
    const ids = url.searchParams.get('ids')
    if (ids) filters.ids = ids.split(',')
    const collectionId = url.searchParams.get('collection_id')
    if (collectionId) filters.collection_id = collectionId

    const result = await ProductService.listProducts(db, shopId, filters, pagination)

    return json({ products: result.products })
  } catch (err) {
    return errorResponse('Failed to list products', 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/products/:id.json
// ---------------------------------------------------------------------------

export async function getProduct(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  productId: string,
): Promise<Response> {
  try {
    const product = await ProductService.getProduct(db, shopId, productId)
    if (!product) {
      return errorResponse('Product not found', 404)
    }
    return json({ product })
  } catch (err) {
    return errorResponse('Failed to get product', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/products.json
// ---------------------------------------------------------------------------

export async function createProduct(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { product: ProductService.CreateProductInput }
    if (!body.product) {
      return errorResponse('Missing "product" in request body', 422)
    }

    const data = body.product
    if (!data.title) {
      return errorResponse('Title is required', 422)
    }

    // Auto-generate slug from title if not provided
    if (!data.slug) {
      data.slug = data.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    }

    const product = await ProductService.createProduct(db, shopId, data)
    return json({ product }, 201)
  } catch (err) {
    return errorResponse('Failed to create product', 500)
  }
}

// ---------------------------------------------------------------------------
// PUT /api/2026-04/products/:id.json
// ---------------------------------------------------------------------------

export async function updateProduct(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  productId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { product: ProductService.UpdateProductInput }
    if (!body.product) {
      return errorResponse('Missing "product" in request body', 422)
    }

    const product = await ProductService.updateProduct(db, shopId, productId, body.product)
    return json({ product })
  } catch (err) {
    return errorResponse('Failed to update product', 500)
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/2026-04/products/:id.json
// ---------------------------------------------------------------------------

export async function deleteProduct(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  productId: string,
): Promise<Response> {
  try {
    await ProductService.deleteProduct(db, shopId, productId)
    return new Response(null, { status: 200 })
  } catch (err) {
    return errorResponse('Failed to delete product', 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/products/:id/variants.json
// ---------------------------------------------------------------------------

export async function listVariants(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  productId: string,
): Promise<Response> {
  try {
    const product = await ProductService.getProduct(db, shopId, productId)
    if (!product) {
      return errorResponse('Product not found', 404)
    }
    return json({ variants: product.variants })
  } catch (err) {
    return errorResponse('Failed to list variants', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/products/:id/variants.json
// ---------------------------------------------------------------------------

export async function createVariant(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  productId: string,
): Promise<Response> {
  try {
    // Verify the product belongs to the shop
    const product = await ProductService.getProduct(db, shopId, productId)
    if (!product) {
      return errorResponse('Product not found', 404)
    }

    const body = (await request.json()) as { variant: ProductService.CreateVariantInput }
    if (!body.variant) {
      return errorResponse('Missing "variant" in request body', 422)
    }

    const variant = await ProductService.createVariant(db, productId, body.variant)
    return json({ variant }, 201)
  } catch (err) {
    return errorResponse('Failed to create variant', 500)
  }
}
