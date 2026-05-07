/**
 * Clone Pro v5 — bucket guardrails (R3 anti-mix enforcement)
 *
 * Every scraped DTO passes through these validators before persist.
 * Rejections are logged + surfaced in job.stages_json; they never
 * become DB rows.
 */

import type {
  ScrapedProduct, ScrapedCollection, ScrapedPage, MenuTree, MenuNode,
} from '../types.js'

export interface Rejection<T> {
  readonly item: T
  readonly reason: string
}

export interface ValidationResult<T> {
  readonly accepted: readonly T[]
  readonly rejected: readonly Rejection<T>[]
}

const BLOCKED_PAGE_PREFIXES = [
  '/products/', '/collections/', '/blogs/', '/cart', '/checkout', '/account',
]

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export function validateProducts(items: readonly ScrapedProduct[]): ValidationResult<ScrapedProduct> {
  const accepted: ScrapedProduct[] = []
  const rejected: Rejection<ScrapedProduct>[] = []
  for (const p of items) {
    const reason = firstProductIssue(p)
    if (reason) rejected.push({ item: p, reason })
    else accepted.push(p)
  }
  return { accepted, rejected }
}

function firstProductIssue(p: ScrapedProduct): string | null {
  if (!p.handle || p.handle.trim() === '') return 'empty handle'
  if (!p.title || p.title.trim() === '') return 'empty title'
  if (p.images.length === 0) return 'no images (requires ≥1)'
  return null
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export function validateCollections(
  items: readonly ScrapedCollection[],
): ValidationResult<ScrapedCollection> {
  const accepted: ScrapedCollection[] = []
  const rejected: Rejection<ScrapedCollection>[] = []
  for (const c of items) {
    if (!c.handle) rejected.push({ item: c, reason: 'empty handle' })
    else if (!c.title) rejected.push({ item: c, reason: 'empty title' })
    else if (c.product_handles.length === 0) rejected.push({ item: c, reason: 'empty (no products)' })
    else accepted.push(c)
  }
  return { accepted, rejected }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function validatePages(items: readonly ScrapedPage[]): ValidationResult<ScrapedPage> {
  const accepted: ScrapedPage[] = []
  const rejected: Rejection<ScrapedPage>[] = []
  for (const p of items) {
    const reason = firstPageIssue(p)
    if (reason) rejected.push({ item: p, reason })
    else accepted.push(p)
  }
  return { accepted, rejected }
}

function firstPageIssue(p: ScrapedPage): string | null {
  if (!p.title || p.title.trim() === '') return 'empty title'
  if (!p.slug) return 'empty slug'
  try {
    const u = new URL(p.url)
    if (BLOCKED_PAGE_PREFIXES.some((pre) => u.pathname.startsWith(pre))) {
      return `blocked URL prefix (${u.pathname})`
    }
  } catch {
    return 'invalid URL'
  }
  return null
}

// ---------------------------------------------------------------------------
// Menu — flags unresolved links as broken=true
// ---------------------------------------------------------------------------

export interface FlaggedMenuNode extends MenuNode {
  readonly broken?: boolean
  readonly children: readonly FlaggedMenuNode[]
}

export interface FlaggedMenuTree {
  readonly handle: string
  readonly nodes: readonly FlaggedMenuNode[]
}

export function validateMenuTree(
  tree: MenuTree,
  importedUrls: ReadonlySet<string>,
): { tree: FlaggedMenuTree; brokenCount: number } {
  let brokenCount = 0
  const flag = (n: MenuNode): FlaggedMenuNode => {
    const broken = !importedUrls.has(n.url)
    if (broken) brokenCount++
    return {
      ...n,
      broken,
      children: n.children.map(flag),
    }
  }
  return {
    tree: { handle: tree.handle, nodes: tree.nodes.map(flag) },
    brokenCount,
  }
}
