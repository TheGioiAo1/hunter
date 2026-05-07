/**
 * Clone Pro v5 — menu parser
 *
 * Parses <header><nav> anchor tree from homepage HTML.
 * Walks <ul>/<li>/<a> hierarchy preserving parent→child.
 * URLs resolved against sourceUrl (absolute output).
 */

import * as cheerio from 'cheerio'
import type { MenuTree, MenuNode } from '../types.js'

export function parseMenuTree(html: string, sourceUrl: string): MenuTree {
  const $ = cheerio.load(html)
  const nav = $('header nav').first()
  if (nav.length === 0) {
    return { handle: 'main-menu', nodes: [] }
  }
  const topUl = nav.find('ul').first()
  const nodes = parseUl($, topUl, sourceUrl)
  return { handle: 'main-menu', nodes }
}

function parseUl(
  $: cheerio.CheerioAPI,
  ul: cheerio.Cheerio<any>,
  sourceUrl: string,
): MenuNode[] {
  const out: MenuNode[] = []
  ul.children('li').each((_, li) => {
    const $li = $(li)
    const $a = $li.children('a').first()
    if ($a.length === 0) return
    const href = $a.attr('href') || ''
    const label = $a.text().trim()
    if (!label) return
    const childUl = $li.children('ul').first()
    const children = childUl.length > 0 ? parseUl($, childUl, sourceUrl) : []
    out.push({
      label,
      url: resolveUrl(href, sourceUrl),
      children,
    })
  })
  return out
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString()
  } catch {
    return href
  }
}
