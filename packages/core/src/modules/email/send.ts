/**
 * Gbox Platform — Templated send pipeline (Phase 14 PR1)
 *
 * One function, `sendTemplatedEmail()`, that wires the four new modules
 * together in the order every send needs:
 *
 *   1. `registry.ts`     — look up the template spec (fail closed on miss)
 *   2. DB override       — prefer `email_template_registry` row if present
 *   3. Variable render   — `{{name}}` substitution, HTML-escape by default
 *   4. `preferences.ts`  — canSend() gate, skip with log on opt-out
 *   5. `delivery-log.ts` — queue row → SMTP call → mark sent/failed
 *   6. `transport.ts`    — resolveTransport() picks Gmail/Console/SES
 *
 * The legacy `service.ts` per-feature senders (sendOrderConfirmation,
 * sendWelcome, etc.) still work untouched. New callers SHOULD prefer
 * this function — when we flip all legacy senders over in PR2, the
 * admin UI gets delivery log rows for everything in one go.
 *
 * SIGNATURE
 * ---------
 *   await sendTemplatedEmail(db, {
 *     templateKey: 'password_reset',
 *     to: 'user@example.com',
 *     shopId: null,                 // or a shop uuid
 *     variables: { user_name: 'Thai', reset_url: '…' },
 *   })
 *
 * The call always resolves — we don't throw on SMTP errors. The return
 * value tells the caller what happened so it can surface an admin
 * toast / retry. Throwing would bubble transport errors up through
 * request handlers and that's not what seller code expects.
 *
 * IRON RULE 5 (no god-admin leak)
 * -------------------------------
 *   Templates with `audience='god_admin'` are only allowed when the
 *   `shopId` is null (platform-scoped send). Attempting to send a
 *   platform template from a seller surface returns
 *   `{ ok: false, reason: 'iron_rule_5_blocked' }` with a log entry.
 */

import type { Kysely } from 'kysely'
import type {
  Database,
  EmailDeliveryProvider,
  EmailDeliveryStatus,
} from '@gbox/db/schema/tables.js'

import {
  EMAIL_TEMPLATE_CATALOG,
  getTemplate,
  resolveTemplate,
  type TemplateSpec,
  type ResolvedTemplate,
} from './registry.js'
import {
  canSend,
  buildUnsubscribeUrl,
  buildPreferenceCenterUrl,
  touchLastSent,
  generateUnsubscribeToken,
  hashUnsubscribeToken,
} from './preferences.js'
import {
  beginDelivery,
  markSent,
  markFailed,
  logSkipped,
  beginDeliveryIdempotent,
} from './delivery-log.js'
import { resolveTransport, type Transport } from './transport.js'
import {
  generateTrackingToken,
  buildPixelUrl,
  injectPixel,
  rewriteHtmlLinks,
  isTrackingEnabled,
  isTrackedCategory,
  resolveTrackingBaseUrl,
} from './tracking.js'
import { checkSuppressed } from './suppression.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SendTemplatedEmailInput {
  templateKey: string
  /** RFC-5322 single-recipient address. */
  to: string
  /** null → platform-scoped email (accounts.gbox.co, not tied to a shop). */
  shopId: string | null
  /** Variable bag merged into subject + bodyHtml + bodyText. */
  variables?: Record<string, unknown>
  /** Optional recipient-user link (for audit). */
  recipientUserId?: string | null
  /** Optional recipient-customer link (for audit). */
  recipientCustomerId?: string | null
  /** Optional idempotency key — dedupes retries. */
  idempotencyKey?: string | null
  /** Override the transport picked by `resolveTransport()` (tests only). */
  transport?: Transport
}

