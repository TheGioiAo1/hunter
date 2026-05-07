/**
 * Clone Pro — Page Persistence
 *
 * Persists scraped pages into the Gbox database.
 * Uses upsert by (shop_id, slug) to avoid duplicates on re-clone.
 * Leverages the existing content/service.ts createPage().
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { createPage } from '../../content/service.js'
import type { ScrapedPage } from '../scrapers/page-scraper.js'
import { sanitizeClonedHtml } from '../sanitize.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistPagesResult {
  readonly inserted: number
  readonly updated: number
  readonly skipped: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist scraped pages into the database.
 * Upserts by slug — existing pages with same slug are updated,
 * new slugs are inserted.
 *
 * @param db - Kysely database instance
 * @param shopId - Target shop UUID
 * @param pages - Array of ScrapedPage from the page scraper
 * @returns Count of inserted, updated, and skipped pages
 */
export async function persistClonePages(
  db: Kysely<Database>,
  shopId: string,
  pages: ScrapedPage[],
  jobId: string | null = null,
): Promise<PersistPagesResult> {
  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const page of pages) {
    try {
      // Check if page with same slug exists
      const existing = await db
        .selectFrom('pages')
        .select('id')
        .where('shop_id', '=', shopId)
        .where('slug', '=', page.slug)
        .executeTakeFirst()

      if (existing) {
        // Update existing page — re-stamp clone_job_id if caller has one
        // (keeps the tab mapping accurate when a re-clone hits the same slug).
        // Phase 7.4 — body_html is sanitized before DB write to strip
        // <script>, <iframe>, event handlers, javascript:/data: URLs.
        const set: Record<string, unknown> = {
          title: page.title,
          body_html: sanitizeClonedHtml(page.body_html ?? ''),
          author: page.author,
          updated_at: new Date().toISOString(),
        }
        if (jobId) set.clone_job_id = jobId
        await db
          .updateTable('pages')
          .set(set as any)
          .where('id', '=', existing.id)
          .execute()
        updated++
      } else {
        // Insert new page — Phase 7.4 sanitizes body_html before write.
        const shouldPublish = isAutoPublishPage(page.page_type)
        const created = await createPage(db, shopId, {
          title: page.title,
          slug: page.slug,
          body_html: page.body_html
            ? sanitizeClonedHtml(page.body_html)
            : null,
          author: page.author || null,
          published: shouldPublish,
        })
        // createPage() doesn't know about clone_job_id (it's shared with
        // the manual-creation flow), so we stamp in a follow-up UPDATE.
        if (jobId && created?.id) {
          await db
            .updateTable('pages')
            .set({ clone_job_id: jobId } as any)
            .where('id', '=', created.id)
            .execute()
        }
        inserted++
      }
    } catch (err) {
      console.warn(`[persist-pages] Failed to persist page "${page.slug}":`, (err as Error).message)
      skipped++
    }
  }

  return { inserted, updated, skipped }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Standard page types are auto-published (about, contact, policies).
 * Custom/unknown pages are saved as drafts.
 */
function isAutoPublishPage(pageType: string): boolean {
  return [
    'about',
    'contact',
    'policy',
    'terms',
    'shipping',
    'refund',
    'faq',
  ].includes(pageType)
}
