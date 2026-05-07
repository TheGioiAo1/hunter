/**
 * Layer 6 — Deployment safety.
 *
 * Four rules gate tool calls touching customer-facing code:
 *   1. Path classification (classifyPath) → 'safe' | 'admin-only' | 'customer-facing'
 *   2. Circuit breaker: if open, block ALL tier-3 calls regardless of path.
 *   3. Traffic level: customer-facing mutations at 'peak' → block.
 *   4. Maintenance window: customer-facing mutations must happen inside
 *      daily 03:00-04:00 GMT+7 OR weekly Sun 02:00-05:00 GMT+7.
 *
 * Tier 1 and 2 (read-only) pass through regardless — a read of
 * apps/storefront/ during peak is fine.
 */

import type { DeployRisk, GuardLayer, GuardResult, SessionContext, ToolCall } from './types.ts'

const NAME = 'deployment-safety'

const CUSTOMER_FACING_PREFIXES = [
  'apps/storefront/',
  'apps/accounts/',
  'packages/db/src/schema/',
  'packages/core/',
]
const ADMIN_ONLY_PREFIXES = [
  'apps/god-admin/',
  'apps/store-admin/',
  'apps/god-admin-agent/',
]

/**
 * Normalize slashes (Windows test paths) then match against prefix
 * lists. Deny classification never reached here — that's Layer 1's job.
 */
export function classifyPath(relPath: string): DeployRisk {
  const fwd = relPath.replace(/\\/g, '/')
  for (const p of CUSTOMER_FACING_PREFIXES) {
    if (fwd.startsWith(p)) return 'customer-facing'
  }
  for (const p of ADMIN_ONLY_PREFIXES) {
    if (fwd.startsWith(p)) return 'admin-only'
  }
  return 'safe'
}

interface PathInput {
  path?: unknown
}
interface DeployInput {
  target?: unknown
}

function extractRiskForCall(call: ToolCall, repoRoot: string): DeployRisk {
  // deploy.run target=storefront|accounts is customer-facing.
  if (call.name === 'deploy.run') {
    const t = (call.input as DeployInput | null)?.target
    if (t === 'storefront' || t === 'accounts') return 'customer-facing'
    if (t === 'god-admin' || t === 'store-admin') return 'admin-only'
    return 'safe'
  }
  // Path-bearing tools: classify by their path relative to repoRoot.
  const p = (call.input as PathInput | null)?.path
  if (typeof p !== 'string') return 'safe'
  const fwdRepo = repoRoot.replace(/\\/g, '/')
  const fwdPath = p.replace(/\\/g, '/')
  const rel = fwdPath.startsWith(fwdRepo + '/')
    ? fwdPath.slice(fwdRepo.length + 1)
    : fwdPath
  return classifyPath(rel)
}

/**
 * Inside daily 03:00-04:00 window in GMT+7?
 * UTC offset +7 means local hour = (UTC hour + 7) % 24.
 */
export function insideDailyWindow(t: Date): boolean {
  const utcH = t.getUTCHours()
  const utcM = t.getUTCMinutes()
  // Local = UTC + 7. Window: local 03:00..04:00 inclusive-start, exclusive-end
  const localH = (utcH + 7) % 24
  if (localH === 3) return true // covers 03:00..03:59
  return false
}

/**
 * Inside Sunday 02:00-05:00 GMT+7 extended window?
 */
export function insideSundayWindow(t: Date): boolean {
  // Compute "local" day-of-week in GMT+7. Shift the Date by +7h then
  // read UTC day/hour of the shifted value.
  const shifted = new Date(t.getTime() + 7 * 60 * 60 * 1000)
  if (shifted.getUTCDay() !== 0) return false // 0 = Sunday
  const h = shifted.getUTCHours()
  return h >= 2 && h < 5
}

export const deploymentSafety: GuardLayer = {
  name: NAME,
  async check(call: ToolCall, ctx: SessionContext): Promise<GuardResult> {
    // Read-only tools pass through unconditionally.
    if (call.tier === 1 || call.tier === 2) return { allowed: true }

    // Rule 2 — circuit breaker blocks everything mutating.
    if (ctx.circuitBreakerOpen) {
      return {
        allowed: false,
        layer: NAME,
        reason: 'circuit breaker OPEN — all tier-3 tools frozen until storefront health recovers',
      }
    }

    const risk = extractRiskForCall(call, ctx.repoRoot)
    if (risk !== 'customer-facing') {
      return { allowed: true }
    }

    // Rule 3 — traffic level
    if (ctx.trafficLevel === 'peak') {
      return {
        allowed: false,
        layer: NAME,
        reason: 'customer-facing mutation blocked during peak traffic — wait for low-traffic window',
      }
    }

    // Rule 4 — maintenance window
    const inWindow = insideDailyWindow(ctx.currentTime) || insideSundayWindow(ctx.currentTime)
    if (!inWindow) {
      return {
        allowed: false,
        layer: NAME,
        reason:
          'outside maintenance window (daily 03:00-04:00 GMT+7 or Sun 02:00-05:00 GMT+7) — use deploy.schedule instead',
      }
    }

    return { allowed: true }
  },
}
