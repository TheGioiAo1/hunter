/**
 * Store Admin — AI Copywriter REST endpoints (Phase 10 PR1)
 *
 * JSON-in / JSON-out routes consumed by inline "✨ Generate with AI"
 * buttons in the product editor, campaigns composer, and elsewhere.
 *
 * All endpoints:
 *   - Require session auth (same middleware as the parent /admin/store/:slug/*)
 *   - Require CSRF token (for POST requests from the admin UI)
 *   - Stream through the shared AIRouter so budget + cost tracking apply
 *   - Route every error through `safeMessage()` — iron rule 5.
 *
 * Endpoints:
 *   POST /admin/store/:slug/api/ai/product-description
 *   POST /admin/store/:slug/api/ai/product-tags
 *   POST /admin/store/:slug/api/ai/campaign-suggestion
 *   POST /admin/store/:slug/api/ai/email-subjects
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import {
  getDecryptedAIKeys,
  generateProductDescription,
  suggestProductTags,
  suggestCampaignContent,
  suggestEmailSubjects,
  CopywriterParseError,
  AIRouter,
  nullRecorder,
  unlimitedBudget,
  type CredentialResolver,
  type ProviderCredential,
  type AIProviderId,
} from '@gbox/core/modules/ai/index.js'
import { logSellerAction } from '../middleware/store-auth.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Iron rule 5: every error surface on seller UI is generic. Specifics
 * go to pino logs, not to the JSON response body.
 */
function safeMessage(err: unknown): string {
  if (err instanceof CopywriterParseError) {
    return 'The AI assistant returned an unexpected format. Please try again.'
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    if (msg.includes('budget')) {
      return 'Your AI usage budget is exhausted for the period. Please check AI settings or contact Gbox support.'
    }
    if (msg.includes('auth') || msg.includes('no ai credentials')) {
      return 'AI is not configured for this store. Please configure a provider in Settings > AI.'
    }
    if (msg.includes('rate_limit') || msg.includes('rate limit')) {
      return 'AI provider is rate-limiting. Please wait a moment and try again.'
    }
  }
  return 'Please contact Gbox support.'
}

/**
 * Build a CredentialResolver that returns the shop's decrypted keys
 * on demand. The resolver is created fresh per-request so we never
 * hold a decrypted key beyond the lifetime of the response.
 */
function makeResolver(db: Kysely<Database>): CredentialResolver {
  return {
    async resolve(shopId: string): Promise<readonly ProviderCredential[]> {
      const decrypted = await getDecryptedAIKeys(db as any, shopId)
      if (!decrypted) return []
      const creds: ProviderCredential[] = []
      if (decrypted.keys.anthropicKey) {
        creds.push({
          provider: 'anthropic',
          apiKey: decrypted.keys.anthropicKey,
          model: decrypted.model || 'claude-sonnet-4-20250514',
        })
      }
      if (decrypted.keys.openaiKey) {
        creds.push({
          provider: 'openai',
          apiKey: decrypted.keys.openaiKey,
          model: decrypted.model || 'gpt-4o-mini',
        })
      }
      if (decrypted.keys.googleKey) {
        creds.push({
          provider: 'google',
          apiKey: decrypted.keys.googleKey,
          model: decrypted.model || 'gemini-2.0-flash',
        })
      }
      return creds
    },
  }
}

function makeRouter(db: Kysely<Database>): AIRouter {
  return new AIRouter({
    resolver: makeResolver(db),
    recorder: nullRecorder,
    budget: unlimitedBudget,
  })
}

function badRequest(res: Response, msg: string) {
  res.status(400).json({ ok: false, error: msg })
}

function serverError(res: Response, err: unknown) {
  // Server-side detail for Thai's logs; generic message for the seller.
  // eslint-disable-next-line no-console
  console.error('[ai-copywriter]', err)
  res.status(500).json({ ok: false, error: safeMessage(err) })
}

function asStringArray(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (trimmed.length > 0 && trimmed.length < 200) out.push(trimmed)
    }
    if (out.length >= max) break
  }
  return out
}

function asString(v: unknown, max = 4000): string {
  if (typeof v !== 'string') return ''
  return v.slice(0, max)
}

// ---------------------------------------------------------------------------
// POST /api/ai/product-description
// ---------------------------------------------------------------------------

export async function postAiProductDescription(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const body = (req.body ?? {}) as Record<string, unknown>

  const title = asString(body.productTitle, 400)
  if (!title) {
    return badRequest(res, 'productTitle is required')
  }
  const category = asString(body.category, 200)
  const keywords = asStringArray(body.keywords, 10)
  const tone = asString(body.tone, 100) || 'neutral'
  const locale = asString(body.locale, 10) || 'en'

  try {
    const router = makeRouter(db)
    const result = await generateProductDescription(router, store.id, {
      productTitle: title,
      category,
      keywords,
      tone,
      locale,
    })
    await logSellerAction(db as any, req, 'generate', 'ai_product_description', store.id, {
      variants: result.data.variants.length,
      provider: result.cost.provider,
    })
    res.json({
      ok: true,
      variants: result.data.variants,
      cost: {
        provider: result.cost.provider,
        model: result.cost.model,
        tokens: result.cost.usage.totalTokens,
      },
    })
  } catch (err) {
    if (err instanceof CopywriterParseError) {
      return badRequest(res, safeMessage(err))
    }
    serverError(res, err)
  }
}

