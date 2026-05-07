/**
 * Shopify product crawler.
 *
 * Shopify publishes a public, stable JSON endpoint on every
 * storefront at `/products.json?page=N&limit=250`. It paginates
 * until an empty `products` array. This module:
 *
 *   1. Hits `/products.json` repeatedly via `safeFetch` until we see
 *      an empty page or hit the `maxProducts` cap (safety net).
 *   2. Normalises each Shopify product into a `CloneProductDTO`
 *      (see types.ts) — stable shape the orchestrator + write-back
 *      layer consume.
 *   3. Never follows arbitrary links — the endpoint is known and
 *      canonical, so this stays SSRF-safe as long as callers pass
 *      in a URL that's already been through safeFetch's guard once.
 *
 * Returns the full product list. For stores with many thousands of
 * products the caller is expected to pass a `maxProducts` limit.
 */
import type { CloneProductDTO, CloneImageDTO, CloneVariantDTO } from './types.js';
import { safeFetch, type SafeFetchOptions } from './safe-fetch.js';

export interface ShopifyCrawlOptions extends SafeFetchOptions {
  readonly maxProducts?: number;
  readonly pageSize?: number;
  /**
   * Optional injection point used by tests: a fetcher that returns
   * raw JSON for a given page. Lets tests avoid spinning up a real
   * HTTP server while still exercising the pagination + parsing code.
   */
  readonly fetchPage?: (
    pageNumber: number,
    pageSize: number,
  ) => Promise<ShopifyProductsPageRaw>;
}

const DEFAULT_PAGE_SIZE = 250;
const DEFAULT_MAX_PRODUCTS = 5000;
const MAX_PAGES_HARD_CAP = 250;

/** Raw shape returned by Shopify's `/products.json` endpoint. */
export interface ShopifyProductsPageRaw {
  readonly products: readonly ShopifyProductRaw[];
}

export interface ShopifyProductRaw {
  readonly id: number;
  readonly title: string;
  readonly handle: string;
  readonly body_html: string | null;
  readonly vendor: string | null;
  readonly product_type: string | null;
  readonly tags: string | string[] | null;
  readonly images?: readonly ShopifyImageRaw[];
  readonly variants?: readonly ShopifyVariantRaw[];
}

export interface ShopifyImageRaw {
  readonly src: string;
  readonly alt?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
}

export interface ShopifyVariantRaw {
  readonly id: number;
  readonly sku: string | null;
  readonly title: string;
  readonly price: string;
  readonly compare_at_price: string | null;
  readonly option1: string | null;
  readonly option2: string | null;
  readonly option3: string | null;
  readonly available: boolean;
}

export class ShopifyCrawlError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.name = 'ShopifyCrawlError';
    this.code = code;
  }
}

/** Normalises a single raw Shopify product → stable DTO. */
export function normaliseProduct(raw: ShopifyProductRaw): CloneProductDTO {
  const tags = Array.isArray(raw.tags)
    ? raw.tags
    : typeof raw.tags === 'string'
      ? raw.tags
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : [];

  const images: readonly CloneImageDTO[] = (raw.images ?? []).map(
    (img): CloneImageDTO => ({
      sourceUrl: img.src,
      altText: img.alt ?? null,
      width: img.width ?? null,
      height: img.height ?? null,
    }),
  );

  const variants: readonly CloneVariantDTO[] = (raw.variants ?? []).map(
    (v): CloneVariantDTO => ({
      sourceVariantId: String(v.id),
      sku: v.sku ?? null,
      title: v.title,
      price: v.price,
      compareAtPrice: v.compare_at_price ?? null,
      optionValues: [v.option1, v.option2, v.option3].filter(
        (x): x is string => typeof x === 'string' && x.length > 0,
      ),
      available: v.available,
    }),
  );

  return {
    sourceProductId: String(raw.id),
    handle: raw.handle,
    title: raw.title,
    descriptionHtml: raw.body_html ?? '',
    vendor: raw.vendor ?? null,
    productType: raw.product_type ?? null,
    tags,
    images,
    variants,
  };
}

function buildPageUrl(baseUrl: string, page: number, pageSize: number): string {
  const u = new URL(baseUrl);
  // Discard any existing path, force /products.json
  u.pathname = '/products.json';
  u.search = `?page=${page}&limit=${pageSize}`;
  return u.toString();
}

async function fetchPageViaHttp(
  baseUrl: string,
  page: number,
  pageSize: number,
  fetchOptions: SafeFetchOptions,
): Promise<ShopifyProductsPageRaw> {
  const url = buildPageUrl(baseUrl, page, pageSize);
  const res = await safeFetch(url, fetchOptions);
  if (res.statusCode !== 200) {
    throw new ShopifyCrawlError(
      'bad_status',
      `GET ${url} returned ${res.statusCode}; expected 200. ` +
        `Is this a Shopify storefront?`,
    );
  }
  const contentType = String(res.headers['content-type'] ?? '');
  if (!contentType.includes('application/json')) {
    throw new ShopifyCrawlError(
      'bad_content_type',
      `GET ${url} returned ${contentType}; expected application/json.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body.toString('utf8'));
  } catch (err) {
    throw new ShopifyCrawlError(
      'bad_json',
      `GET ${url} returned non-JSON body: ${(err as Error).message}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { products?: unknown }).products)
  ) {
    throw new ShopifyCrawlError(
      'bad_shape',
      `GET ${url} did not contain a 'products' array.`,
    );
  }
  return parsed as ShopifyProductsPageRaw;
}

export async function crawlShopifyProducts(
  baseUrl: string,
  options: ShopifyCrawlOptions = {},
): Promise<readonly CloneProductDTO[]> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxProducts = options.maxProducts ?? DEFAULT_MAX_PRODUCTS;

  const fetchPage =
    options.fetchPage ??
    ((page: number, size: number) =>
      fetchPageViaHttp(baseUrl, page, size, options));

  const out: CloneProductDTO[] = [];
  for (let page = 1; page <= MAX_PAGES_HARD_CAP; page += 1) {
    const raw = await fetchPage(page, pageSize);
    if (raw.products.length === 0) break;
    for (const r of raw.products) {
      out.push(normaliseProduct(r));
      if (out.length >= maxProducts) return out;
    }
    if (raw.products.length < pageSize) break;
  }
  return out;
}
