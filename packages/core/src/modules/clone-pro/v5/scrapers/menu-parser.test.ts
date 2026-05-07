import { describe, it, expect } from 'vitest'
import { parseMenuTree } from './menu-parser.js'

const homepageHtml = `
<html><body>
  <header>
    <nav>
      <ul>
        <li><a href="/collections/all">Shop All</a></li>
        <li>
          <a href="/collections/men">Men</a>
          <ul>
            <li><a href="/collections/men-tops">Tops</a></li>
            <li><a href="/collections/men-pants">Pants</a></li>
          </ul>
        </li>
        <li><a href="/pages/about">About</a></li>
      </ul>
    </nav>
  </header>
</body></html>
`

describe('parseMenuTree', () => {
  it('extracts nested menu items from <header><nav>', () => {
    const tree = parseMenuTree(homepageHtml, 'https://shop.example.com')
    expect(tree.handle).toBe('main-menu')
    expect(tree.nodes).toHaveLength(3)
    expect(tree.nodes[0].label).toBe('Shop All')
    expect(tree.nodes[0].url).toBe('https://shop.example.com/collections/all')
    expect(tree.nodes[1].children).toHaveLength(2)
    expect(tree.nodes[1].children[0].label).toBe('Tops')
  })

  it('resolves relative URLs against sourceUrl', () => {
    const tree = parseMenuTree(homepageHtml, 'https://shop.example.com')
    expect(tree.nodes[2].url).toBe('https://shop.example.com/pages/about')
  })

  it('returns empty tree when no <nav> found', () => {
    const tree = parseMenuTree('<html><body>no nav</body></html>', 'https://x.com')
    expect(tree.nodes).toEqual([])
  })
})
