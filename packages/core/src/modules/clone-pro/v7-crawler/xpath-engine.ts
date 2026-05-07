/**
 * XPath engine — port of Lonspy `Helpers/CrawlHelper.cs::GetValueSingleNode`
 * + `GetValueNodes`. Uses `xpath-html` for XPath 1.0 navigation under the hood
 * (parse5 → xmldom → xpath) plus a recursive innerText walker to match the
 * C# `HtmlAgilityPack.HtmlNode.InnerText` semantics (concatenated descendant
 * text, not just first text child).
 *
 * All functions are total — they never throw. Malformed input → empty result.
 * Iron Rule 5: errors stay server-side; nothing in this module composes a
 * seller-facing message. The orchestrator pipes failures through
 * `safeMessage()` at the API boundary.
 */

// xpath-html is CommonJS — import via default + property access.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import xpathHtmlDefault from 'xpath-html'
import he from 'he'
import type { Replace } from './types.js'

// CommonJS interop — pull `fromPageSource` regardless of how Node resolves it.
type XPathHelper = {
  findElement(xpath: string): unknown
  findElements(xpath: string): unknown[]
}
type XPathHtmlModule = {
  fromPageSource(html: string): XPathHelper
}
const xpathHtml = (xpathHtmlDefault as unknown as XPathHtmlModule)

interface DomNode {
  nodeName?: string
  nodeValue?: string | null
  childNodes?: ArrayLike<DomNode>
  attributes?: { length: number; item(i: number): { name: string; value: string } | null } | null
  getAttribute?(name: string): string | null
  toString?(): string
}

/** Recursively concatenate text content of all descendant `#text` nodes. */
function innerText(node: DomNode | null | undefined): string {
  if (!node) return ''
  const out: string[] = []
  walkText(node, out)
  return out.join('')
}

function walkText(node: DomNode, out: string[]): void {
  const kids = node.childNodes
  if (!kids || kids.length === 0) return
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i]
    if (!child) continue
    if (child.nodeName === '#text' && typeof child.nodeValue === 'string') {
      out.push(child.nodeValue)
    } else if (child.childNodes && child.childNodes.length > 0) {
      walkText(child, out)
    }
  }
}

/** Read attribute value via xmldom's `getAttribute()` (returns '' when missing). */
function attrOf(node: DomNode | null | undefined, name: string): string {
  if (!node) return ''
  if (typeof node.getAttribute === 'function') {
    return node.getAttribute(name) ?? ''
  }
  // Fallback: walk attributes list
  const attrs = node.attributes
  if (!attrs) return ''
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs.item(i)
    if (a && a.name === name) return a.value
  }
  return ''
}

/**
 * Extract a single value from `html` matching `xpath`.
 *
 * @param attr  null → return innerText (HTML-decoded). Otherwise → attribute value.
 * @returns extracted string, or `''` if no match / error.
 */
export function extractValue(html: string, xpath: string, attr: string | null): string {
  try {
    const node = xpathHtml.fromPageSource(html).findElement(xpath) as DomNode | null
    if (!node) return ''
    const raw = attr ? attrOf(node, attr) : innerText(node)
    return he.decode(raw ?? '')
  } catch {
    return ''
  }
}

/**
 * Extract all values from `html` matching `xpath`.
 * Empty/whitespace strings are filtered out (matches Lonspy
 * `if (!string.IsNullOrEmpty(_value)) result.Add(_value);`).
 */
export function extractValues(html: string, xpath: string, attr: string | null = null): string[] {
  try {
    const nodes = xpathHtml.fromPageSource(html).findElements(xpath) as DomNode[]
    const out: string[] = []
    for (const n of nodes) {
      const raw = attr ? attrOf(n, attr) : innerText(n)
      const decoded = he.decode(raw ?? '')
      if (decoded.length > 0) out.push(decoded)
    }
    return out
  } catch {
    return []
  }
}

/**
 * Return the serialised XHTML chunk of each matched node.
 * Used by listing-crawler / detail-crawler when an Element's XPath is
 * declared relative to the per-row root (so we need to re-parse the row).
 */
export function extractElements(html: string, xpath: string): string[] {
  try {
    const nodes = xpathHtml.fromPageSource(html).findElements(xpath) as DomNode[]
    return nodes
      .map((n) => (typeof n.toString === 'function' ? n.toString() : ''))
      .filter((s) => s.length > 0)
  } catch {
    return []
  }
}

/** Apply each replacement left-to-right. Replaces ALL occurrences (string.Replace parity). */
export function applyReplaces(value: string, replaces: Replace[] | null): string {
  if (!replaces || replaces.length === 0) return value
  let out = value
  for (const r of replaces) {
    if (!r.from) continue
    out = out.split(r.from).join(r.to)
  }
  return out
}
