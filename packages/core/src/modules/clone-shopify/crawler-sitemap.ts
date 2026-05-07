/**
 * Shopify sitemap walker.
 *
 * Shopify exposes a sitemap index at `/sitemap.xml` which fans out
 * into `sitemap_products_1.xml`, `sitemap_collections_1.xml`,
 * `sitemap_pages_1.xml`, `sitemap_blogs_1.xml`. Each leaf is a
 * classic <urlset> document. We:
 *
 *   1. Fetch the index via `safeFetch`.
 *   2. Parse nested <sitemap><loc> entries. For each child URL we
 *      infer a `kind` from the filename ("sitemap_products" →
 *      `product`, etc.) and recurse once.
 *   3. Parse each leaf <urlset><url><loc> into `CloneSitemapNode`
 *      rows with the inherited kind.
 *
 * No external XML library — we use a small hand-rolled regex parser
 * because the Shopify sitemap grammar is strictly regular enough
 * and adding a full XML parser to the security surface isn't worth
 * it for this narrow use case.
 */
import type { CloneSitemapNode } from './types.js';
import { safeFetch, type SafeFetchOptions } from './safe-fetch.js';

export interface SitemapCrawlOptions extends SafeFetchOptions {
  readonly maxNodes?: number;
  /** Test hook: map URL → raw XML body. */
  readonly fetchXml?: (url: string) => Promise<string>;
}

const DEFAULT_MAX_NODES = 10_000;

export class SitemapCrawlError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.name = 'SitemapCrawlError';
    this.code = code;
  }
}

/** Extracts every `<loc>…</loc>` text inside a given parent tag. */
function extractLocs(
  xml: string,
  parentTag: 'sitemap' | 'url',
): string[] {
  const openTag = `<${parentTag}>`;
  const closeTag = `</${parentTag}>`;
  const out: string[] = [];
  let idx = 0;
  while (true) {
    const start = xml.indexOf(openTag, idx);
    if (start === -1) break;
    const end = xml.indexOf(closeTag, start + openTag.length);
    if (end === -1) break;
    const inner = xml.slice(start + openTag.length, end);
    const locStart = inner.indexOf('<loc>');
    const locEnd = inner.indexOf('</loc>');
    if (locStart !== -1 && locEnd !== -1 && locEnd > locStart) {
      const raw = inner.slice(locStart + '<loc>'.length, locEnd).trim();
      // Decode &amp; which is the only entity Shopify uses in practice.
      out.push(raw.replace(/&amp;/g, '&'));
    }
    idx = end + closeTag.length;
  }
  return out;
}

/** Infer sitemap kind from a leaf sitemap URL's filename. */
export function inferKindFromSitemapUrl(
  url: string,
): CloneSitemapNode['kind'] {
  const lower = url.toLowerCase();
  if (lower.includes('sitemap_products')) return 'product';
  if (lower.includes('sitemap_collections')) return 'collection';
  if (lower.includes('sitemap_pages')) return 'page';
  if (lower.includes('sitemap_blogs')) return 'blog';
  return 'unknown';
}

async function defaultFetchXml(
  url: string,
  options: SafeFetchOptions,
): Promise<string> {
  const res = await safeFetch(url, options);
  if (res.statusCode !== 200) {
    throw new SitemapCrawlError(
      'bad_status',
      `GET ${url} returned ${res.statusCode}; expected 200.`,
    );
  }
  return res.body.toString('utf8');
}

/**
 * Walk `/sitemap.xml` on the given base URL, returning a flat list
 * of classified sitemap nodes.
 */
export async function walkSitemap(
  baseUrl: string,
  options: SitemapCrawlOptions = {},
): Promise<readonly CloneSitemapNode[]> {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const fetchXml =
    options.fetchXml ?? ((url: string) => defaultFetchXml(url, options));

  const indexUrl = new URL('/sitemap.xml', baseUrl).toString();
  const indexXml = await fetchXml(indexUrl);
  const childSitemapUrls = extractLocs(indexXml, 'sitemap');

  const out: CloneSitemapNode[] = [];

  // If the top level is already a <urlset> (simple storefronts),
  // classify directly.
  if (childSitemapUrls.length === 0) {
    const locs = extractLocs(indexXml, 'url');
    for (const loc of locs) {
      if (out.length >= maxNodes) break;
      out.push({
        url: loc,
        kind: 'unknown',
        title: null,
        depth: 0,
        parentUrl: null,
      });
    }
    return out;
  }

  for (const childUrl of childSitemapUrls) {
    if (out.length >= maxNodes) break;
    const kind = inferKindFromSitemapUrl(childUrl);

    // Record the leaf sitemap itself as a depth-0 "index" entry so
    // the consumer can see the topology.
    out.push({
      url: childUrl,
      kind,
      title: null,
      depth: 0,
      parentUrl: indexUrl,
    });

    let leafXml: string;
    try {
      leafXml = await fetchXml(childUrl);
    } catch {
      // One bad leaf shouldn't kill the whole walk; skip and continue.
      continue;
    }
    const locs = extractLocs(leafXml, 'url');
    for (const loc of locs) {
      if (out.length >= maxNodes) break;
      out.push({
        url: loc,
        kind,
        title: null,
        depth: 1,
        parentUrl: childUrl,
      });
    }
  }

  return out;
}
