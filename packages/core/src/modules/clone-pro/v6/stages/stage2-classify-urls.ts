/**
 * Clone Pro v6 — Stage 2: URL classification
 *
 * Two-phase pipeline:
 * 1. Shopify-pattern shortcut  — zero AI cost; classifies /products/, /collections/, etc.
 * 2. AI fallback (batch 50)    — for unmatched URLs only.
 *
 * Ordering note: blog_post rule (/blogs/x/y) is listed BEFORE collection
 * so a URL like /blogs/x/y never accidentally matches /collections/.
 */

import type { Classification } from '../types.js'

// ---------------------------------------------------------------------------
// Pattern rules (ordered — blog_post BEFORE collection)
// ---------------------------------------------------------------------------

const PATTERN_RULES: { pattern: RegExp; classification: Classification }[] = [
  { pattern: /\/products\/[^/?#]+/, classification: 'product' },
  { pattern: /\/blogs\/[^/]+\/[^/?#]+/, classification: 'blog_post' },
  { pattern: /\/collections\/[^/?#]+/, classification: 'collection' },
  { pattern: /\/pages\/[^/?#]+/, classification: 'page' },
  { pattern: /\/policies\/[^/?#]+/, classification: 'policy' },
]

// ---------------------------------------------------------------------------
// Pattern shortcut (exported for testing)
// ---------------------------------------------------------------------------

export function classifyUrlsByPattern(
  urls: string[],
): Record<string, Classification | null> {
  const out: Record<string, Classification | null> = {}
  for (const url of urls) {
    let match: Classification | null = null
    for (const rule of PATTERN_RULES) {
      if (rule.pattern.test(url)) {
        match = rule.classification
        break
      }
    }
    out[url] = match
  }
  return out
}

// ---------------------------------------------------------------------------
// Full pipeline with AI fallback
// ---------------------------------------------------------------------------

export interface ClassifyUrlsInput {
  urls: string[]
  callAI: (urls: string[]) => Promise<Record<string, Classification>>
}

const BATCH_SIZE = 50

export async function classifyUrls(
  input: ClassifyUrlsInput,
): Promise<Record<string, Classification | null>> {
  const byPattern = classifyUrlsByPattern(input.urls)
  const unmatched = input.urls.filter((u) => byPattern[u] === null)

  if (unmatched.length === 0) return byPattern

  const out = { ...byPattern }
  for (let i = 0; i < unmatched.length; i += BATCH_SIZE) {
    const batch = unmatched.slice(i, i + BATCH_SIZE)
    const aiResult = await input.callAI(batch)
    for (const url of batch) {
      out[url] = aiResult[url] ?? 'other'
    }
  }
  return out
}
