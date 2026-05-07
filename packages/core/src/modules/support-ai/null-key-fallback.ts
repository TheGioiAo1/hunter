/**
 * Gbox Platform — support-ai null-key fallback (Phase 12.5 PR4).
 *
 * Spec clarification C2 + §10.6.5: the Anthropic API key is NOT
 * provisioned in the MVP repository. Thai pastes it into
 * /god-admin/settings/ai on day 1 of soft launch. Everything between
 * now and that moment MUST degrade gracefully:
 *
 *   - AI buttons render disabled with a "chưa cấu hình" tooltip
 *   - pickModel / suggestReply / etc. throw a well-known typed error
 *     that the UI catches and converts to a friendly toast
 *   - `isAISupportConfigured()` returns false so cron jobs no-op
 *     instead of failing
 *
 * This file owns:
 *   1. `AINotConfiguredError` — the typed sentinel everyone throws
 *   2. `isAISupportConfigured(keys)` — pure predicate on a keyset
 *   3. `missingReason(keys)` — actionable text for god admin
 *
 * The file is deliberately DB-free. Reading the key from
 * `platform_settings` is done in `config-store.ts`; this file just
 * answers "given these values, is AI on?".
 */

/**
 * Sentinel error thrown when an AI surface is invoked but the key
 * isn't set or AI is disabled. Distinguishable from Anthropic
 * network errors so the UI can show different copy.
 *
 * Why a class and not a string?
 *   - `instanceof` narrows type in catch blocks across TS 5.3+.
 *   - Future-proofs additional fields (e.g. `.reason` for
 *     "budget_exceeded" vs "no_key").
 */
export class AINotConfiguredError extends Error {
  readonly reason: 'missing_key' | 'disabled' | 'budget_exceeded'
  constructor(
    reason: 'missing_key' | 'disabled' | 'budget_exceeded',
    message?: string,
  ) {
    super(message ?? defaultMessage(reason))
    this.name = 'AINotConfiguredError'
    this.reason = reason
  }
}

function defaultMessage(reason: string): string {
  switch (reason) {
    case 'missing_key':
      return 'Support AI is not configured (no Anthropic API key).'
    case 'disabled':
      return 'Support AI is disabled.'
    case 'budget_exceeded':
      return 'Support AI monthly budget exceeded.'
    default:
      return 'Support AI is not available.'
  }
}

/**
 * The bundle of flags this module evaluates. Populated from
 * `platform_settings` by config-store.ts — unit tests can build it
 * by hand.
 */
export interface AISupportKeys {
  /** Decrypted Anthropic API key, or empty string when not set. */
  readonly anthropicApiKey: string
  /** Master on/off toggle from god-admin. */
  readonly enabled: boolean
  /** Current month's spend in USD cents (for budget short-circuit). */
  readonly spentCentsThisMonth: number
  /** Configured monthly cap in cents. */
  readonly capCents: number
}

/**
 * Pure predicate: is the AI runtime safe to invoke right now?
 *
 * Returns false if ANY of:
 *   - `anthropicApiKey` is empty
 *   - `enabled` is false
 *   - spend has reached or exceeded the cap
 *
 * Callers that want the specific reason should use `missingReason()`.
 */
export function isAISupportConfigured(keys: AISupportKeys): boolean {
  if (!keys.anthropicApiKey || keys.anthropicApiKey.trim().length === 0) {
    return false
  }
  if (!keys.enabled) return false
  if (keys.capCents <= 0) return false
  if (keys.spentCentsThisMonth >= keys.capCents) return false
  return true
}

/**
 * Actionable English/Vietnamese message explaining WHY AI is off.
 * Shown in the god-admin /settings/ai page and in disabled-button
 * tooltips on the supporter portal. Returns null if AI is on.
 *
 * Iron Rule 5 compliant — never mentions `/god-admin/...` to sellers
 * because seller-facing AI buttons are not wired in Phase 12.5
 * (layer 1 is suggest-only, agent-facing). If that changes in a
 * later phase, replace the "Paste key at..." sentence with a seller
 * safe equivalent before shipping.
 */
export function missingReason(keys: AISupportKeys): string | null {
  if (!keys.anthropicApiKey || keys.anthropicApiKey.trim().length === 0) {
    return 'Chưa cấu hình Anthropic API key. Dán key vào /god-admin/settings/ai.' // iron-rule-5-ok: rendered only in god-admin /settings/ai and supporter-portal tooltips (agent-facing); see file header
  }
  if (!keys.enabled) {
    return 'AI trợ lý đang tắt. Bật lại ở /god-admin/settings/ai.' // iron-rule-5-ok: agent-facing only, see file header
  }
  if (keys.capCents <= 0) {
    return 'Budget $0 — chưa thiết lập hạn mức chi tiêu. Set cap ở /god-admin/settings/ai.' // iron-rule-5-ok: agent-facing only, see file header
  }
  if (keys.spentCentsThisMonth >= keys.capCents) {
    return 'AI budget tháng này đã hết. Reset tự động vào 1st tháng sau.'
  }
  return null
}

/**
 * Throw AINotConfiguredError with the right reason if keys fail.
 * Used at the top of every AI surface entry point so the call site
 * stays a one-liner.
 */
export function assertAISupportConfigured(keys: AISupportKeys): void {
  if (!keys.anthropicApiKey || keys.anthropicApiKey.trim().length === 0) {
    throw new AINotConfiguredError('missing_key')
  }
  if (!keys.enabled) {
    throw new AINotConfiguredError('disabled')
  }
  if (keys.capCents > 0 && keys.spentCentsThisMonth >= keys.capCents) {
    throw new AINotConfiguredError('budget_exceeded')
  }
}
