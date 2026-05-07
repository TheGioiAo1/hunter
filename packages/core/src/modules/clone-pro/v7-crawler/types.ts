/**
 * Clone Pro v7 Crawler — public types.
 *
 * Ports the C# Lonspy data shapes (`Helpers/CrawlHelper.cs::Config`,
 * `Models/Lonspy/Row.cs::Row`) to TypeScript. Field semantics kept identical
 * so the 24 ConfigSite/*.json files (battle-tested with production sites)
 * port verbatim.
 *
 * Iron Rule 5: nothing here references god-admin paths or internal feature
 * flags. Errors flow through `safeMessage()` at the orchestrator boundary.
 */

/** Replace rule applied after extracting a value (Lonspy `Replace`). */
export interface Replace {
  from: string
  to: string
}

/**
 * Single field extractor (Lonspy `Element`).
 * `attr=null` → take innerText. `attr="src"` → take attribute value.
 * `replaces` → run all replacements left-to-right after extraction.
 */
export interface Element {
  name: string
  xpath: string
  attr: string | null
  replaces: Replace[] | null
}

/**
 * Item descriptor — XPath of one row + the elements to extract.
 * `images_in_detail` is optional; only used by detail crawler.
 */
export interface Item {
  xpath: string
  elements: Element[]
  images_in_detail?: Element
}

/** Top-level crawl config (Lonspy `Config`). */
export interface Config {
  delay: number
  item: Item
  /** Optional platform tag, set by `loadConfig()` after parse. */
  platform?: string
}

/**
 * Supported auto-detected platforms. `unknown` triggers AI fallback path
 * in Sprint 2; Sprint 1 throws for unknown.
 */
export type Platform =
  | 'shopify-classic'
  | 'shopify-hydrogen'
  | 'woocommerce'
  | 'bigcommerce'
  | 'shopbase'
  | 'unknown'

/**
 * Crawled product row (Lonspy `Row`).
 * Field names match C# parity so the v6 DTO mapper can reuse without rename.
 */
export interface Row {
  Num?: number
  Title: string | null
  TitleNew?: string | null
  ImageUrls: string[]
  Description: string | null
  short_description?: string | null
  seo_description?: string | null
  tags?: string[] | null
  Price: number | null
  OldPrice?: number | null
  Spin?: string[] | null
  Link: string | null
  ImageUrlType?: 'ONLINE' | 'OFFLINE'
}

/** Collection summary harvested by listing crawler. */
export interface CollectionSummary {
  handle: string
  title: string
  product_handles: string[]
}

/** Static page summary. Sprint 2 will populate; Sprint 1 leaves empty. */
export interface PageSummary {
  handle: string
  title: string
  body_html: string
}

/** Final crawl output — single source of truth for downstream stages. */
export interface CrawlResult {
  source_url: string
  platform: string
  config_used: string
  products: Row[]
  collections: CollectionSummary[]
  pages: PageSummary[]
  warnings: string[]
}
