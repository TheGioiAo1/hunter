/**
 * Clone Pro v4 — Deep Crawler (Phase 1.2)
 *
 * BFS crawler that discovers every internal page on a website by
 * following `<a href>` links starting from the homepage. Yields
 * real-time events so the caller can stream progress to the UI.
 *
 * Key design decisions:
 *   - Uses `safeFetch` for all HTTP requests (SSRF protection)
 *   - Respects robots.txt (simple disallow-path parser)
 *   - Cheerio for HTML link extraction (no headless browser needed)
 *   - Configurable concurrency with per-request delay
 *   - URL normalization (fragments, trailing slashes, optional query params)
 *   - Skips non-HTML resources by file extension
 *
 * @module clone-pro/discovery/deep-crawler
 */

import * as cheerio from 'cheerio';
import { safeFetch } from '../../clone-shopify/safe-fetch.js';
import type { SafeFetchResponse } from '../../clone-shopify/safe-fetch.js';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** Page type classification based on URL patterns. */
export type PageType =
  | 'home'
  | 'product'
  | 'collection'
  | 'list-collections'
  | 'page'
  | 'blog'
  | 'blog-post'
  | 'cart'
  | 'search'
  | 'account'
  | 'login'
  | 'register'
  | 'policy'
  | 'password'
  | '404'
  | 'other';

/** A single discovered page with its metadata and content. */
export interface DiscoveredPage {
  /** Canonical URL of the page (normalized). */
  readonly url: string;
  /** Title extracted from `<title>` tag. */
  readonly title: string;
  /** Classified page type based on URL pattern. */
  readonly pageType: PageType;
  /** HTTP status code returned by the server. */
  readonly statusCode: number;
  /** Raw HTML body. */
  readonly html: string;
  /** Internal links discovered on this page. */
  readonly outLinks: readonly string[];
  /** Number of hops from the homepage (0 = homepage). */
  readonly depth: number;
}

/** Events yielded by the deep crawler as it progresses. */
export type CrawlEvent =
  | { readonly type: 'page'; readonly page: DiscoveredPage }
  | { readonly type: 'progress'; readonly crawled: number; readonly queued: number; readonly total: number }
  | { readonly type: 'error'; readonly url: string; readonly error: string };

/** Configuration options for the deep crawler. */
export interface DeepCrawlOptions {
  /** Maximum number of pages to crawl. @default 500 */
  readonly maxPages?: number;
  /** Maximum BFS depth from the homepage. @default 10 */
  readonly maxDepth?: number;
  /** Number of concurrent fetches. @default 3 */
  readonly concurrency?: number;
  /** Delay between requests in milliseconds. @default 200 */
  readonly delayMs?: number;
  /** Whether to strip query parameters during URL normalization. @default false */
  readonly stripQueryParams?: boolean;
  /** Whether to respect robots.txt disallow rules. @default true */
  readonly respectRobots?: boolean;
  /** Custom user-agent string for crawling. */
  readonly userAgent?: string;
  /** Timeout per request in milliseconds. @default 15000 */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: Required<DeepCrawlOptions> = {
  maxPages: 500,
  maxDepth: 10,
  concurrency: 3,
  delayMs: 200,
  stripQueryParams: false,
  respectRobots: true,
  userAgent: 'GboxCloneBot/4.0 (+https://gbox.co/bot)', // Phase 7.3 — stable identity
  timeoutMs: 15_000,
};

/**
 * File extensions that indicate a non-HTML resource.
 * We skip these URLs entirely — no point fetching a JPEG.
 */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.css', '.js', '.mjs', '.map', '.json', '.xml', '.csv',
  '.exe', '.dmg', '.apk', '.deb', '.rpm',
]);

// ---------------------------------------------------------------------------
// URL Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a URL for deduplication.
 *
 * - Resolves relative URLs against a base
 * - Removes fragments (`#...`)
 * - Removes trailing slashes (except for root `/`)
 * - Optionally strips query parameters
 * - Lowercases the hostname
 *
 * @returns Normalized URL string, or `null` if the URL is invalid or external.
 */
