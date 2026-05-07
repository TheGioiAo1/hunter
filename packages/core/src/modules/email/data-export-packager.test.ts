/**
 * Unit tests for email/data-export-packager.ts — pure function.
 *
 * Tests the whole pipeline end-to-end in memory using JSZip to
 * re-open the produced archive and verify contents. This is legit
 * unit testing — no DB, no network; the packager itself is pure.
 *
 * DB-facing behaviour (querying orders/deliveries/events for a
 * customer, uploading to S3) is covered in
 * `scripts/smoke-phase14-pr5.ts`.
 */

import crypto from 'node:crypto'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  packageCustomerData,
  InMemoryExportStorage,
  type CustomerDataBundle,
} from './data-export-packager.js'

function sampleBundle(overrides: Partial<CustomerDataBundle> = {}): CustomerDataBundle {
  return {
    customer: {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'customer@example.com',
      first_name: 'Alice',
      last_name: 'Smith',
      phone: '+1-555-0100',
      country: 'US',
      locale: 'en',
      created_at: new Date('2024-01-01T00:00:00Z'),
      accepts_marketing: true,
    },
    orders: [
      {
        id: 'ord-1',
        order_number: 1001,
        status: 'paid',
        financial_status: 'paid',
        fulfillment_status: 'fulfilled',
        total_price: '42.00',
        currency: 'USD',
        created_at: new Date('2024-02-15T10:30:00Z'),
        shipping_address: { city: 'New York', country: 'US' },
        billing_address: null,
        line_items: [{ product_title: 'Widget', quantity: 2, unit_price: '21.00', sku: 'W-1' }],
      },
    ],
    emailDeliveries: [
      {
        id: 1,
        template_key: 'order_confirmation',
        subject: 'Your order is on the way',
        to_email: 'customer@example.com',
        status: 'sent',
        created_at: new Date('2024-02-15T10:31:00Z'),
        sent_at: new Date('2024-02-15T10:31:02Z'),
        bounced_at: null,
        opened_at: new Date('2024-02-15T11:00:00Z'),
        clicked_at: null,
      },
    ],
    emailTrackingEvents: [
      {
        id: 1,
        email_delivery_id: 1,
        event_type: 'open',
        user_agent_family: 'chrome',
        country: 'US',
        created_at: new Date('2024-02-15T11:00:00Z'),
      },
    ],
    emailPreferences: [
      {
        category: 'marketing',
        opted_in: true,
        max_per_day: 3,
        max_per_week: 10,
        updated_at: new Date('2024-01-01T00:00:00Z'),
      },
    ],
    consentEvents: [
      {
        consent_type: 'marketing',
        action: 'opt_in',
        source: 'checkout',
        source_url: 'https://shop.example.com/checkout',
        user_agent_family: 'chrome',
        actor_role: 'customer',
        recorded_at: new Date('2024-01-01T00:00:00Z'),
      },
    ],
    suppressions: [],
    meta: { shopName: 'Acme Shop', requestId: 42 },
    ...overrides,
  }
}

describe('packageCustomerData — happy path', () => {
  it('returns a non-empty ZIP buffer', async () => {
    const out = await packageCustomerData(sampleBundle())
    expect(out.zip).toBeInstanceOf(Buffer)
    expect(out.zip.length).toBeGreaterThan(100)
  })

  it('suggests a filename with timestamp + customer id prefix', async () => {
    const out = await packageCustomerData(sampleBundle())
    expect(out.filename).toMatch(/^customer-export-[0-9a-f]+-\d+\.zip$/)
  })

  it('JSON buffer parses as valid JSON', async () => {
    const out = await packageCustomerData(sampleBundle())
    const parsed = JSON.parse(out.json.toString('utf8'))
    expect(parsed.customer.email).toBe('customer@example.com')
    expect(parsed.orders).toHaveLength(1)
  })

  it('json has meta.generator stamp', async () => {
    const out = await packageCustomerData(sampleBundle())
    const parsed = JSON.parse(out.json.toString('utf8'))
    expect(parsed.meta.generator).toBe('gbox-platform-v4')
    expect(parsed.meta.request_id).toBe(42)
  })
})

