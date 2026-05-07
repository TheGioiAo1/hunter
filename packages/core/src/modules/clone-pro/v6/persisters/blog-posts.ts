/**
 * Clone Pro v6 — blog-posts persister (L17 provenance-aware)
 *
 * Persists BlogPostDTO[] into the `blog_posts` table.
 * Respects L17: rows with source='edited' or source='manual' are NEVER
 * overwritten by a re-clone.
 *
 * Schema deviations from the task plan (schema wins):
 *   - BlogPostTable has NO `blog_id` column and there is NO `blogs` table.
 *     The task plan described auto-creating a parent blog row — but the actual
 *     schema stores blog posts directly under `shop_id`.  The `blogHandle`
 *     from the DTO is stored in `clone_snapshot` only (for provenance).
 *   - blog_posts.slug  (NOT `handle` or `sourceHandle`) — sourceHandle maps
 *     to slug, as confirmed from BlogPostTable in tables.ts.
 *   - blog_posts.body_html  (NOT `body`) — confirmed from BlogPostTable.
 *   - blog_posts.tags is `string[] | null`  — passed as JS array directly,
 *     Kysely/pg will coerce to a PostgreSQL TEXT[] column.
 *   - blog_posts has no `is_policy` or `blog_id` column.
 */

import type { BucketPersister, PersistInput, PersistResult } from './types.js'
import type { BlogPostDTO } from '../scrapers/types.js'
import { withSerializable } from '../../../db/transaction.js'
import { shouldOverwriteOnReclone } from './snapshot.js'

export const blogPostsPersister: BucketPersister<BlogPostDTO> = {
  bucketName: 'blog_posts',

  async persist(input: PersistInput<BlogPostDTO>): Promise<PersistResult> {
    const out: PersistResult = { inserted: 0, updated: 0, skippedEdited: 0, errors: [] }

    await withSerializable(input.db, async (trx) => {
      for (const dto of input.dtos) {
        try {
          const existing = await (trx as any)
            .selectFrom('blog_posts')
            .where('shop_id', '=', input.shopId)
            .where('slug', '=', dto.sourceHandle)
            .select(['id', 'source'])
            .executeTakeFirst() as { id: string; source: string } | undefined

          if (existing) {
            if (!shouldOverwriteOnReclone(existing)) {
              out.skippedEdited++
              continue
            }
            await (trx as any).updateTable('blog_posts')
              .set({
                title: dto.title,
                body_html: dto.bodyHtml,
                author: dto.author,
                published_at: dto.publishedAt ?? null,
                tags: dto.tags.length > 0 ? dto.tags : null,
                source: 'clone',
              })
              .where('id', '=', existing.id)
              .execute()
            out.updated++
          } else {
            const snapshotJson = JSON.stringify({
              blog_handle: dto.blogHandle,
              title: dto.title,
              body_html: dto.bodyHtml,
              author: dto.author,
              published_at: dto.publishedAt,
              tags: dto.tags,
            })
            await (trx as any).insertInto('blog_posts')
              .values({
                shop_id: input.shopId,
                slug: dto.sourceHandle,
                title: dto.title,
                body_html: dto.bodyHtml,
                author: dto.author,
                published_at: dto.publishedAt ?? null,
                tags: dto.tags.length > 0 ? dto.tags : null,
                published: false,
                clone_job_id: input.jobId,
                source: 'clone',
                clone_snapshot: snapshotJson,
              })
              .execute()
            out.inserted++
          }
        } catch (err) {
          out.errors.push({ sourceHandle: dto.sourceHandle, reason: (err as Error).message })
        }
      }
    })

    return out
  },
}
