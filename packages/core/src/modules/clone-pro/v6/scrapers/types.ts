import type { RenderedPage, Classification } from '../types.js'

export interface ProductDTO {
  sourceHandle: string
  sourceUrl: string
  title: string
  bodyHtml: string
  vendor: string | null
  productType: string | null
  tags: string[]
  variants: VariantDTO[]
  options: OptionDTO[]
  images: ProductImageDTO[]
  seo: { title: string | null; description: string | null }
}

export interface VariantDTO {
  sourceVariantId: string
  title: string
  price: string
  compareAtPrice: string | null
  sku: string | null
  optionValues: Record<string, string>
  available: boolean
}

export interface OptionDTO {
  name: string
  position: number
  values: string[]
}

export interface ProductImageDTO {
  sourceUrl: string
  alt: string | null
  position: number
}

export interface CollectionDTO {
  sourceHandle: string
  sourceUrl: string
  title: string
  bodyHtml: string
  productHandles: string[]
  seo: { title: string | null; description: string | null }
}

export interface PageDTO {
  sourceHandle: string
  sourceUrl: string
  title: string
  bodyHtml: string
  isPolicy: boolean
  seo: { title: string | null; description: string | null }
}

export interface BlogPostDTO {
  blogHandle: string
  sourceHandle: string
  sourceUrl: string
  title: string
  author: string | null
  bodyHtml: string
  publishedAt: string | null
  tags: string[]
  seo: { title: string | null; description: string | null }
}

export interface MenuDTO {
  sourceHandle: string
  title: string
  items: MenuItemDTO[]
}

export interface MenuItemDTO {
  title: string
  url: string
  position: number
  children: MenuItemDTO[]
}

export interface ThemeTokensDTO {
  colors: Record<string, string>
  fonts: { heading: string; body: string; alt: string | null }
  spacing: Record<string, string>
  radii: Record<string, string>
  shadows: Record<string, string>
  raw: { computedStyles: Record<string, string> }
}

export interface BucketScraper<T> {
  classification: Classification
  scrape(page: RenderedPage, ctx: ScraperContext): Promise<T | null>
}

export interface ScraperContext {
  callAI?: (systemPrompt: string, userPrompt: string) => Promise<string>
  isShopify: boolean
}
