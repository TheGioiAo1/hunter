/**
 * Clone Pro v6 — generic-media persister (no-op pass-through)
 *
 * Stage 6 (asset-download) already wrote all media rows into `clone_assets_map`
 * with the correct bucket_tag values. This persister is a pass-through that
 * counts existing rows for the bucket summary — no additional writes needed.
 *
 * Bucket tags counted: hero, logo, favicon, icon, video, generic-image
 *
 * Returns inserted = count of existing clone_assets_map rows for this job
 * matching the generic-media bucket tags.
 */

import type { BucketPersister, PersistInput, PersistResult } from './types.js'

export interface GenericMediaDTO {
  sourceUrl: string
  bucketTag: 'hero' | 'logo' | 'favicon' | 'icon' | 'video' | 'generic-image'
}

const GENERIC_MEDIA_BUCKET_TAGS = ['hero', 'logo', 'favicon', 'icon', 'video', 'generic-image'] as const

export const genericMediaPersister: BucketPersister<GenericMediaDTO> = {
  bucketName: 'generic_media',

  async persist(input: PersistInput<GenericMediaDTO>): Promise<PersistResult> {
    const r = await (input.db as any)
      .selectFrom('clone_assets_map')
      .where('shop_id', '=', input.shopId)
      .where('job_id', '=', input.jobId)
      .where('bucket_tag', 'in', [...GENERIC_MEDIA_BUCKET_TAGS])
      .select(({ fn }: any) => [fn.count('id').as('n')])
      .executeTakeFirst() as { n: string | number } | undefined

    return {
      inserted: Number(r?.n ?? 0),
      updated: 0,
      skippedEdited: 0,
      errors: [],
    }
  },
}
