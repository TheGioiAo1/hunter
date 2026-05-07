/**
 * Design Library — emit-pipeline hook tests (Phase D2).
 *
 * The hook runs at the TAIL of every clone-pro pipeline. These tests
 * lock its three contracts:
 *
 *   1. SKIPS  — when `design` is missing, or `jobId` is missing,
 *               the hook returns without touching the DB (important:
 *               stubbed DB would throw if called).
 *
 *   2. HAPPY  — when all prereqs are present, the hook calls the
 *               underlying DB write with the right row shape
 *               (slug format, shopId, sourceCloneJobId wiring, etc.)
 *               and returns `{ emitted: true, slug }`.
 *
 *   3. SWALLOW — when the DB write throws (e.g. duplicate slug
 *                conflict), the hook logs + returns
 *                `{ emitted: false, reason: 'insert-failed', error }`
 *                WITHOUT rethrowing. Clone pipelines must stay green.
 *
 * The DB is stubbed — we don't want this test touching a real Postgres.
 * It's a unit test on the glue code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractedDesign } from '../clone-pro/types.js'

// Mock the DB write — we want to assert arguments + control outcome.
// We capture the mock reference so each test can reconfigure it.
const insertCloneEntryMock = vi.fn()
vi.mock('./upsert.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./upsert.js')>()
  return {
    ...actual,
    insertCloneEntry: (...args: unknown[]) => insertCloneEntryMock(...args),
  }
})

// Import AFTER the mock is registered — otherwise the real function
// gets bound into `emit-pipeline` before our stub takes effect.
const { emitCloneEntry } = await import('./emit-pipeline.js')

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeDesign(): ExtractedDesign {
  return {
    palette: {
      primary: '#FF5A5F',
      secondary: '#00A699',
      accent: '#FC642D',
      background: '#FFFFFF',
      surface: '#F7F7F7',
      text: '#484848',
      textMuted: '#767676',
      border: '#EBEBEB',
      success: '#008A05',
      error: '#C13515',
      warning: '#FFB400',
    },
    typography: {
      headingFamily: 'Circular, sans-serif',
      bodyFamily: 'Inter, sans-serif',
      headingWeight: '700',
      bodyWeight: '400',
      baseSize: '16px',
      lineHeight: '1.5',
      googleFontsUrls: [],
    },
    layout: {
      maxWidth: '1280px',
      containerPadding: '24px',
      sectionGap: '96px',
      gridColumns: 12,
      hasAnnouncement: false,
      hasStickyHeader: true,
      hasHero: true,
      hasMegaMenu: false,
      footerColumns: 4,
    },
    sections: [
      { type: 'header', position: 0, estimatedHeight: '80px', classes: [] },
      { type: 'hero', position: 1, estimatedHeight: '600px', classes: [] },
    ],
    style: 'modern',
  }
}

/** A Kysely handle stub. The emit hook only passes it through to
 *  the mocked `insertCloneEntry`, so we don't need a real DB. */
const fakeDb = {} as unknown as Parameters<typeof emitCloneEntry>[0]

// ---------------------------------------------------------------------------
// Silence the console — the hook logs skip/error lines. We want the
// logs in production but not in CI output.
// ---------------------------------------------------------------------------

