/**
 * Unit tests for media-ingest.ts
 *
 * Tests focus on:
 *   - Content type detection (header vs extension fallback)
 *   - S3 key construction (hash-based, collision-safe)
 *   - Dedup check (objectStore.has → skip upload)
 *   - DB update (src → CDN URL, srcset_json populated)
 *   - Batch concurrency (doesn't blow up on many images)
 *   - Error handling (individual failures logged, job continues)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ingestProductImages, type SrcsetJson } from './media-ingest.js';
import type { ObjectStore } from '../storage/interface.js';

// ---------------------------------------------------------------------------
// Mock ObjectStore
// ---------------------------------------------------------------------------

interface MockStoreLog {
  puts: Array<{ key: string; contentType: string }>;
  hasChecks: string[];
}

function createMockStore(
  log: MockStoreLog,
  existingKeys: Set<string> = new Set(),
): ObjectStore {
  return {
    name: 'mock',
    put: vi.fn(async (key: string, _body: Uint8Array | string, opts?: any) => {
      log.puts.push({ key, contentType: opts?.contentType ?? '' });
      return `https://cdn.test.com/${key}`;
    }),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    has: vi.fn(async (key: string) => {
      log.hasChecks.push(key);
      return existingKeys.has(key);
    }),
    url: vi.fn((key: string) => `https://cdn.test.com/${key}`),
  };
}

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

interface DbLog {
  selects: Array<{ table: string }>;
  updates: Array<{ table: string; values: any; where: any }>;
}

function createMockDb(
  images: Array<{ id: string; product_id: string; src: string; width: number | null; height: number | null }>,
  dbLog: DbLog,
): any {
  // The function does:
  //   1. selectFrom('product_images').innerJoin('products').select(...).where(...).execute()
  //   2. For each image: updateTable('product_images').set({src,srcset_json}).where({id}).execute()
  const db: any = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      dbLog.selects.push({ table });
      const chain: any = {
        innerJoin: () => chain,
        select: () => chain,
        where: () => chain,
        orderBy: () => chain,
        execute: vi.fn(async () => images),
      };
      return chain;
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      const chain: any = {
        set: (values: any) => {
          const withWhere: any = {
            where: (_col: string, _op: string, val: any) => {
              dbLog.updates.push({ table, values, where: val });
              return {
                execute: vi.fn(async () => []),
              };
            },
          };
          return withWhere;
        },
      };
      return chain;
    }),
  };
  return db;
}

// ---------------------------------------------------------------------------
// Mock safeFetch — we need to mock the module import
// ---------------------------------------------------------------------------

// We'll use vi.mock to intercept safeFetch calls.
vi.mock('../clone-shopify/safe-fetch.js', () => ({
  safeFetch: vi.fn(async (url: string) => {
    // Return a fake 200 response with a tiny JPEG-like buffer.
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    return {
      statusCode: 200,
      headers: {
        'content-type': 'image/jpeg',
      },
      body: fakeJpeg,
      redirects: [],
    };
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ingestProductImages', () => {
  let storeLog: MockStoreLog;
  let dbLog: DbLog;

  beforeEach(() => {
    storeLog = { puts: [], hasChecks: [] };
    dbLog = { selects: [], updates: [] };
    vi.clearAllMocks();
  });

  it('downloads, uploads, and updates DB for each image', async () => {
    const images = [
      { id: 'img-1', product_id: 'prod-1', src: 'https://cdn.shopify.com/a.jpg', width: 800, height: 600 },
      { id: 'img-2', product_id: 'prod-1', src: 'https://cdn.shopify.com/b.png', width: null, height: null },
    ];
    const store = createMockStore(storeLog);
    const db = createMockDb(images, dbLog);

    const result = await ingestProductImages(db, {
      shopId: 'shop-1',
      cloneJobId: 'job-1',
      objectStore: store,
    });

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);

    // Two S3 puts (not deduped).
    expect(storeLog.puts).toHaveLength(2);
    expect(storeLog.puts[0]!.contentType).toBe('image/jpeg');

    // Two DB updates (src + srcset_json).
    expect(dbLog.updates).toHaveLength(2);
    expect(dbLog.updates[0]!.values.src).toContain('https://cdn.test.com/');
    expect(dbLog.updates[0]!.values.srcset_json).toBeDefined();

    // Verify srcset_json shape.
    const srcset: SrcsetJson = JSON.parse(dbLog.updates[0]!.values.srcset_json);
    expect(srcset.key).toMatch(/^shops\/shop-1\/products\/prod-1\//);
    expect(srcset.contentType).toBe('image/jpeg');
    expect(srcset.hash).toHaveLength(16);
    expect(srcset.bytes).toBeGreaterThan(0);
    expect(srcset.width).toBe(800);
    expect(srcset.height).toBe(600);
  });

  it('skips upload when objectStore.has returns true (dedup)', async () => {
    const images = [
      { id: 'img-1', product_id: 'prod-1', src: 'https://cdn.shopify.com/a.jpg', width: 800, height: 600 },
    ];
    // Pre-seed the "exists" set with the expected key pattern.
    const store = createMockStore(storeLog, new Set(['*'])); // we'll override has
    // Override has to always return true.
    (store.has as any).mockResolvedValue(true);
    const db = createMockDb(images, dbLog);

    const result = await ingestProductImages(db, {
      shopId: 'shop-1',
      cloneJobId: 'job-1',
      objectStore: store,
    });

    expect(result.succeeded).toBe(1);
    // put was NOT called because has() returned true.
    expect(storeLog.puts).toHaveLength(0);
    // But DB was still updated with the CDN URL.
    expect(dbLog.updates).toHaveLength(1);
  });

  it('returns empty result when no external images found', async () => {
    const db = createMockDb([], dbLog);
    const store = createMockStore(storeLog);

    const result = await ingestProductImages(db, {
      shopId: 'shop-1',
      cloneJobId: 'job-1',
      objectStore: store,
    });

    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(storeLog.puts).toHaveLength(0);
  });

  it('reports progress callback with done/total', async () => {
    const images = Array.from({ length: 12 }, (_, i) => ({
      id: `img-${i}`,
      product_id: 'prod-1',
      src: `https://cdn.shopify.com/img${i}.jpg`,
      width: 100,
      height: 100,
    }));
    const store = createMockStore(storeLog);
    const db = createMockDb(images, dbLog);

    const progressCalls: Array<[number, number]> = [];
    await ingestProductImages(db, {
      shopId: 'shop-1',
      cloneJobId: 'job-1',
      objectStore: store,
      onProgress: (done, total) => progressCalls.push([done, total]),
    });

    // With 12 images and batch size 6, we expect 2 progress calls.
    expect(progressCalls.length).toBe(2);
    expect(progressCalls[0]).toEqual([6, 12]);
    expect(progressCalls[1]).toEqual([12, 12]);
  });

  it('continues processing when individual images fail', async () => {
    const { safeFetch } = await import('../clone-shopify/safe-fetch.js');
    const mockFetch = safeFetch as ReturnType<typeof vi.fn>;

    // Make the second call fail.
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error('network timeout');
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'image/jpeg' },
        body: Buffer.from([0xff, 0xd8]),
        redirects: [],
      };
    });

    const images = [
      { id: 'img-1', product_id: 'prod-1', src: 'https://cdn.shopify.com/a.jpg', width: 100, height: 100 },
      { id: 'img-2', product_id: 'prod-1', src: 'https://cdn.shopify.com/b.jpg', width: 100, height: 100 },
      { id: 'img-3', product_id: 'prod-1', src: 'https://cdn.shopify.com/c.jpg', width: 100, height: 100 },
    ];
    const store = createMockStore(storeLog);
    const db = createMockDb(images, dbLog);

    const result = await ingestProductImages(db, {
      shopId: 'shop-1',
      cloneJobId: 'job-1',
      objectStore: store,
    });

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.imageId).toBe('img-2');
    expect(result.errors[0]!.message).toContain('network timeout');
  });
});
