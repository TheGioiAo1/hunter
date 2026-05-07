/**
 * Hero detector tests.
 *
 * The detector's job is pattern-matching on messy homepages. These tests
 * pin the common shapes we expect to recognise (and a handful we don't).
 */

import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { detectHero } from './hero.js'
import type { DetectorContext } from './shared.js'

function ctx(html: string, baseUrl?: string): DetectorContext {
  const $ = cheerio.load(html, { decodeEntities: false } as any)
  return { $, baseUrl }
}

describe('detectHero', () => {
  it('detects a class="hero" block with heading, subheading, and CTA', () => {
    const html = `
      <main>
        <section class="hero">
          <h1>Built for builders</h1>
          <p>Everything you need to launch a store in one afternoon.</p>
          <a href="/collections/featured">Shop the collection</a>
        </section>
      </main>
    `
    const hit = detectHero(ctx(html, 'https://example.com'))
    expect(hit).not.toBeNull()
    expect(hit!.id).toBe('hero')
    expect(hit!.position).toBe(0)
    expect(hit!.settings.heading).toBe('Built for builders')
    expect(hit!.settings.subheading).toContain('launch a store')
    expect(hit!.settings.cta_label).toBe('Shop the collection')
    expect(hit!.settings.cta_link).toBe('https://example.com/collections/featured')
  })

  it('recognises the "banner" class variant', () => {
    const html = `
      <main>
        <div class="page-banner">
          <h1>Hello</h1>
          <a href="/shop">Shop</a>
        </div>
      </main>
    `
    const hit = detectHero(ctx(html))
    expect(hit).not.toBeNull()
    expect(hit!.settings.heading).toBe('Hello')
  })

  it('falls back to h1 + CTA at position 0 when no hero class present', () => {
    const html = `
      <main>
        <section>
          <h1>Welcome home</h1>
          <a href="/shop">Start shopping</a>
        </section>
        <section class="random"><p>More content</p></section>
      </main>
    `
    const hit = detectHero(ctx(html))
    expect(hit).not.toBeNull()
    expect(hit!.settings.heading).toBe('Welcome home')
    expect(hit!.settings.cta_label).toBe('Start shopping')
  })

  it('extracts a background image from a CSS url(...) style', () => {
    const html = `
      <main>
        <section class="hero" style="background-image: url('/media/banner.jpg')">
          <h1>On sale</h1>
        </section>
      </main>
    `
    const hit = detectHero(ctx(html, 'https://shop.com'))
    expect(hit).not.toBeNull()
    expect(hit!.settings.background_image).toBe('https://shop.com/media/banner.jpg')
  })

  it('picks up <img src> as the background image', () => {
    const html = `
      <main>
        <section class="hero">
          <img src="/img/h1.png" alt="" />
          <h1>Big sale</h1>
          <a href="/sale">Go</a>
        </section>
      </main>
    `
    const hit = detectHero(ctx(html, 'https://brand.test'))
    expect(hit).not.toBeNull()
    expect(hit!.settings.background_image).toBe('https://brand.test/img/h1.png')
  })

  it('returns null when no hero-ish block exists', () => {
    const html = `
      <main>
        <section class="plain">
          <p>Just a paragraph, no heading.</p>
        </section>
      </main>
    `
    expect(detectHero(ctx(html))).toBeNull()
  })

  it('handles a descendant hero wrapper inside a generic block', () => {
    const html = `
      <main>
        <section class="page-section">
          <div class="hero-wrapper">
            <h2>Hey</h2>
            <a href="/shop">Shop</a>
          </div>
        </section>
      </main>
    `
    const hit = detectHero(ctx(html))
    expect(hit).not.toBeNull()
    expect(hit!.settings.heading).toBe('Hey')
  })

  it('does not match on a jumbotron without any heading', () => {
    const html = `
      <main>
        <section class="jumbotron">
          <p>Just copy, no heading at all.</p>
        </section>
      </main>
    `
    expect(detectHero(ctx(html))).toBeNull()
  })

  it('resolves protocol-relative image urls to https', () => {
    const html = `
      <main>
        <section class="hero">
          <img src="//cdn.example.com/a.png" />
          <h1>Hi</h1>
          <a href="/x">Go</a>
        </section>
      </main>
    `
    const hit = detectHero(ctx(html))
    expect(hit!.settings.background_image).toBe('https://cdn.example.com/a.png')
  })

  it('handles data-src lazy-loaded images', () => {
    const html = `
      <main>
        <section class="hero">
          <img data-src="/lazy.jpg" />
          <h1>Yo</h1>
          <a href="/go">Go</a>
        </section>
      </main>
    `
    const hit = detectHero(ctx(html, 'https://x.com'))
    expect(hit!.settings.background_image).toBe('https://x.com/lazy.jpg')
  })
})
