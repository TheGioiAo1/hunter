/**
 * Gbox God Admin — AI chat endpoint
 *
 * POST /god-admin/ai/chat
 *
 * Receives the operator's follow-up question plus the board
 * snapshot the panel was initialised with, and hands it to
 * `chatAboutContext()` from @gbox/core. Returns the model's reply
 * as JSON the client-side panel can append to its conversation.
 *
 * Request body (JSON):
 *   {
 *     _csrf: string,          // token from renderAiPanel(…)
 *     context: AdvisorContext,
 *     history: ChatTurn[],    // rolling chat turns from the client
 *     question: string,
 *   }
 *
 * Response (JSON):
 *   { text: string, usage: { inputTokens, outputTokens } }
 *
 * Errors:
 *   400 — invalid body shape
 *   403 — missing/invalid CSRF
 *   413 — body too large (basic DoS guard)
 *   503 — AI not configured (missing ANTHROPIC_API_KEY or AI_ENABLED=false)
 *   500 — upstream Anthropic error
 *
 * Auth:
 *   Relies on the god-auth middleware already mounted at
 *   `/god-admin/*` — by the time this handler runs we know the
 *   session is a fully verified Default God Admin. No extra check
 *   needed here.
 *
 * Security note — why we trust `context` from the client:
 *   The panel ships the same snapshot the server assembled for
 *   `analyzeContext()`. A malicious operator could edit it in
 *   devtools before POSTing, but a malicious operator IS the god
 *   admin — they already have full DB access. The only real
 *   threat model for this endpoint is accidentally leaking
 *   snapshot data or burning tokens, and we cap both with the
 *   body-size limit below.
 */

import type { Request, Response } from 'express'
import {
  chatAboutContext,
  isAiConfigured,
  type AdvisorContext,
  type ChatTurn,
} from '@gbox/core/modules/ai/index.js'
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'

// ---------------------------------------------------------------------------
// CSRF store — shared singleton
// ---------------------------------------------------------------------------

/**
 * Separate CSRF store instance for the AI panel so issued tokens
 * live in their own namespace (`gbox_csrf_ai` cookie) and can't
 * collide with the login form's CSRF.
 *
 * Issued from detail page handlers via `aiPanelCsrf.issue(res,
 * isProduction)` and verified here on POST.
 */
export const aiPanelCsrf = createCsrfStore({
  cookieName: 'gbox_csrf_ai',
  // 4 hours — matches a long operator investigation session. The
  // panel can sit idle on a detail page while the operator reads
  // the board before asking a question.
  cookieTtlSeconds: 4 * 60 * 60,
})

// ---------------------------------------------------------------------------
// Body guards
// ---------------------------------------------------------------------------

/**
 * Hard cap on question length. The client textarea has maxlength=2000
 * but we can't trust the client, so we re-enforce here.
 */
const MAX_QUESTION_CHARS = 2000

/**
 * Hard cap on history turns passed back from the client. Panel
 * trims to the last 10 anyway.
 */
const MAX_HISTORY_TURNS = 20

/**
 * Hard cap on JSON body bytes before we even try to parse the
 * structure. 64 KB is plenty for a 10-turn chat history plus an
 * 8 KB board snapshot.
 */
const MAX_BODY_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ChatRequestBody {
  context: AdvisorContext
  history: ChatTurn[]
  question: string
}

function validateBody(body: unknown): ChatRequestBody | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Body must be a JSON object' }
  }
  const b = body as Record<string, unknown>

  if (!b.context || typeof b.context !== 'object') {
    return { error: 'context must be an object' }
  }
  const ctx = b.context as Record<string, unknown>
  if (typeof ctx.type !== 'string' || typeof ctx.title !== 'string' || !ctx.snapshot || typeof ctx.snapshot !== 'object') {
    return { error: 'context must have type, title, and snapshot fields' }
  }
  const validTypes = ['order', 'store', 'customer', 'revenue', 'dashboard']
  if (!validTypes.includes(ctx.type as string)) {
    return { error: `context.type must be one of ${validTypes.join(', ')}` }
  }

  if (!Array.isArray(b.history)) {
    return { error: 'history must be an array' }
  }
  if (b.history.length > MAX_HISTORY_TURNS) {
    return { error: `history cannot exceed ${MAX_HISTORY_TURNS} turns` }
  }
  const history: ChatTurn[] = []
  for (const turn of b.history) {
    if (!turn || typeof turn !== 'object') {
      return { error: 'each history turn must be an object' }
    }
    const t = turn as Record<string, unknown>
    if (t.role !== 'user' && t.role !== 'assistant') {
      return { error: 'history turn role must be user or assistant' }
    }
    if (typeof t.content !== 'string') {
      return { error: 'history turn content must be a string' }
    }
    history.push({ role: t.role, content: t.content })
  }

  if (typeof b.question !== 'string') {
    return { error: 'question must be a string' }
  }
  const question = b.question.trim()
  if (question.length === 0) {
    return { error: 'question cannot be empty' }
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return { error: `question cannot exceed ${MAX_QUESTION_CHARS} characters` }
  }

  return {
    context: {
      type: ctx.type as AdvisorContext['type'],
      title: ctx.title as string,
      snapshot: ctx.snapshot as Record<string, unknown>,
    },
    history,
    question,
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function postAiChat(req: Request, res: Response): Promise<void> {
  // Body size guard. Express's urlencoded/json parsers already
  // enforce a 1mb cap in server.ts, but the AI endpoint wants a
  // tighter one.
  const rawLength = Number(req.headers['content-length'] ?? 0)
  if (rawLength > MAX_BODY_BYTES) {
    res.status(413).json({ error: 'Request body too large' })
    return
  }

  // CSRF check
  const csrfOk = await aiPanelCsrf.verify(req)
  if (!csrfOk) {
    res.status(403).json({ error: 'Invalid or missing CSRF token' })
    return
  }

  // AI configuration check — graceful degradation path.
  if (!isAiConfigured()) {
    res.status(503).json({
      error: 'AI advisor is not configured. Set ANTHROPIC_API_KEY and AI_ENABLED=true in the god-admin environment.',
    })
    return
  }

  // Validate body shape
  const parsed = validateBody(req.body)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }

  // Call the advisor. Any upstream failure (network, rate limit,
  // invalid key) bubbles up as a 500 with the error message — the
  // god admin is operator and can read the raw error.
  try {
    const result = await chatAboutContext({
      context: parsed.context,
      history: parsed.history,
      question: parsed.question,
    })
    res.json({
      text: result.text,
      usage: result.usage,
    })
  } catch (err) {
    console.error('[God Admin] AI chat error:', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown AI error',
    })
  }
}
