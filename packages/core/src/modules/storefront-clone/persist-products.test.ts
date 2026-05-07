/**
 * Unit tests for persist-products.ts
 *
 * These tests focus on the pure helpers (safeSlug, normalisePrice,
 * deriveOptions via round-trip) and exercise the persist function
 * against a chainable mock DB to verify the expected call shape.
 */

import { describe, it, expect, vi } from 'vitest';
import { persistCloneProducts, safeSlug, normalisePrice } from './persist-products.js';
import type { CloneProductDTO } from '../clone-shopify/index.js';

// ───────────────────────────────────────────────────────────────────
// Chainable mock DB (same style as products/service.test.ts)
// ───────────────────────────────────────────────────────────────────

function chainable(result: unknown = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        if (prop === 'execute') {
          return vi
            .fn()
            .mockResolvedValue(Array.isArray(result) ? result : result ? [result] : []);
        }
        if (prop === 'executeTakeFirst') return vi.fn().mockResolvedValue(result ?? null);
        if (prop === 'executeTakeFirstOrThrow') {
          return vi.fn().mockImplementation(async () => {
            if (result == null) throw new Error('no result');
            return result;
          });
        }
        return vi.fn().mockReturnValue(obj);
      },
    },
  );
  return obj;
}

interface MockTrxState {
  readonly inserts: Array<{ table: string; values: any }>;
  readonly updates: Array<{ table: string; values: any }>;
  readonly deletes: string[];
  readonly selects: string[];
  // simulate "found existing product" for rows with source_external_id === this id
  existingSourceId?: string;
}

function createMockTrx(state: MockTrxState) {
  const trx: any = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      state.selects.push(table);
      if (table === 'products' && state.existingSourceId) {
        return chainable({ id: 'existing-product-id' });
      }
      return chainable(null);
    }),
    insertInto: vi.fn().mockImplementation((table: string) => {
      const proxy: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'values') {
              return (values: any) => {
                state.inserts.push({ table, values });
                return proxy;
              };
            }
            if (prop === 'execute') return () => Promise.resolve([]);
            if (prop === 'returning' || prop === 'returningAll') {
              return () => proxy;
            }
            if (prop === 'executeTakeFirstOrThrow') {
              return () => Promise.resolve({ id: 'new-product-id' });
            }
            return vi.fn().mockReturnValue(proxy);
          },
        },
      );
      return proxy;
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      const proxy: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'set') {
              return (values: any) => {
                state.updates.push({ table, values });
                return proxy;
              };
            }
            if (prop === 'execute') return () => Promise.resolve([]);
            return vi.fn().mockReturnValue(proxy);
          },
        },
      );
      return proxy;
    }),
    deleteFrom: vi.fn().mockImplementation((table: string) => {
      state.deletes.push(table);
      return chainable();
    }),
  };
  return trx;
}

function createMockDb(state: MockTrxState) {
  return {
    transaction: () => ({
      execute: async (fn: (trx: any) => Promise<void>) => {
        await fn(createMockTrx(state));
      },
    }),
  } as any;
}

// ───────────────────────────────────────────────────────────────────
// Fixture DTO
// ───────────────────────────────────────────────────────────────────

const sampleProduct: CloneProductDTO = {
  sourceProductId: '12345',
  handle: 'aurora-tee',
  title: 'Aurora Tee',
  descriptionHtml: '<p>Soft.</p>',
  vendor: 'Aurora',
  productType: 'Apparel',
  tags: ['tee', 'summer'],
  images: [
    { sourceUrl: 'https://cdn.example.com/a.jpg', altText: 'front', width: 800, height: 800 },
    { sourceUrl: 'https://cdn.example.com/b.jpg', altText: null, width: null, height: null },
  ],
  variants: [
    {
      sourceVariantId: '901',
      sku: 'AT-S',
      title: 'Small',
      price: '19.99',
      compareAtPrice: '24.99',
      optionValues: ['Small', 'Red'],
      available: true,
    },
    {
      sourceVariantId: '902',
      sku: 'AT-M',
      title: 'Medium',
      price: '19.99',
      compareAtPrice: null,
      optionValues: ['Medium', 'Red'],
      available: false,
    },
  ],
};

// ───────────────────────────────────────────────────────────────────
// safeSlug / normalisePrice
// ───────────────────────────────────────────────────────────────────

describe('safeSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(safeSlug('Aurora Tee')).toBe('aurora-tee');
  });

  it('strips diacritics', () => {
    expect(safeSlug('Café Déjà Vu')).toBe('cafe-deja-vu');
  });

  it('collapses runs of non-alphanumeric', () => {
    expect(safeSlug('a!!!b??c')).toBe('a-b-c');
  });

  it('trims leading and trailing hyphens', () => {
    expect(safeSlug('---hello---')).toBe('hello');
  });

  it('caps at 80 chars', () => {
    const long = 'x'.repeat(120);
    expect(safeSlug(long).length).toBeLessThanOrEqual(80);
  });

  it('returns empty string for pure symbols', () => {
    expect(safeSlug('!!!')).toBe('');
  });
});

