/**
 * Gbox Platform — Email Transport Abstraction (Phase 14 PR1)
 *
 * One interface, three implementations:
 *
 *   gmail_smtp — Nodemailer + Gmail App Password. This is the TEMPORARY
 *                bootstrap transport while we build the system. App
 *                Password is 16-char single-app credential tied to the
 *                `admingbox@gmail.com` mailbox. Quota is 500 recipients/
 *                day and 100 recipients/email. When we graduate to SES
 *                or Resend, we swap `resolveTransport()` and keep every
 *                caller unchanged.
 *
 *   console     — Pure stdout logger. Used in dev when SMTP isn't set,
 *                 in CI smoke runs, and in tests. Never writes out.
 *                 Returns a fake messageId so callers can still log it.
 *
 *   ses         — Scaffold. Throws on send until we wire it in the
 *                 "graduate to SES" PR. Kept here so the Database enum
 *                 `provider='ses'` has a landing pad and the admin UI
 *                 can show a grey disabled badge.
 *
 * WHY THIS FILE
 * -------------
 *   The legacy `service.ts` has a hardcoded nodemailer import + SMTP
 *   config. That works, but it couples every sender to one provider
 *   and makes it impossible to route DIFFERENT templates to DIFFERENT
 *   providers (e.g. send high-deliverability transactional via SES,
 *   send marketing via Resend). This module extracts the transport
 *   into a strategy-pattern so PR4+ can add per-template routing without
 *   touching call sites.
 *
 * IRON RULE 1 (Security)
 * ----------------------
 *   Credentials come from `process.env` ONLY. We NEVER accept them as
 *   function args or log them. If SMTP_PASS is missing we fall back to
 *   the console transport with a clear warning — we do NOT crash the
 *   process, because a dev box without SMTP configured should still boot.
 */

import type {
  EmailDeliveryProvider,
} from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Normalized send envelope. Every transport accepts this shape. Reply-To
 * defaults to `EMAIL_REPLY_TO` env so tests don't end up in the bounce
 * folder of `admingbox@gmail.com`.
 */
export interface TransportEnvelope {
  /** Comma-safe single address or "Name <addr@…>" form. */
  to: string
  /** Fully-rendered subject (after variable interpolation). */
  subject: string
  /** Fully-rendered HTML body. */
  html: string
  /** Fully-rendered plain-text body (required — spam filters expect it). */
  text: string
  /** Optional override of the From; defaults to `EMAIL_FROM`. */
  from?: string
  /** Optional override of the Reply-To; defaults to `EMAIL_REPLY_TO`. */
  replyTo?: string
  /** Optional CC list (comma-separated). */
  cc?: string
  /** Optional BCC list (comma-separated). */
  bcc?: string
  /**
   * Optional `Message-ID` header override. We leave this undefined for
   * normal sends — the provider generates one. Setting it is only useful
   * for threading replies / test fixtures.
   */
  messageId?: string
}

/** Result of a transport call. `ok=false` on provider rejection. */
export interface TransportResult {
  ok: boolean
  /** Provider-reported message ID (gmail_smtp) or synthetic (console). */
  messageId: string | null
  /**
   * The canonical provider string matching the DB enum. Set by the
   * transport itself, not the caller, so the delivery log stays honest.
   */
  provider: EmailDeliveryProvider
  /** Error text on failure. Truncated to 500 chars by `delivery-log.ts`. */
  error: string | null
}

/**
 * Every transport implements this. Keep it small; per-template logic
 * (registry lookup, preferences check, etc.) lives one layer up.
 */
export interface Transport {
  readonly name: EmailDeliveryProvider
  send(env: TransportEnvelope): Promise<TransportResult>
}

// ---------------------------------------------------------------------------
// Nodemailer typing
// ---------------------------------------------------------------------------
//
// We don't `import nodemailer` directly because:
//   (a) PR1 must compile on a box where nodemailer isn't yet installed
//       (smoke script installs it on demand)
//   (b) Loading nodemailer eagerly at module import time would inject ~2MB
//       into every bundle that touches `@gbox/core` — even ones that
//       never send email.
// So we keep a minimal structural type here and dynamic-import inside
// `GmailSmtpTransport.send()`.

