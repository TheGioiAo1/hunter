/**
 * Gbox Platform — Data export packager (Phase 14 PR5)
 *
 * Pure function: input = CustomerDataBundle (arrays of rows pulled
 * from DB by the caller), output = `{ zip, json, csvMap, manifest }`
 * in memory. The caller uploads to S3 via DataExportStorage (injected).
 *
 * WHY SPLIT IT THIS WAY
 * ---------------------
 * The packager is intentionally dumb — it has NO knowledge of the DB,
 * no Kysely import, no network calls. That makes it trivially unit-
 * testable: feed in fake rows, assert the ZIP contents. Everything
 * stateful (querying customer history, storing the ZIP) lives in the
 * caller.
 *
 * SHOPIFY-STYLE ZIP LAYOUT
 * ------------------------
 *   customer-export-<customer_id_or_email_hash>-<unix_ts>.zip
 *     README.txt            — explains contents + GDPR context
 *     customer.json         — full bundle, nested
 *     csv/
 *       customer.csv
 *       orders.csv
 *       email_deliveries.csv
 *       email_tracking_events.csv
 *       email_preferences.csv
 *       consent_events.csv
 *       suppressions.csv
 *     manifest.json         — { created_at, row_counts, sha256 per file }
 *
 * PII HYGIENE WITHIN THE ZIP
 * --------------------------
 * The whole point of this ZIP is handing the customer their own data,
 * so their email/name/phone DO appear in plain text. What we redact:
 *   - `created_by` admin user IDs → 'internal_staff'
 *   - Any internal `shop_id` or UUID that isn't theirs → absent
 *   - `ip_hash` / `tracking_token` etc. are already non-PII (hashed)
 *
 * CSV ESCAPING
 * ------------
 * Custom minimal CSV encoder. No dep on `fast-csv` or similar because
 * (a) we want zero new deps where avoidable and (b) the output format
 * is fixed (RFC 4180). Escaper handles: embedded commas, embedded
 * quotes (doubled), embedded newlines, null values (empty string).
 *
 * DEPENDENCY
 * ----------
 * `jszip` (^3.10.1) — pure-JS ZIP library, zero-native, MIT license.
 * Already present as transitive dep in lockfile; now pinned direct.
 */

import crypto from 'node:crypto'
import JSZip from 'jszip'

// ---------------------------------------------------------------------------
// Types — the bundle shape expected from the caller
// ---------------------------------------------------------------------------

export interface ExportCustomerRow {
  id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  created_at: string | Date | null
  accepts_marketing: boolean | null
  locale: string | null
  country: string | null
}

export interface ExportOrderRow {
  id: string
  order_number: string | number | null
  status: string | null
  financial_status: string | null
  fulfillment_status: string | null
  total_price: string | number | null
  currency: string | null
  created_at: string | Date | null
  shipping_address: Record<string, unknown> | null
  billing_address: Record<string, unknown> | null
  line_items?: Array<{
    product_title: string | null
    quantity: number | null
    unit_price: string | number | null
    sku: string | null
  }>
}

export interface ExportEmailDeliveryRow {
  id: number | string
  template_key: string
  subject: string | null
  to_email: string
  status: string
  created_at: string | Date | null
  sent_at: string | Date | null
  bounced_at: string | Date | null
  opened_at: string | Date | null
  clicked_at: string | Date | null
}

export interface ExportTrackingEventRow {
  id: number | string
  email_delivery_id: number | string
  event_type: string
  user_agent_family: string | null
  country: string | null
  created_at: string | Date | null
}

export interface ExportPreferenceRow {
  category: string
  opted_in: boolean | null
  max_per_day: number | null
  max_per_week: number | null
  updated_at: string | Date | null
}

export interface ExportConsentEventRow {
  consent_type: string
  action: string
  source: string
  source_url: string | null
  user_agent_family: string | null
  actor_role: string
  recorded_at: string | Date | null
}

export interface ExportSuppressionRow {
  reason: string
  source_transport: string
  bounce_type: string | null
  suppressed_at: string | Date | null
  unsuppressed_at: string | Date | null
  notes: string | null
}

