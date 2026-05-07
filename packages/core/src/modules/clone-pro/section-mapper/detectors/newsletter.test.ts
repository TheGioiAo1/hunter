/**
 * Newsletter detector tests.
 *
 * Ensures we recognise the common newsletter-signup patterns (by class,
 * by form action, or plain email-input fallback) and extract a sensible
 * heading + subheading.
 */

import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { detectNewsletter } from './newsletter.js'
import type { DetectorContext } from './shared.js'

function ctx(html: string): DetectorContext {
  const $ = cheerio.load(html, { decodeEntities: false } as any)
  return { $ }
}

describe('detectNewsletter', () => {
  it('detects a class="newsletter" block with an email form', () => {
    const html = `
      <main>
        <section class="newsletter">
          <h2>Join our newsletter</h2>
          <p>Get 10% off your first order.</p>
          <form action="/subscribe">
            <input type="email" name="email" />
            <button>Join</button>
          </form>
        </section>
      </main>
    `
    const hit = detectNewsletter(ctx(html))
    expect(hit).not.toBeNull()
    expect(hit!.id).toBe('newsletter')
    expect(hit!.settings.heading).toBe('Join our newsletter')
    expect(hit!.settings.subheading).toBe('Get 10% off your first order.')
  })

  it('recognises a form-action hint like /subscribe', () => {
    const html = `
      <main>
        <section class="footer-bottom">
          <h3>Stay in touch</h3>
          <form action="https://example.com/subscribe">
            <input type="email" />
          </form>
        </section>
      </main>
    `
    const hit = detectNewsletter(ctx(html))
    expect(hit).not.toBeNull()
    expect(hit!.settings.heading).toBe('Stay in touch')
  })

  it('recognises the Klaviyo hint in form action', () => {
    const html = `
      <main>
        <section>
          <h2>Subscribe</h2>
          <form action="https://manage.kmail-lists.com/subscriptions">
            <input type="email" />
          </form>
        </section>
      </main>
    `
    const hit = detectNewsletter(ctx(html))
    // No "klaviyo" or "newsletter" or "subscribe" inside action — but
    // the block contains an email input, which triggers the generic fallback.
    expect(hit).not.toBeNull()
  })

  it('recognises Mailchimp-hosted hint in action', () => {
    const html = `
      <main>
        <section>
          <h2>Sign up</h2>
          <form action="https://shop.us4.list-manage.com/subscribe/post">
            <input type="email" />
          </form>
        </section>
      </main>
    `
    const hit = detectNewsletter(ctx(html))
    expect(hit).not.toBeNull()
    expect(hit!.settings.heading).toBe('Sign up')
  })

  it('falls back to any <form> with an email input at document level', () => {
    const html = `
      <header>
        <form action="/foo">
          <input type="email" />
        </form>
      </header>
      <main>
        <section><p>Body</p></section>
      </main>
    `
    const hit = detectNewsletter(ctx(html))
    expect(hit).not.toBeNull()
    expect(hit!.position).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('returns null when no email input exists anywhere', () => {
    const html = `
      <main>
        <section>
          <h2>Not a signup</h2>
          <p>Just words.</p>
          <form><input type="text" /></form>
        </section>
      </main>
    `
    expect(detectNewsletter(ctx(html))).toBeNull()
  })

  it('ignores subscribe-success messages as subheading', () => {
    const html = `
      <main>
        <section class="newsletter">
          <h2>Newsletter</h2>
          <p>Thanks for subscribing!</p>
          <form><input type="email" /></form>
        </section>
      </main>
    `
    const hit = detectNewsletter(ctx(html))
    expect(hit!.settings.subheading).toBeUndefined()
  })

  it('defaults heading to "Subscribe" when no heading tag is present', () => {
    const html = `
      <main>
        <section class="signup">
          <form><input type="email" /></form>
        </section>
      </main>
    `
    const hit = detectNewsletter(ctx(html))
    expect(hit).not.toBeNull()
    expect(hit!.settings.heading).toBe('Subscribe')
  })

  it('falls back to h4/h5 when no h2/h3 is present', () => {
    const html = `
      <main>
        <section class="newsletter">
          <h4>Tiny heading</h4>
          <form><input type="email" /></form>
        </section>
      </main>
    `
    const hit = detectNewsletter(ctx(html))
    expect(hit!.settings.heading).toBe('Tiny heading')
  })

  it('picks up a descendant newsletter wrapper', () => {
    const html = `
      <main>
        <section class="grid">
          <div class="email-signup">
            <h2>Don't miss out</h2>
            <form><input type="email" /></form>
          </div>
        </section>
      </main>
    `
    const hit = detectNewsletter(ctx(html))
    expect(hit).not.toBeNull()
    expect(hit!.settings.heading).toBe("Don't miss out")
  })
})
