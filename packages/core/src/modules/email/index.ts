/**
 * Gbox Platform — @gbox/core/modules/email public surface
 *
 * One barrel for the whole Shopify-class email system (Phase 14 PR1).
 * External callers should import from here, not the individual files,
 * so we can refactor internals without breaking consumers.
 *
 * Layers:
 *   - `registry`    — 95-template catalog + metadata helpers
 *   - `transport`   — Gmail / Console / SES pluggable provider
 *   - `preferences` — canSend() gate, unsubscribe token lifecycle
 *   - `delivery-log`— append-only send audit trail
 *   - `send`        — high-level `sendTemplatedEmail()` that wires them
 *   - `service`     — legacy per-feature senders (kept working, pre-PR1)
 */

export * from './registry.js'
export * from './transport.js'
export * from './preferences.js'
export * from './delivery-log.js'
export * from './send.js'
export * from './tracking.js'
export * from './tracking-recorder.js'
export * from './analytics.js'
// PR5 — Privacy/GDPR pack
export * from './user-agent-family.js'
export * from './consent-ledger.js'
export * from './privacy-requests.js'
export * from './data-export-packager.js'
export * from './bounce-aggregator.js'
export * from './salt-rotation.js'
// PR8 — zombie janitor (bug 9): sweep rows stuck in status='queued' past
// the grace period. Run on a 5-minute cron.
export * from './zombie-janitor.js'
export * from './cron-seed.js'
// `service.js` is re-exported by name so legacy `sendOrderConfirmation`
// etc. still resolve through @gbox/core/modules/email.
export {
  sendEmail,
  renderTemplate,
  sendOrderConfirmation,
  sendShippingNotification,
  sendPasswordReset,
  sendWelcome,
  sendInvoice,
  sendRefundNotification,
  sendAbandonedCartRecovery,
  sendGiftCardDelivery,
  sendReviewApproved,
  sendReviewReplied,
  sendNewOrderReceived,
  sendOrderCanceled,
  sendFulfillmentDelivered,
} from './service.js'
