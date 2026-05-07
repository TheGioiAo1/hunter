/**
 * Gbox Platform — Content API Routes
 *
 * Shopify-compatible REST endpoints for CMS pages and blog articles.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

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

// ===========================================================================
// PAGES
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/2026-04/pages.json
// ---------------------------------------------------------------------------

export async function listPages(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const { limit, offset } = parsePagination(url)

    let query = db
      .selectFrom('pages')
      .selectAll()
      .where('shop_id', '=', shopId)

    const published = url.searchParams.get('published')
    if (published === 'true') query = query.where('published', '=', true)
    if (published === 'false') query = query.where('published', '=', false)

    const rows = await query
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute()

    return json({ pages: rows })
  } catch (err) {
    return errorResponse('Failed to list pages', 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/pages/:id.json
// ---------------------------------------------------------------------------

export async function getPage(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  pageId: string,
): Promise<Response> {
  try {
    // Support lookup by ID or slug
    const page = await db
      .selectFrom('pages')
      .selectAll()
      .where('shop_id', '=', shopId)
      .where((eb) =>
        eb.or([eb('id', '=', pageId), eb('slug', '=', pageId)]),
      )
      .executeTakeFirst()

    if (!page) {
      return errorResponse('Page not found', 404)
    }

    return json({ page })
  } catch (err) {
    return errorResponse('Failed to get page', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/pages.json
// ---------------------------------------------------------------------------

interface CreatePageInput {
  title: string
  slug?: string
  body_html?: string | null
  author?: string | null
  template_suffix?: string | null
  published?: boolean
}

export async function createPage(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { page: CreatePageInput }
    if (!body.page) {
      return errorResponse('Missing "page" in request body', 422)
    }

    const data = body.page
    if (!data.title) {
      return errorResponse('Title is required', 422)
    }

    const slug =
      data.slug ??
      data.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')

    const page = await db
      .insertInto('pages')
      .values({
        shop_id: shopId,
        title: data.title,
        slug,
        body_html: data.body_html ?? null,
        author: data.author ?? null,
        template_suffix: data.template_suffix ?? null,
        published: data.published ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return json({ page }, 201)
  } catch (err) {
    return errorResponse('Failed to create page', 500)
  }
}

// ---------------------------------------------------------------------------
// PUT /api/2026-04/pages/:id.json
// ---------------------------------------------------------------------------

interface UpdatePageInput {
  title?: string
  slug?: string
  body_html?: string | null
  author?: string | null
  template_suffix?: string | null
  published?: boolean
}

export async function updatePage(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  pageId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { page: UpdatePageInput }
    if (!body.page) {
      return errorResponse('Missing "page" in request body', 422)
    }

    const page = await db
      .updateTable('pages')
      .set({ ...body.page, updated_at: new Date().toISOString() } as any)
      .where('id', '=', pageId)
      .where('shop_id', '=', shopId)
      .returningAll()
      .executeTakeFirst()

    if (!page) {
      return errorResponse('Page not found', 404)
    }

    return json({ page })
  } catch (err) {
    return errorResponse('Failed to update page', 500)
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/2026-04/pages/:id.json
// ---------------------------------------------------------------------------

export async function deletePage(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  pageId: string,
): Promise<Response> {
  try {
    const result = await db
      .deleteFrom('pages')
      .where('id', '=', pageId)
      .where('shop_id', '=', shopId)
      .executeTakeFirst()

    if (!result.numDeletedRows || result.numDeletedRows === BigInt(0)) {
      return errorResponse('Page not found', 404)
    }

    return new Response(null, { status: 200 })
  } catch (err) {
    return errorResponse('Failed to delete page', 500)
  }
}

// ===========================================================================
// BLOG ARTICLES
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/2026-04/blogs/articles.json
// ---------------------------------------------------------------------------

export async function listArticles(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const { limit, offset } = parsePagination(url)

    let query = db
      .selectFrom('blog_posts')
      .selectAll()
      .where('shop_id', '=', shopId)

    const published = url.searchParams.get('published')
    if (published === 'true') query = query.where('published', '=', true)
    if (published === 'false') query = query.where('published', '=', false)

    const tag = url.searchParams.get('tag')
    if (tag) {
      query = query.where('tags', '&&', [tag])
    }

    const author = url.searchParams.get('author')
    if (author) {
      query = query.where('author', '=', author)
    }

    const [rows, countRow] = await Promise.all([
      query
        .orderBy('published_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute(),
      db
        .selectFrom('blog_posts')
        .select(db.fn.countAll<number>().as('count'))
        .where('shop_id', '=', shopId)
        .where('published', '=', true)
        .executeTakeFirstOrThrow(),
    ])

    return json({ articles: rows, total: Number(countRow.count) })
  } catch (err) {
    return errorResponse('Failed to list articles', 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/blogs/articles/:id.json
// ---------------------------------------------------------------------------

export async function getArticle(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  articleId: string,
): Promise<Response> {
  try {
    const article = await db
      .selectFrom('blog_posts')
      .selectAll()
      .where('shop_id', '=', shopId)
      .where((eb) =>
        eb.or([eb('id', '=', articleId), eb('slug', '=', articleId)]),
      )
      .executeTakeFirst()

    if (!article) {
      return errorResponse('Article not found', 404)
    }

    return json({ article })
  } catch (err) {
    return errorResponse('Failed to get article', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/blogs/articles.json
// ---------------------------------------------------------------------------

interface CreateArticleInput {
  title: string
  slug?: string
  body_html?: string | null
  excerpt?: string | null
  author?: string | null
  tags?: string[] | null
  image_url?: string | null
  published?: boolean
  published_at?: string | null
}

export async function createArticle(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { article: CreateArticleInput }
    if (!body.article) {
      return errorResponse('Missing "article" in request body', 422)
    }

    const data = body.article
    if (!data.title) {
      return errorResponse('Title is required', 422)
    }

    const slug =
      data.slug ??
      data.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')

    const article = await db
      .insertInto('blog_posts')
      .values({
        shop_id: shopId,
        title: data.title,
        slug,
        body_html: data.body_html ?? null,
        excerpt: data.excerpt ?? null,
        author: data.author ?? null,
        tags: data.tags ?? null,
        image_url: data.image_url ?? null,
        published: data.published ?? false,
        published_at: data.published_at ?? (data.published ? new Date().toISOString() : null),
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return json({ article }, 201)
  } catch (err) {
    return errorResponse('Failed to create article', 500)
  }
}