export type SendTemplatedEmailResult =
  | { ok: true; deliveryId: number; messageId: string | null; provider: EmailDeliveryProvider }
  | {
      ok: false
      deliveryId: number | null
      reason:
        | 'unknown_template'
        | 'iron_rule_5_blocked'
        | 'skipped_pref'
        | 'skipped_suppressed'
        | 'transport_failed'
        /**
         * Phase 14 PR8 — Cluster B bug 7. `resolveTransport()` (or its
         * underlying `GmailSmtpTransport` ctor) threw BEFORE any actual
         * send attempt — e.g. NODE_ENV=production + no SMTP creds, or
         * `EMAIL_TRANSPORT=gmail` with missing SMTP_HOST / USER / PASS.
         *
         * Prior to PR8 this path bubbled to the outer try/catch and
         * returned `reason='db_write_failed'` which sent ops hunting in
         * Postgres logs for a problem that was really just a missing env
         * var. The new classifier (`classifyTransportResolutionError`)
         * surfaces the transport-config failure explicitly so the admin
         * UI can show "email transport not configured — set SMTP_*" and
         * ops can jump straight to the right fix.
         */
        | 'transport_not_configured'
        | 'db_write_failed'
      error?: string
    }

// ---------------------------------------------------------------------------
// Transport-resolution classifier (Phase 14 PR8 — Cluster B bug 7)
// ---------------------------------------------------------------------------

/** Shape of a transport-resolution failure before it hits the delivery row. */
export interface TransportResolutionFailure {
  reason: 'transport_not_configured'
  error: string
}

/**
 * Map whatever `resolveTransport()` threw into a structured failure. This
 * exists so the classification logic is trivially unit-testable without
 * standing up a DB harness. Non-Error throws (strings / plain objects)
 * are stringified rather than propagating `[object Object]`.
 */
export function classifyTransportResolutionError(
  err: unknown,
): TransportResolutionFailure {
  const error = err instanceof Error ? err.message : String(err)
  return { reason: 'transport_not_configured', error }
}

// ---------------------------------------------------------------------------
// Idempotency prior-row classifier (Phase 14 PR8 — Cluster C bug 8)
// ---------------------------------------------------------------------------

/**
 * Shape of a prior `email_deliveries` row that the idempotency fast-path
 * reads when INSERT is skipped. We intentionally widen this beyond just
 * `id` — pre-PR8 the fast-path only fetched `id` and the caller assumed
 * any existing row meant "already sent", which lied when the prior row
 * was queued / failed / skipped_*.
 */
export interface IdempotentPriorRow {
  id: number
  status: EmailDeliveryStatus
  smtp_message_id: string | null
  provider: EmailDeliveryProvider | null
  failed_reason: string | null
}

/**
 * Map a prior delivery row into the correct `SendTemplatedEmailResult`.
 *
 * This is the guts of the bug 8 fix — before PR8, a second send with a
 * matching idempotency key returned `ok: true` regardless of whether the
 * prior attempt actually reached SMTP. Now we branch on `status`:
 *
 *   sent                → ok:true (genuinely a dup; the email went out)
 *   failed / bounced    → ok:false reason='transport_failed' + prior msg
 *   queued (zombie)     → ok:false reason='transport_failed' + explicit
 *                         "queued state" message so the caller (and the
 *                         janitor added in bug 9) can distinguish
 *   skipped_pref        → ok:false reason='skipped_pref'
 *   skipped_suppressed  → ok:false reason='skipped_suppressed'
 *   skipped_invalid     → ok:false reason='iron_rule_5_blocked'
 *                         (platform_scope_mismatch dominates this bucket;
 *                         other failure_reasons still map here, they just
 *                         lose a little fidelity vs. their original gate)
 *
 * Kept pure (no DB, no I/O) so the logic is unit-testable in isolation.
 */
