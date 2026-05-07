/**
 * Featured-collection detector tests.
 *
 * Validates the rules that decide whether a block of homepage HTML looks
 * like a product grid / featured collection, and the settings we extract
 * (heading, subheading, products_to_show, collection_handle).
 */

import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { detectFeaturedCollection } from './featured-collection.js'
import type { DetectorContext } from './shared.js'

function ctx(html: string): DetectorContext {
  const $ = cheerio.load(html, { decodeEntities: false } as any)
  return { $ }
}

describe('detectFeaturedCollection', () => {
  it('detects a class="product-grid" block with product cards', () => {
    const html = `
      <main>
        <section class="home-products">
          <h2>Our best sellers</h2>
          <ul class="product-grid">
            <li class="product-card"><a href="/products/a">A</a></li>
            <li class="product-card"><a href="/products/b">B</a></li>
            <li class="product-card"><a href="/products/c">C</a></li>
          </ul>
        </section>
      </main>
    `
    const hit = detectFeaturedCollection(ctx(html))
    expect(hit).not.toBeNull()
    expect(hit!.id).toBe('featured-collection')
    expect(hit!.settings.heading).toBe('Our best sellers')
    expect(hit!.settings.products_to_show).toBe(3)
  })

  it('extracts the collection handle from the first /collections/<handle> link', () => {
    const html = `
      <main>
        <section class="product-grid">
          <h2>Shop the edit</h2>
          <a class="product-card" href="/collections/summer/products/sunglasses">Sunglasses</a>
          <a class="product-card" href="/collections/summer/products/hat">Hat</a>
        </section>
      </main>
    `
    const hit = detectFeaturedCollection(ctx(html))
    expect(hit!.settings.collection_handle).toBe('summer')
  })

  it('clamps products_to_show to [2, 24]', () => {
    // A grid with 30 cards
    const cards = Array.from({ length: 30 }).map((_, i) => `<div class="product-card">p${i}</div>`).join('')
    const html = `
      <main>
        <section class="product-grid">
          <h2>Many products</h2>
          ${cards}
        </section>
      </main>
    `
    const hit = detectFeaturedCollection(ctx(html))
    expect(hit!.settings.products_to_show).toBe(24)
  })

  it('defaults products_to_show to at least 2', () => {
    const html = `
      <main>
        <section class="featured-collection">
          <h2>Alone</h2>
          <div class="product-card">Only one</div>
        </section>
      </main>
    `
    const hit = detectFeaturedCollection(ctx(html))
    expect(hit!.settings.products_to_show).toBeGreaterThanOrEqual(2)
  })

  it('falls back to the structural rule (≥2 product cards) when class does not match', () => {
    const html = `
      <main>
        <section class="section-wrap">
          <h2>Shop now</h2>
          <article class="product-card">One</article>
          <article class="product-card">Two</article>
          <article class="product-card">Three</article>
        </section>
      </main>
    `
    const hit = detectFeaturedCollection(ctx(html))
    expect(hit).not.toBeNull()
    expect(hit!.settings.heading).toBe('Shop now')
  })

  it('returns null when there are no cards and no matching class', () => {
    const html = `
      <main>
        <section class="plain">
          <h2>Just text</h2>
          <p>Nothing to see.</p>
        </section>
      </main>
    `
    expect(detectFeaturedCollection(ctx(html))).toBeNull()
  })

  it('defaults heading to "Featured collection" when none found', () => {
    const html = `
      <main>
        <section class="product-grid">
          <div class="product-card">A</div>
          <div class="product-card">B</div>
        </section>
      </main>
    `
    const hit = detectFeaturedCollection(ctx(html))
    expect(hit!.settings.heading).toBe('Featured collection')
  })

  it('honours a descendant .product-grid inside a wrapper', () => {
    const html = `
      <main>
        <section class="section-wrap">
          <header><h2>Best sellers</h2></header>
          <div class="product-grid">
            <div class="product-card">A</div>
            <div class="product-card">B</div>
          </div>
        </section>
      </main>
    `
    const hit = detectFeaturedCollection(ctx(html))
    expect(hit).not.toBeNull()
    expect(hit!.settings.heading).toBe('Best sellers')
  })

  it('finds heading in preceding sibling h2 when grid has no inner heading', () => {
    const html = `
      <main>
        <h2>Before grid</h2>
        <div class="product-grid">
          <div class="product-card">A</div>
          <div class="product-card">B</div>
        </div>
      </main>
    `
    const hit = detectFeaturedCollection(ctx(html))
    // Note: iterateBlocks yields children of <main>, so the h2 is its own
    // block — the detector picks up the grid at position 1. The preceding
    // sibling of the grid in its parent is the h2, which the detector uses.
    expect(hit).not.toBeNull()
    expect(hit!.settings.heading).toBe('Before grid')
  })

  it('extracts subheading from header p inside the section-header', () => {
    const html = `
      <main>
        <section class="product-grid">
          <div class="section-header">
            <h2>Latest</h2>
            <p>Curated weekly.</p>
          </div>
          <div class="product-card">A</div>
          <div class="product-card">B</div>
        </section>
      </main>
    `
    const hit = detectFeaturedCollection(ctx(html))
    expect(hit!.settings.subheading).toBe('Curated weekly.')
  })
})
