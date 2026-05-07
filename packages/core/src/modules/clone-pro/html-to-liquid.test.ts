/**
 * Clone Pro v4 — html-to-liquid templatizer tests
 *
 * Pins the behaviour we actually care about for pixel-perfect cloning:
 *
 *   1. CSS classes on outer elements are preserved verbatim. This is THE
 *      whole point of v4's "scrape real HTML + inject Liquid" approach —
 *      if we lose `class="product-title"`, the source site's CSS no
 *      longer styles the template.
 *
 *   2. Per-page-type substitutions inject the expected Liquid expressions
 *      (product.title / price / images / description, collection loop,
 *      page.content, article fields, cart items).
 *
 *   3. Partial templatization is treated as success with `warnings[]`,
 *      NOT as a thrown error. A page missing some selector should still
 *      emit a template — downstream verification scores fidelity.
 *
 *   4. Tracking scripts are stripped (gtm/fbq/klaviyo/…); JSON-LD stays.
 *
 *   5. Absolute links to the source origin are rewritten to relative paths
 *      when `sourceUrl` is provided.
 */

import { describe, it, expect } from 'vitest'
import { htmlToLiquid } from './html-to-liquid.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapBody(inner: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${inner}</body></html>`
}

// ---------------------------------------------------------------------------
// Product templatizer
// ---------------------------------------------------------------------------