describe('packageCustomerData — ZIP contents', () => {
  it('contains all 10 expected files', async () => {
    const out = await packageCustomerData(sampleBundle())
    const zip = await JSZip.loadAsync(out.zip)
    const names = Object.keys(zip.files).sort()
    expect(names).toContain('README.txt')
    expect(names).toContain('customer.json')
    expect(names).toContain('manifest.json')
    expect(names).toContain('csv/customer.csv')
    expect(names).toContain('csv/orders.csv')
    expect(names).toContain('csv/email_deliveries.csv')
    expect(names).toContain('csv/email_tracking_events.csv')
    expect(names).toContain('csv/email_preferences.csv')
    expect(names).toContain('csv/consent_events.csv')
    expect(names).toContain('csv/suppressions.csv')
  })

  it('README.txt contains shop name + customer email', async () => {
    const out = await packageCustomerData(sampleBundle())
    const zip = await JSZip.loadAsync(out.zip)
    const readme = await zip.file('README.txt')!.async('string')
    expect(readme).toContain('Acme Shop')
    expect(readme).toContain('customer@example.com')
    expect(readme).toContain('GDPR')
  })

  it('customer.csv has correct header + one row', async () => {
    const out = await packageCustomerData(sampleBundle())
    const zip = await JSZip.loadAsync(out.zip)
    const csv = await zip.file('csv/customer.csv')!.async('string')
    const lines = csv.trim().split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(
      'id,email,first_name,last_name,phone,country,locale,accepts_marketing,created_at',
    )
    expect(lines[1]).toContain('customer@example.com')
    expect(lines[1]).toContain('Alice')
    expect(lines[1]).toContain('true')
  })

  it('manifest.json has row_counts matching inputs', async () => {
    const out = await packageCustomerData(sampleBundle())
    const zip = await JSZip.loadAsync(out.zip)
    const manifestTxt = await zip.file('manifest.json')!.async('string')
    const manifest = JSON.parse(manifestTxt)
    expect(manifest.row_counts.customer).toBe(1)
    expect(manifest.row_counts.orders).toBe(1)
    expect(manifest.row_counts.email_deliveries).toBe(1)
    expect(manifest.row_counts.email_tracking_events).toBe(1)
    expect(manifest.row_counts.email_preferences).toBe(1)
    expect(manifest.row_counts.consent_events).toBe(1)
    expect(manifest.row_counts.suppressions).toBe(0)
  })

  it('manifest.json has SHA-256 for every file', async () => {
    const out = await packageCustomerData(sampleBundle())
    const zip = await JSZip.loadAsync(out.zip)
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(Object.keys(manifest.files_sha256).sort()).toEqual([
      'README.txt',
      'csv/consent_events.csv',
      'csv/customer.csv',
      'csv/email_deliveries.csv',
      'csv/email_preferences.csv',
      'csv/email_tracking_events.csv',
      'csv/orders.csv',
      'csv/suppressions.csv',
      'customer.json',
    ])
    for (const hash of Object.values(manifest.files_sha256) as string[]) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('manifest SHA-256 matches actual file content', async () => {
    const out = await packageCustomerData(sampleBundle())
    const zip = await JSZip.loadAsync(out.zip)
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))

    // Verify README.txt hash
    const readme = await zip.file('README.txt')!.async('nodebuffer')
    const computed = crypto.createHash('sha256').update(readme).digest('hex')
    expect(computed).toBe(manifest.files_sha256['README.txt'])

    // Verify one CSV
    const ordersCsv = await zip.file('csv/orders.csv')!.async('nodebuffer')
    const ordersHash = crypto.createHash('sha256').update(ordersCsv).digest('hex')
    expect(ordersHash).toBe(manifest.files_sha256['csv/orders.csv'])
  })
})

describe('packageCustomerData — empty bundle', () => {
  it('handles customer with zero orders', async () => {
    const bundle = sampleBundle({
      orders: [],
      emailDeliveries: [],
      emailTrackingEvents: [],
      emailPreferences: [],
      consentEvents: [],
      suppressions: [],
    })
    const out = await packageCustomerData(bundle)
    const zip = await JSZip.loadAsync(out.zip)
    const manifestTxt = await zip.file('manifest.json')!.async('string')
    const manifest = JSON.parse(manifestTxt)
    expect(manifest.row_counts.orders).toBe(0)
    const ordersCsv = await zip.file('csv/orders.csv')!.async('string')
    // Header only (no data rows)
    expect(ordersCsv.trim().split('\r\n')).toHaveLength(1)
  })
})

