/**
 * Clone Pro v4 — Phase 1.3: Site Mapper
 *
 * Takes the flat list of discovered pages from the deep crawler and builds
 * a hierarchical site map tree. The tree is constructed using URL path
 * segments for parent-child relationships, with outLinks used to refine
 * product→collection associations.
 *
 * @module clone-pro/discovery/site-mapper
 */

import type { DiscoveredPage } from './deep-crawler.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single node in the site map tree. Each node represents a discovered page
 * with its children organized by URL path hierarchy.
 */
export interface SiteMapNode {
  /** Full URL of the page */
  url: string
  /** Page title extracted during crawl */
  title: string
  /** Classified page type */
  pageType: string
  /** Child nodes in the hierarchy */
  children: SiteMapNode[]
  /** Crawl depth from homepage */
  depth: number
}

/**
 * Counts of each page type discovered on the site.
 * Used for quick summary statistics.
 */
export interface PageTypeStats {
  home: number
  product: number
  collection: number
  'list-collections': number
  page: number
  blog: number
  'blog-post': number
  cart: number
  search: number
  account: number
  login: number
  register: number
  policy: number
  password: number
  '404': number
  other: number
  /** Sum of all page types */
  total: number
}

/**
 * The complete site map produced by `buildSiteMap`.
 * Contains the tree structure, grouped pages, statistics,
 * and orphan detection results.
 */
export interface SiteMap {
  /** The source URL that was crawled */
  sourceUrl: string
  /** Total number of pages discovered */
  totalPages: number
  /** Root node of the hierarchical site tree (homepage) */
  tree: SiteMapNode
  /** Pages grouped by their pageType for quick lookup */
  pagesByType: Map<string, DiscoveredPage[]>
  /** Aggregate counts per page type */
  stats: PageTypeStats
  /** Pages not reachable (linked) from any other discovered page */
  orphanPages: DiscoveredPage[]
}

// ---------------------------------------------------------------------------
// All recognized page types — used to initialise stats
// ---------------------------------------------------------------------------

const PAGE_TYPES = [
  'home',
  'product',
  'collection',
  'list-collections',
  'page',
  'blog',
  'blog-post',
  'cart',
  'search',
  'account',
  'login',
  'register',
  'policy',
  'password',
  '404',
  'other',
] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a URL to a consistent pathname for comparison.
 * Strips trailing slashes, lowercases, removes query/hash.
 *
 * @param raw - Raw URL string
 * @returns Normalised pathname (e.g. `/collections/shoes`)
 */
function normalisePath(raw: string): string {
  try {
    const u = new URL(raw)
    return u.pathname.replace(/\/+$/, '') || '/'
  } catch {
    return raw.replace(/\/+$/, '') || '/'
  }
}

/**
 * Extract the origin (scheme + host) from a URL string.
 *
 * @param raw - Raw URL string
 * @returns Origin string or empty string on failure
 */
function extractOrigin(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    return ''
  }
}

/**
 * Derive the parent path for a given pathname.
 * E.g. `/collections/shoes` → `/collections`, `/about` → `/`
 *
 * @param pathname - Normalised pathname
 * @returns Parent pathname
 */
function parentPath(pathname: string): string {
  if (pathname === '/') return ''
  const segments = pathname.split('/')
  segments.pop()
  return segments.join('/') || '/'
}

// ---------------------------------------------------------------------------
// Core: buildSiteMap
// ---------------------------------------------------------------------------

/**
 * Build a hierarchical site map from a flat list of discovered pages.
 *
 * Algorithm:
 * 1. Index all pages by normalised path.
 * 2. Group pages by pageType.
 * 3. Calculate per-type statistics.
 * 4. Build a tree by walking URL path segments (parent-child).
 *    - Products are re-parented under the first collection that links to them
 *      (via outLinks), falling back to URL-based hierarchy.
 * 5. Detect orphan pages (not linked from any other page).
 *
 * @param pages - Flat array of `DiscoveredPage` from the deep crawler
 * @param sourceUrl - The original URL that was crawled
 * @returns Complete `SiteMap` structure
 */