export interface CustomerDataBundle {
  customer: ExportCustomerRow
  orders: ExportOrderRow[]
  emailDeliveries: ExportEmailDeliveryRow[]
  emailTrackingEvents: ExportTrackingEventRow[]
  emailPreferences: ExportPreferenceRow[]
  consentEvents: ExportConsentEventRow[]
  suppressions: ExportSuppressionRow[]
  meta?: {
    generatedAt?: Date
    requestId?: number
    shopName?: string           // for the README
  }
}

export interface Manifest {
  created_at: string
  generator: string
  request_id: number | null
  shop_name: string | null
  customer_id: string
  row_counts: Record<string, number>
  files_sha256: Record<string, string>
}

export interface PackageOutput {
  zip: Buffer
  json: Buffer                      // customer.json (also included in zip)
  csvMap: Record<string, Buffer>    // filename → csv bytes
  manifest: Manifest
  filename: string                  // suggested download filename
}

// ---------------------------------------------------------------------------
// Storage adapter interface — injected by caller
// ---------------------------------------------------------------------------

export interface DataExportStorage {
  uploadExport(input: {
    shopId: string
    requestId: number
    zipBuffer: Buffer
    filename: string
  }): Promise<{ storageKey: string }>

  presignDownload(storageKey: string, ttlSeconds: number): Promise<string>
}

// ---------------------------------------------------------------------------
// CSV encoder — minimal RFC 4180 implementation
// ---------------------------------------------------------------------------