describe('packageCustomerData — CSV escaping', () => {
  it('escapes commas in values', async () => {
    const bundle = sampleBundle()
    bundle.customer.first_name = 'Alice, the Great'
    const out = await packageCustomerData(bundle)
    const zip = await JSZip.loadAsync(out.zip)
    const csv = await zip.file('csv/customer.csv')!.async('string')
    expect(csv).toContain('"Alice, the Great"')
  })

  it('escapes embedded quotes by doubling', async () => {
    const bundle = sampleBundle()
    bundle.customer.first_name = 'Alice "the Great"'
    const out = await packageCustomerData(bundle)
    const zip = await JSZip.loadAsync(out.zip)
    const csv = await zip.file('csv/customer.csv')!.async('string')
    expect(csv).toContain('"Alice ""the Great"""')
  })

  it('escapes embedded newlines', async () => {
    const bundle = sampleBundle()
    bundle.suppressions = [
      {
        reason: 'manual',
        source_transport: 'manual',
        bounce_type: null,
        suppressed_at: new Date('2024-01-01'),
        unsuppressed_at: null,
        notes: 'Line one\nLine two',
      },
    ]
    const out = await packageCustomerData(bundle)
    const zip = await JSZip.loadAsync(out.zip)
    const csv = await zip.file('csv/suppressions.csv')!.async('string')
    expect(csv).toContain('"Line one\nLine two"')
  })

  it('represents null values as empty cells', async () => {
    const bundle = sampleBundle()
    bundle.customer.phone = null
    bundle.customer.country = null
    const out = await packageCustomerData(bundle)
    const zip = await JSZip.loadAsync(out.zip)
    const csv = await zip.file('csv/customer.csv')!.async('string')
    const lines = csv.trim().split('\r\n')
    const cells = lines[1].split(',')
    // id,email,first_name,last_name,phone,country,...
    expect(cells[4]).toBe('') // phone
    expect(cells[5]).toBe('') // country
  })

  it('stringifies dates as ISO', async () => {
    const out = await packageCustomerData(sampleBundle())
    const zip = await JSZip.loadAsync(out.zip)
    const csv = await zip.file('csv/customer.csv')!.async('string')
    expect(csv).toContain('2024-01-01T00:00:00.000Z')
  })
})

describe('InMemoryExportStorage — adapter for tests', () => {
  it('uploads and retrieves a buffer', async () => {
    const storage = new InMemoryExportStorage()
    const buf = Buffer.from('hello')
    const { storageKey } = await storage.uploadExport({
      shopId: 'shop-1',
      requestId: 42,
      zipBuffer: buf,
      filename: 'test.zip',
    })
    expect(storageKey).toContain('privacy-exports/shop-1/42-')
    expect(storage.read(storageKey)).toEqual(buf)
  })

  it('presignDownload returns a memory:// URL', async () => {
    const storage = new InMemoryExportStorage()
    const url = await storage.presignDownload('privacy-exports/x/y.zip', 3600)
    expect(url).toBe('memory://privacy-exports/x/y.zip')
  })

  it('returns null for unknown keys', () => {
    const storage = new InMemoryExportStorage()
    expect(storage.read('unknown-key')).toBe(null)
  })
})

describe('packageCustomerData — large batch', () => {
  it('handles 500 delivery rows without hanging', async () => {
    const bundle = sampleBundle()
    bundle.emailDeliveries = Array.from({ length: 500 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, '0')
      return {
        id: i,
        template_key: 'newsletter',
        subject: `Issue #${i}`,
        to_email: 'customer@example.com',
        status: 'sent',
        created_at: new Date(`2024-01-${day}T00:00:00Z`),
        sent_at: new Date(`2024-01-${day}T00:00:01Z`),
        bounced_at: null,
        opened_at: null,
        clicked_at: null,
      }
    })
    const start = Date.now()
    const out = await packageCustomerData(bundle)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000) // generous for cold start
    const zip = await JSZip.loadAsync(out.zip)
    const csv = await zip.file('csv/email_deliveries.csv')!.async('string')
    expect(csv.trim().split('\r\n')).toHaveLength(501) // header + 500 rows
  })
})
