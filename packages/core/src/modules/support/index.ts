/**
 * Gbox Platform — Support module public surface.
 *
 * Re-exports the handful of symbols HTTP routes, cron tasks, and
 * (future) AI wiring should import. Anything not exported here is an
 * internal — update the barrel deliberately when a new surface needs to
 * become public.
 */

// Service layer (mutations).
export {
  ALLOWED_TRANSITIONS,
  addMessage,
  claimTicket,
  createTicket,
  markReadByAgent,
  markReadBySeller,
  setPriority,
  setStatus,
  submitCsat,
  validateAddMessage,
  validateCreateTicket,
} from './service.ts'

// Queries.
export {
  getTicketForSeller,
  getTicketUnreadCountsForSeller,
  listMessagesForAgent,
  listMessagesForSeller,
  listTicketsForAgent,
  listTicketsForSeller,
} from './queries.ts'

// Crypto.
export {
  SUPPORT_MESSAGE_KEY_ENV,
  decryptMessage,
  encryptMessage,
  generateMessageKey,
  parseMessageKey,
  resolveCurrentKey,
  resolveKeyForVersion,
  rotateMessage,
  type EncryptedMessage,
} from './crypto.ts'

// SLA math.
export {
  DEFAULT_BUSINESS_HOURS,
  addBusinessMinutes,
  computeSlaDeadlines,
  dateInTz,
  isSlaBreached,
  type BusinessHours,
} from './sla-calc.ts'

// Rate limit.
export {
  SUPPORT_RATE_LIMITS,
  checkRateLimit,
  computeWindow,
  type RateLimitSpec,
} from './rate-limit.ts'

// Canned-reply rendering.
export {
  renderCannedReply,
  type CannedReplyContext,
  type RenderResult,
} from './canned-reply-render.ts'

// Safe error messages (Iron rule 5).
export {
  LEAK_TERMS_REGEX,
  SAFE_MESSAGE_EN,
  SAFE_MESSAGE_VI,
  assertSellerSafe,
  safeMessage,
  type SafeMessage,
} from './safe-message.ts'

// Types.
export {
  DEFAULT_SLA_CONFIG,
  SupportError,
  type AddMessageInput,
  type AgentMessageView,
  type AgentTicketView,
  type CreateTicketInput,
  type EventMetadataMap,
  type SellerMessageView,
  type SellerTicketView,
  type SlaConfig,
  type SupportAgentPreset,
  type SupportCategory,
  type SupportErrorCode,
  type SupportEventType,
  type SupportPriority,
  type SupportSenderType,
  type SupportStatus,
} from './types.ts'
