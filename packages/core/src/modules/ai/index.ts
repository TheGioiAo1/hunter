/**
 * Gbox Platform — AI module barrel
 *
 * Public surface of the AI runtime. Callers should import from here,
 * not from individual files — that lets us re-organise internals
 * without breaking consumers.
 *
 * What's here:
 *
 *   prompts.ts           Pure Anthropic-shaped request builders for
 *                        the four Expert subsystems. Unchanged from
 *                        Stage 3G.2 — still the deterministic floor.
 *
 *   config-service.ts    Per-shop `shop_ai_config` CRUD with
 *                        AES-256-GCM key encryption at rest.
 *
 *   types.ts             Vendor-neutral vocabulary: providers,
 *                        messages, stream events, cost records,
 *                        price sheets, errors.
 *
 *   providers/*          Runtime adapters for Anthropic, OpenAI,
 *                        Google, Groq. All speak the same
 *                        `AIProvider` interface.
 *
 *   router.ts            Orchestrator. Wires credential resolution,
 *                        fallback chain, budget gate, and cost
 *                        recorder into a single entrypoint.
 *
 *   xml-stream-parser.ts Incremental parser for XML-tagged streams —
 *                        the protocol we use for multi-section LLM
 *                        output (cheaper + more resilient than JSON).
 *
 *   cost-tracker.ts      In-memory cost store + time-window roll-ups.
 *
 *   budget.ts            Daily/monthly spending caps enforced at the
 *                        router boundary.
 */

// ─── Prompts (Stage 3G.2, unchanged) ────────────────────────────

export {
  AI_MODEL,
  MAX_MERCHANT_INPUT_CHARS,
  buildProductDescriptionPrompt,
  buildSeoMetaPrompt,
  buildThemeClonePrompt,
  buildAnalyticsInsightPrompt,
  buildProductTagsPrompt,
  buildCampaignSuggestionPrompt,
  buildEmailSubjectPrompt,
  truncateForPrompt,
  type AiPromptRequest,
  type PromptMessage,
  type ProductDescriptionPromptInput,
  type SeoMetaPromptInput,
  type ThemeClonePromptInput,
  type AnalyticsMetric,
  type AnalyticsInsightPromptInput,
  type ProductTagsPromptInput,
  type CampaignSuggestionPromptInput,
  type EmailSubjectPromptInput,
} from './prompts.js'

// ─── Copywriter service (Phase 10 PR1) ──────────────────────────

export {
  CopywriterParseError,
  generateProductDescription,
  suggestProductTags,
  suggestCampaignContent,
  suggestEmailSubjects,
  parseProductDescription,
  parseProductTags,
  parseCampaignContent,
  parseEmailSubjects,
  stripCodeFences,
  type CopywriterCost,
  type CopywriterResult,
  type ProductDescriptionOutput,
  type ProductTagsOutput,
  type CampaignContentOutput,
  type EmailSubjectsOutput,
} from './copywriter.js'

// ─── Config service (migration 020) ─────────────────────────────

export {
  getAIConfig,
  upsertAIConfig,
  getDecryptedAIKeys,
  clearAIKey,
  type AIProvider as AIConfigProviderId,
  type AIConfigPublic,
  type UpsertAIConfigInput,
  type DecryptedAIKeys,
} from './config-service.js'

// ─── Runtime types ──────────────────────────────────────────────

export {
  AIError,
  DEFAULT_FALLBACK_CHAIN,
  DEFAULT_MODELS,
  DEFAULT_PRICE_SHEET,
  isDoneEvent,
  isErrorEvent,
  isTextEvent,
  type AIErrorKind,
  type AIProviderId,
  type ChatContentBlock,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ChatRole,
  type CostRecord,
  type FinishReason,
  type PriceSheet,
  type ProviderCapabilities,
  type ProviderCredential,
  type StreamEvent,
  type TokenUsage,
} from './types.js'

// ─── Providers ──────────────────────────────────────────────────

export {
  AnthropicProvider,
  GoogleProvider,
  GroqProvider,
  OpenAIProvider,
  createProvider,
  isKnownProvider,
  type AIProvider as AIProviderRuntime,
} from './providers/index.js'

// ─── Router ─────────────────────────────────────────────────────

export {
  AIRouter,
  chatWithFallback,
  computeCostCents,
  nullRecorder,
  unlimitedBudget,
  type BudgetGate,
  type CostRecorder,
  type CredentialResolver,
  type RouterChatInput,
  type RouterDeps,
  type RouterStreamInput,
} from './router.js'

// ─── XML streaming parser ───────────────────────────────────────

export {
  XmlStreamParser,
  collectTags,
  type XmlEvent,
} from './xml-stream-parser.js'

// ─── Cost tracker ───────────────────────────────────────────────

export {
  InMemoryCostStore,
  isoNow,
  startOfUtcDay,
  startOfUtcMonth,
  type UsageRollup,
} from './cost-tracker.js'

// ─── Budget gate ────────────────────────────────────────────────

export {
  MapBudgetConfig,
  StaticBudgetConfig,
  WindowBudgetGate,
  type BudgetConfigResolver,
  type CostRollupReader,
  type ShopBudgetConfig,
  type WindowBudgetGateDeps,
} from './budget.js'

// ─── Advisor (god-admin AI chat) ────────────────────────────────
// Re-exported so apps/god-admin/src/pages/ai-chat.ts can import
// from the barrel instead of deep-linking into advisor.ts / client.ts
// (which also prevents a TS-rootDirs gotcha when the god-admin app
// is built with its own tsconfig in isolation).

export {
  analyzeContext,
  chatAboutContext,
  type AdvisorContext,
  type AnalyzeResult,
  type ChatResult,
  type ContextType,
} from './advisor.js'

export {
  isAiConfigured,
  sendChat,
  type ChatTurn,
  type SendChatResult,
} from './client.js'
