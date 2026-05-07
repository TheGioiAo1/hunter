/**
 * crawler-products tests.
 *
 * These exercise the normaliser + pagination with in-memory fixtures
 * via the `fetchPage` injection point — no real HTTP.
 */
import { describe, it, expect } from 'vitest';
import {
  crawlShopifyProducts,
  normaliseProduct,
  type ShopifyProductRaw,
  type ShopifyProductsPageRaw,
} from './crawler-products.js';

function makeRaw(overrides: Partial<ShopifyProductRaw> = {}): ShopifyProductRaw {
  return {
    id: 100,
    title: 'Test Product',
    handle: 'test-product',
    body_html: '<p>desc</p>',
    vendor: 'Acme',
    product_type: 'shirt',
    tags: 'summer,cotton',
    images: [
      { src: 'https://cdn.example.com/img1.jpg', alt: 'front', width: 800, height: 600 },
    ],
    variants: [
      {
        id: 1001,
        sku: 'SKU-1',
        title: 'Small / Red',
        price: '19.99',
        compare_at_price: '24.99',
        option1: 'Small',
        option2: 'Red',
        option3: null,
        available: true,
      },
    ],
    ...overrides,
  };
}

describe('normaliseProduct', () => {
  it('maps the happy path', () => {
    const dto = normaliseProduct(makeRaw());
    expect(dto.sourceProductId).toBe('100');
    expect(dto.handle).toBe('test-product');
    expect(dto.title).toBe('Test Product');
    expect(dto.descriptionHtml).toBe('<p>desc</p>');
    expect(dto.vendor).toBe('Acme');
    expect(dto.productType).toBe('shirt');
    expect(dto.tags).toEqual(['summer', 'cotton']);
    expect(dto.images).toHaveLength(1);
    expect(dto.images[0]).toMatchObject({
      sourceUrl: 'https://cdn.example.com/img1.jpg',
      altText: 'front',
      width: 800,
      height: 600,
    });
    expect(dto.variants).toHaveLength(1);
    expect(dto.variants[0]).toMatchObject({
      sourceVariantId: '1001',
      sku: 'SKU-1',
      price: '19.99',
      compareAtPrice: '24.99',
      optionValues: ['Small', 'Red'],
      available: true,
    });
  });

  it('handles tags as array', () => {
    const dto = normaliseProduct(makeRaw({ tags: ['a', 'b'] }));
    expect(dto.tags).toEqual(['a', 'b']);
  });

  it('handles null body_html', () => {
    const dto = normaliseProduct(makeRaw({ body_html: null }));
    expect(dto.descriptionHtml).toBe('');
  });

  it('trims empty option values', () => {
    const dto = normaliseProduct(
      makeRaw({
        variants: [
          {
            id: 1,
            sku: null,
            title: 'Default Title',
            price: '9.99',
            compare_at_price: null,
            option1: 'Default',
            option2: null,
            option3: '',
            available: false,
          },
        ],
      }),
    );
    expect(dto.variants[0]?.optionValues).toEqual(['Default']);
    expect(dto.variants[0]?.sku).toBeNull();
    expect(dto.variants[0]?.compareAtPrice).toBeNull();
  });
});

describe('crawlShopifyProducts pagination', () => {
  it('stops on empty page', async () => {
    const pages: Record<number, ShopifyProductsPageRaw> = {
      1: { products: [makeRaw({ id: 1, handle: 'p1' })] },
      2: { products: [makeRaw({ id: 2, handle: 'p2' })] },
      3: { products: [] },
    };
    const result = await crawlShopifyProducts('https://shop.example.com', {
      pageSize: 1,
      fetchPage: async (page) => pages[page] ?? { products: [] },
    });
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.handle)).toEqual(['p1', 'p2']);
  });

  it('stops on short page (page.length < pageSize)', async () => {
    const pages: Record<number, ShopifyProductsPageRaw> = {
      1: {
        products: [
          makeRaw({ id: 1, handle: 'p1' }),
          makeRaw({ id: 2, handle: 'p2' }),
        ],
      },
      2: { products: [makeRaw({ id: 3, handle: 'p3' })] }, // short
    };
    const result = await crawlShopifyProducts('https://shop.example.com', {
      pageSize: 2,
      fetchPage: async (page) => pages[page] ?? { products: [] },
    });
    expect(result.map((p) => p.handle)).toEqual(['p1', 'p2', 'p3']);
  });

  it('respects maxProducts cap mid-page', async () => {
    const page1 = {
      products: [1, 2, 3, 4, 5].map((n) =>
        makeRaw({ id: n, handle: `p${n}` }),
      ),
    };
    const result = await crawlShopifyProducts('https://shop.example.com', {
      pageSize: 5,
      maxProducts: 3,
      fetchPage: async () => page1,
    });
    expect(result).toHaveLength(3);
  });
});
