/**
 * crawler-sitemap tests — fixture XML via fetchXml injection point.
 */
import { describe, it, expect } from 'vitest';
import { walkSitemap, inferKindFromSitemapUrl } from './crawler-sitemap.js';

const INDEX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://shop.example.com/sitemap_products_1.xml?from=1&amp;to=250</loc>
    <lastmod>2026-04-10T00:00:00Z</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://shop.example.com/sitemap_collections_1.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://shop.example.com/sitemap_pages_1.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://shop.example.com/sitemap_blogs_1.xml</loc>
  </sitemap>
</sitemapindex>`;

const PRODUCTS_LEAF = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shop.example.com/products/red-tee</loc></url>
  <url><loc>https://shop.example.com/products/blue-tee</loc></url>
</urlset>`;

const COLLECTIONS_LEAF = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://shop.example.com/collections/all</loc></url>
  <url><loc>https://shop.example.com/collections/sale</loc></url>
  <url><loc>https://shop.example.com/collections/new</loc></url>
</urlset>`;

const PAGES_LEAF = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://shop.example.com/pages/about</loc></url>
</urlset>`;

const BLOGS_LEAF = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://shop.example.com/blogs/news/hello-world</loc></url>
</urlset>`;

describe('inferKindFromSitemapUrl', () => {
  it.each([
    ['https://x/sitemap_products_1.xml', 'product'],
    ['https://x/sitemap_collections_1.xml', 'collection'],
    ['https://x/sitemap_pages_1.xml', 'page'],
    ['https://x/sitemap_blogs_1.xml', 'blog'],
    ['https://x/sitemap_random.xml', 'unknown'],
  ])('classifies %s → %s', (url, expected) => {
    expect(inferKindFromSitemapUrl(url)).toBe(expected);
  });
});

describe('walkSitemap', () => {
  it('recurses into nested sitemap index and classifies leaves', async () => {
    const fetchXml = async (url: string): Promise<string> => {
      if (url.endsWith('/sitemap.xml')) return INDEX_XML;
      if (url.includes('sitemap_products')) return PRODUCTS_LEAF;
      if (url.includes('sitemap_collections')) return COLLECTIONS_LEAF;
      if (url.includes('sitemap_pages')) return PAGES_LEAF;
      if (url.includes('sitemap_blogs')) return BLOGS_LEAF;
      throw new Error(`unexpected fetch: ${url}`);
    };

    const nodes = await walkSitemap('https://shop.example.com', { fetchXml });

    // 4 leaf index entries + 2 products + 3 collections + 1 page + 1 blog = 11
    expect(nodes).toHaveLength(4 + 2 + 3 + 1 + 1);

    const productUrls = nodes
      .filter((n) => n.kind === 'product' && n.depth === 1)
      .map((n) => n.url);
    expect(productUrls).toEqual([
      'https://shop.example.com/products/red-tee',
      'https://shop.example.com/products/blue-tee',
    ]);

    const collectionLeafUrls = nodes
      .filter((n) => n.kind === 'collection' && n.depth === 1)
      .map((n) => n.url);
    expect(collectionLeafUrls).toHaveLength(3);
  });

  it('decodes &amp; entities in loc', async () => {
    const fetchXml = async (url: string): Promise<string> => {
      if (url.endsWith('/sitemap.xml')) return INDEX_XML;
      return '<urlset></urlset>';
    };
    const nodes = await walkSitemap('https://shop.example.com', { fetchXml });
    const productsIndex = nodes.find(
      (n) => n.kind === 'product' && n.depth === 0,
    );
    expect(productsIndex?.url).toBe(
      'https://shop.example.com/sitemap_products_1.xml?from=1&to=250',
    );
  });

  it('handles a flat urlset with no sitemap index', async () => {
    const flat = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://shop.example.com/products/a</loc></url>
  <url><loc>https://shop.example.com/products/b</loc></url>
</urlset>`;
    const nodes = await walkSitemap('https://shop.example.com', {
      fetchXml: async () => flat,
    });
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.kind === 'unknown' && n.depth === 0)).toBe(true);
  });

  it('respects maxNodes cap', async () => {
    const leaf = `<urlset>${Array.from({ length: 20 }, (_, i) => `<url><loc>https://shop.example.com/products/${i}</loc></url>`).join('')}</urlset>`;
    const simpleIndex = `<sitemapindex><sitemap><loc>https://shop.example.com/sitemap_products_1.xml</loc></sitemap></sitemapindex>`;
    const nodes = await walkSitemap('https://shop.example.com', {
      maxNodes: 5,
      fetchXml: async (url) =>
        url.endsWith('/sitemap.xml') ? simpleIndex : leaf,
    });
    expect(nodes.length).toBeLessThanOrEqual(5);
  });
});
