/**
 * Shared types for the Shopify clone pipeline.
 *
 * Narrow + serialisable. Each crawler module defines its own internal
 * shapes and exports only the stable types here.
 */

export type CloneJobStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface CloneJobOptions {
  readonly sourceUrl: string;
  readonly includeProducts: boolean;
  readonly includeSitemap: boolean;
  readonly includeMedia: boolean;
  readonly maxPages?: number;
}

export interface CloneProductDTO {
  readonly sourceProductId: string;
  readonly handle: string;
  readonly title: string;
  readonly descriptionHtml: string;
  readonly vendor: string | null;
  readonly productType: string | null;
  readonly tags: readonly string[];
  readonly images: readonly CloneImageDTO[];
  readonly variants: readonly CloneVariantDTO[];
}

export interface CloneImageDTO {
  readonly sourceUrl: string;
  readonly altText: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface CloneVariantDTO {
  readonly sourceVariantId: string;
  readonly sku: string | null;
  readonly title: string;
  readonly price: string;
  readonly compareAtPrice: string | null;
  readonly optionValues: readonly string[];
  readonly available: boolean;
}

export interface CloneSitemapNode {
  readonly url: string;
  readonly kind: 'product' | 'collection' | 'page' | 'blog' | 'unknown';
  readonly title: string | null;
  readonly depth: number;
  readonly parentUrl: string | null;
}
