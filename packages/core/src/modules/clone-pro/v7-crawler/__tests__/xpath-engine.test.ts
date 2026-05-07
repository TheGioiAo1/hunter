import { describe, it, expect } from 'vitest'
import {
  extractValue,
  extractValues,
  applyReplaces,
  extractElements,
} from '../xpath-engine.js'

const HTML = `<html><body>
  <article class="item collection-product">
    <div class="image-container">
      <a href="/products/widget" title="Widget">
        <img data-src="//cdn.shopify.com/x_480x.jpg" />
      </a>
    </div>
    <span class="sell-price">$29.99</span>
    <p class="multi">Hello <b>bold</b> world</p>
  </article>
  <article class="item collection-product">
    <div class="image-container">
      <a href="/products/gadget" title="Gadget">
        <img data-src="//cdn.shopify.com/y_480x.jpg" />
      </a>
    </div>
    <span class="sell-price">$49.50</span>
  </article>
  <p class="entity">Caf&eacute;</p>
</body></html>`

describe('xpath-engine', () => {
  describe('extractValue', () => {
    it('returns text by xpath', () => {
      expect(extractValue(HTML, '//span[@class="sell-price"]', null)).toBe('$29.99')
    })

    it('returns attribute value', () => {
      expect(
        extractValue(HTML, '//div[@class="image-container"]/a', 'title'),
      ).toBe('Widget')
    })

    it('returns first match for non-rooted xpath', () => {
      expect(extractValue(HTML, '//a', 'href')).toBe('/products/widget')
    })

    it('returns concatenated innerText (recursive) like HtmlAgilityPack', () => {
      // Lonspy parity: HtmlAgilityPack InnerText concatenates text from all descendants.
      expect(extractValue(HTML, '//p[@class="multi"]', null)).toContain('Hello')
      expect(extractValue(HTML, '//p[@class="multi"]', null)).toContain('bold')
      expect(extractValue(HTML, '//p[@class="multi"]', null)).toContain('world')
    })

    it('decodes HTML entities', () => {
      expect(extractValue(HTML, '//p[@class="entity"]', null)).toBe('Café')
    })

    it('returns empty string when xpath does not match', () => {
      expect(extractValue(HTML, '//nope', null)).toBe('')
    })

    it('returns empty string when attribute is missing', () => {
      expect(extractValue(HTML, '//span[@class="sell-price"]', 'data-x')).toBe('')
    })

    it('does not throw on malformed xpath', () => {
      expect(extractValue(HTML, '///[[bad', null)).toBe('')
    })

    it('does not throw on malformed html', () => {
      expect(extractValue('<html><body><div', '//div', null)).toBe('')
    })
  })

  describe('extractValues', () => {
    it('returns array of texts', () => {
      const v = extractValues(HTML, '//span[@class="sell-price"]', null)
      expect(v).toEqual(['$29.99', '$49.50'])
    })

    it('returns array of attribute values', () => {
      const v = extractValues(HTML, '//a', 'href')
      expect(v).toEqual(['/products/widget', '/products/gadget'])
    })

    it('returns empty array when xpath does not match', () => {
      expect(extractValues(HTML, '//nope', null)).toEqual([])
    })

    it('filters empty strings out (Lonspy parity)', () => {
      const html = '<html><body><span class="x">a</span><span class="x"></span><span class="x">b</span></body></html>'
      expect(extractValues(html, '//span[@class="x"]', null)).toEqual(['a', 'b'])
    })

    it('does not throw on malformed xpath', () => {
      expect(extractValues(HTML, '///[[bad', null)).toEqual([])
    })
  })

  describe('extractElements (raw HTML chunks for nested extraction)', () => {
    it('returns one HTML chunk per matched node', () => {
      const chunks = extractElements(HTML, '//article')
      expect(chunks).toHaveLength(2)
      expect(chunks[0]).toContain('Widget')
      expect(chunks[1]).toContain('Gadget')
    })
  })

  describe('applyReplaces', () => {
    it('returns input unchanged when replaces is null', () => {
      expect(applyReplaces('//cdn/x.jpg', null)).toBe('//cdn/x.jpg')
    })

    it('removes Shopify _480x image suffix', () => {
      const out = applyReplaces('//cdn.shopify.com/x_480x.jpg', [{ from: '_480x', to: '' }])
      expect(out).toBe('//cdn.shopify.com/x.jpg')
    })

    it('applies multiple replaces in declared order', () => {
      const out = applyReplaces('$29.99 USD', [
        { from: '$', to: '' },
        { from: ' USD', to: '' },
      ])
      expect(out).toBe('29.99')
    })

    it('replaces all occurrences (Lonspy parity — uses string.Replace global)', () => {
      const out = applyReplaces('a-x-a-x-a', [{ from: 'x', to: 'y' }])
      expect(out).toBe('a-y-a-y-a')
    })
  })
})
