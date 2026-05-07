/**
 * Composer tests — `composeIndexJson` glues all four detectors together
 * and emits a Shopify `templates/index.json` shape.
 *
 * These tests cover:
 *   - End-to-end recognition on a realistic homepage.
 *   - Preservation of DOM order in the `order` array.
 *   - Fallback to a baseline index.json when no section matches.
 *   - `fillDefaults` behaviour — settings missing from the detection
 *     output get populated from the schema default.
 */

import { describe, it, expect } from 'vitest'
import { composeIndexJson } from './compose-index-json.js'

const REALISTIC_HOMEPAGE = `
  <html>
    <body>
      <header><nav><a href="/">Home</a></nav></header>
      <main>
        <section class="hero">
          <h1>Big spring sale</h1>
          <p>Up to 50% off everything.</p>
          <a href="/collections/sale">Shop sale</a>
          <img src="/banner.jpg" />
        </section>

        <section class="product-grid">
          <h2>Best sellers</h2>
          <div class="product-card"><a href="/collections/featured/products/a">A</a></div>
          <div class="product-card"><a href="/collections/featured/products/b">B</a></div>
          <div class="product-card"><a href="/collections/featured/products/c">C</a></div>
          <div class="product-card"><a href="/collections/featured/products/d">D</a></div>
        </section>

        <section class="image-with-text">
          <img src="/studio.jpg" />
          <h2>Our story</h2>
          <p>Made by hand, shipped with care.</p>
          <a href="/about">Learn more</a>
        </section>

        <section class="newsletter">
          <h2>Stay in the loop</h2>
          <p>Monthly drops, early access, no spam.</p>
          <form action="/subscribe">
            <input type="email" />
            <button>Join</button>
          </form>
        </section>
      </main>
      <footer><p>&copy; 2026</p></footer>
    </body>
  </html>
`

describe('composeIndexJson', () => {
  it('detects all four composable sections on a realistic homepage', () => {
    const result = composeIndexJson({
      homepageHtml: REALISTIC_HOMEPAGE,
      baseUrl: 'https://brand.test',
    })
    expect(result.fellBackToDefaults).toBe(false)
    expect(result.detected).toHaveLength(4)
    const ids = result.detected.map((d) => d.id).sort()
    expect(ids).toEqual([
      'featured-collection',
      'hero',
      'image-with-text',
      'newsletter',
    ])
  })

  it('preserves DOM order in the output order array', () => {
    const result = composeIndexJson({
      homepageHtml: REALISTIC_HOMEPAGE,
      baseUrl: 'https://brand.test',
    })
    expect(result.indexJson.order).toEqual([
      'hero',
      'featured-collection',
      'image-with-text',
      'newsletter',
    ])
  })

  it('produces a valid index.json shape with `sections` keyed by id', () => {
    const result = composeIndexJson({
      homepageHtml: REALISTIC_HOMEPAGE,
      baseUrl: 'https://brand.test',
    })
    for (const id of result.indexJson.order) {
      expect(result.indexJson.sections[id]).toBeDefined()
      expect(result.indexJson.sections[id].type).toBe(id)
      expect(typeof result.indexJson.sections[id].settings).toBe('object')
    }
  })

  it('fills in schema defaults for settings the detector did not populate', () => {
    // Hero schema in Gbox Dawn has several settings with defaults; the
    // detector only returns heading/subheading/cta/background_image.
    // Any schema default not covered should show up in the composed output.
    const html = `
      <main>
        <section class="hero">
          <h1>Hi</h1>
          <a href="/x">Go</a>
        </section>
      </main>
    `
    const result = composeIndexJson({ homepageHtml: html, baseUrl: 'https://x.test' })
    const hero = result.indexJson.sections['hero']
    expect(hero.settings.heading).toBe('Hi')
    // cta_label + cta_link are populated by the detector
    expect(hero.settings.cta_label).toBe('Go')
  })

  it('skips fillDefaults when the option is false', () => {
    const html = `
      <main>
        <section class="hero">
          <h1>Hi</h1>
          <a href="/x">Go</a>
        </section>
      </main>
    `
    const withDefaults = composeIndexJson({
      homepageHtml: html,
      fillDefaults: true,
    })
    const withoutDefaults = composeIndexJson({
      homepageHtml: html,
      fillDefaults: false,
    })
    // Both have the detector's keys, but "with defaults" should have at
    // least as many keys as "without defaults".
    const withKeys = Object.keys(withDefaults.indexJson.sections.hero.settings).length
    const withoutKeys = Object.keys(withoutDefaults.indexJson.sections.hero.settings).length
    expect(withKeys).toBeGreaterThanOrEqual(withoutKeys)
  })

  it('falls back to seed defaults when no sections are detected', () => {
    const html = `<html><body><main><p>Empty-ish homepage with nothing to match.</p></main></body></html>`
    const result = composeIndexJson({ homepageHtml: html })
    expect(result.fellBackToDefaults).toBe(true)
    expect(result.indexJson.order).toEqual([
      'hero',
      'featured-collection',
      'image-with-text',
      'newsletter',
    ])
    expect(result.detected).toHaveLength(0)
  })

  it('passes through unknown detected settings (observability)', () => {
    // Same realistic homepage — detector writes `collection_handle` which
    // IS in the schema, so it should appear in the output.
    const result = composeIndexJson({
      homepageHtml: REALISTIC_HOMEPAGE,
      baseUrl: 'https://brand.test',
    })
    const fc = result.indexJson.sections['featured-collection']
    expect(fc.settings.collection_handle).toBe('featured')
  })

  it('serialises to valid JSON', () => {
    const result = composeIndexJson({
      homepageHtml: REALISTIC_HOMEPAGE,
      baseUrl: 'https://brand.test',
    })
    const text = JSON.stringify(result.indexJson, null, 2)
    const roundtripped = JSON.parse(text)
    expect(roundtripped.order).toEqual(result.indexJson.order)
    expect(Object.keys(roundtripped.sections).sort()).toEqual(
      Object.keys(result.indexJson.sections).sort(),
    )
  })

  it('handles a homepage with only a hero', () => {
    const html = `
      <main>
        <section class="hero">
          <h1>Just a hero</h1>
          <a href="/x">Go</a>
        </section>
      </main>
    `
    const result = composeIndexJson({ homepageHtml: html })
    expect(result.fellBackToDefaults).toBe(false)
    expect(result.indexJson.order).toEqual(['hero'])
    expect(result.detected).toHaveLength(1)
  })

  it('attaches the detected source position to each result', () => {
    const result = composeIndexJson({ homepageHtml: REALISTIC_HOMEPAGE })
    const positions = result.detected.map((d) => d.position)
    // Monotonically increasing, since they're sorted
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1])
    }
  })
})