interface NodemailerTransport {
  sendMail(options: {
    from: string
    to: string
    subject: string
    html: string
    text: string
    replyTo?: string
    cc?: string
    bcc?: string
    messageId?: string
  }): Promise<{ messageId: string; response?: string }>
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * SMTP + identity fields pulled from env. `host` is required for
 * gmail_smtp to initialize; everything else has a sensible default.
 *
 * Expected env on the server (admingbox@gmail.com bootstrap):
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_SECURE=false           # STARTTLS at 587; set true only for 465
 *   SMTP_USER=admingbox@gmail.com
 *   SMTP_PASS=<16-char App Password — NEVER commit>
 *   EMAIL_FROM="Gbox <admingbox@gmail.com>"
 *   EMAIL_REPLY_TO=support@gbox.co
 *   EMAIL_TEST_RECIPIENT=buithai3107@gmail.com   # smoke tests only
 */
export interface EmailEnvConfig {
  host: string | null
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
  replyTo: string | null
}

export function readEmailEnv(): EmailEnvConfig {
  const host = process.env.SMTP_HOST?.trim() || null
  const port = Number.parseInt(process.env.SMTP_PORT ?? '587', 10)
  const secure = (process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true'
  const user = process.env.SMTP_USER?.trim() ?? ''
  const pass = process.env.SMTP_PASS ?? ''
  const from =
    process.env.EMAIL_FROM?.trim() ||
    process.env.SMTP_FROM?.trim() ||          // legacy alias used by service.ts
    'noreply@gbox.co'
  const replyTo = process.env.EMAIL_REPLY_TO?.trim() || null
  return { host, port, secure, user, pass, from, replyTo }
}

/** True when env is sufficient to send real email via Gmail. */
export function hasGmailSmtpCredentials(env = readEmailEnv()): boolean {
  return Boolean(env.host && env.user && env.pass)
}

// ---------------------------------------------------------------------------
// GmailSmtpTransport
// ---------------------------------------------------------------------------

export class GmailSmtpTransport implements Transport {
  readonly name: EmailDeliveryProvider = 'gmail_smtp'

  // Lazy-init so importing this module in a no-SMTP box doesn't touch
  // nodemailer. One transport per process; Gmail is happy with pooling.
  private transporter: NodemailerTransport | null = null
  private readonly env: EmailEnvConfig

  constructor(env: EmailEnvConfig = readEmailEnv()) {
    this.env = env
    if (!env.host) {
      throw new Error('GmailSmtpTransport: SMTP_HOST is not set')
    }
    if (!env.user || !env.pass) {
      throw new Error('GmailSmtpTransport: SMTP_USER / SMTP_PASS not set')
    }
  }

  private async getTransporter(): Promise<NodemailerTransport> {
    if (this.transporter) return this.transporter
    const nodemailer = await import('nodemailer')
    this.transporter = nodemailer.createTransport({
      host: this.env.host!,
      port: this.env.port,
      secure: this.env.secure,
      auth: { user: this.env.user, pass: this.env.pass },
      // Gmail rate limit hints: 100 recipients/email, ~500/day on a
      // free App Password. Pool=true keeps the TCP connection warm so
      // back-to-back sends in a cron fan-out don't each pay TLS setup.
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
    }) as NodemailerTransport
    return this.transporter
  }

  async send(env: TransportEnvelope): Promise<TransportResult> {
    try {
      const t = await this.getTransporter()
      const out = await t.sendMail({
        from: env.from ?? this.env.from,
        to: env.to,
        subject: env.subject,
        html: env.html,
        text: env.text,
        replyTo: env.replyTo ?? this.env.replyTo ?? undefined,
        cc: env.cc,
        bcc: env.bcc,
        messageId: env.messageId,
      })
      return {
        ok: true,
        messageId: out.messageId ?? null,
        provider: this.name,
        error: null,
      }
    } catch (err) {
      return {
        ok: false,
        messageId: null,
        provider: this.name,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ConsoleTransport
// ---------------------------------------------------------------------------

/**
 * Logs the envelope to stdout and returns a synthetic message ID. Used
 * when SMTP isn't configured (dev boxes, smoke tests) so the rest of
 * the pipeline still exercises the full send path.
 *
 * We prefix log lines with `[email:console]` so pino / CI filters can
 * grep them out.
 */
export class ConsoleTransport implements Transport {
  readonly name: EmailDeliveryProvider = 'console'

  private counter = 0
  /** Optional capture sink — tests pass a callback to snapshot envelopes. */
  private readonly capture?: (env: TransportEnvelope) => void

  constructor(opts?: { capture?: (env: TransportEnvelope) => void }) {
    this.capture = opts?.capture
  }

  async send(env: TransportEnvelope): Promise<TransportResult> {
    this.counter += 1
    const id = `console-${Date.now()}-${this.counter}`
    this.capture?.(env)
    // Use console.log (not stderr) so smoke tests can assert on stdout.
    // eslint-disable-next-line no-console
    console.log(
      '[email:console]',
      JSON.stringify({
        messageId: id,
        to: env.to,
        subject: env.subject,
        // Don't dump full HTML — noise for smoke logs. Preview first 200
        // chars only; the delivery-log stores a 500-char preview anyway.
        bodyPreview: env.html.slice(0, 200),
      }),
    )
    return { ok: true, messageId: id, provider: this.name, error: null }
  }
}

// ---------------------------------------------------------------------------
// SesTransport (scaffold only — throws)
// ---------------------------------------------------------------------------

/**
 * Scaffold. Wired up in a later PR when we add `@aws-sdk/client-ses` as
 * a dependency and switch the production workload over. For now `send()`
 * rejects with a clear error so accidental production use is noisy.
 */
export class SesTransport implements Transport {
  readonly name: EmailDeliveryProvider = 'ses'

  async send(_env: TransportEnvelope): Promise<TransportResult> {
    return {
      ok: false,
      messageId: null,
      provider: this.name,
      error: 'SesTransport not yet implemented (scaffold in PR1)',
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Thrown when `resolveTransport()` is called in production but no SMTP
 * credentials are wired up AND the operator hasn't explicitly opted into
 * console mode via `EMAIL_TRANSPORT=console`. Surfacing this as a typed
 * error lets the boot sequence fail loud instead of quietly marking
 * every delivery row `status=sent provider=console` for weeks.
 *
 * Phase 14 PR8 Bug 6 — prior to this guard, 104/104 rows in the live
 * `email_deliveries` table carried `provider=console` even though the
 * platform was nominally in production. Nothing actually left the server.
 */
export class EmailTransportMisconfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailTransportMisconfiguredError'
  }
}

/**
 * Preference order (first one that's usable wins):
 *
 *   1. Explicit `EMAIL_TRANSPORT` env (useful for tests / CI):
 *        EMAIL_TRANSPORT=console    — force console (escape hatch in prod too)
 *        EMAIL_TRANSPORT=gmail      — force Gmail (errors if creds missing)
 *        EMAIL_TRANSPORT=ses        — force SES (stub; will throw on send)
 *
 *   2. Auto:
 *        - gmail_smtp if SMTP_HOST + SMTP_USER + SMTP_PASS all set
 *        - console otherwise (with a warning to stderr once) — dev/test only
 *
 * Phase 14 PR8 Bug 6 — in `NODE_ENV=production` we REFUSE the silent
 * console fallback and throw `EmailTransportMisconfiguredError` so ops
 * notices instantly. Explicit `EMAIL_TRANSPORT=console` is still allowed
 * as an opt-in escape hatch (for incident-mode debugging, staging
 * profiling, etc.).
 *
 * The warn-once lives in this module so prod logs don't scream on every
 * send. Test code gets a fresh module in each vitest worker anyway.
 */
let warnedAboutConsoleFallback = false

function isProductionEnv(): boolean {
  return (process.env.NODE_ENV ?? '').toLowerCase().trim() === 'production'
}

export function resolveTransport(): Transport {
  const forced = (process.env.EMAIL_TRANSPORT ?? '').toLowerCase().trim()

  if (forced === 'console') return new ConsoleTransport()
  if (forced === 'ses') return new SesTransport()
  if (forced === 'gmail' || forced === 'gmail_smtp') {
    return new GmailSmtpTransport()
  }

  const env = readEmailEnv()
  if (hasGmailSmtpCredentials(env)) {
    return new GmailSmtpTransport(env)
  }

  // Phase 14 PR8 Bug 6 — production must NEVER silently fall back to
  // console. Marking deliveries `sent` while the transport writes to
  // stdout is a data-integrity violation (the admin UI's "sent today"
  // counter becomes a lie) and a compliance violation (transactional
  // email never reaches the customer).
  if (isProductionEnv()) {
    throw new EmailTransportMisconfiguredError(
      'Refusing silent console fallback in production. ' +
        'Set SMTP_HOST / SMTP_USER / SMTP_PASS to enable real sends, ' +
        'or set EMAIL_TRANSPORT=console explicitly if you intend to swallow emails.',
    )
  }

  // Dev / test → console, but flag it once so ops notices.
  if (!warnedAboutConsoleFallback) {
    warnedAboutConsoleFallback = true
    // eslint-disable-next-line no-console
    console.warn(
      '[email:transport] SMTP env not set — falling back to ConsoleTransport. ' +
        'Set SMTP_HOST / SMTP_USER / SMTP_PASS to enable real sends.',
    )
  }
  return new ConsoleTransport()
}

/** Test helper — reset the warn-once flag between vitest workers. */
export function __resetTransportWarningForTests(): void {
  warnedAboutConsoleFallback = false
}