function normalizeUrl(
  raw: string,
  baseUrl: string,
  targetHost: string,
  stripQueryParams: boolean,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw, baseUrl);
  } catch {
    return null;
  }

  // Only http(s)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  // Must be same host
  if (parsed.hostname.toLowerCase() !== targetHost) {
    return null;
  }

  // Remove fragment
  parsed.hash = '';

  // Optionally strip query params
  if (stripQueryParams) {
    parsed.search = '';
  }

  // Lowercase hostname
  parsed.hostname = parsed.hostname.toLowerCase();

  let result = parsed.href;

  // Remove trailing slash (but keep root `/`)
  if (result.endsWith('/') && parsed.pathname !== '/') {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * Check whether a URL path has a file extension that indicates a non-HTML resource.
 */
function hasSkippableExtension(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot === -1) return false;
    const ext = pathname.slice(lastDot);
    return SKIP_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Page Type Detection
// ---------------------------------------------------------------------------

/**
 * Classify a page type based on its URL pathname.
 *
 * Uses Shopify-convention URL patterns, which are also common on
 * many e-commerce platforms.
 */
function detectPageType(url: string): PageType {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return 'other';
  }

  // Remove trailing slash for consistent matching
  const path = pathname.endsWith('/') && pathname !== '/'
    ? pathname.slice(0, -1)
    : pathname;

  // Exact matches first
  if (path === '/' || path === '') return 'home';
  if (path === '/cart') return 'cart';
  if (path === '/search') return 'search';
  if (path === '/password') return 'password';
  if (path === '/collections') return 'list-collections';
  if (path === '/account') return 'account';
  if (path === '/account/login') return 'login';
  if (path === '/account/register') return 'register';

  // Prefix-based matches (order matters)
  if (path.startsWith('/account/login')) return 'login';
  if (path.startsWith('/account/register')) return 'register';
  if (path.startsWith('/account')) return 'account';
  if (path.startsWith('/policies/')) return 'policy';
  if (path.startsWith('/products/')) return 'product';
  if (path.startsWith('/pages/')) return 'page';

  // /collections/*  but NOT  /collections/*/products/*
  if (path.startsWith('/collections/')) {
    if (path.includes('/products/')) return 'product';
    return 'collection';
  }

  // /blogs/<handle>/<article> → blog-post
  // /blogs/<handle>            → blog
  if (path.startsWith('/blogs/')) {
    const segments = path.slice(7).split('/').filter(Boolean);
    if (segments.length >= 2) return 'blog-post';
    if (segments.length === 1) return 'blog';
    return 'other';
  }

  return 'other';
}

// ---------------------------------------------------------------------------
// Robots.txt Parser (Simple)
// ---------------------------------------------------------------------------

/** A parsed robots.txt rule set (disallow paths for our user-agent). */
interface RobotsRules {
  readonly disallowedPaths: readonly string[];
}

/**
 * Fetch and parse robots.txt for the target origin.
 *
 * This is a simple parser — it looks at `User-agent: *` and our
 * specific bot's user-agent. Only `Disallow:` directives are
 * processed (no `Allow:` override logic).
 *
 * @returns Parsed rules, or an empty ruleset if robots.txt is missing/broken.
 */
async function fetchRobotsTxt(
  origin: string,
  userAgent: string,
  timeoutMs: number,
): Promise<RobotsRules> {
  const empty: RobotsRules = { disallowedPaths: [] };

  try {
    const response = await safeFetch(`${origin}/robots.txt`, {
      timeoutMs,
      userAgent,
    });

    if (response.statusCode !== 200) return empty;

    const text = response.body.toString('utf-8');
    return parseRobotsTxt(text, userAgent);
  } catch {
    // robots.txt is optional — if we can't fetch it, proceed
    return empty;
  }
}

/**
 * Parse robots.txt content into disallow rules.
 *
 * Matches both `User-agent: *` and the specific bot name. The bot-
 * specific rules take precedence if present.
 */
