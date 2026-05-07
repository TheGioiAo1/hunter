/**
 * Layer 4 — Rate limit.
 *
 * Four per-session rules from spec §7 L4:
 *   1. Session cap: 100 total tool calls → hard stop.
 *   2. Tier-3 window: max 20 in any 300_000 ms window.
 *   3. Consecutive repo.edit failures: max 2 on the same path.
 *   4. bashInFlight: handled by Layer 3, skipped here.
 *
 * The layer is pure — it never mutates ctx. The sidecar appends to
 * ctx.tier3CallsLast5Min etc. AFTER the chain has returned allowed.
 */

import type { GuardLayer, GuardResult, SessionContext, ToolCall } from './types.ts'

const NAME = 'rate-limit'

const SESSION_CAP = 100
const TIER3_WINDOW_MS = 5 * 60 * 1000
const TIER3_WINDOW_MAX = 20
const CONSECUTIVE_EDIT_LIMIT = 3

interface EditInput {
  path?: unknown
}

export const rateLimit: GuardLayer = {
  name: NAME,
  async check(call: ToolCall, ctx: SessionContext): Promise<GuardResult> {
    // Rule 1 — session cap
    if (ctx.toolCallCount >= SESSION_CAP) {
      return {
        allowed: false,
        layer: NAME,
        reason: `session cap reached (${ctx.toolCallCount}/${SESSION_CAP}) — user must explicitly continue`,
      }
    }

    // Rule 2 — tier-3 window
    if (call.tier === 3) {
      const cutoff = ctx.currentTime.getTime() - TIER3_WINDOW_MS
      const inWindow = ctx.tier3CallsLast5Min.filter((t) => t >= cutoff).length
      if (inWindow >= TIER3_WINDOW_MAX) {
        return {
          allowed: false,
          layer: NAME,
          reason: `tier-3 rate: ${inWindow} calls in last 5 min (limit ${TIER3_WINDOW_MAX})`,
        }
      }
    }

    // Rule 3 — consecutive repo.edit failures on same path
    if (call.name === 'repo.edit') {
      const path = (call.input as EditInput | null)?.path
      if (typeof path === 'string') {
        const failures = ctx.consecutiveEditFailures.get(path) ?? 0
        if (failures >= CONSECUTIVE_EDIT_LIMIT) {
          return {
            allowed: false,
            layer: NAME,
            reason: `${failures} consecutive repo.edit failures on ${path} — retry loop detected`,
          }
        }
      }
    }

    return { allowed: true }
  },
}
