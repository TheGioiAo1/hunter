import type { BucketScraper, MenuDTO, MenuItemDTO } from './types.js'

export const menuScraper: BucketScraper<MenuDTO> = {
  classification: 'page',
  async scrape(page, _ctx) {
    if (new URL(page.sourceUrl).pathname !== '/') return null
    const navMatch = page.html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i)
    if (!navMatch) return null

    const items = parseUlList(navMatch[1])
    return {
      sourceHandle: 'main-menu',
      title: 'Main Menu',
      items,
    }
  },
}

function parseUlList(html: string): MenuItemDTO[] {
  const ulMatch = html.match(/<ul[^>]*>([\s\S]*)<\/ul>/i)
  if (!ulMatch) return []
  const inner = ulMatch[1]

  const items: MenuItemDTO[] = []
  let pos = 0
  let depth = 0
  let buf = ''
  let inLi = false
  for (let i = 0; i < inner.length; i++) {
    const remaining = inner.slice(i)
    const liOpen = remaining.match(/^<li[^>]*>/i)
    const liClose = remaining.match(/^<\/li>/i)
    if (liOpen && depth === 0) {
      inLi = true; buf = ''; depth = 1; i += liOpen[0].length - 1; continue
    }
    if (liOpen && depth > 0) { depth++; buf += liOpen[0]; i += liOpen[0].length - 1; continue }
    if (liClose) {
      depth--
      if (depth === 0 && inLi) {
        const item = parseLiBuffer(buf, ++pos)
        if (item) items.push(item)
        inLi = false; buf = ''
        i += liClose[0].length - 1; continue
      }
      buf += liClose[0]
      i += liClose[0].length - 1; continue
    }
    if (inLi) buf += inner[i]
  }
  return items
}

function parseLiBuffer(buf: string, position: number): MenuItemDTO | null {
  const aMatch = buf.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
  if (!aMatch) return null
  const url = aMatch[1]
  const title = aMatch[2].replace(/<[^>]+>/g, '').trim()
  const childUlMatch = buf.match(/<ul[^>]*>[\s\S]*<\/ul>/i)
  const children = childUlMatch ? parseUlList(childUlMatch[0]) : []
  return { title, url, position, children }
}