function parseRobotsTxt(content: string, userAgent: string): RobotsRules {
  const lines = content.split('\n').map((l) => l.trim());
  const botName = userAgent.split('/')[0]?.toLowerCase() ?? '';

  const wildcardDisallows: string[] = [];
  const botDisallows: string[] = [];

  let currentTarget: 'wildcard' | 'bot' | 'other' | null = null;

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith('#') || line === '') {
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === 'user-agent') {
      const agent = value.toLowerCase();
      if (agent === '*') {
        currentTarget = 'wildcard';
      } else if (botName && agent.includes(botName)) {
        currentTarget = 'bot';
      } else {
        currentTarget = 'other';
      }
      continue;
    }

    if (directive === 'disallow' && value) {
      if (currentTarget === 'wildcard') {
        wildcardDisallows.push(value);
      } else if (currentTarget === 'bot') {
        botDisallows.push(value);
      }
    }
  }

  // Bot-specific rules take precedence
  const disallowedPaths = botDisallows.length > 0 ? botDisallows : wildcardDisallows;
  return { disallowedPaths };
}

/**
 * Check whether a URL path is disallowed by robots.txt rules.
 */
function isDisallowed(url: string, rules: RobotsRules): boolean {
  if (rules.disallowedPaths.length === 0) return false;

  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }

  return rules.disallowedPaths.some((disallowed) => pathname.startsWith(disallowed));
}

// ---------------------------------------------------------------------------
// HTML Link Extraction
// ---------------------------------------------------------------------------

/**
 * Extract the `<title>` text from an HTML document.
 */
function extractTitle($: cheerio.CheerioAPI): string {
  return $('title').first().text().trim() || '';
}

/**
 * Extract all `href` values from `<a>` tags in the HTML document.
 *
 * @returns Array of raw href strings (may be relative, may have fragments, etc.).
 */
function extractLinks($: cheerio.CheerioAPI): string[] {
  const hrefs: string[] = [];
  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href');
    if (href) {
      hrefs.push(href);
    }
  });
  return hrefs;
}

// ---------------------------------------------------------------------------
// Concurrency Helpers
// ---------------------------------------------------------------------------

/**
 * Simple async delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Deep Crawler
// ---------------------------------------------------------------------------

/**
 * BFS deep-crawl a website, yielding events as pages are discovered.
 *
 * Starts at the given `sourceUrl`, fetches the homepage, and follows
 * all internal `<a href>` links breadth-first. Respects `robots.txt`,
 * skips non-HTML resources, normalizes URLs, and classifies each page
 * by its URL pattern.
 *
 * @param sourceUrl - The homepage URL to start crawling from.
 * @param options - Crawl configuration (concurrency, limits, delays).
 *
 * @yields {CrawlEvent} Real-time events: discovered pages, progress updates, and errors.
 *
 * @example
 * ```ts
 * for await (const event of deepCrawl('https://example-store.com')) {
 *   if (event.type === 'page') {
 *     console.log(`Found: ${event.page.url} (${event.page.pageType})`);
 *   } else if (event.type === 'progress') {
 *     console.log(`Progress: ${event.crawled}/${event.total}`);
 *   } else if (event.type === 'error') {
 *     console.error(`Error on ${event.url}: ${event.error}`);
 *   }
 * }
 * ```
 */
