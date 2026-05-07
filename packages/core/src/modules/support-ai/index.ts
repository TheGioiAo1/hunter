/**
 * Gbox Platform — support-ai module barrel (Phase 12.5 PR4).
 *
 * Public surface for the supporter portal, store-admin widget, and
 * god-admin settings page. Callers import from here instead of
 * individual files so internal reorganisation doesn't break
 * consumers.
 *
 * What's here:
 *
 *   pick-model.ts         Sonnet vs Opus decision tree + pricing sheet
 *   redact-pii.ts         Luhn-checked CC, SSN, CMND/CCCD, email stripping
 *   budget.ts             Monthly cap evaluator + UTC month key
 *   null-key-fallback.ts  AINotConfiguredError + predicate + message
 *   usage-tracker.ts      INSERT + rollup for support_ai_usage
 *   client.ts             Anthropic SDK adapter with typed error mapping
 *   suggest-reply.ts      Surface 1: reply composer
 *   summarize-thread.ts   Surface 2: 3-bullet catch-up
 *   auto-categorize.ts    Surface 3: category suggestion on ticket open
 *   sentiment-flag.ts     Surface 4: angry/neutral/happy batch scorer
 *   config-store.ts       Encrypted-at-rest key reader/writer
 */

// --- pick-model ------------------------------------------------------
export {
  ANTHROPIC_SKU,
  HIGH_STAKES_KEYWORDS,
  OPUS_CONFIDENCE_FLOOR,
  SUPPORT_AI_PRICE_SHEET,
  computeCostCents,
  pickModel,
  type ModelPrice,
  type SupportAiModel,
  type TicketSnapshot,
} from './pick-model.ts'

// --- redact-pii ------------------------------------------------------
export {
  REDACTION_SENTINELS,
  isLuhnValid,
  redactPii,
} from './redact-pii.ts'

// --- budget ----------------------------------------------------------
export {
  BUDGET_WARN_THRESHOLD,
  DEFAULT_BUDGET_CAP_CENTS,
  evaluateBudget,
  isWithinBudget,
  monthKey,
  type BudgetState,
  type BudgetStatus,
} from './budget.ts'

// --- null-key-fallback -----------------------------------------------
export {
  AINotConfiguredError,
  assertAISupportConfigured,
  isAISupportConfigured,
  missingReason,
  type AISupportKeys,
} from './null-key-fallback.ts'

// --- usage-tracker ---------------------------------------------------
export {
  getMonthlySpendCents,
  getMonthlySurfaceBreakdown,
  logAIUsage,
  type AISurface,
  type LogAIUsageInput,
} from './usage-tracker.ts'

// --- client ----------------------------------------------------------
export {
  SupportAIError,
  mapAnthropicError,
  sendSupportChat,
  type SendSupportChatInput,
  type SendSupportChatResult,
  type SupportAIErrorKind,
} from './client.ts'

// --- suggest-reply ---------------------------------------------------
export {
  buildSuggestReplySystemPrompt,
  suggestReply,
  type SuggestReplyInput,
  type SuggestReplyResult,
  type ThreadMessage,
} from './suggest-reply.ts'

// --- summarize-thread ------------------------------------------------
export {
  buildSummarizeThreadSystemPrompt,
  parseSummaryBullets,
  summarizeThread,
  type SummarizeThreadInput,
  type SummarizeThreadResult,
} from './summarize-thread.ts'

// --- auto-categorize -------------------------------------------------
export {
  SUPPORT_CATEGORIES,
  autoCategorize,
  buildAutoCategorizeSystemPrompt,
  parseCategorizeResponse,
  type AutoCategorizeInput,
  type AutoCategorizeResult,
  type SupportCategoryId,
} from './auto-categorize.ts'

// --- sentiment-flag --------------------------------------------------
export {
  SENTIMENT_LABELS,
  buildSentimentSystemPrompt,
  parseSentimentResponse,
  scoreSentimentBatch,
  type SentimentBatchInput,
  type SentimentBatchResult,
  type SentimentInput,
  type SentimentLabel,
  type SentimentResult,
} from './sentiment-flag.ts'

// --- config-store ----------------------------------------------------
export {
  AI_BUDGET_SETTING,
  AI_ENABLED_SETTING,
  AI_KEY_SETTING,
  decryptAnthropicKey,
  encryptAnthropicKey,
  isEncryptedKeyBlob,
  readAISupportConfig,
  type EncryptedKeyBlob,
} from './config-store.ts'
