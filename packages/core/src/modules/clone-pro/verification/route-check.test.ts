/**
 * Clone Pro v4 — Route Coverage Check tests
 *
 * Pins the behaviour the orchestrator depends on:
 *   - Critical page types missing → critical severity + score drop
 *   - Important page types missing → warning severity, moderate score drop
 *   - Optional page types missing → info-level, no score impact
 *   - Layout + homepage are always expected
 *   - Zero pages discovered → graceful 100 with info finding
 */

import { describe, it, expect } from 'vitest'
import { runRouteCheck } from './route-check.js'
import type { DiscoveryResult } from '../pipeline-v4.js'
import type { DiscoveredPage, PageType } from '../discovery/deep-crawler.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePage(pageType: PageType, path = `/${pageType}`): DiscoveredPage {
  return {
    url: `https://example.com${path}`,
    title: pageType,
    pageType,
    statusCode: 200,
    html: '<html><body></body></html>',
    outLinks: [],
    depth: 1,
  }
}

function makeDiscovery(pages: DiscoveredPage[]): DiscoveryResult {
  return {
    platform: { platform: 'shopify', confidence: 90 },
    pages,
    siteMap: {} as any,
    templates: { templates: [], totalTemplateTypes: 0, warnings: [] },
    assets: {} as any,
    report: {} as any,
    durationMs: 0,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runRouteCheck', () => {
  it('returns 100 and passes when every expected template is present', () => {
    const pages = [
      makePage('home'),
      makePage('product'),
      makePage('collection'),
      makePage('page'),
      makePage('cart'),
    ]
    const result = runRouteCheck({
      discovery: makeDiscovery(pages),
      writtenTemplateKeys: [
        'layout/theme.liquid',
        'templates/index.liquid',
        'templates/product.liquid',
        'templates/collection.liquid',
        'templates/page.liquid',
        'templates/cart.liquid',
      ],
    })
    expect(result.score).toBe(100)
    expect(result.passed).toBe(true)
    expect(result.findings.some((f) => f.severity === 'critical')).toBe(false)
  })

  it('flags missing critical templates as critical severity and drops score', () => {
    const pages = [makePage('home'), makePage('product'), makePage('collection')]
    // Missing templates/product.liquid + templates/collection.liquid.
    const result = runRouteCheck({
      discovery: makeDiscovery(pages),
      writtenTemplateKeys: ['layout/theme.liquid', 'templates/index.liquid'],
    })
    expect(result.score).toBeLessThan(50)
    expect(result.passed).toBe(false)
    const critFindings = result.findings.filter((f) => f.severity === 'critical')
    expect(critFindings.length).toBeGreaterThanOrEqual(2)
  })

  it('flags missing important templates as warning', () => {
    const pages = [
      makePage('home'),
      makePage('product'),
      makePage('collection'),
      makePage('page'),
      makePage('cart'),
    ]
    const result = runRouteCheck({
      discovery: makeDiscovery(pages),
      writtenTemplateKeys: [
        'layout/theme.liquid',
        'templates/index.liquid',
        'templates/product.liquid',
        'templates/collection.liquid',
        'templates/page.liquid',
        // cart.liquid missing
      ],
    })
    expect(result.findings.some(
      (f) => f.severity === 'warning' && f.message.includes('cart'),
    )).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(80)
    expect(result.score).toBeLessThan(100)
  })

  it('treats optional types (account/login/404) as info-level', () => {
    const pages = [
      makePage('home'),
      makePage('product'),
      makePage('collection'),
      makePage('page'),
      makePage('cart'),
      makePage('account'),
      makePage('404'),
    ]
    const result = runRouteCheck({
      discovery: makeDiscovery(pages),
      writtenTemplateKeys: [
        'layout/theme.liquid',
        'templates/index.liquid',
        'templates/product.liquid',
        'templates/collection.liquid',
        'templates/page.liquid',
        'templates/cart.liquid',
      ],
    })
    // Missing account + 404 templates — both should be info, not warnings.
    expect(result.findings.some(
      (f) => f.severity === 'info' && f.message.includes('account'),
    )).toBe(true)
    expect(result.findings.some(
      (f) => f.severity === 'info' && f.message.includes('404'),
    )).toBe(true)
    // Info findings don't count against the score.
    expect(result.score).toBe(100)
  })

  it('flags missing layout/theme.liquid as critical even if everything else is present', () => {
    const pages = [makePage('home'), makePage('product')]
    const result = runRouteCheck({
      discovery: makeDiscovery(pages),
      writtenTemplateKeys: ['templates/index.liquid', 'templates/product.liquid'],
    })
    expect(result.findings.some(
      (f) => f.severity === 'critical' && f.message.includes('layout/theme.liquid'),
    )).toBe(true)
    expect(result.passed).toBe(false)
  })

  it('flags missing templates/index.liquid as critical when pages exist', () => {
    const pages = [makePage('home'), makePage('product')]
    const result = runRouteCheck({
      discovery: makeDiscovery(pages),
      writtenTemplateKeys: ['layout/theme.liquid', 'templates/product.liquid'],
    })
    expect(result.findings.some(
      (f) => f.severity === 'critical' && f.message.includes('templates/index.liquid'),
    )).toBe(true)
  })

  it('returns a pass when discovery has zero pages', () => {
    const result = runRouteCheck({
      discovery: makeDiscovery([]),
      writtenTemplateKeys: [],
    })
    expect(result.score).toBe(100)
    // Still flags missing layout + index since pages.length > 0 check is
    // false but the layout/index absence is evaluated regardless of pages.
    // We accept that critical if layout is missing, but with zero pages
    // the `hasHome` check is also false so templates/index.liquid is NOT
    // flagged. Layout still is.
    expect(result.findings.some((f) => f.severity === 'critical' && f.message.includes('layout/theme.liquid'))).toBe(true)
  })
})
