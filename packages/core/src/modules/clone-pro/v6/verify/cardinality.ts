import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

export interface CardinalityInput {
  db: Kysely<Database>
  shopId: string
  sourceUrlCounts: { products: number; collections: number; pages: number; blogPosts: number }
}

export interface CardinalityResult {
  ok: boolean
  productsActual: number
  productsExpected: number
  productsPct: number
  collectionsActual: number
  collectionsExpected: number
  collectionsPct: number
  pagesActual: number
  pagesExpected: number
  pagesPct: number
  blogPostsActual: number
  blogPostsExpected: number
  blogPostsPct: number
  overallPct: number
}

export async function checkCardinality(input: CardinalityInput): Promise<CardinalityResult> {
  const cnt = async (table: string) => {
    const r = await (input.db as any).selectFrom(table).where('shop_id', '=', input.shopId)
      .select(({ fn }: any) => fn.count('id').as('n')).executeTakeFirst()
    return Number(r?.n ?? 0)
  }
  const productsActual = await cnt('products')
  const collectionsActual = await cnt('collections')
  const pagesActual = await cnt('pages')
  const blogPostsActual = await cnt('blog_posts')

  const pct = (a: number, e: number) => e === 0 ? 100 : +(100 * a / e).toFixed(2)
  const productsPct = pct(productsActual, input.sourceUrlCounts.products)
  const collectionsPct = pct(collectionsActual, input.sourceUrlCounts.collections)
  const pagesPct = pct(pagesActual, input.sourceUrlCounts.pages)
  const blogPostsPct = pct(blogPostsActual, input.sourceUrlCounts.blogPosts)

  const overallPct = +((productsPct + collectionsPct + pagesPct + blogPostsPct) / 4).toFixed(2)

  return {
    ok: overallPct >= 99,
    productsActual, productsExpected: input.sourceUrlCounts.products, productsPct,
    collectionsActual, collectionsExpected: input.sourceUrlCounts.collections, collectionsPct,
    pagesActual, pagesExpected: input.sourceUrlCounts.pages, pagesPct,
    blogPostsActual, blogPostsExpected: input.sourceUrlCounts.blogPosts, blogPostsPct,
    overallPct,
  }
}
