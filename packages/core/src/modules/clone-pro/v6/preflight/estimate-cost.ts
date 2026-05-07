import type { AIProvider } from './ping-provider.js'

export const COST_PER_URL: Record<AIProvider, Record<string, number>> = {
  anthropic: {
    'claude-haiku-4-5-20251001': 0.0002,
    'claude-sonnet-4-6': 0.0015,
    'claude-opus-4-7': 0.005,
  },
  openai: {
    'gpt-5': 0.0008,
    'gpt-5-vision': 0.0012,
  },
  google: {
    'gemini-2.5-pro': 0.0006,
  },
}

const DEFAULT_FALLBACK_USD_PER_URL = 0.002
const URLS_PER_AI_BATCH = 50

export interface EstimateInput {
  urlCount: number
  provider: AIProvider
  model: string
}

export interface EstimateResult {
  urlCount: number
  aiCallsEstimate: number
  aiCostUsd: number
  advisory: string
  modelKnown: boolean
}

export function estimateCloneCost(input: EstimateInput): EstimateResult {
  const perUrl = COST_PER_URL[input.provider]?.[input.model] ?? DEFAULT_FALLBACK_USD_PER_URL
  const modelKnown = COST_PER_URL[input.provider]?.[input.model] !== undefined
  const aiCallsEstimate = Math.ceil(input.urlCount / URLS_PER_AI_BATCH)
  const aiCostUsd = +(input.urlCount * perUrl).toFixed(4)
  const advisory = `Ensure your provider has at least $5 available for this clone (estimated $${aiCostUsd}).`
  return { urlCount: input.urlCount, aiCallsEstimate, aiCostUsd, advisory, modelKnown }
}
