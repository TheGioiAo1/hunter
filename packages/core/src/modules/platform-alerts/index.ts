/**
 * Gbox Platform — @gbox/core/modules/platform-alerts public surface
 *
 * Phase 14 PR6. Routes the 9 god-admin-audience email templates
 * to internal @gbox.co mailboxes with per-alert dedup. External
 * callers should import from here so we can refactor internals
 * without breaking emitter wiring sites.
 *
 * Layers:
 *   - `types`      — AlertType enum + env kill-switch helper
 *   - `recipients` — platform_alert_recipients DB access
 *   - `send`       — sendPlatformAlert() orchestrator (dedup + transport)
 *   - `emitters`   — 9 typed helpers, one per alert_type
 *
 * IRON RULE 5: Every function here hardcodes `shopId: null` in its
 * downstream sendTemplatedEmail() call — that's what keeps god_admin
 * templates from ever leaking to a seller surface. Do NOT bypass
 * `sendPlatformAlert()` by constructing direct calls; the dedup +
 * recipient-lookup contract only holds through this entry.
 */

export * from './types.js'
export * from './recipients.js'
export * from './send.js'
export * from './emitters.js'