describe('normalisePrice', () => {
  it('formats to 2 decimal places', () => {
    expect(normalisePrice('19.9')).toBe('19.90');
  });

  it('rounds down extra precision', () => {
    expect(normalisePrice('19.999')).toBe('20.00');
  });

  it('rejects negatives', () => {
    expect(normalisePrice('-5')).toBe('0');
  });

  it('rejects non-numeric', () => {
    expect(normalisePrice('free')).toBe('0');
  });

  it('preserves zero', () => {
    expect(normalisePrice('0')).toBe('0.00');
  });
});

// ───────────────────────────────────────────────────────────────────
// persistCloneProducts
// ───────────────────────────────────────────────────────────────────

describe('persistCloneProducts', () => {
  it('inserts a new product when no existing source match', async () => {
    const state: MockTrxState = { inserts: [], updates: [], deletes: [], selects: [] };
    const db = createMockDb(state);

    const result = await persistCloneProducts(db, {
      shopId: 'shop-1',
      cloneJobId: 'job-1',
      sourceBaseUrl: 'https://example.myshopify.com',
      products: [sampleProduct],
    });

    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.imagesWritten).toBe(2);
    expect(result.variantsWritten).toBe(2);

    // products insert + variants insert + options insert + images insert
    const productInsert = state.inserts.find((i) => i.table === 'products');
    expect(productInsert).toBeDefined();
    expect(productInsert?.values.shop_id).toBe('shop-1');
    expect(productInsert?.values.status).toBe('draft');
    expect(productInsert?.values.source_external_id).toBe('12345');
    expect(productInsert?.values.source_url).toContain('/products/aurora-tee');
    expect(productInsert?.values.clone_job_id).toBe('job-1');

    const variantInsert = state.inserts.find((i) => i.table === 'product_variants');
    expect(variantInsert?.values).toHaveLength(2);
    expect(variantInsert?.values[0].price).toBe('19.99');
    expect(variantInsert?.values[0].compare_at_price).toBe('24.99');
    expect(variantInsert?.values[0].inventory_quantity).toBe(1); // available
    expect(variantInsert?.values[1].inventory_quantity).toBe(0); // unavailable

    const optionInsert = state.inserts.find((i) => i.table === 'product_options');
    expect(optionInsert?.values).toHaveLength(2);
    expect(optionInsert?.values[0].name).toBe('Option 1');
    expect(optionInsert?.values[0].values).toEqual(['Small', 'Medium']);
    expect(optionInsert?.values[1].values).toEqual(['Red']);

    const imageInsert = state.inserts.find((i) => i.table === 'product_images');
    expect(imageInsert?.values).toHaveLength(2);
    expect(imageInsert?.values[0].src).toBe('https://cdn.example.com/a.jpg');
  });

  it('updates + wipes children when source_external_id matches', async () => {
    const state: MockTrxState = {
      inserts: [],
      updates: [],
      deletes: [],
      selects: [],
      existingSourceId: '12345',
    };
    const db = createMockDb(state);

    const result = await persistCloneProducts(db, {
      shopId: 'shop-1',
      cloneJobId: 'job-2',
      sourceBaseUrl: 'https://example.myshopify.com',
      products: [sampleProduct],
    });

    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);

    // update path → one products update, then variants/options/images deleted, then re-inserted
    expect(state.updates.some((u) => u.table === 'products')).toBe(true);
    expect(state.deletes).toContain('product_variants');
    expect(state.deletes).toContain('product_options');
    expect(state.deletes).toContain('product_images');
    expect(state.inserts.some((i) => i.table === 'product_variants')).toBe(true);
  });

  it('creates a default variant when DTO has none', async () => {
    const state: MockTrxState = { inserts: [], updates: [], deletes: [], selects: [] };
    const db = createMockDb(state);

    const noVariants: CloneProductDTO = { ...sampleProduct, variants: [] };
    await persistCloneProducts(db, {
      shopId: 'shop-1',
      cloneJobId: 'job-3',
      sourceBaseUrl: 'https://example.myshopify.com',
      products: [noVariants],
    });

    const variantInsert = state.inserts.find((i) => i.table === 'product_variants');
    expect(variantInsert?.values).toHaveLength(1);
    expect(variantInsert?.values[0].title).toBe('Default Title');
    expect(variantInsert?.values[0].price).toBe('0');
  });

  it('aggregates inserts and updates across multiple products', async () => {
    const state: MockTrxState = { inserts: [], updates: [], deletes: [], selects: [] };
    const db = createMockDb(state);

    const result = await persistCloneProducts(db, {
      shopId: 'shop-1',
      cloneJobId: 'job-4',
      sourceBaseUrl: 'https://example.myshopify.com',
      products: [sampleProduct, { ...sampleProduct, sourceProductId: '999', handle: 'other' }],
    });

    expect(result.inserted).toBe(2);
    expect(result.variantsWritten).toBe(4);
    expect(result.imagesWritten).toBe(4);
  });
});