describe('htmlToLiquid — product', () => {
  it('substitutes product.title but keeps the original h1 class', () => {
    const html = wrapBody(`
      <div class="product-page">
        <h1 class="product-title hero-big">Cool T-Shirt</h1>
      </div>
    `)
    const r = htmlToLiquid(html, 'product')
    expect(r.template).toContain('class="product-title hero-big"')
    expect(r.template).toContain('{{ product.title }}')
    // Hardcoded title must be gone — it's where the classes WERE, not their value.
    expect(r.template).not.toContain('Cool T-Shirt')
    expect(r.changes.find((c) => c.field === 'product.title')).toBeTruthy()
  })

  it('substitutes product.price inside the price element', () => {
    const html = wrapBody(`
      <div class="product-page">
        <div class="product-price"><span class="money">$19.99</span></div>
      </div>
    `)
    const r = htmlToLiquid(html, 'product')
    expect(r.template).toContain('{{ product.price | money }}')
    expect(r.template).not.toContain('$19.99')
  })

  it('emits a gallery loop when an image container is present', () => {
    const html = wrapBody(`
      <div class="product-page">
        <div class="product-gallery">
          <img src="/cdn/shirt.jpg" alt="Cool T-Shirt" class="product-img">
          <img src="/cdn/shirt2.jpg" alt="" class="product-img">
        </div>
      </div>
    `)
    const r = htmlToLiquid(html, 'product')
    expect(r.template).toContain('{% for image in product.images %}')
    expect(r.template).toContain("{{ image | img_url: 'large' }}")
    expect(r.template).toContain('{% endfor %}')
  })

  it('substitutes product.description', () => {
    const html = wrapBody(`
      <div class="product-page">
        <div class="product-description"><p>Great shirt.</p></div>
      </div>
    `)
    const r = htmlToLiquid(html, 'product')
    expect(r.template).toContain('{{ product.description }}')
    expect(r.template).not.toContain('Great shirt.')
  })

  it('wires add-to-cart form even when source did not have hidden variant input', () => {
    const html = wrapBody(`
      <div class="product-page">
        <form action="/cart/add" class="product-form">
          <button type="submit">Add</button>
        </form>
      </div>
    `)
    const r = htmlToLiquid(html, 'product')
    expect(r.template).toContain('action="/cart/add"')
    expect(r.template).toContain('name="id"')
    expect(r.template).toContain('{{ product.selected_or_first_available_variant.id }}')
  })

  it('emits warnings for missing selectors rather than throwing', () => {
    const html = wrapBody('<div class="just-a-shell"></div>')
    const r = htmlToLiquid(html, 'product')
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.warnings.some((w) => w.includes('title'))).toBe(true)
    expect(() => htmlToLiquid(html, 'product')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Collection templatizer
// ---------------------------------------------------------------------------

describe('htmlToLiquid — collection', () => {
  it('wraps product cards in {% for product in collection.products %} loop', () => {
    const html = wrapBody(`
      <div class="collection-page">
        <h1 class="collection-title">Summer Sale</h1>
        <div class="product-grid">
          <div class="product-card"><a href="/products/a"><h3>A</h3><span>$10</span></a></div>
          <div class="product-card"><a href="/products/b"><h3>B</h3><span>$20</span></a></div>
          <div class="product-card"><a href="/products/c"><h3>C</h3><span>$30</span></a></div>
        </div>
      </div>
    `)
    const r = htmlToLiquid(html, 'collection')
    expect(r.template).toContain('{% for product in collection.products %}')
    expect(r.template).toContain('{% endfor %}')
    expect(r.template).toContain('{{ product.title }}')
    expect(r.template).toContain('{{ product.price | money }}')
    expect(r.template).toContain('{{ collection.title }}')
    // Duplicate product cards should be stripped so the loop only renders once.
    const cardCount = (r.template.match(/class="product-card"/g) ?? []).length
    expect(cardCount).toBe(1)
  })

  it('rewrites pagination controls to use Liquid paginate object', () => {
    const html = wrapBody(`
      <div class="collection-page">
        <div class="product-card"><a href="/products/a">A</a></div>
        <nav class="pagination"><a href="?page=2">Next</a></nav>
      </div>
    `)
    const r = htmlToLiquid(html, 'collection')
    expect(r.template).toContain('{% if paginate.pages > 1 %}')
    expect(r.template).toContain('paginate.next')
  })
})

// ---------------------------------------------------------------------------
// Page templatizer
// ---------------------------------------------------------------------------

describe('htmlToLiquid — page', () => {
  it('swaps page.title and page.content into the rte area', () => {
    const html = wrapBody(`
      <div class="page-wrap">
        <h1 class="page-title">About</h1>
        <div class="rte"><p>Some content here.</p></div>
      </div>
    `)
    const r = htmlToLiquid(html, 'page')
    expect(r.template).toContain('{{ page.title }}')
    expect(r.template).toContain('{{ page.content }}')
    expect(r.template).not.toContain('Some content here.')
  })

  it('treats policy pages like ordinary pages', () => {
    const html = wrapBody(`<main><h1>Privacy</h1><div class="rte"><p>Policy body</p></div></main>`)
    const r = htmlToLiquid(html, 'policy')
    expect(r.template).toContain('{{ page.title }}')
    expect(r.template).toContain('{{ page.content }}')
  })
})

// ---------------------------------------------------------------------------
// Blog templatizer
// ---------------------------------------------------------------------------

describe('htmlToLiquid — blog index', () => {
  it('wraps article cards in a blog.articles loop', () => {
    const html = wrapBody(`
      <div class="blog-index">
        <h1 class="blog-title">News</h1>
        <article class="article-card"><a href="/blogs/news/a"><h3>Post A</h3></a></article>
        <article class="article-card"><a href="/blogs/news/b"><h3>Post B</h3></a></article>
      </div>
    `)
    const r = htmlToLiquid(html, 'blog')
    expect(r.template).toContain('{% for article in blog.articles %}')
    expect(r.template).toContain('{{ article.title }}')
    expect(r.template).toContain('{{ blog.title }}')
  })
})

// ---------------------------------------------------------------------------
// Blog post templatizer
// ---------------------------------------------------------------------------

describe('htmlToLiquid — blog-post', () => {
  it('substitutes article.title / content / published_at / author', () => {
    const html = wrapBody(`
      <article class="article-content">
        <h1 class="article-title">Big News</h1>
        <time datetime="2025-01-01" class="article-date">Jan 1</time>
        <span class="article-author">Jane Doe</span>
        <div class="rte"><p>Body...</p></div>
      </article>
    `)
    const r = htmlToLiquid(html, 'blog-post')
    expect(r.template).toContain('{{ article.title }}')
    expect(r.template).toContain('{{ article.content }}')
    expect(r.template).toContain("{{ article.published_at | date: '%B %d, %Y' }}")
    expect(r.template).toContain('{{ article.author }}')
    expect(r.template).not.toContain('Jane Doe')
  })
})

// ---------------------------------------------------------------------------
// Cart templatizer
// ---------------------------------------------------------------------------

describe('htmlToLiquid — cart', () => {
  it('wraps cart items in {% for item in cart.items %} and rewrites total', () => {
    const html = wrapBody(`
      <form class="cart-form" action="/cart">
        <div class="cart-item"><span>A</span><span>$10</span></div>
        <div class="cart-total">$10</div>
      </form>
    `)
    const r = htmlToLiquid(html, 'cart')
    expect(r.template).toContain('{% for item in cart.items %}')
    expect(r.template).toContain('{{ cart.total_price | money }}')
    expect(r.template).toContain('action="/cart"')
  })
})

// ---------------------------------------------------------------------------
// Search templatizer
// ---------------------------------------------------------------------------

describe('htmlToLiquid — search', () => {
  it('wraps results in a search.results loop and rewires the query input', () => {
    const html = wrapBody(`
      <div class="search-page">
        <input type="search" name="q" value="old">
        <div class="search-result"><a href="/old"><h3>Old</h3></a></div>
      </div>
    `)
    const r = htmlToLiquid(html, 'search')
    expect(r.template).toContain('{% for item in search.results %}')
    expect(r.template).toContain('{{ search.terms | escape }}')
    expect(r.template).toContain('{% if search.performed')
  })
})

// ---------------------------------------------------------------------------
// Tracking-script removal
// ---------------------------------------------------------------------------

describe('htmlToLiquid — script cleanup', () => {
  it('strips tracking scripts (gtm/fbq/klaviyo) but keeps JSON-LD', () => {
    const html = wrapBody(`
      <main>
        <h1>About</h1>
        <script src="https://www.googletagmanager.com/gtag/js?id=GA-XXX"></script>
        <script>window.dataLayer = [];</script>
        <script type="application/ld+json">{"@context":"http://schema.org"}</script>
        <p>Hi</p>
      </main>
    `)
    const r = htmlToLiquid(html, 'page')
    expect(r.template).not.toContain('googletagmanager')
    expect(r.template).not.toContain('dataLayer')
    expect(r.template).toContain('application/ld+json')
    expect(r.template).toContain('@context')
  })
})

// ---------------------------------------------------------------------------
// URL rewriting
// ---------------------------------------------------------------------------

describe('htmlToLiquid — URL rewriting', () => {
  it('rewrites absolute source links to root-relative paths when sourceUrl is given', () => {
    const html = wrapBody(`
      <main>
        <h1 class="page-title">X</h1>
        <div class="rte">
          <a href="https://source.example.com/about">About</a>
          <a href="https://other.example.com/foo">External</a>
        </div>
      </main>
    `)
    const r = htmlToLiquid(html, 'page', { sourceUrl: 'https://source.example.com' })
    // Internal: stripped to relative
    expect(r.template).not.toContain('https://source.example.com/about')
    // External: untouched (foreign domain)
    // Note: page.content slot replaces the .rte body with {{ page.content }},
    // so the anchor tags disappear. Use a non-rte area to validate rewriting:
    const html2 = wrapBody(`
      <main>
        <h1>X</h1>
        <header class="keeper">
          <a href="https://source.example.com/about">About</a>
          <a href="https://other.example.com/foo">External</a>
        </header>
        <div class="rte">body</div>
      </main>
    `)
    const r2 = htmlToLiquid(html2, 'page', { sourceUrl: 'https://source.example.com', keepHeaderFooter: true })
    expect(r2.template).toContain('href="/about"')
    expect(r2.template).toContain('href="https://other.example.com/foo"')
  })
})

// ---------------------------------------------------------------------------
// Unknown page types + home
// ---------------------------------------------------------------------------

describe('htmlToLiquid — other page types', () => {
  it('passes through unknown page types with a warning', () => {
    const html = wrapBody('<main><h1>404 not found</h1></main>')
    const r = htmlToLiquid(html, '404')
    expect(r.warnings.some((w) => w.includes("'404'"))).toBe(true)
    expect(r.template.length).toBeGreaterThan(0)
  })

  it('emits a warning for home pages and leaves the body intact', () => {
    const html = wrapBody('<main><section>Hero</section></main>')
    const r = htmlToLiquid(html, 'home')
    expect(r.warnings.some((w) => w.toLowerCase().includes('home'))).toBe(true)
    expect(r.template).toContain('Hero')
  })
})

// ---------------------------------------------------------------------------
// Header/footer stripping
// ---------------------------------------------------------------------------

describe('htmlToLiquid — header/footer handling', () => {
  it('strips <header>/<footer>/nav by default', () => {
    const html = wrapBody(`
      <header>NAVIGATION</header>
      <main>
        <h1 class="page-title">X</h1>
        <div class="rte">body</div>
      </main>
      <footer>COPYRIGHT</footer>
    `)
    const r = htmlToLiquid(html, 'page')
    expect(r.template).not.toContain('NAVIGATION')
    expect(r.template).not.toContain('COPYRIGHT')
  })

  it('keeps header/footer when keepHeaderFooter=true', () => {
    const html = wrapBody(`
      <header>NAVIGATION</header>
      <main>
        <h1 class="page-title">X</h1>
        <div class="rte">body</div>
      </main>
      <footer>COPYRIGHT</footer>
    `)
    const r = htmlToLiquid(html, 'page', { keepHeaderFooter: true })
    expect(r.template).toContain('NAVIGATION')
    expect(r.template).toContain('COPYRIGHT')
  })
})
