/**
 * Clone Pro v5 — shared DTOs
 * All scrapers return these shapes; persisters accept them.
 */

export type Platform = 'shopify' | 'woocommerce' | 'generic' | 'unknown'

export interface ScrapedProduct {
  readonly source_id: string            // shopify numeric id or URL handle
  readonly handle: string
  readonly title: string
  readonly body_html: string
  readonly vendor: string | null
  readonly product_type: string | null
  readonly tags: readonly string[]
  readonly images: readonly ScrapedImage[]
  readonly variants: readonly ScrapedVariant[]
  readonly options: readonly ScrapedOption[]
}

export interface ScrapedImage {
  readonly src: string                   // external URL (asset rehost = PR3)
  readonly alt: string | null
  readonly position: number
}

export interface ScrapedVariant {
  readonly source_id: string
  readonly title: string
  readonly price: string                 // decimal string preserved from source
  readonly compare_at_price: string | null
  readonly sku: string | null
  readonly inventory_quantity: number | null
  readonly option_values: readonly string[]  // aligned with options[].name order
  readonly weight: number | null
  readonly weight_unit: 'g' | 'kg' | 'lb' | 'oz' | null
}

export interface ScrapedOption {
  readonly name: string                  // e.g., "Size"
  readonly position: number
  readonly values: readonly string[]     // ["S","M","L"]
}

export interface ScrapedCollection {
  readonly source_id: string
  readonly handle: string
  readonly title: string
  readonly body_html: string
  readonly image: ScrapedImage | null
  readonly product_handles: readonly string[]  // handles, not ids
}

export interface ScrapedPage {
  readonly url: string                   // canonical source URL
  readonly slug: string                  // derived from URL path
  readonly title: string
  readonly body_html: string
}

export interface MenuNode {
  readonly label: string
  readonly url: string                   // source URL — resolved later by persister
  readonly children: readonly MenuNode[]
}

export interface MenuTree {
  readonly handle: string                // 'main-menu' | 'footer' etc.
  readonly nodes: readonly MenuNode[]
}

export interface ThemeTokens {
  readonly colors: {
    readonly primary: string | null
    readonly secondary: string | null
    readonly background: string | null
    readonly text: string | null
  }
  readonly typography: {
    readonly heading_family: string | null
    readonly body_family: string | null
    readonly base_size_px: number | null
  }
  readonly spacing: {
    readonly base_px: number | null
  }
  readonly radius_px: number | null
  readonly raw_css_vars: Record<string, string>   // everything we found, keyed
}

export interface GradeResult {
  readonly score: number                  // 0..100
  readonly letter: 'A' | 'B' | 'C' | 'D' | 'F'
  readonly breakdown: {
    readonly route_check_pct: number
    readonly product_completeness_pct: number
    readonly css_token_pct: number
    readonly page_body_pct: number
    readonly menu_resolution_pct: number
  }
  readonly warnings: readonly string[]    // seller-visible ("Some collection pages missing")
}

export interface PipelineContext {
  readonly jobId: string
  readonly shopId: string
  readonly sourceUrl: string
  readonly sourceHost: string              // derived: new URL(sourceUrl).hostname
  readonly scope: {
    readonly products: boolean
    readonly collections: boolean
    readonly pages: boolean
    readonly menu: boolean
    readonly theme: boolean
  }
}