export function resolveIdempotentPriorRow(
  prior: IdempotentPriorRow,
): SendTemplatedEmailResult {
  switch (prior.status) {
    case 'sent':
      return {
        ok: true,
        deliveryId: prior.id,
        messageId: prior.smtp_message_id,
        // Legacy rows from before the provider column was always set
        // fall back to 'other' so the admin UI has SOMETHING to render.
        provider: prior.provider ?? 'other',
      }
    case 'failed':
      return {
        ok: false,
        deliveryId: prior.id,
        reason: 'transport_failed',
        error: prior.failed_reason ?? 'prior attempt failed',
      }
    case 'queued':
      // Zombie row: the prior process died between `beginDelivery` and
      // `markSent`/`markFailed`. Telling the caller `ok: true` would be
      // a lie (no SMTP call happened). The janitor from bug 9 reaps
      // these; in the meantime surface a distinctive error so a human
      // looking at admin logs can tell "zombie" apart from "real SMTP
      // failure".
      return {
        ok: false,
        deliveryId: prior.id,
        reason: 'transport_failed',
        error:
          'prior attempt left row in queued state (zombie) — did not actually send',
      }
    case 'skipped_pref':
      return {
        ok: false,
        deliveryId: prior.id,
        reason: 'skipped_pref',
      }
    case 'skipped_suppressed':
      return {
        ok: false,
        deliveryId: prior.id,
        reason: 'skipped_suppressed',
      }
    case 'skipped_invalid':
      // The dominant cause for `skipped_invalid` in-code is the Iron
      // Rule 5 platform-scope mismatch (god_admin template routed to a
      // shop scope). Other skipped_invalid causes (unknown template via
      // canSend, future gate reasons) also map here — the caller can
      // inspect `error` for the raw failed_reason if disambiguation is
      // needed.
      return {
        ok: false,
        deliveryId: prior.id,
        reason: 'iron_rule_5_blocked',
        error: prior.failed_reason ?? undefined,
      }
    case 'bounced':
      return {
        ok: false,
        deliveryId: prior.id,
        reason: 'transport_failed',
        error: prior.failed_reason ?? 'prior attempt bounced',
      }
    default: {
      // Exhaustiveness check — if a new status lands in the enum and
      // we forget to extend this switch, TS will complain on build.
      const _exhaustive: never = prior.status
      void _exhaustive
      return {
        ok: false,
        deliveryId: prior.id,
        reason: 'db_write_failed',
        error: `unknown prior status: ${String(prior.status)}`,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Template render
// ---------------------------------------------------------------------------

/**
 * Load the fully-resolved template for a (shopId, key) pair. Delegates
 * to `resolveTemplate()` which handles the 3-layer merge
 * (in-code catalog → email_template_registry defaults → per-shop
 * email_template_overrides). Returns null if the key is unknown OR
 * the resolved template is `active=false` (seller disabled for non-
 * forced-send categories only — the resolver already guards this).
 *
 * PR1.5: this function is now per-shop aware. Pre-PR1.5 it only
 * consulted `email_template_registry.subject_default`.
 */
async function loadTemplate(
  db: Kysely<Database>,
  templateKey: string,
  shopId: string | null,
): Promise<
  | {
      subject: string
      bodyHtml: string
      bodyText: string
      spec: TemplateSpec
      resolved: ResolvedTemplate
    }
  | null
> {
  const spec = getTemplate(templateKey)
  if (!spec) return null

  // `resolveTemplate()` uses a narrow db type — Kysely<Database> is a
  // superset so the cast is safe.
  const resolved = await resolveTemplate(
    db as unknown as Parameters<typeof resolveTemplate>[0],
    shopId,
    templateKey,
  )
  if (!resolved) return null
  if (resolved.active === false) return null

  return {
    subject: resolved.subject,
    bodyHtml: resolved.bodyHtml,
    bodyText: resolved.bodyText,
    spec,
    resolved,
  }
}

/**
 * `{{name}}` substitution. Supports `{{order.id}}` dot-path for nested
 * objects (matches the legacy `service.ts::interpolate`). Unknown keys
 * render as empty string (Shopify convention).
 */
function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_m, path: string) => {
    const keys = path.split('.')
    let value: unknown = data
    for (const k of keys) {
      if (value == null || typeof value !== 'object') return ''
      value = (value as Record<string, unknown>)[k]
    }
    return value == null ? '' : String(value)
  })
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function sendTemplatedEmail(
  db: Kysely<Database>,
  input: SendTemplatedEmailInput,
): Promise<SendTemplatedEmailResult> {
  // Phase 14 PR7 (BUG-E1) — Enforce the no-throw contract the docblock
  // at the top of this file has always promised. The transport layer
  // is already safe (all 3 Transport implementations catch provider
  // errors and return { ok: false, error }), but the DB calls in this
  // function (loadTemplate / canSend / beginDelivery / markSent /
  // markFailed / touchLastSent) CAN throw on connection drops or
  // schema drift, and a throw here bubbles up through request
  // handlers — exactly what the "always resolves" contract prohibits.
  //
  // This outer try/catch is the last line of defense. Any internal
  // throw maps to { ok: false, reason: 'db_write_failed' } with the
  // error message preserved for ops logs. The seller-facing layer
  // already maps 'db_write_failed' → "Please contact Gbox support."
  // so Iron Rule 5 stays intact.
  try {
    return await sendTemplatedEmailInner(db, input)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.error(
      '[email:send] Unexpected throw in sendTemplatedEmail — swallowed to honour no-throw contract:',
      { templateKey: input.templateKey, shopId: input.shopId, error: msg },
    )
    return {
      ok: false,
      deliveryId: null,
      reason: 'db_write_failed',
      error: msg,
    }
  }
}

/**
 * Inner implementation. All existing logic lives here so the outer
 * wrapper stays trivial + readable. Breaking this into its own
 * function (vs. wrapping the whole body in try/catch) keeps the happy
 * path un-indented and mirrors the pattern we use elsewhere
 * (resolveTransport / sendPlatformAlert).
 */
async function sendTemplatedEmailInner(
  db: Kysely<Database>,
  input: SendTemplatedEmailInput,
): Promise<SendTemplatedEmailResult> {
  // ---- Step 1: load template (PR1.5 — now shop-scoped resolve) ----
  const loaded = await loadTemplate(db, input.templateKey, input.shopId)
  if (!loaded) {
    return { ok: false, deliveryId: null, reason: 'unknown_template' }
  }
  const { subject, bodyHtml, bodyText, spec } = loaded

  // ---- Iron Rule 5: platform-owned templates never go to shop scope ----
  if (spec.audience === 'god_admin' && input.shopId !== null) {
    // Log intent even when we refuse — ops needs to see these attempts.
    const skipped = await logSkipped(db, {
      templateKey: spec.key,
      shopId: input.shopId,
      recipientEmail: input.to,
      subject,
      bodyHtml,
      recipientUserId: input.recipientUserId ?? null,
      recipientCustomerId: input.recipientCustomerId ?? null,
      status: 'skipped_invalid',
      reason: 'platform_scope_mismatch',
    }).catch(() => null)
    return {
      ok: false,
      deliveryId: skipped?.id ?? null,
      reason: 'iron_rule_5_blocked',
    }
  }

  // ---- Step 2a: suppression gate (PR4.B) ----
  //
  // Runs BEFORE the preferences gate: a hard bounce / complaint means
  // the address is effectively dead for this shop. Sending anything —
  // even a forced transactional (password_reset, order_confirmation) —
  // just re-bounces into SES and bleeds our sender reputation. Admins
  // can un-block a specific address via /settings/email-suppressions.
  //
  // Per-shop scope: the lookup matches `shop_id = input.shopId` OR
  // `shop_id IS NULL` (platform-wide block). See suppression.ts for
  // the partial-index semantics.
  const suppressionHit = await checkSuppressed(db, {
    shopId: input.shopId,
    email: input.to,
  })

  // ---- Step 2b: canSend() gate ----
  const gate = await canSend(db, {
    templateKey: spec.key,
    shopId: input.shopId,
    recipientEmail: input.to,
  })

  // ---- Variable render (needed for both skipped + sent paths) ----
  // If the template is non-forced, we need an unsubscribe link. We
  // mint a fresh token per email (no persistence in PR1 — PR2 adds a
  // background sweeper to reconcile these). The token is rendered into
  // `unsubscribe_html` / `unsubscribe_text` variables the scaffold
  // template consumes.
  const variables: Record<string, unknown> = { ...(input.variables ?? {}) }

  // Default-fill scaffold-expected vars so templates render cleanly
  // even when the caller passes a minimal var bag.
  if (!('unsubscribe_html' in variables) && !('unsubscribe_text' in variables)) {
    if (spec.category === 'marketing' || spec.category === 'lifecycle' || spec.category === 'reviews') {
      const token = generateUnsubscribeToken()
      // We persist the hash eagerly so the unsubscribe click later
      // can find the row. On double-opt-in flows `preferences.ts::
      // upsertPreference` will have done this already; this block is
      // the simple-path compatible scaffold. Guarded against failure
      // — a preference-insert error must NOT block the send of a
      // non-marketing transactional.
      try {
        await db
          .insertInto('email_preferences')
          .values({
            shop_id: input.shopId,
            customer_id: input.recipientCustomerId ?? null,
            email: input.to.trim(),
            category:
              spec.category === 'reviews'
                ? 'reviews'
                : spec.category === 'lifecycle'
                  ? 'lifecycle'
                  : 'marketing',
            subscribed: true,
            unsubscribe_token_hash: hashUnsubscribeToken(token),
            source: 'api',
          })
          .onConflict((oc) => oc.doNothing())
          .execute()
      } catch {
        // Swallow — unique violations on concurrent inserts are fine;
        // anything else doesn't justify blocking the send.
      }
      const url = buildUnsubscribeUrl(token)
      const prefUrl = buildPreferenceCenterUrl(token)
      // PR1.5 — footer now advertises BOTH: one-click unsubscribe (RFC
      // 8058 fast path) and the preference center (per-category +
      // frequency + quiet-hours granular control). Scaffold templates
      // consume `unsubscribe_html` / `unsubscribe_text`, so we append
      // the preferences link into the same variable set — keeps the
      // change zero-impact on the 95 template scaffolds.
      variables.unsubscribe_html = `<a href="${escapeHtml(url)}">Unsubscribe</a> · <a href="${escapeHtml(prefUrl)}">Manage preferences</a>`
      variables.unsubscribe_text = `Unsubscribe: ${url}\nManage preferences: ${prefUrl}`
      // Also expose the raw URLs as individual variables so custom
      // templates can lay them out however they want.
      variables.unsubscribe_url = url
      variables.preferences_url = prefUrl
    } else {
      variables.unsubscribe_html = ''
      variables.unsubscribe_text = ''
      variables.unsubscribe_url = ''
      variables.preferences_url = ''
    }
  }

  // Fill scaffold-only placeholders with safe defaults so "scaffolded"
  // templates look clean without forcing every caller to pass them.
  if (!('heading' in variables)) variables.heading = interpolate(subject, variables)
  if (!('body_html' in variables)) variables.body_html = ''
  if (!('body_text' in variables)) variables.body_text = ''
  if (!('cta_html' in variables)) variables.cta_html = ''
  if (!('cta_text' in variables)) variables.cta_text = ''
  if (!('shop_name' in variables)) variables.shop_name = ''

  const renderedSubject = interpolate(subject, variables)
  const renderedHtml = interpolate(bodyHtml, variables)
  const renderedText = interpolate(bodyText, variables)

  // ---- Step 3a: suppression short-circuit (PR4.B) ----
  //
  // Takes precedence over the canSend gate below — even forced-send
  // templates are blocked when the recipient is on the suppression list.
  // Logs a `skipped_suppressed` delivery row so the admin's deliveries
  // report still shows intent (and the deliveries dashboard can
  // tally "would-have-sent-but-blocked" volume).
  if (suppressionHit) {
    const skipped = await logSkipped(db, {
      templateKey: spec.key,
      shopId: input.shopId,
      recipientEmail: input.to,
      subject: renderedSubject,
      bodyHtml: renderedHtml,
      recipientUserId: input.recipientUserId ?? null,
      recipientCustomerId: input.recipientCustomerId ?? null,
      status: 'skipped_suppressed',
      // `failed_reason` column — keep internal-detail-free. The
      // suppression row itself carries the raw diagnostic code; this
      // field just records the classification.
      reason: `suppressed:${suppressionHit.reason}`,
    })
    return {
      ok: false,
      deliveryId: skipped.id,
      reason: 'skipped_suppressed',
    }
  }

  // ---- Step 3b: if preference gate blocked, log skipped + return ----
  if (!gate.allowed) {
    // PR1.5: 'frequency_capped' + 'quiet_hours' both map to 'skipped_pref'
    // in the delivery log — ops can disambiguate via the `reason` text
    // field. (A future PR may add dedicated status enum values if the
    // admin UI wants separate counters.)
    const reason =
      gate.reason === 'unsubscribed' ||
      gate.reason === 'frequency_capped' ||
      gate.reason === 'quiet_hours'
        ? 'skipped_pref'
        : gate.reason === 'suppressed'
          ? 'skipped_suppressed'
          : gate.reason === 'unknown_template'
            ? 'skipped_invalid'
            : 'skipped_invalid'
    const skipped = await logSkipped(db, {
      templateKey: spec.key,
      shopId: input.shopId,
      recipientEmail: input.to,
      subject: renderedSubject,
      bodyHtml: renderedHtml,
      recipientUserId: input.recipientUserId ?? null,
      recipientCustomerId: input.recipientCustomerId ?? null,
      status: reason,
      reason: gate.reason,
    })
    return {
      ok: false,
      deliveryId: skipped.id,
      reason: 'skipped_pref',
    }
  }

  // ---- Step 4: queue delivery row ----
  let delivery
  try {
    delivery = input.idempotencyKey
      ? await beginDeliveryIdempotent(db, {
          templateKey: spec.key,
          shopId: input.shopId,
          recipientEmail: input.to,
          recipientCustomerId: input.recipientCustomerId ?? null,
          recipientUserId: input.recipientUserId ?? null,
          subject: renderedSubject,
          bodyHtml: renderedHtml,
          idempotencyKey: input.idempotencyKey,
        })
      : await beginDelivery(db, {
          templateKey: spec.key,
          shopId: input.shopId,
          recipientEmail: input.to,
          recipientCustomerId: input.recipientCustomerId ?? null,
          recipientUserId: input.recipientUserId ?? null,
          subject: renderedSubject,
          bodyHtml: renderedHtml,
        })
  } catch (err) {
    return {
      ok: false,
      deliveryId: null,
      reason: 'db_write_failed',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Phase 14 PR8 — Cluster C bug 8. If the idempotent insert found an
  // existing row we use `resolveIdempotentPriorRow()` to map its actual
  // terminal state into the correct result shape. Pre-PR8 this branch
  // unconditionally returned `ok: true, provider: 'other'` — which lied
  // to callers whenever the prior row was queued/failed/skipped_*.
  if (!delivery.inserted) {
    if (delivery.prior) {
      return resolveIdempotentPriorRow({
        id: delivery.id,
        status: delivery.prior.status,
        smtp_message_id: delivery.prior.smtp_message_id,
        provider: delivery.prior.provider,
        failed_reason: delivery.prior.failed_reason,
      })
    }
    // Legacy safety net — shouldn't happen now that beginDelivery*
    // always populates `prior` when `inserted: false`, but if something
    // ever skips that path we return the old shape rather than crashing.
    return {
      ok: true,
      deliveryId: delivery.id,
      messageId: null,
      provider: 'other',
    }
  }

  // ---- Step 4b: apply open/click tracking (PR4) ----
  //
  // For marketing / lifecycle / reviews categories we mint a
  // per-delivery HMAC-signed token, persist it on the row (for the
  // tracking routes to look up on hit), rewrite every http(s) link to
  // route through our click-tracker, and inject a 1×1 pixel before
  // </body>. Transactional emails (password_reset, order_confirmation,
  // etc.) are NEVER tracked — scope doc §3b: recipient trust + GDPR
  // posture trumps analytics on receipts.
  //
  // Any failure here is swallowed — we must not block the actual send
  // over a tracking-decoration hiccup. Worst case the email goes out
  // un-tracked and the dashboard just shows "not delivered yet".
  let htmlToSend = renderedHtml
  if (isTrackingEnabled() && isTrackedCategory(spec.category)) {
    try {
      const token = generateTrackingToken(delivery.id)
      const baseUrl = resolveTrackingBaseUrl()
      const pixelUrl = buildPixelUrl(baseUrl, token)
      const rewritten = rewriteHtmlLinks(renderedHtml, token, baseUrl)
      htmlToSend = injectPixel(rewritten, pixelUrl)

      // Persist the token on the delivery row so the tracking routes
      // can look it up (partial UNIQUE index from migration 086). We
      // deliberately don't mutate `body_preview` — it's a 500-char
      // diagnostic snippet, not the canonical sent body; keeping it
      // as the pre-tracked rendering avoids noise in admin views.
      await db
        .updateTable('email_deliveries')
        .set({ tracking_token: token })
        .where('id', '=', delivery.id)
        .execute()
    } catch {
      // Tracking is best-effort. Fall back to un-tracked HTML so the
      // send still goes out.
      htmlToSend = renderedHtml
    }
  }

  // ---- Step 5: send via transport ----
  //
  // Phase 14 PR8 — Cluster B bug 7. `resolveTransport()` can throw:
  //   - EmailTransportMisconfiguredError (NODE_ENV=production + no SMTP
  //     creds + no explicit EMAIL_TRANSPORT=console) — added in bug 6.
  //   - `GmailSmtpTransport` ctor error when EMAIL_TRANSPORT=gmail but
  //     SMTP_HOST / SMTP_USER / SMTP_PASS are missing.
  //
  // Before the fix these bubbled to the outer try/catch and came back as
  // `reason='db_write_failed'`, which sent ops on a wild-goose chase into
  // Postgres logs when the actual problem was a missing env var. We now
  // classify the failure explicitly AND mark the already-queued delivery
  // row as failed so it doesn't sit in `status='queued'` forever.
  let transport: Transport
  try {
    transport = input.transport ?? resolveTransport()
  } catch (err) {
    const classified = classifyTransportResolutionError(err)
    // Mark the delivery row we just inserted as failed — we never want a
    // zombie queued row when we already know the transport won't work.
    // `provider='other'` because we don't have a resolved transport to
    // quote; the failure reason carries the detail.
    await markFailed(db, {
      id: delivery.id,
      reason: classified.error,
      provider: 'other',
    }).catch(() => {
      // Best-effort — if the mark-failed write itself blows up (DB drop,
      // schema drift) we still honour the no-throw contract via the
      // outer try/catch wrapper.
    })
    return {
      ok: false,
      deliveryId: delivery.id,
      reason: classified.reason,
      error: classified.error,
    }
  }
  const result = await transport.send({
    to: input.to,
    subject: renderedSubject,
    html: htmlToSend,
    text: renderedText,
  })

  if (!result.ok) {
    await markFailed(db, {
      id: delivery.id,
      reason: result.error ?? 'unknown transport error',
      provider: result.provider,
    })
    return {
      ok: false,
      deliveryId: delivery.id,
      reason: 'transport_failed',
      error: result.error ?? undefined,
    }
  }

  // ---- Step 6: mark sent + touch preference lastSent ----
  await markSent(db, {
    id: delivery.id,
    messageId: result.messageId,
    provider: result.provider,
  })
  if (gate.preferenceId) {
    await touchLastSent(db, gate.preferenceId).catch(() => {
      // Non-fatal.
    })
  }

  return {
    ok: true,
    deliveryId: delivery.id,
    messageId: result.messageId,
    provider: result.provider,
  }
}

// ---------------------------------------------------------------------------
// Utility (kept local — tiny enough to not justify a shared file)
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// ---------------------------------------------------------------------------
// Re-export registry for ergonomic callers.
// ---------------------------------------------------------------------------

export { EMAIL_TEMPLATE_CATALOG, getTemplate }
