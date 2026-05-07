/**
 * Gbox Platform — Popup trigger engine (Stage 4.4)
 *
 * A pure decision function with one job:
 *
 *   evaluatePopup(rule, snapshot) → { show: true } | { show: false, reason }
 *
 * The caller (storefront JS) collects the session snapshot (time
 * on page, scroll depth, exit-intent flag, previous dismissal
 * timestamps) and asks the engine whether a popup should fire
 * right now. The engine never touches the DOM, never schedules
 * anything, and never calls back into the network.
 *
 * Decision order (fail-fast):
 *
 *   1. `active` flag          → `inactive`
 *   2. `shownThisSession`     → `already_shown_session`
 *   3. `cooldownHours`        → `cooldown`
 *   4. `excludePaths` match   → `path_excluded`
 *   5. `includePaths` miss    → `path_not_included`
 *   6. `audienceSegments`     → `audience_mismatch`
 *   7. trigger not met        → `trigger_not_met`
 *   8. otherwise              → `show: true`
 *
 * Every rejection reason is a string literal so TypeScript and
 * the admin UI can exhaustively handle them.
 */

import type { CustomerSegment } from './segments.js'
export type { CustomerSegment }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PopupTrigger =
  | { kind: 'exit_intent' }
  | { kind: 'time_on_page'; seconds: number }
  | { kind: 'scroll_depth'; percent: number }
  | { kind: 'page_view_count'; count: number }

export interface PopupRule {
  id: string
  active: boolean
  trigger: PopupTrigger
  /**
   * Segment allow-list. `null` means "anyone", including anonymous
   * visitors.
   */
  audienceSegments: CustomerSegment[] | null
  /** Glob paths that should NEVER show the popup (e.g. `/checkout`). */
  excludePaths: string[] | null
  /**
   * Glob paths that MUST match for the popup to show. `null` means
   * "every path except the excluded ones".
   */
  includePaths: string[] | null
  /** If true, do not show more than once per browser session. */
  showOncePerSession: boolean
  /**
   * Minimum number of hours between shows across sessions. Paired
   * with a `lastShownAt` snapshot field.
   */
  cooldownHours: number
}

export interface PopupSessionSnapshot {
  path: string
  now: Date
  /** Seconds the visitor has been on the current page. */
  dwellSeconds: number
  /** 0..100. */
  scrollDepthPercent: number
  /** 1-based page view counter for the current session. */
  pageViewCount: number
  /** Set by the exit-intent mouse tracker. */
  exitIntentDetected: boolean
  customerSegment: CustomerSegment | null
  /** Timestamp the popup was last shown, from a cookie. */
  lastShownAt: Date | null
  /** Did we already show this popup in the current session? */
  shownThisSession: boolean
}

export type PopupRejectionReason =
  | 'inactive'
  | 'already_shown_session'
  | 'cooldown'
  | 'path_excluded'
  | 'path_not_included'
  | 'audience_mismatch'
  | 'trigger_not_met'

export type PopupDecision =
  | { show: true }
  | { show: false; reason: PopupRejectionReason }

// ---------------------------------------------------------------------------
// evaluatePopup
// ---------------------------------------------------------------------------

export function evaluatePopup(
  rule: PopupRule,
  snap: PopupSessionSnapshot,
): PopupDecision {
  // 1. Active flag
  if (!rule.active) {
    return { show: false, reason: 'inactive' }
  }

  // 2. Session dedupe
  if (rule.showOncePerSession && snap.shownThisSession) {
    return { show: false, reason: 'already_shown_session' }
  }

  // 3. Cross-session cooldown
  if (rule.cooldownHours > 0 && snap.lastShownAt) {
    const deltaMs = snap.now.getTime() - snap.lastShownAt.getTime()
    const cooldownMs = rule.cooldownHours * 60 * 60 * 1000
    if (deltaMs < cooldownMs) {
      return { show: false, reason: 'cooldown' }
    }
  }

  // 4. Exclude paths
  if (rule.excludePaths && rule.excludePaths.length > 0) {
    if (rule.excludePaths.some((p) => matchGlob(p, snap.path))) {
      return { show: false, reason: 'path_excluded' }
    }
  }

  // 5. Include paths
  if (rule.includePaths && rule.includePaths.length > 0) {
    if (!rule.includePaths.some((p) => matchGlob(p, snap.path))) {
      return { show: false, reason: 'path_not_included' }
    }
  }

  // 6. Audience segment
  if (rule.audienceSegments && rule.audienceSegments.length > 0) {
    if (
      !snap.customerSegment ||
      !rule.audienceSegments.includes(snap.customerSegment)
    ) {
      return { show: false, reason: 'audience_mismatch' }
    }
  }

  // 7. Trigger
  if (!isTriggerMet(rule.trigger, snap)) {
    return { show: false, reason: 'trigger_not_met' }
  }

  return { show: true }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTriggerMet(
  trigger: PopupTrigger,
  snap: PopupSessionSnapshot,
): boolean {
  switch (trigger.kind) {
    case 'exit_intent':
      return snap.exitIntentDetected === true
    case 'time_on_page':
      return snap.dwellSeconds >= trigger.seconds
    case 'scroll_depth':
      return snap.scrollDepthPercent >= trigger.percent
    case 'page_view_count':
      return snap.pageViewCount >= trigger.count
    default: {
      // exhaustiveness guard
      const _n: never = trigger
      return _n
    }
  }
}

/**
 * Minimal glob matcher supporting `*` (any run of non-slash chars)
 * and `**` (any run including slashes). Anything more exotic should
 * be normalised upstream.
 */
function matchGlob(pattern: string, path: string): boolean {
  // Convert glob → regex
  const re =
    '^' +
    pattern
      .split('')
      .map((ch, i, arr) => {
        if (ch === '*') {
          if (arr[i + 1] === '*') return '' // handled by next iter
          if (arr[i - 1] === '*') return '.*'
          return '[^/]*'
        }
        // Escape regex metachars
        if (/[.+?^${}()|[\]\\]/.test(ch)) return '\\' + ch
        return ch
      })
      .join('') +
    '$'
  try {
    return new RegExp(re).test(path)
  } catch {
    return pattern === path
  }
}