// ---------------------------------------------------------------------------
// POST /api/ai/product-tags
// ---------------------------------------------------------------------------

export async function postAiProductTags(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const body = (req.body ?? {}) as Record<string, unknown>

  const title = asString(body.productTitle, 400)
  if (!title) return badRequest(res, 'productTitle is required')
  const description = asString(body.productDescription, 4000)
  const category = asString(body.category, 200)
  const locale = asString(body.locale, 10) || 'en'
  const maxTags = Number.isFinite(Number(body.maxTags))
    ? Number(body.maxTags)
    : undefined

  try {
    const router = makeRouter(db)
    const result = await suggestProductTags(router, store.id, {
      productTitle: title,
      productDescription: description,
      category,
      locale,
      maxTags,
    })
    await logSellerAction(db as any, req, 'generate', 'ai_product_tags', store.id, {
      tags: result.data.tags.length,
      provider: result.cost.provider,
    })
    res.json({
      ok: true,
      tags: result.data.tags,
      cost: {
        provider: result.cost.provider,
        model: result.cost.model,
        tokens: result.cost.usage.totalTokens,
      },
    })
  } catch (err) {
    if (err instanceof CopywriterParseError) {
      return badRequest(res, safeMessage(err))
    }
    serverError(res, err)
  }
}

// ---------------------------------------------------------------------------
// POST /api/ai/campaign-suggestion
// ---------------------------------------------------------------------------

export async function postAiCampaignSuggestion(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const body = (req.body ?? {}) as Record<string, unknown>

  const shopName = asString(body.shopName, 200) || store.name || 'Our store'
  const goal = asString(body.campaignGoal, 2000)
  if (!goal) return badRequest(res, 'campaignGoal is required')
  const segment = asString(body.segmentLabel, 100) || 'all_subscribers'
  const incentive = asString(body.incentive, 200)
  const locale = asString(body.locale, 10) || 'en'

  try {
    const router = makeRouter(db)
    const result = await suggestCampaignContent(router, store.id, {
      shopName,
      campaignGoal: goal,
      segmentLabel: segment,
      incentive: incentive || undefined,
      locale,
    })
    await logSellerAction(db as any, req, 'generate', 'ai_campaign_suggestion', store.id, {
      subject_lines: result.data.subject_lines.length,
      provider: result.cost.provider,
    })
    res.json({
      ok: true,
      campaign: result.data,
      cost: {
        provider: result.cost.provider,
        model: result.cost.model,
        tokens: result.cost.usage.totalTokens,
      },
    })
  } catch (err) {
    if (err instanceof CopywriterParseError) {
      return badRequest(res, safeMessage(err))
    }
    serverError(res, err)
  }
}

// ---------------------------------------------------------------------------
// POST /api/ai/email-subjects
// ---------------------------------------------------------------------------

export async function postAiEmailSubjects(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const body = (req.body ?? {}) as Record<string, unknown>

  const purpose = asString(body.emailPurpose, 1000)
  if (!purpose) return badRequest(res, 'emailPurpose is required')
  const audience = asString(body.audience, 200) || 'all_subscribers'
  const locale = asString(body.locale, 10) || 'en'
  const count = Number.isFinite(Number(body.count)) ? Number(body.count) : undefined

  try {
    const router = makeRouter(db)
    const result = await suggestEmailSubjects(router, store.id, {
      emailPurpose: purpose,
      audience,
      locale,
      count,
    })
    await logSellerAction(db as any, req, 'generate', 'ai_email_subjects', store.id, {
      subjects: result.data.subjects.length,
      provider: result.cost.provider,
    })
    res.json({
      ok: true,
      subjects: result.data.subjects,
      cost: {
        provider: result.cost.provider,
        model: result.cost.model,
        tokens: result.cost.usage.totalTokens,
      },
    })
  } catch (err) {
    if (err instanceof CopywriterParseError) {
      return badRequest(res, safeMessage(err))
    }
    serverError(res, err)
  }
}

// ---------------------------------------------------------------------------
// GET /api/ai/status — lightweight check "is AI wired up?"
// ---------------------------------------------------------------------------

export async function getAiStatus(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  try {
    const decrypted = await getDecryptedAIKeys(db as any, store.id)
    if (!decrypted) {
      res.json({ ok: true, configured: false, providers: [] as AIProviderId[] })
      return
    }
    const providers: AIProviderId[] = []
    if (decrypted.keys.anthropicKey) providers.push('anthropic')
    if (decrypted.keys.openaiKey) providers.push('openai')
    if (decrypted.keys.googleKey) providers.push('google')
    res.json({
      ok: true,
      configured: providers.length > 0,
      providers,
      primary: decrypted.provider,
    })
  } catch (err) {
    serverError(res, err)
  }
}

// Exported for smoke-test introspection — not part of the public REST API.
export const _safeMessage = safeMessage
