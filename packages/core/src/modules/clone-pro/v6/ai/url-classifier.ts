/**
 * Clone Pro v6 — AI URL classifier
 *
 * Wraps callAIProvider to classify a batch of URLs via a system prompt.
 * Returns one label per URL in the same order as input.
 *
 * Iron Rule 5: raw AI responses never forwarded to sellers.
 * Invalid labels are silently downgraded to 'other'.
 */

import type { Classification } from '../types.js'
import { callAIProvider, type CallAIInput } from './adapter.js'

const SYSTEM_PROMPT = `You classify URLs from an e-commerce site. For each URL, return ONE of these labels: product, collection, page, blog_post, policy, 404, other. Output one label per line, in the same order as input. NO commentary.`

const VALID_CLASSIFICATIONS = new Set<Classification>([
  'product',
  'collection',
  'page',
  'blog_post',
  'policy',
  '404',
  'other',
])

function isValidClassification(s: string): s is Classification {
  return VALID_CLASSIFICATIONS.has(s as Classification)
}

export async function classifyUrlsViaAI(
  urls: string[],
  providerCfg: Pick<CallAIInput, 'provider' | 'apiKey' | 'model'>,
): Promise<Record<string, Classification>> {
  const userPrompt = urls.join('\n')
  const r = await callAIProvider({
    ...providerCfg,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: urls.length * 8,
  })
  const labels = r.text.split('\n').map((l) => l.trim().toLowerCase())
  const out: Record<string, Classification> = {}
  for (let i = 0; i < urls.length; i++) {
    const lbl = labels[i] as Classification
    out[urls[i]] = isValidClassification(lbl) ? lbl : 'other'
  }
  return out
}
