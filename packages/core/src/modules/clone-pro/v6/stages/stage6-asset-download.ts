import { createHash } from 'node:crypto'
import type { AssetGraphEntry } from '../types.js'

export interface DownloadInput {
  assets: AssetGraphEntry[]
  shopId: string
  jobId: string
  sellerUuid: string
  bucket: string
  cdnHost: string
  fetch?: typeof globalThis.fetch
  s3Put: (input: { bucket: string; key: string; body: Buffer; contentType: string }) => Promise<{ uploaded: boolean; skipped: boolean }>
  db: any
  cap: { check: (shopId: string, addBytes: number) => Promise<{ ok: boolean; reason?: string }> }
  concurrency?: number
  failureThresholdPct?: number
}

export interface DownloadResult {
  downloaded: number
  skipped: number
  failed: number
  bytesUploaded: number
  aborted: boolean
}

export async function downloadAssetsToS3(input: DownloadInput): Promise<DownloadResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch
  const concurrency = input.concurrency ?? 20
  const threshold = input.failureThresholdPct ?? 5
  let downloaded = 0, skipped = 0, failed = 0, bytesUploaded = 0, aborted = false

  let cursor = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (!aborted) {
      const idx = cursor++
      if (idx >= input.assets.length) return
      const asset = input.assets[idx]
      try {
        // Cloudflare + many CDNs 429 the default Node UA; pin browser UA.
        const res = await fetchImpl(asset.sourceUrl, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'accept': '*/*',
          },
        })
        if (!res.ok) { failed++; continue }
        const ab = await res.arrayBuffer()
        const buf = Buffer.from(ab)
        const sha1 = createHash('sha1').update(buf).digest('hex')
        const ext = inferExt(asset.sourceUrl, res.headers.get('content-type') ?? 'application/octet-stream')

        const cap = await input.cap.check(input.shopId, buf.byteLength)
        if (!cap.ok) {
          aborted = true
          throw new Error(`cap_exceeded: ${cap.reason}`)
        }

        const key = `${input.sellerUuid}/${input.shopId}/${sha1}.${ext}`
        const cdnUrl = `https://${input.cdnHost}/${key}`
        const r = await input.s3Put({ bucket: input.bucket, key, body: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' })
        if (r.skipped) skipped++; else { downloaded++; bytesUploaded += buf.byteLength }

        await input.db.insertInto('clone_assets_map')
          .values({
            shop_id: input.shopId, job_id: input.jobId,
            source_url: asset.sourceUrl, sha1, extension: ext,
            content_type: res.headers.get('content-type'),
            byte_size: buf.byteLength,
            s3_key: key, cdn_url: cdnUrl,
            bucket_tag: asset.bucket,
            source: 'clone',
          })
          .onConflict((oc) => oc.columns(['shop_id', 'sha1']).doNothing())
          .execute()
      } catch (err) {
        failed++
        const failPct = (failed / Math.max(1, downloaded + skipped + failed)) * 100
        if (failPct > threshold) aborted = true
      }
    }
  })
  await Promise.all(workers)
  return { downloaded, skipped, failed, bytesUploaded, aborted }
}

function inferExt(url: string, contentType: string): string {
  const fromUrl = (url.match(/\.([a-z0-9]{1,5})(\?|#|$)/i)?.[1] ?? '').toLowerCase()
  if (fromUrl) return fromUrl
  const ctMap: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif',
    'text/css': 'css', 'application/javascript': 'js', 'text/javascript': 'js',
    'font/woff2': 'woff2', 'font/woff': 'woff', 'video/mp4': 'mp4',
  }
  return ctMap[contentType] ?? 'bin'
}