export function buildSiteMap(pages: DiscoveredPage[], sourceUrl: string): SiteMap {
  const origin = extractOrigin(sourceUrl)

  // ----- Index pages by normalised path ------------------------------------
  const pageByPath = new Map<string, DiscoveredPage>()
  for (const page of pages) {
    const path = normalisePath(page.url)
    pageByPath.set(path, page)
  }

  // ----- Group by page type ------------------------------------------------
  const pagesByType = new Map<string, DiscoveredPage[]>()
  for (const page of pages) {
    const group = pagesByType.get(page.pageType) ?? []
    group.push(page)
    pagesByType.set(page.pageType, group)
  }

  // ----- Calculate stats ---------------------------------------------------
  const stats = calculateStats(pages)

  // ----- Build outLink reverse index: child → set of parents ---------------
  // Used to determine which collection "owns" a product.
  const linkedFrom = new Map<string, Set<string>>()
  for (const page of pages) {
    if (!page.outLinks) continue
    for (const link of page.outLinks) {
      const linkPath = normalisePath(link)
      if (!linkedFrom.has(linkPath)) {
        linkedFrom.set(linkPath, new Set())
      }
      linkedFrom.get(linkPath)!.add(normalisePath(page.url))
    }
  }

  // ----- Build tree nodes --------------------------------------------------
  const nodeByPath = new Map<string, SiteMapNode>()

  // Create a SiteMapNode for every page
  for (const page of pages) {
    const path = normalisePath(page.url)
    nodeByPath.set(path, {
      url: page.url,
      title: page.title,
      pageType: page.pageType,
      children: [],
      depth: page.depth,
    })
  }

  // Ensure root exists (may not be in pages if homepage was excluded)
  if (!nodeByPath.has('/')) {
    const homePage = pages.find((p) => p.pageType === 'home')
    nodeByPath.set('/', {
      url: homePage?.url ?? sourceUrl,
      title: homePage?.title ?? 'Home',
      pageType: 'home',
      children: [],
      depth: 0,
    })
  }

  const root = nodeByPath.get('/')!

  // Set of paths already attached to a parent
  const attached = new Set<string>(['/'])

  // First pass: try to attach products under a collection that links to them
  for (const [path, node] of nodeByPath) {
    if (node.pageType !== 'product' || path === '/') continue

    const parents = linkedFrom.get(path)
    if (parents) {
      // Find the first parent that is a collection
      for (const pPath of parents) {
        const parentNode = nodeByPath.get(pPath)
        if (parentNode && parentNode.pageType === 'collection') {
          parentNode.children.push(node)
          attached.add(path)
          break
        }
      }
    }
  }

  // Second pass: attach remaining nodes by URL path hierarchy
  // Sort by path depth so that shallower nodes are attached first
  const sortedPaths = [...nodeByPath.keys()]
    .filter((p) => !attached.has(p))
    .sort((a, b) => {
      const aDepth = a === '/' ? 0 : a.split('/').length
      const bDepth = b === '/' ? 0 : b.split('/').length
      return aDepth - bDepth
    })

  for (const path of sortedPaths) {
    const node = nodeByPath.get(path)!
    let currentParentPath = parentPath(path)

    // Walk up the path until we find a node that exists
    while (currentParentPath && !nodeByPath.has(currentParentPath)) {
      currentParentPath = parentPath(currentParentPath)
    }

    const parentNode = currentParentPath ? nodeByPath.get(currentParentPath) : root
    if (parentNode && parentNode !== node) {
      parentNode.children.push(node)
    } else {
      // Fallback: attach directly to root
      root.children.push(node)
    }
    attached.add(path)
  }

  // Sort children at every level by pageType priority then alphabetically
  sortChildren(root)

  // ----- Detect orphan pages -----------------------------------------------
  const orphanPages = detectOrphans(pages, linkedFrom)

  return {
    sourceUrl,
    totalPages: pages.length,
    tree: root,
    pagesByType,
    stats,
    orphanPages,
  }
}

// ---------------------------------------------------------------------------
// Stats calculation
// ---------------------------------------------------------------------------

/**
 * Count pages per type and produce a `PageTypeStats` object.
 *
 * @param pages - All discovered pages
 * @returns Aggregate statistics
 */
function calculateStats(pages: DiscoveredPage[]): PageTypeStats {
  const counts: Record<string, number> = {}
  for (const t of PAGE_TYPES) counts[t] = 0

  for (const page of pages) {
    if (page.pageType in counts) {
      counts[page.pageType]++
    } else {
      counts['other']++
    }
  }

  return {
    ...(counts as Omit<PageTypeStats, 'total'>),
    total: pages.length,
  } as PageTypeStats
}

// ---------------------------------------------------------------------------
// Orphan detection
// ---------------------------------------------------------------------------

/**
 * Find pages that are not linked to from any other discovered page.
 * A page is orphan if no other page's `outLinks` contain its URL.
 *
 * The homepage is never considered orphan.
 *
 * @param pages - All discovered pages
 * @param linkedFrom - Reverse index of path → set of linking paths
 * @returns Array of orphan `DiscoveredPage` objects
 */
