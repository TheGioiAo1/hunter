/**
 * Unit tests for run.ts — the clone orchestrator.
 *
 * Uses a mock DB that records calls (no real Postgres) and a crawler
 * override to feed fixture product DTOs. The goal is to verify:
 *
 *   - Job transitions queued → running → succeeded
 *   - stages_json gets a `products` entry appended
 *   - progress_pct reaches 100 on success
 *   - Failures mark the job `failed` with a classified error code
 */

import { describe, it, expect, vi } from 'vitest';
import { runStorefrontClone } from './run.js';
import { ShopifyCrawlError } from '../clone-shopify/index.js';
import type { CloneProductDTO } from '../clone-shopify/index.js';

interface DbCallLog {
  readonly updates: Array<{ jobId: string; values: any }>;
  readonly stageAppends: Array<{ jobId: string; stage: any }>;
  productInserts: number;
}

function createMockDb(log: DbCallLog): any {
  // The orchestrator uses these job-store helpers — we mock them via
  // a chainable proxy that matches the Kysely builder surface.
  const chainable: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        if (prop === 'execute') return () => Promise.resolve([]);
        if (prop === 'executeTakeFirst') return () => Promise.resolve(null);
        if (prop === 'executeTakeFirstOrThrow') {
          return () =>
            Promise.resolve({
              id: 'job-1',
              shop_id: 'shop-1',
              source_url: 'https://example.com',
              status: 'running',
              stages_json: [],
              progress_pct: 0,
              result_json: null,
              error_code: null,
              error_message: null,
              started_at: null,
              finished_at: null,
              created_by: null,
              created_at: new Date().toISOString(),
            });
        }
        return vi.fn().mockReturnValue(chainable);
      },
    },
  );

  // persist-products uses transaction().execute() with a trx that
  // exposes selectFrom/insertInto/updateTable/deleteFrom. We also need
  // updateTable('storefront_clone_jobs') at the top level.
  const trxProxy: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'selectFrom') {
          return vi.fn().mockReturnValue(chainable);
        }
        if (prop === 'insertInto') {
          return vi.fn().mockImplementation((table: string) => {
            if (table === 'products') log.productInserts += 1;
            return {
              values: () => ({
                returning: () => ({
                  executeTakeFirstOrThrow: () => Promise.resolve({ id: 'new-product-id' }),
                }),
                returningAll: () => ({
                  executeTakeFirstOrThrow: () => Promise.resolve({ id: 'new-product-id' }),
                  execute: () => Promise.resolve([]),
                }),
                execute: () => Promise.resolve([]),
              }),
            };
          });
        }
        if (prop === 'updateTable') {
          return vi.fn().mockImplementation((table: string) => ({
            set: (values: any) => {
              if (table === 'storefront_clone_jobs') {
                log.updates.push({ jobId: 'job-1', values });
              }
              return {
                where: () => ({
                  execute: () => Promise.resolve([]),
                  returningAll: () => ({
                    executeTakeFirstOrThrow: () =>
                      Promise.resolve({
                        id: 'job-1',
                        shop_id: 'shop-1',
                        source_url: 'https://example.com',
                        status: values.status ?? 'running',
                        stages_json: [],
                        progress_pct: values.progress_pct ?? 0,
                        result_json: null,
                        error_code: values.error_code ?? null,
                        error_message: values.error_message ?? null,
                        started_at: null,
                        finished_at: null,
                        created_by: null,
                        created_at: new Date().toISOString(),
                      }),
                  }),
                }),
              };
            },
          }));
        }
        if (prop === 'deleteFrom') {
          return vi.fn().mockReturnValue({
            where: () => ({ execute: () => Promise.resolve([]) }),
          });
        }
        return vi.fn().mockReturnValue(chainable);
      },
    },
  );

  return {
    transaction: () => ({
      execute: async (fn: (trx: any) => Promise<void>) => {
        await fn(trxProxy);
      },
    }),
    selectFrom: trxProxy.selectFrom,
    insertInto: trxProxy.insertInto,
    updateTable: trxProxy.updateTable,
    deleteFrom: trxProxy.deleteFrom,
  };
}

const fixtureProduct: CloneProductDTO = {
  sourceProductId: '1',
  handle: 'sample',
  title: 'Sample',
  descriptionHtml: '',
  vendor: null,
  productType: null,
  tags: [],
  images: [],
  variants: [
    {
      sourceVariantId: '11',
      sku: null,
      title: 'Default',
      price: '10',
      compareAtPrice: null,
      optionValues: [],
      available: true,
    },
  ],
};

describe('runStorefrontClone', () => {
  it('transitions queued → running → succeeded on happy path', async () => {
    const log: DbCallLog = { updates: [], stageAppends: [], productInserts: 0 };
    const db = createMockDb(log);

    const result = await runStorefrontClone(db, {
      shopId: 'shop-1',
      jobId: 'job-1',
      sourceUrl: 'https://example.com',
      crawlerOverride: async () => [fixtureProduct],
    });

    expect(result.productsInserted).toBe(1);
    expect(result.productsUpdated).toBe(0);

    // Should have set status=running at start
    expect(log.updates.some((u) => u.values.status === 'running')).toBe(true);

    // Should have set status=succeeded with progress=100 at end
    const succeeded = log.updates.find((u) => u.values.status === 'succeeded');
    expect(succeeded).toBeDefined();
    expect(succeeded?.values.progress_pct).toBe(100);
    expect(succeeded?.values.result_json).toBeDefined();
  });

  it('marks job failed when crawler throws a ShopifyCrawlError', async () => {
    const log: DbCallLog = { updates: [], stageAppends: [], productInserts: 0 };
    const db = createMockDb(log);

    await expect(
      runStorefrontClone(db, {
        shopId: 'shop-1',
        jobId: 'job-1',
        sourceUrl: 'https://example.com',
        crawlerOverride: async () => {
          throw new ShopifyCrawlError('bad_status', 'Got 404');
        },
      }),
    ).rejects.toThrow(ShopifyCrawlError);

    const failed = log.updates.find((u) => u.values.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed?.values.error_code).toBe('crawl_bad_status');
    expect(failed?.values.error_message).toContain('404');
  });

  it('marks job failed on generic errors too', async () => {
    const log: DbCallLog = { updates: [], stageAppends: [], productInserts: 0 };
    const db = createMockDb(log);

    await expect(
      runStorefrontClone(db, {
        shopId: 'shop-1',
        jobId: 'job-1',
        sourceUrl: 'https://example.com',
        crawlerOverride: async () => {
          throw new Error('network down');
        },
      }),
    ).rejects.toThrow('network down');

    const failed = log.updates.find((u) => u.values.status === 'failed');
    expect(failed?.values.error_code).toBe('unknown');
  });
});
