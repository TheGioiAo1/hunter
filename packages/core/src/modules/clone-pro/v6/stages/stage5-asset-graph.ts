import type { AssetGraphEntry, RenderedPage, Classification } from '../types.js'

export function categorizeByUrl(url: string): AssetGraphEntry['bucket'] {
  const path = (() => { try { return new URL(url).pathname.toLowerCase() } catch { return url.toLowerCase() } })()
  if (path.endsWith('.woff2') || path.endsWith('.woff') || path.endsWith('.ttf') || path.endsWith('.otf')) return 'font'
  if (path.endsWith('.css')) return 'css'
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'js'
  if (path.endsWith('.mp4') || path.endsWith('.webm') || path.endsWith('.ogg')) return 'video'
  if (path.includes('favicon')) return 'favicon'
  if (path.includes('logo')) return 'logo'
  if (path.endsWith('.svg') && (path.includes('icon') || path.match(/\.svg$/))) return 'icon'
  return 'generic-image'
}

/**
 * Hostnames whose assets we host on cdn.gbox.co. Anything else (gtag,
 * googleanalytics, judge.me, fonts.shopifycdn third-party widgets, etc.)
 * is skipped — those vendors typically referer-block, embed user IDs in
 * the URL, or require runtime auth that wouldn't survive the rehost.
 *
 * Set to null to disable filtering (dev / manual smoke).
 */
const KNOWN_CDN_HOSTS = [
  'cdn.shopify.com',
  'cdn.shopifycdn.net',
  'fonts.shopifycdn.com',
  'shopify.com',
  'shopifycdn.com',
]

function isHostingCandidate(assetUrl: string, sourceHost: string | null): boolean {
  let host: string
  try {
    host = new URL(assetUrl).host.toLowerCase()
  } catch {
    return false
  }
  if (sourceHost && (host === sourceHost || host.endsWith('.' + sourceHost))) return true
  for (const known of KNOWN_CDN_HOSTS) {
    if (host === known || host.endsWith('.' + known)) return true
  }
  return false
}

export function buildAssetGraph(input: {
  pages: (RenderedPage & { classification: Classification })[]
  sourceHost?: string  // optional — when provided, filters out 3rd-party assets
}): AssetGraphEntry[] {
  const map = new Map<string, AssetGraphEntry>()
  const sourceHost = input.sourceHost ? input.sourceHost.toLowerCase() : null
  for (const p of input.pages) {
    for (const a of p.assetUrls) {
      // Skip 3rd-party domains (gtag, GA, judge.me, etc.) — they referer-block,
      // embed user IDs, and don't belong in the seller's hosted assets.
      if (sourceHost && !isHostingCandidate(a, sourceHost)) continue

      const existing = map.get(a)
      if (existing) {
        if (!existing.referencedFrom.includes(p.queueId)) {
          existing.referencedFrom.push(p.queueId)
        }
      } else {
        const bucket = categorizeByUrl(a)
        const contentType = inferContentType(bucket)
        map.set(a, { sourceUrl: a, contentType, bucket, referencedFrom: [p.queueId] })
      }
    }
  }
  return Array.from(map.values())
}

function inferContentType(bucket: AssetGraphEntry['bucket']): AssetGraphEntry['contentType'] {
  switch (bucket) {
    case 'font': return 'font'
    case 'css': return 'css'
    case 'js': return 'js'
    case 'video': return 'video'
    default: return 'image'
  }
}
