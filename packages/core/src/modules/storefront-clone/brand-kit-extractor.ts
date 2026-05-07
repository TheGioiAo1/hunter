/**
 * Gbox Platform — Storefront Clone: brand kit extraction.
 *
 * Fetches the source storefront's homepage, extracts inline + linked
 * CSS, then runs the existing theme cloner's palette + font extractors
 * to produce a BrandKitData object that gets persisted to
 * `shops.brand_kit_json`.
 *
 * Design:
 *   - Reuses `extractColorPalette` + `extractFontConfig` from
 *     `@gbox/core/modules/themes/cloner.ts` — no duplicate logic.
 *   - Fetches via safeFetch (SSRF-safe, byte-capped, redirect-safe).
 *   - Extracts <style> blocks and linked stylesheet URLs, fetches up
 *     to 5 external CSS files, concatenates them all.
 *   - Fail-open: if fetching fails, returns a default brand kit so
 *     the clone job isn't blocked by CSS extraction issues.
 */

import type { Kysely } from 'kysely';
import type { Database } from '@gbox/db/schema/tables.js';
import { safeFetch, type SafeFetchOptions } from '../clone-shopify/safe-fetch.js';
import {
  extractColorPalette,
  extractFontConfig,
  type ColorPalette,
  type FontConfig,
} from '../themes/cloner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrandKitData {
  readonly palette: ColorPalette;
  readonly fonts: FontConfig;
  readonly sourceUrl: string;
  readonly extractedAt: string;
}

export interface ExtractBrandKitInput {
  readonly sourceUrl: string;
  readonly shopId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CSS_LINKS = 5;
const CSS_FETCH_OPTS: SafeFetchOptions = {
  maxBytes: 2 * 1024 * 1024, // 2 MB per CSS file
  timeoutMs: 15_000,
  maxRedirects: 3,
};
const HTML_FETCH_OPTS: SafeFetchOptions = {
  maxBytes: 5 * 1024 * 1024, // 5 MB for the HTML page
  timeoutMs: 20_000,
  maxRedirects: 5,
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Fetch the source storefront homepage, extract CSS, derive a brand
 * kit, and persist it to `shops.brand_kit_json`.
 *
 * Returns the extracted brand kit data.
 */
export async function extractAndPersistBrandKit(
  db: Kysely<Database>,
  input: ExtractBrandKitInput,
): Promise<BrandKitData> {
  let css = '';

  try {
    const htmlResult = await safeFetch(input.sourceUrl, HTML_FETCH_OPTS);
    if (htmlResult.statusCode === 200) {
      const html = htmlResult.body.toString('utf8');

      // Extract inline <style> blocks.
      css += extractInlineStyles(html);

      // Extract linked stylesheet URLs and fetch them.
      const cssLinks = extractCssLinks(html, input.sourceUrl);
      const fetched = await fetchCssFiles(cssLinks.slice(0, MAX_CSS_LINKS));
      css += '\n' + fetched;
    }
  } catch {
    // Fail-open: if fetching fails, use empty CSS → default brand kit.
  }

  const palette = extractColorPalette(css);
  const fonts = extractFontConfig(css);

  const brandKit: BrandKitData = {
    palette,
    fonts,
    sourceUrl: input.sourceUrl,
    extractedAt: new Date().toISOString(),
  };

  // Persist to shops.brand_kit_json.
  await db
    .updateTable('shops')
    .set({ brand_kit_json: JSON.stringify(brandKit) as any })
    .where('id', '=', input.shopId)
    .execute();

  return brandKit;
}

// ---------------------------------------------------------------------------
// HTML parsing helpers (regex-based, no DOM dep)
// ---------------------------------------------------------------------------

/**
 * Extract all <style> block contents from HTML.
 */
export function extractInlineStyles(html: string): string {
  const parts: string[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    parts.push(match[1]!);
  }
  return parts.join('\n');
}

/**
 * Extract <link rel="stylesheet" href="..."> URLs from HTML.
 * Resolves relative URLs against the base URL.
 */
export function extractCssLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const re = /<link[^>]+rel\s*=\s*["']stylesheet["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const hrefMatch = match[0].match(/href\s*=\s*["']([^"']+)["']/i);
    if (hrefMatch?.[1]) {
      try {
        const resolved = new URL(hrefMatch[1], baseUrl).toString();
        links.push(resolved);
      } catch {
        // Skip malformed URLs.
      }
    }
  }
  return links;
}

/**
 * Fetch multiple CSS files in parallel and concatenate their contents.
 * Silently drops files that fail to fetch.
 */
async function fetchCssFiles(urls: string[]): Promise<string> {
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const res = await safeFetch(url, CSS_FETCH_OPTS);
      if (res.statusCode === 200) {
        return res.body.toString('utf8');
      }
      return '';
    }),
  );
  return results
    .filter(
      (r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled',
    )
    .map((r) => r.value)
    .join('\n');
}
