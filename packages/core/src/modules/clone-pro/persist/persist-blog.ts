/**
 * Clone Pro — Blog Post Persistence
 *
 * Persists scraped blog posts into the Gbox database.
 * Uses the existing content/service.ts createBlogPost().
 * Deduplicates by slug.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { createBlogPost } from '../../content/service.js'
import type { ScrapedBlogPost } from '../scrapers/blog-scraper.js'
import { sanitizeClonedHtml } from '../sanitize.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistBlogResult {
  readonly inserted: number
  readonly skipped: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist scraped blog posts into the database.
 * Skips posts with duplicate slugs.
 *
 * @param db - Kysely database instance
 * @param shopId - Target shop UUID
 * @param posts - Array of ScrapedBlogPost from the blog scraper
 * @returns Count of inserted and skipped posts
 */
export async function persistCloneBlogPosts(
  db: Kysely<Database>,
  shopId: string,
  posts: ScrapedBlogPost[],
  jobId: string | null = null,
): Promise<PersistBlogResult> {
  let inserted = 0
  let skipped = 0

  for (const post of posts) {
    try {
      // Check if blog post with same slug exists
      const existing = await db
        .selectFrom('blog_posts')
        .select('id')
        .where('shop_id', '=', shopId)
        .where('slug', '=', post.slug)
        .executeTakeFirst()

      if (existing) {
        skipped++
        continue
      }

      // Phase 7.4 — sanitize body_html + excerpt before insert.
      // Excerpts sometimes contain minimal HTML from scrapers
      // (links, <em>, etc.); we run them through the same allowlist
      // so an attacker planting <script> in a blog summary can't
      // round-trip into our storefront.
      const created = await createBlogPost(db, shopId, {
        title: post.title,
        slug: post.slug,
        body_html: post.body_html ? sanitizeClonedHtml(post.body_html) : null,
        excerpt: post.excerpt ? sanitizeClonedHtml(post.excerpt) : null,
        author: post.author || null,
        tags: post.tags.length > 0 ? post.tags : null,
        image_url: post.image_url || null,
        published: true,
        published_at: post.published_at || new Date().toISOString(),
      })
      // Stamp clone_job_id so this post shows up under the site tab in
      // the Blog admin. Done in a follow-up UPDATE because createBlogPost
      // is shared with the manual-creation flow.
      if (jobId && created?.id) {
        await db
          .updateTable('blog_posts')
          .set({ clone_job_id: jobId } as any)
          .where('id', '=', created.id)
          .execute()
      }
      inserted++
    } catch (err) {
      console.warn(`[persist-blog] Failed to persist post "${post.slug}":`, (err as Error).message)
      skipped++
    }
  }

  return { inserted, skipped }
}