beforeEach(() => {
  insertCloneEntryMock.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1. Skips
// ---------------------------------------------------------------------------

describe('emitCloneEntry — skip branches', () => {
  it('skips when design is undefined (extract_design did not run)', async () => {
    const result = await emitCloneEntry(fakeDb, {
      design: undefined,
      sourceUrl: 'https://example.com',
      shopId: 'shop-1',
      jobId: 'job-1',
      themeId: 'theme-1',
    })
    expect(result).toEqual({ emitted: false, reason: 'design-not-extracted' })
    expect(insertCloneEntryMock).not.toHaveBeenCalled()
  })

  it('skips when jobId is undefined (test harness, not production)', async () => {
    const result = await emitCloneEntry(fakeDb, {
      design: makeDesign(),
      sourceUrl: 'https://example.com',
      shopId: 'shop-1',
      jobId: undefined,
      themeId: 'theme-1',
    })
    expect(result).toEqual({ emitted: false, reason: 'no-job-id' })
    expect(insertCloneEntryMock).not.toHaveBeenCalled()
  })

  it('skips when jobId is the empty string', async () => {
    const result = await emitCloneEntry(fakeDb, {
      design: makeDesign(),
      sourceUrl: 'https://example.com',
      shopId: 'shop-1',
      jobId: '',
      themeId: null as unknown as undefined,
    })
    expect(result).toEqual({ emitted: false, reason: 'no-job-id' })
    expect(insertCloneEntryMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 2. Happy path
// ---------------------------------------------------------------------------

describe('emitCloneEntry — happy path', () => {
  it('writes a row via insertCloneEntry with the expected shape', async () => {
    insertCloneEntryMock.mockResolvedValue({ id: 'new-entry-uuid' })

    const result = await emitCloneEntry(fakeDb, {
      design: makeDesign(),
      sourceUrl: 'https://www.airbnb.com/',
      shopId: 'shop-42',
      jobId: '6df3a4b1-c290-4f22-a0ce-deadbeef1234',
      themeId: 'theme-99',
    })

    // Hook returned the expected slug.
    expect(result).toEqual({
      emitted: true,
      slug: 'airbnb-com-6df3a4b1',
    })

    // DB write happened exactly once.
    expect(insertCloneEntryMock).toHaveBeenCalledTimes(1)

    // Arguments assertion — lock the mapping from CloneEmitInput to
    // CloneDesignInput. A refactor that swaps shopId/jobId would trip here.
    const [, cloneInput] = insertCloneEntryMock.mock.calls[0]
    expect(cloneInput).toMatchObject({
      slug: 'airbnb-com-6df3a4b1',
      shopId: 'shop-42',
      sourceThemeId: 'theme-99',
      sourceCloneJobId: '6df3a4b1-c290-4f22-a0ce-deadbeef1234',
      // D3 owns preview files — hook always writes nulls here.
      previewHtml: null,
      previewDarkHtml: null,
    })
    // Title + summary come from the serializer round-trip.
    expect(cloneInput.title).toBe('Airbnb.com')
    expect(cloneInput.summary).toMatch(/^A modern design cloned from airbnb\.com/)
    // designMd must be the full serialized body (H1 + 5 sections).
    expect(cloneInput.designMd).toMatch(/^# Airbnb\.com\n/)
    expect(cloneInput.designMd).toMatch(/## 1\. Visual Theme/)
    expect(cloneInput.designMd).toMatch(/## 5\. Sections Detected/)
  })

  it('passes sourceThemeId=null when themeId is undefined', async () => {
    // Clone that failed the generate_theme stage non-fatally — no theme
    // to link, but the gallery row should still be emitted.
    insertCloneEntryMock.mockResolvedValue({ id: 'x' })
    await emitCloneEntry(fakeDb, {
      design: makeDesign(),
      sourceUrl: 'https://example.com',
      shopId: 'shop-1',
      jobId: 'job-abcd1234',
      themeId: undefined,
    })
    const [, cloneInput] = insertCloneEntryMock.mock.calls[0]
    expect(cloneInput.sourceThemeId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. Swallow errors
// ---------------------------------------------------------------------------

describe('emitCloneEntry — error swallowing', () => {
  it('returns insert-failed + does NOT rethrow when insertCloneEntry throws', async () => {
    insertCloneEntryMock.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "idx_design_library_clone_slug"'),
    )

    // The hook MUST resolve — throwing here would break the clone
    // pipeline's promise chain and mark an otherwise-successful clone
    // as failed.
    const result = await emitCloneEntry(fakeDb, {
      design: makeDesign(),
      sourceUrl: 'https://example.com',
      shopId: 'shop-1',
      jobId: 'job-1',
      themeId: 'theme-1',
    })

    expect(result).toMatchObject({
      emitted: false,
      reason: 'insert-failed',
    })
    if (!result.emitted) {
      expect(result.error).toMatch(/duplicate key/)
    }
  })

  it('logs a warning when swallowing (discoverable in pipeline logs)', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    insertCloneEntryMock.mockRejectedValue(new Error('connection lost'))
    await emitCloneEntry(fakeDb, {
      design: makeDesign(),
      sourceUrl: 'https://example.com',
      shopId: 'shop-1',
      jobId: 'job-xyz',
      themeId: 'theme-1',
    })
    expect(warnSpy).toHaveBeenCalled()
    const warning = String(warnSpy.mock.calls[0]?.[0] ?? '')
    expect(warning).toContain('design-library')
    expect(warning).toContain('shop=shop-1')
    expect(warning).toContain('jobId=job-xyz')
  })
})
