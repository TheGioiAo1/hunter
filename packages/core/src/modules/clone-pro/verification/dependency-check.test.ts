/**
 * Clone Pro v4 — External Dependency Audit tests
 *
 * Covers:
 *   - URL extraction across href/src/srcset/url() forms
 *   - Tracking hosts → critical + heavy score penalty
 *   - Self-host-recommended CDNs → warning
 *   - Allowed hosts (fonts/stripe) → info-level, no penalty
 *   - Source origin URLs are skipped (not counted as external)
 */

import { describe, it, expect } from 'vitest'
import { runDependencyCheck, extractUrls } from './dependency-check.js'

// ---------------------------------------------------------------------------
// extractUrls
// ---------------------------------------------------------------------------

describe('extractUrls', () => {
  it('picks URLs out of href, src, and srcset', () => {
    const html = `
      <a href="https://example.com/page">Link</a>
      <img src="https://cdn/image.jpg" srcset="https://cdn/img-1x.jpg 1x, https://cdn/img-2x.jpg 2x">
    `
    const urls = extractUrls(html)
    expect(urls).toContain('https://example.com/page')
    expect(urls).toContain('https://cdn/image.jpg')
    expect(urls).toContain('https://cdn/img-1x.jpg')
    expect(urls).toContain('https://cdn/img-2x.jpg')
  })

  it('picks URLs out of inline style url(...)', () => {
    const html = `<div style="background-image: url('https://cdn/bg.jpg')">X</div>`
    const urls = extractUrls(html)
    expect(urls).toContain('https://cdn/bg.jpg')
  })

  it('ignores relative, protocol-relative, and Liquid URLs', () => {
    const html = `
      <a href="/local">local</a>
      <img src="//cdn/protocol-rel.jpg">
      <img src="{{ product.featured_image | img_url: 'medium' }}">
    `
    const urls = extractUrls(html)
    expect(urls).toEqual([])
  })

  it('deduplicates identical URLs', () => {
    const html = `
      <img src="https://cdn/x.jpg">
      <a href="https://cdn/x.jpg">link</a>
    `
    const urls = extractUrls(html)
    expect(urls).toEqual(['https://cdn/x.jpg'])
  })
})

// ---------------------------------------------------------------------------
// runDependencyCheck
// ---------------------------------------------------------------------------

describe('runDependencyCheck', () => {
  it('scores 100 when every URL is on the source origin', () => {
    const result = runDependencyCheck({
      templates: {
        'templates/product.liquid': '<a href="https://source.example.com/about">about</a>',
      },
      sourceOrigin: 'https://source.example.com',
    })
    expect(result.score).toBe(100)
    expect(result.passed).toBe(true)
  })

  it('flags tracking hosts as critical and slashes the score', () => {
    const result = runDependencyCheck({
      templates: {
        'templates/index.liquid': `
          <script src="https://www.googletagmanager.com/gtag/js?id=GA"></script>
          <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
        `,
      },
      sourceOrigin: 'https://shop.example.com',
    })
    expect(result.findings.some(
      (f) => f.severity === 'critical' && f.message.toLowerCase().includes('tracking'),
    )).toBe(true)
    // Two tracking hosts = -50 from 100.
    expect(result.score).toBeLessThanOrEqual(50)
    expect(result.passed).toBe(false)
  })

  it('flags CDNs as warnings but leaves score respectable', () => {
    const result = runDependencyCheck({
      templates: {
        'templates/product.liquid':
          '<link href="https://cdn.shopify.com/s/files/1/0000/theme.css" rel="stylesheet">' +
          '<script src="https://cdnjs.cloudflare.com/ajax/libs/lib.js"></script>',
      },
      sourceOrigin: 'https://new-shop.example.com',
    })
    const warnings = result.findings.filter((f) => f.severity === 'warning')
    expect(warnings.length).toBeGreaterThanOrEqual(2)
    expect(result.score).toBeLessThan(100)
    expect(result.score).toBeGreaterThanOrEqual(70)
  })

  it('treats allowed hosts (fonts/stripe) as info-level, no score penalty', () => {
    const result = runDependencyCheck({
      templates: {
        'templates/product.liquid':
          '<link href="https://fonts.googleapis.com/css?family=Inter" rel="stylesheet">' +
          '<script src="https://js.stripe.com/v3/"></script>',
      },
      sourceOrigin: 'https://shop.example.com',
    })
    const infoFindings = result.findings.filter((f) => f.severity === 'info')
    expect(infoFindings.length).toBeGreaterThanOrEqual(2)
    expect(result.score).toBe(100)
    expect(result.passed).toBe(true)
  })

  it('returns 100 with info finding when no templates supplied', () => {
    const result = runDependencyCheck({ templates: {} })
    expect(result.score).toBe(100)
    expect(result.passed).toBe(true)
    expect(result.findings[0].severity).toBe('info')
  })
})
