/**
 * Clone Pro — Shopify Collection-Product Linker
 *
 * For Shopify sites, fetches which products belong to which collection
 * using the public /collections/{handle}/products.json API.
 * Returns a mapping that can be used to populate the collection_products
 * junction table.
 */

import { safeFetch } from '../../clone-shopify/safe-fetch.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CollectionProductMap {
  /** Map of collection handle → array of product handles */
  readonly links: ReadonlyMap<string, readonly string[]>
  /** Total number of product-collection links */
  readonly totalLinks: number
  /** Collections that failed to fetch */
  readonly errors: readonly string[]
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Fetch product→collection mappings from a Shopify site.
 *
 * @param baseUrl - Source site URL (e.g. https://bibliobloom.com)
 * @param collectionHandles - Array of collection handles to fetch
 * @param maxProductsPerCollection - Max products to fetch per collection (default 250)
 * @returns Map of collection handle → product handles
 */
export async function scrapeShopifyCollectionProducts(
  baseUrl: string,
  collectionHandles: string[],
  maxProductsPerCollection = 250,
): Promise<CollectionProductMap> {
  const links = new Map<string, string[]>()
  const errors: string[] = []
  let totalLinks = 0
  const normalizedBase = baseUrl.replace(/\/$/, '')

  // Process in batches of 3 to avoid overwhelming the server
  const CONCURRENCY = 3
  for (let i = 0; i < collectionHandles.length; i += CONCURRENCY) {
    const batch = collectionHandles.slice(i, i + CONCURRENCY)

    const results = await Promise.allSettled(
      batch.map(async (handle) => {
        const productHandles: string[] = []
        let page = 1

        while (productHandles.length < maxProductsPerCollection) {
          const url = `${normalizedBase}/collections/${handle}/products.json?limit=250&page=${page}`

          try {
            const resp = await safeFetch(url, { maxBytes: 5 * 1024 * 1024, timeoutMs: 15000 })
            if (resp.statusCode !== 200) break

            const data = JSON.parse(resp.body.toString('utf-8'))
            const products = data.products ?? []

            if (!Array.isArray(products) || products.length === 0) break

            for (const p of products) {
              if (productHandles.length >= maxProductsPerCollection) break
              if (p.handle) productHandles.push(p.handle)
            }

            if (products.length < 250) break // Last page
            page++
          } catch {
            break
          }
        }

        return { handle, productHandles }
      }),
    )

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { handle, productHandles } = result.value
        if (productHandles.length > 0) {
          links.set(handle, productHandles)
          totalLinks += productHandles.length
        }
      } else {
        errors.push(batch[0] || 'unknown')
      }
    }
  }

  return { links, totalLinks, errors }
}