function detectOrphans(
  pages: DiscoveredPage[],
  linkedFrom: Map<string, Set<string>>,
): DiscoveredPage[] {
  const orphans: DiscoveredPage[] = []

  for (const page of pages) {
    const path = normalisePath(page.url)

    // Homepage is never orphan
    if (path === '/' || page.pageType === 'home') continue

    const parents = linkedFrom.get(path)
    if (!parents || parents.size === 0) {
      orphans.push(page)
    }
  }

  return orphans
}

// ---------------------------------------------------------------------------
// Tree sorting
// ---------------------------------------------------------------------------

/** Priority order for page types when sorting tree children. */
const TYPE_PRIORITY: Record<string, number> = {
  'list-collections': 1,
  collection: 2,
  product: 3,
  page: 4,
  blog: 5,
  'blog-post': 6,
  cart: 7,
  search: 8,
  account: 9,
  login: 10,
  register: 11,
  policy: 12,
  password: 13,
  '404': 14,
  other: 15,
}

/**
 * Recursively sort children of a `SiteMapNode` by page type priority
 * and then alphabetically by URL.
 *
 * @param node - Node whose children to sort (mutated in place)
 */
function sortChildren(node: SiteMapNode): void {
  node.children.sort((a, b) => {
    const pa = TYPE_PRIORITY[a.pageType] ?? 99
    const pb = TYPE_PRIORITY[b.pageType] ?? 99
    if (pa !== pb) return pa - pb
    return a.url.localeCompare(b.url)
  })

  for (const child of node.children) {
    sortChildren(child)
  }
}

// ---------------------------------------------------------------------------
// Tree visualisation: printSiteMap
// ---------------------------------------------------------------------------

/**
 * Render the site map as a human-readable text tree.
 *
 * Example output:
 * ```
 * https://example.com (home)
 * ├── /collections (list-collections) [30 children]
 * │   ├── /collections/shoes (collection) [24 children]
 * │   └── /collections/bags (collection) [18 children]
 * ├── /pages/about (page)
 * └── /cart (cart)
 *
 * Stats: 1 home, 30 collections, 245 products, ...
 * Total: 312 pages
 * Orphans: 3 pages not linked from anywhere
 * ```
 *
 * @param siteMap - The `SiteMap` to visualise
 * @returns Multi-line string representation
 */
export function printSiteMap(siteMap: SiteMap): string {
  const lines: string[] = []
  const origin = extractOrigin(siteMap.sourceUrl) || siteMap.sourceUrl

  // Root line
  const rootLabel = `${origin} (${siteMap.tree.pageType})`
  lines.push(rootLabel)

  // Render children recursively
  renderChildren(siteMap.tree.children, '', lines, origin)

  // Blank line before stats
  lines.push('')

  // Stats line
  const statParts: string[] = []
  for (const t of PAGE_TYPES) {
    const count = siteMap.stats[t as keyof Omit<PageTypeStats, 'total'>]
    if (count > 0) {
      statParts.push(`${count} ${t}`)
    }
  }
  lines.push(`Stats: ${statParts.join(', ')}`)
  lines.push(`Total: ${siteMap.stats.total} pages`)

  // Orphans
  if (siteMap.orphanPages.length > 0) {
    lines.push(`Orphans: ${siteMap.orphanPages.length} pages not linked from anywhere`)
  }

  return lines.join('\n')
}

/**
 * Recursively render child nodes as a text tree with box-drawing characters.
 *
 * @param children - Array of child nodes to render
 * @param prefix - Indentation prefix for this level
 * @param lines - Accumulator for output lines
 * @param origin - Site origin for stripping from URLs
 */
function renderChildren(
  children: SiteMapNode[],
  prefix: string,
  lines: string[],
  origin: string,
): void {
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    const isLast = i === children.length - 1
    const connector = isLast ? '└── ' : '├── '
    const childPrefix = isLast ? '    ' : '│   '

    // Display path relative to origin
    const displayPath = child.url.startsWith(origin)
      ? child.url.slice(origin.length) || '/'
      : child.url

    // Build the label
    let label = `${displayPath} (${child.pageType})`
    if (child.children.length > 0) {
      label += ` [${child.children.length} children]`
    }

    lines.push(`${prefix}${connector}${label}`)

    // Recurse into children
    if (child.children.length > 0) {
      renderChildren(child.children, prefix + childPrefix, lines, origin)
    }
  }
}
