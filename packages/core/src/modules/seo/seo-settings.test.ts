/**
 * SEO Settings service — unit coverage (Phase 8 PR3).
 *
 * Covers:
 *   • DEFAULT_SEO_SETTINGS shape (all 11 keys, sensible defaults)
 *   • mergeSettings: null / non-object / empty → defaults
 *   • mergeSettings: every scalar field round-trips + trim + empty→null
 *   • mergeSettings: robots_noindex is type-guarded against truthy strings
 *   • mergeSettings: last_scan_report shallow-validates + drops bad issues
 *   • applyTitleTemplate: token expansion (incl. resource_title alias)
 *   • applyTitleTemplate: unknown tokens left intact for spot-debugging
 *   • resolveSettings: calls selectFrom('shops') and merges the column
 *   • setShopSettings: preserves scan fields the admin form doesn't send
 *   • recordScanReport: stamps last_scan_at and writes report verbatim
 *
 * Pure + DB tests are interleaved; the DB layer is a minimal in-memory
 * mock (no sqlite), so the suite stays fast and doesn't touch Postgres.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DEFAULT_SEO_SETTINGS,
  applyTitleTemplate,
  mergeSettings,
  recordScanReport,
  resolveSettings,
  setShopSettings,
  type SeoScanReport,
  type SeoSettings,
} from './seo-settings.js'

// ---------------------------------------------------------------------------
// In-memory fake Kysely
// ---------------------------------------------------------------------------

type Row = { id: string; seo_settings: unknown; updated_at: string }

function makeDb(initial: Row[] = []) {
  const rows = new Map<string, Row>(initial.map((r) => [r.id, { ...r }]))

  const db = {
    selectFrom(_table: string) {
      return {
        _where: null as null | { id: string },
        _select: null as null | string[],
        where(col: string, _op: string, val: string) {
          if (col !== 'id') throw new Error(`unexpected where on ${col}`)
          this._where = { id: val }
          return this
        },
        select(cols: string | string[]) {
          this._select = Array.isArray(cols) ? cols : [cols]
          return this
        },
        async executeTakeFirst() {
          if (!this._where) return undefined
          const row = rows.get(this._where.id)
          if (!row) return undefined
          const out: Record<string, unknown> = {}
          for (const c of this._select ?? []) {
            out[c] = (row as unknown as Record<string, unknown>)[c]
          }
          return out
        },
      }
    },
    updateTable(_table: string) {
      return {
        _set: null as null | Record<string, unknown>,
        _where: null as null | { id: string },
        set(values: Record<string, unknown>) {
          this._set = values
          return this
        },
        where(col: string, _op: string, val: string) {
          if (col !== 'id') throw new Error(`unexpected where on ${col}`)
          this._where = { id: val }
          return this
        },
        async execute() {
          if (!this._where || !this._set) throw new Error('incomplete update')
          const row = rows.get(this._where.id)
          if (!row) return
          // Emulate Postgres JSONB: `JSON.stringify(...)` written into a
          // JSONB column comes back as the parsed object, not the raw
          // string. Any other string value (updated_at etc.) passes
          // through unchanged.
          const coerced: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(this._set)) {
            if (k === 'seo_settings' && typeof v === 'string') {
              coerced[k] = JSON.parse(v)
            } else {
              coerced[k] = v
            }
          }
          Object.assign(row, coerced)
        },
      }
    },
    _rows: rows,
  }

  return db as unknown as ReturnType<typeof Object> & { _rows: Map<string, Row> }
}

// ---------------------------------------------------------------------------
// DEFAULT_SEO_SETTINGS
// ---------------------------------------------------------------------------

describe('DEFAULT_SEO_SETTINGS', () => {
  it('indexable by default (robots_noindex=false)', () => {
    expect(DEFAULT_SEO_SETTINGS.robots_noindex).toBe(false)
  })

  it('every nullable field is null out of the box', () => {
    expect(DEFAULT_SEO_SETTINGS.default_title_template).toBeNull()
    expect(DEFAULT_SEO_SETTINGS.default_description).toBeNull()
    expect(DEFAULT_SEO_SETTINGS.default_og_image_url).toBeNull()
    expect(DEFAULT_SEO_SETTINGS.twitter_handle).toBeNull()
    expect(DEFAULT_SEO_SETTINGS.facebook_url).toBeNull()
    expect(DEFAULT_SEO_SETTINGS.google_analytics_id).toBeNull()
    expect(DEFAULT_SEO_SETTINGS.google_tag_manager_id).toBeNull()
    expect(DEFAULT_SEO_SETTINGS.google_site_verification).toBeNull()
    expect(DEFAULT_SEO_SETTINGS.last_scan_at).toBeNull()
    expect(DEFAULT_SEO_SETTINGS.last_scan_report).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// mergeSettings — edge cases
// ---------------------------------------------------------------------------

describe('mergeSettings', () => {
  it('null → defaults', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SEO_SETTINGS)
  })

  it('undefined → defaults', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SEO_SETTINGS)
  })

  it('non-object (string/number/boolean) → defaults', () => {
    expect(mergeSettings('oops')).toEqual(DEFAULT_SEO_SETTINGS)
    expect(mergeSettings(42)).toEqual(DEFAULT_SEO_SETTINGS)
    expect(mergeSettings(true)).toEqual(DEFAULT_SEO_SETTINGS)
  })

  it('empty object → defaults', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SEO_SETTINGS)
  })

  it('round-trips every scalar string field', () => {
    const full: SeoSettings = {
      default_title_template: '{page_title} — {shop_name}',
      default_description: 'Handmade goods shipped worldwide.',
      default_og_image_url: 'https://cdn.example.com/og.png',
      twitter_handle: '@gbox',
      facebook_url: 'https://facebook.com/gbox',
      google_analytics_id: 'G-ABCDEF1234',
      google_tag_manager_id: 'GTM-AABBCC',
      google_site_verification: 'some-verification-string',
      robots_noindex: false,
      last_scan_at: null,
      last_scan_report: null,
    }
    expect(mergeSettings(full)).toEqual(full)
  })

  it('trims whitespace and normalises empty → null', () => {
    const merged = mergeSettings({
      default_title_template: '   ',
      default_description: '\t\n  ',
      twitter_handle: '  @gbox  ',
    })
    expect(merged.default_title_template).toBeNull()
    expect(merged.default_description).toBeNull()
    expect(merged.twitter_handle).toBe('@gbox')
  })

  it('robots_noindex guards against truthy strings / numbers', () => {
    expect(mergeSettings({ robots_noindex: 'true' }).robots_noindex).toBe(false)
    expect(mergeSettings({ robots_noindex: 1 }).robots_noindex).toBe(false)
    expect(mergeSettings({ robots_noindex: true }).robots_noindex).toBe(true)
    expect(mergeSettings({ robots_noindex: false }).robots_noindex).toBe(false)
  })

  it('ignores unknown top-level keys', () => {
    const merged = mergeSettings({ unknown_key: 'value', twitter_handle: '@x' })
    expect(merged.twitter_handle).toBe('@x')
    expect((merged as unknown as Record<string, unknown>).unknown_key).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// mergeSettings — scan report coercion
// ---------------------------------------------------------------------------

describe('mergeSettings — scan report', () => {
  it('accepts a well-formed report verbatim', () => {
    const report: SeoScanReport = {
      pages_scanned: 8,
      score: 90,
      issues: [
        {
          url: 'https://shop.test/',
          severity: 'warning',
          code: 'missing_meta_description',
          message: 'Page has no meta description.',
        },
      ],
    }
    const merged = mergeSettings({ last_scan_report: report })
    expect(merged.last_scan_report).toEqual(report)
  })

  it('clamps score to [0, 100]', () => {
    expect(
      mergeSettings({
        last_scan_report: { pages_scanned: 1, score: 200, issues: [] },
      }).last_scan_report?.score,
    ).toBe(100)
    expect(
      mergeSettings({
        last_scan_report: { pages_scanned: 1, score: -5, issues: [] },
      }).last_scan_report?.score,
    ).toBe(0)
  })

  it('drops issues missing required fields', () => {
    const merged = mergeSettings({
      last_scan_report: {
        pages_scanned: 3,
        score: 50,
        issues: [
          { url: 'https://shop.test/', severity: 'error', code: 'x', message: 'ok' },
          { url: '', severity: 'error', code: 'x', message: 'missing url' },
          { url: 'https://shop.test/b', severity: 'invalid', code: 'x', message: 'bad sev' },
          { severity: 'info', code: 'x', message: 'no url at all' },
        ],
      },
    })
    expect(merged.last_scan_report?.issues).toHaveLength(1)
    expect(merged.last_scan_report?.issues[0]?.url).toBe('https://shop.test/')
  })

  it('non-array issues → empty list, report still built', () => {
    const merged = mergeSettings({
      last_scan_report: { pages_scanned: 0, score: 100, issues: 'oops' },
    })
    expect(merged.last_scan_report?.issues).toEqual([])
  })

  it('non-object report → null', () => {
    const merged = mergeSettings({ last_scan_report: 'oops' })
    expect(merged.last_scan_report).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// applyTitleTemplate
// ---------------------------------------------------------------------------

describe('applyTitleTemplate', () => {
  it('expands {page_title} and {shop_name}', () => {
    expect(
      applyTitleTemplate('{page_title} — {shop_name}', {
        page_title: 'All Products',
        shop_name: 'Acme',
      }),
    ).toBe('All Products — Acme')
  })

  it('{resource_title} aliases {page_title}', () => {
    expect(
      applyTitleTemplate('{resource_title} at {shop_name}', {
        page_title: 'Hoodie',
        shop_name: 'Acme',
      }),
    ).toBe('Hoodie at Acme')
  })

  it('leaves unknown tokens untouched', () => {
    expect(
      applyTitleTemplate('{page_title} | {unknown}', {
        page_title: 'P',
        shop_name: 'S',
      }),
    ).toBe('P | {unknown}')
  })

  it('replaces every occurrence, not just the first', () => {
    expect(
      applyTitleTemplate('{page_title} — {page_title}', {
        page_title: 'X',
        shop_name: 'Y',
      }),
    ).toBe('X — X')
  })
})

// ---------------------------------------------------------------------------
// resolveSettings / setShopSettings / recordScanReport
// ---------------------------------------------------------------------------

describe('resolveSettings / setShopSettings', () => {
  it('resolveSettings returns defaults for an unconfigured shop', async () => {
    const db = makeDb([{ id: 'shop_1', seo_settings: {}, updated_at: 't0' }])
    const s = await resolveSettings(db as any, 'shop_1')
    expect(s).toEqual(DEFAULT_SEO_SETTINGS)
  })

  it('resolveSettings merges persisted blob', async () => {
    const db = makeDb([
      {
        id: 'shop_1',
        seo_settings: { twitter_handle: '@gbox', robots_noindex: true },
        updated_at: 't0',
      },
    ])
    const s = await resolveSettings(db as any, 'shop_1')
    expect(s.twitter_handle).toBe('@gbox')
    expect(s.robots_noindex).toBe(true)
    expect(s.default_description).toBeNull()
  })

  it('resolveSettings on missing row → defaults', async () => {
    const db = makeDb([])
    const s = await resolveSettings(db as any, 'nope')
    expect(s).toEqual(DEFAULT_SEO_SETTINGS)
  })

  it('setShopSettings persists full object', async () => {
    const db = makeDb([{ id: 'shop_1', seo_settings: {}, updated_at: 't0' }])
    const next: SeoSettings = {
      ...DEFAULT_SEO_SETTINGS,
      twitter_handle: '@gbox',
      google_analytics_id: 'G-XYZ',
      robots_noindex: true,
    }
    await setShopSettings(db as any, 'shop_1', next)
    const reloaded = await resolveSettings(db as any, 'shop_1')
    expect(reloaded.twitter_handle).toBe('@gbox')
    expect(reloaded.google_analytics_id).toBe('G-XYZ')
    expect(reloaded.robots_noindex).toBe(true)
  })

  it('setShopSettings preserves existing scan report when caller omits it', async () => {
    const prior: SeoScanReport = {
      pages_scanned: 5,
      score: 75,
      issues: [
        { url: 'https://a', severity: 'warning', code: 'x', message: 'ok' },
      ],
    }
    const db = makeDb([
      {
        id: 'shop_1',
        seo_settings: {
          twitter_handle: '@old',
          last_scan_at: '2026-04-20T00:00:00.000Z',
          last_scan_report: prior,
        },
        updated_at: 't0',
      },
    ])
    const next: SeoSettings = {
      ...DEFAULT_SEO_SETTINGS,
      twitter_handle: '@new',
      last_scan_at: null, // admin form doesn't include it
      last_scan_report: null,
    }
    await setShopSettings(db as any, 'shop_1', next)
    const reloaded = await resolveSettings(db as any, 'shop_1')
    expect(reloaded.twitter_handle).toBe('@new')
    expect(reloaded.last_scan_at).toBe('2026-04-20T00:00:00.000Z')
    expect(reloaded.last_scan_report).toEqual(prior)
  })
})

describe('recordScanReport', () => {
  it('stamps last_scan_at and writes report', async () => {
    const db = makeDb([
      {
        id: 'shop_1',
        seo_settings: { twitter_handle: '@keep' },
        updated_at: 't0',
      },
    ])
    const report: SeoScanReport = {
      pages_scanned: 3,
      score: 85,
      issues: [
        { url: 'https://a', severity: 'info', code: 'missing_alt', message: 'ok' },
      ],
    }
    const frozen = new Date('2026-04-21T10:00:00.000Z')
    await recordScanReport(db as any, 'shop_1', report, frozen)
    const reloaded = await resolveSettings(db as any, 'shop_1')
    expect(reloaded.last_scan_at).toBe('2026-04-21T10:00:00.000Z')
    expect(reloaded.last_scan_report).toEqual(report)
    // Preserves unrelated fields
    expect(reloaded.twitter_handle).toBe('@keep')
  })

  it('defaults `now` to current date when not provided', async () => {
    const db = makeDb([{ id: 'shop_1', seo_settings: {}, updated_at: 't0' }])
    const before = Date.now()
    await recordScanReport(db as any, 'shop_1', {
      pages_scanned: 1,
      score: 100,
      issues: [],
    })
    const after = Date.now()
    const reloaded = await resolveSettings(db as any, 'shop_1')
    const stamp = Date.parse(reloaded.last_scan_at!)
    expect(stamp).toBeGreaterThanOrEqual(before)
    expect(stamp).toBeLessThanOrEqual(after)
  })
})
