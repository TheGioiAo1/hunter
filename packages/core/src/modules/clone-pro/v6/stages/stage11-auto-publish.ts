import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { shouldAutoPublish } from '../../runner.js'

export interface Stage11Input {
  db: Kysely<Database>
  jobId: string
  shopId: string
  gradeLetter: 'A' | 'B' | 'C' | 'D' | 'F'
  configOverride?: boolean
}

export interface Stage11Result {
  published: boolean
  reason?: string
}

export async function runStage11(input: Stage11Input): Promise<Stage11Result> {
  if (input.gradeLetter === 'F') {
    return { published: false, reason: 'grade_F' }
  }

  const shop = await input.db
    .selectFrom('shops')
    .where('id', '=', input.shopId)
    .select(['domain'])
    .executeTakeFirst()

  if (!shop?.domain) {
    return { published: false, reason: 'no_domain' }
  }

  const decision = shouldAutoPublish({
    env: process.env,
    configOverride: input.configOverride,
  })

  if (!decision) {
    return { published: false, reason: 'auto_publish_disabled' }
  }

  const now = new Date().toISOString()

  // Flip the job row first
  await input.db
    .updateTable('storefront_clone_jobs')
    .set({ status: 'published' as any, published_at: now } as any)
    .where('id', '=', input.jobId)
    .execute()

  // Flip per-row visibility on cloned content so the storefront can serve it.
  // Only touch rows that v6 wrote (source='clone' / clone_job_id matches),
  // never overwrite seller-edited rows (L17).
  await publishCloneJobRows(input.db, input.shopId, input.jobId, now)

  return { published: true }
}

async function publishCloneJobRows(
  db: Kysely<Database>,
  shopId: string,
  jobId: string,
  publishedAt: string,
): Promise<void> {
  // products: status enum (draft|active|archived); active = visible
  await (db as any)
    .updateTable('products')
    .set({ status: 'active', published_at: publishedAt })
    .where('shop_id', '=', shopId)
    .where('clone_job_id', '=', jobId)
    .where('source', '=', 'clone')
    .execute()

  // collections: published boolean
  await (db as any)
    .updateTable('collections')
    .set({ published: true, published_at: publishedAt })
    .where('shop_id', '=', shopId)
    .where('clone_job_id', '=', jobId)
    .where('source', '=', 'clone')
    .execute()

  // pages: only `published` boolean (no `published_at` column on this table)
  // No `clone_job_id` either, so filter by source.
  await (db as any)
    .updateTable('pages')
    .set({ published: true })
    .where('shop_id', '=', shopId)
    .where('source', '=', 'clone')
    .execute()

  // blog_posts: published boolean
  await (db as any)
    .updateTable('blog_posts')
    .set({ published: true, published_at: publishedAt })
    .where('shop_id', '=', shopId)
    .where('clone_job_id', '=', jobId)
    .where('source', '=', 'clone')
    .execute()
}