export async function* deepCrawl(
  sourceUrl: string,
  options?: DeepCrawlOptions,
): AsyncGenerator<CrawlEvent> {
  const opts: Required<DeepCrawlOptions> = { ...DEFAULT_OPTIONS, ...options };

  // Parse the source URL and extract host for same-domain checks
  let startUrl: URL;
  try {
    startUrl = new URL(sourceUrl);
  } catch {
    yield { type: 'error', url: sourceUrl, error: `Invalid source URL: ${sourceUrl}` };
    return;
  }

  const targetHost = startUrl.hostname.toLowerCase();
  const origin = startUrl.origin;

  // Normalize the start URL itself
  const normalizedStart = normalizeUrl(sourceUrl, sourceUrl, targetHost, opts.stripQueryParams);
  if (!normalizedStart) {
    yield { type: 'error', url: sourceUrl, error: 'Could not normalize start URL' };
    return;
  }

  // -----------------------------------------------------------------------
  // Fetch and parse robots.txt
  // -----------------------------------------------------------------------
  let robotsRules: RobotsRules = { disallowedPaths: [] };
  if (opts.respectRobots) {
    robotsRules = await fetchRobotsTxt(origin, opts.userAgent, opts.timeoutMs);
  }

  // -----------------------------------------------------------------------
  // BFS State
  // -----------------------------------------------------------------------
  /** URLs we have already enqueued (visited or in the queue). */
  const seen = new Set<string>();
  /** BFS queue: [url, depth] */
  const queue: Array<[string, number]> = [];
  /** Number of pages successfully crawled so far. */
  let crawledCount = 0;

  // Seed the queue with the start URL
  seen.add(normalizedStart);
  queue.push([normalizedStart, 0]);

  // -----------------------------------------------------------------------
  // Worker — fetch a single URL and yield results
  // -----------------------------------------------------------------------
  /**
   * Crawl a single URL. Returns an array of events to yield and an
   * array of newly discovered internal URLs with their depths.
   */
  async function crawlOne(
    url: string,
    depth: number,
  ): Promise<{
    events: CrawlEvent[];
    newLinks: Array<[string, number]>;
  }> {
    const events: CrawlEvent[] = [];
    const newLinks: Array<[string, number]> = [];

    // Check robots.txt
    if (isDisallowed(url, robotsRules)) {
      return { events, newLinks };
    }

    // Skip non-HTML resources
    if (hasSkippableExtension(url)) {
      return { events, newLinks };
    }

    let response: SafeFetchResponse;
    try {
      response = await safeFetch(url, {
        timeoutMs: opts.timeoutMs,
        userAgent: opts.userAgent,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      events.push({ type: 'error', url, error: message });
      return { events, newLinks };
    }

    // Check content-type — only process HTML
    const contentType = getContentType(response.headers);
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return { events, newLinks };
    }

    const html = response.body.toString('utf-8');
    const $ = cheerio.load(html);

    const title = extractTitle($);
    const pageType = response.statusCode === 404 ? '404' : detectPageType(response.finalUrl);

    // Extract and normalize internal links
    const rawLinks = extractLinks($);
    const outLinks: string[] = [];

    for (const raw of rawLinks) {
      const normalized = normalizeUrl(raw, response.finalUrl, targetHost, opts.stripQueryParams);
      if (!normalized) continue;
      if (hasSkippableExtension(normalized)) continue;

      outLinks.push(normalized);

      // Enqueue if not seen and within depth limit
      if (!seen.has(normalized) && depth + 1 <= opts.maxDepth) {
        seen.add(normalized);
        newLinks.push([normalized, depth + 1]);
      }
    }

    // Deduplicate outLinks for the page record
    const uniqueOutLinks = [...new Set(outLinks)];

    const page: DiscoveredPage = {
      url: response.finalUrl,
      title,
      pageType,
      statusCode: response.statusCode,
      html,
      outLinks: uniqueOutLinks,
      depth,
    };

    events.push({ type: 'page', page });

    return { events, newLinks };
  }

  // -----------------------------------------------------------------------
  // BFS Loop with bounded concurrency
  // -----------------------------------------------------------------------
  while (queue.length > 0 && crawledCount < opts.maxPages) {
    // Take up to `concurrency` items from the queue
    const batchSize = Math.min(opts.concurrency, queue.length, opts.maxPages - crawledCount);
    const batch = queue.splice(0, batchSize);

    // Run the batch concurrently
    const results = await Promise.all(
      batch.map(([url, depth]) => crawlOne(url, depth)),
    );

    // Process results: yield events, enqueue new links
    for (const result of results) {
      for (const event of result.events) {
        if (event.type === 'page') {
          crawledCount++;
        }
        yield event;
      }

      // Add newly discovered links to the queue
      for (const link of result.newLinks) {
        if (crawledCount + queue.length < opts.maxPages * 2) {
          // Don't let the queue grow unboundedly
          queue.push(link);
        }
      }
    }

    // Yield a progress event after each batch
    yield {
      type: 'progress',
      crawled: crawledCount,
      queued: queue.length,
      total: crawledCount + queue.length,
    };

    // Polite delay between batches
    if (queue.length > 0 && opts.delayMs > 0) {
      await delay(opts.delayMs);
    }
  }

  // Final progress event
  yield {
    type: 'progress',
    crawled: crawledCount,
    queued: 0,
    total: crawledCount,
  };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the content-type header value (lowercased) from response headers.
 * Handles both string and string[] header formats.
 */
function getContentType(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string {
  const ct = headers['content-type'];
  if (!ct) return '';
  const value = Array.isArray(ct) ? ct[0] : ct;
  return (value ?? '').toLowerCase();
}
