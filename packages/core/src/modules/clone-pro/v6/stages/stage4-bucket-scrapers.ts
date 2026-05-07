import type { BucketScraper, ProductDTO, CollectionDTO, PageDTO, BlogPostDTO, MenuDTO, ThemeTokensDTO } from '../scrapers/types.js'
import type { RenderedPage, Classification } from '../types.js'

export interface ScraperRegistry {
  products: BucketScraper<ProductDTO>[]
  collections: BucketScraper<CollectionDTO>[]
  pages: BucketScraper<PageDTO>[]
  blog: BucketScraper<BlogPostDTO>[]
  menu: BucketScraper<MenuDTO> | null
  theme: BucketScraper<ThemeTokensDTO> | null
}

export interface DispatchInput {
  pages: (RenderedPage & { classification: Classification })[]
  isShopify: boolean
  callAI?: (sys: string, usr: string) => Promise<string>
  scrapers: ScraperRegistry
}

export interface DispatchResult {
  products: ProductDTO[]
  collections: CollectionDTO[]
  pages: PageDTO[]
  blogPosts: BlogPostDTO[]
  menu: MenuDTO | null
  themeTokens: ThemeTokensDTO | null
  errors: { queueId: string; sourceUrl: string; classification: Classification; error: string }[]
}

export async function dispatchBucketScrapers(input: DispatchInput): Promise<DispatchResult> {
  const out: DispatchResult = {
    products: [], collections: [], pages: [], blogPosts: [],
    menu: null, themeTokens: null, errors: [],
  }
  const ctx = { isShopify: input.isShopify, callAI: input.callAI }

  for (const p of input.pages) {
    try {
      switch (p.classification) {
        case 'product': {
          for (const s of input.scrapers.products) {
            const dto = await s.scrape(p, ctx)
            if (dto) { out.products.push(dto); break }
          }
          break
        }
        case 'collection': {
          for (const s of input.scrapers.collections) {
            const dto = await s.scrape(p, ctx)
            if (dto) { out.collections.push(dto); break }
          }
          break
        }
        case 'page':
        case 'policy': {
          for (const s of input.scrapers.pages) {
            const dto = await s.scrape(p, ctx)
            if (dto) { out.pages.push(dto); break }
          }
          if (new URL(p.sourceUrl).pathname === '/') {
            if (input.scrapers.menu) out.menu = await input.scrapers.menu.scrape(p, ctx)
            if (input.scrapers.theme) out.themeTokens = await input.scrapers.theme.scrape(p, ctx)
          }
          break
        }
        case 'blog_post': {
          for (const s of input.scrapers.blog) {
            const dto = await s.scrape(p, ctx)
            if (dto) { out.blogPosts.push(dto); break }
          }
          break
        }
        case '404':
        case 'other':
          break
      }
    } catch (err) {
      out.errors.push({
        queueId: p.queueId,
        sourceUrl: p.sourceUrl,
        classification: p.classification,
        error: (err as Error).message,
      })
    }
  }
  return out
}