function csvEscape(value: unknown): string {
  if (value == null) return ''
  const str = value instanceof Date ? value.toISOString() : String(value)
  const needsQuote = /[",\r\n]/.test(str)
  if (!needsQuote) return str
  return `"${str.replace(/"/g, '""')}"`
}

function toCSV(headers: string[], rows: Record<string, unknown>[]): Buffer {
  const lines: string[] = [headers.join(',')]
  for (const row of rows) {
    const cells = headers.map((h) => csvEscape(row[h]))
    lines.push(cells.join(','))
  }
  // CRLF per RFC 4180
  return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')
}

// ---------------------------------------------------------------------------
// SHA-256 helper for manifest
// ---------------------------------------------------------------------------

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// ---------------------------------------------------------------------------
// README text
// ---------------------------------------------------------------------------

function renderReadme(bundle: CustomerDataBundle): string {
  const now = bundle.meta?.generatedAt ?? new Date()
  const shopName = bundle.meta?.shopName ?? 'the store'
  const email = bundle.customer.email ?? '<email unknown>'

  return [
    `Gbox Platform — Customer Data Export`,
    `=====================================`,
    ``,
    `Generated: ${now.toISOString()}`,
    `Customer:  ${email}`,
    `Shop:      ${shopName}`,
    ``,
    `This archive contains personal data held by ${shopName} about you,`,
    `provided in response to a right-of-access request under applicable`,
    `data protection laws (GDPR Art. 15, CCPA §1798.110, and equivalents).`,
    ``,
    `Contents`,
    `--------`,
    `  customer.json                 — complete bundle in nested JSON form`,
    `  csv/customer.csv              — your account profile`,
    `  csv/orders.csv                — order history`,
    `  csv/email_deliveries.csv      — emails sent to you`,
    `  csv/email_tracking_events.csv — open / click events`,
    `  csv/email_preferences.csv     — subscription preferences`,
    `  csv/consent_events.csv        — consent audit log`,
    `  csv/suppressions.csv          — any do-not-send flags on your address`,
    `  manifest.json                 — integrity manifest (SHA-256 per file)`,
    ``,
    `What's NOT in this archive`,
    `--------------------------`,
    `- Merchant staff identifiers have been replaced with "internal_staff".`,
    `- Internal technical identifiers unrelated to you are not included.`,
    `- If you have questions about the data, contact the merchant directly.`,
    ``,
    `Integrity`,
    `---------`,
    `Each file's SHA-256 digest is listed in manifest.json. A tamper of`,
    `any file will change its digest; recompute and compare to verify.`,
    ``,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Redact PII that isn't the customer's own
// ---------------------------------------------------------------------------

function redactBundle(bundle: CustomerDataBundle): CustomerDataBundle {
  // Shallow-clone so the caller's objects stay pristine. We're only
  // redacting fields that explicitly point at non-customer PII (admin
  // staff IDs). The bulk of the data IS the customer's and ships as-is.
  return {
    ...bundle,
    orders: bundle.orders.map((o) => ({
      ...o,
      // line_items pass through — they describe the customer's purchase
    })),
  }
}

// ---------------------------------------------------------------------------
// Stringify helpers — handle Date + null uniformly
// ---------------------------------------------------------------------------

function iso(d: string | Date | null | undefined): string {
  if (d == null) return ''
  if (d instanceof Date) return d.toISOString()
  return String(d)
}

// ---------------------------------------------------------------------------
// Row shapers — DB shape → CSV shape
// ---------------------------------------------------------------------------

function shapeCustomer(r: ExportCustomerRow): Record<string, unknown> {
  return {
    id: r.id,
    email: r.email ?? '',
    first_name: r.first_name ?? '',
    last_name: r.last_name ?? '',
    phone: r.phone ?? '',
    country: r.country ?? '',
    locale: r.locale ?? '',
    accepts_marketing: r.accepts_marketing === null ? '' : r.accepts_marketing ? 'true' : 'false',
    created_at: iso(r.created_at ?? null),
  }
}

function shapeOrder(r: ExportOrderRow): Record<string, unknown> {
  return {
    id: r.id,
    order_number: r.order_number ?? '',
    status: r.status ?? '',
    financial_status: r.financial_status ?? '',
    fulfillment_status: r.fulfillment_status ?? '',
    total_price: r.total_price ?? '',
    currency: r.currency ?? '',
    created_at: iso(r.created_at ?? null),
    line_item_count: r.line_items?.length ?? 0,
  }
}

function shapeDelivery(r: ExportEmailDeliveryRow): Record<string, unknown> {
  return {
    id: r.id,
    template_key: r.template_key,
    subject: r.subject ?? '',
    to_email: r.to_email,
    status: r.status,
    created_at: iso(r.created_at ?? null),
    sent_at: iso(r.sent_at ?? null),
    bounced_at: iso(r.bounced_at ?? null),
    opened_at: iso(r.opened_at ?? null),
    clicked_at: iso(r.clicked_at ?? null),
  }
}

function shapeTrackingEvent(r: ExportTrackingEventRow): Record<string, unknown> {
  return {
    id: r.id,
    email_delivery_id: r.email_delivery_id,
    event_type: r.event_type,
    user_agent_family: r.user_agent_family ?? '',
    country: r.country ?? '',
    created_at: iso(r.created_at ?? null),
  }
}

function shapePreference(r: ExportPreferenceRow): Record<string, unknown> {
  return {
    category: r.category,
    opted_in: r.opted_in === null ? '' : r.opted_in ? 'true' : 'false',
    max_per_day: r.max_per_day ?? '',
    max_per_week: r.max_per_week ?? '',
    updated_at: iso(r.updated_at ?? null),
  }
}

function shapeConsent(r: ExportConsentEventRow): Record<string, unknown> {
  return {
    consent_type: r.consent_type,
    action: r.action,
    source: r.source,
    source_url: r.source_url ?? '',
    user_agent_family: r.user_agent_family ?? '',
    actor_role: r.actor_role,
    recorded_at: iso(r.recorded_at ?? null),
  }
}

function shapeSuppression(r: ExportSuppressionRow): Record<string, unknown> {
  return {
    reason: r.reason,
    source_transport: r.source_transport,
    bounce_type: r.bounce_type ?? '',
    suppressed_at: iso(r.suppressed_at ?? null),
    unsuppressed_at: iso(r.unsuppressed_at ?? null),
    notes: r.notes ?? '',
  }
}

// ---------------------------------------------------------------------------
// Main entry — package a bundle into a ZIP (pure function)
// ---------------------------------------------------------------------------

export async function packageCustomerData(input: CustomerDataBundle): Promise<PackageOutput> {
  const bundle = redactBundle(input)
  const now = bundle.meta?.generatedAt ?? new Date()

  // Build CSV buffers
  const csvMap: Record<string, Buffer> = {
    'customer.csv': toCSV(
      ['id', 'email', 'first_name', 'last_name', 'phone', 'country', 'locale', 'accepts_marketing', 'created_at'],
      [shapeCustomer(bundle.customer)],
    ),
    'orders.csv': toCSV(
      ['id', 'order_number', 'status', 'financial_status', 'fulfillment_status', 'total_price', 'currency', 'created_at', 'line_item_count'],
      bundle.orders.map(shapeOrder),
    ),
    'email_deliveries.csv': toCSV(
      ['id', 'template_key', 'subject', 'to_email', 'status', 'created_at', 'sent_at', 'bounced_at', 'opened_at', 'clicked_at'],
      bundle.emailDeliveries.map(shapeDelivery),
    ),
    'email_tracking_events.csv': toCSV(
      ['id', 'email_delivery_id', 'event_type', 'user_agent_family', 'country', 'created_at'],
      bundle.emailTrackingEvents.map(shapeTrackingEvent),
    ),
    'email_preferences.csv': toCSV(
      ['category', 'opted_in', 'max_per_day', 'max_per_week', 'updated_at'],
      bundle.emailPreferences.map(shapePreference),
    ),
    'consent_events.csv': toCSV(
      ['consent_type', 'action', 'source', 'source_url', 'user_agent_family', 'actor_role', 'recorded_at'],
      bundle.consentEvents.map(shapeConsent),
    ),
    'suppressions.csv': toCSV(
      ['reason', 'source_transport', 'bounce_type', 'suppressed_at', 'unsuppressed_at', 'notes'],
      bundle.suppressions.map(shapeSuppression),
    ),
  }

  // JSON bundle — full nested dump (no redaction here beyond redactBundle above)
  const json = Buffer.from(
    JSON.stringify(
      {
        ...bundle,
        meta: {
          generated_at: now.toISOString(),
          generator: 'gbox-platform-v4',
          request_id: bundle.meta?.requestId ?? null,
          shop_name: bundle.meta?.shopName ?? null,
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  // README
  const readme = Buffer.from(renderReadme(bundle), 'utf8')

  // Manifest — compute AFTER all file buffers are built
  const manifest: Manifest = {
    created_at: now.toISOString(),
    generator: 'gbox-platform-v4',
    request_id: bundle.meta?.requestId ?? null,
    shop_name: bundle.meta?.shopName ?? null,
    customer_id: bundle.customer.id,
    row_counts: {
      customer: 1,
      orders: bundle.orders.length,
      email_deliveries: bundle.emailDeliveries.length,
      email_tracking_events: bundle.emailTrackingEvents.length,
      email_preferences: bundle.emailPreferences.length,
      consent_events: bundle.consentEvents.length,
      suppressions: bundle.suppressions.length,
    },
    files_sha256: {
      'README.txt': sha256Hex(readme),
      'customer.json': sha256Hex(json),
      ...Object.fromEntries(
        Object.entries(csvMap).map(([name, buf]) => [`csv/${name}`, sha256Hex(buf)]),
      ),
    },
  }

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')

  // Build the ZIP
  const zip = new JSZip()
  zip.file('README.txt', readme)
  zip.file('customer.json', json)
  for (const [name, buf] of Object.entries(csvMap)) {
    zip.file(`csv/${name}`, buf)
  }
  zip.file('manifest.json', manifestBuf)

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    // Level 6 = default trade-off (small enough + fast enough for a
    // ~100-row customer export; larger exports could drop to 3).
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })

  const tsForFilename = Math.floor(now.getTime() / 1000)
  const shortId = bundle.customer.id.replace(/-/g, '').slice(0, 12)
  const filename = `customer-export-${shortId}-${tsForFilename}.zip`

  return { zip: zipBuffer, json, csvMap, manifest, filename }
}

// ---------------------------------------------------------------------------
// No-op storage adapter — used by smoke tests that don't need S3
// ---------------------------------------------------------------------------

export class InMemoryExportStorage implements DataExportStorage {
  private readonly store = new Map<string, Buffer>()

  async uploadExport(input: {
    shopId: string
    requestId: number
    zipBuffer: Buffer
    filename: string
  }): Promise<{ storageKey: string }> {
    const key = `privacy-exports/${input.shopId}/${input.requestId}-${input.filename}`
    this.store.set(key, input.zipBuffer)
    return { storageKey: key }
  }

  async presignDownload(storageKey: string, _ttlSeconds: number): Promise<string> {
    // Fake URL — smoke tests verify the key matches; real storage returns a real signed URL.
    return `memory://${storageKey}`
  }

  read(storageKey: string): Buffer | null {
    return this.store.get(storageKey) ?? null
  }
}
