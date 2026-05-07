/**
 * Clone Pro v5 — real dependency factory for `runCloneProV5Wired`
 *
 * The pipeline orchestrator is pure and takes a `PipelineDeps` bundle.
 * Unit tests inject fakes; production runs inject real scrapers +
 * DB-backed persisters + HTTP route-check via this factory.
 *
 * Kept as a separate module (not inlined in wired-runner.ts) so:
 *   - wired-runner stays importable without the concrete scraper/pg
 *     graph (keeps unit tests fast).
 *   - real-world E2E smoke scripts can build the same deps bundle
 *     without going through the BullMQ worker.
 *
 * Design notes:
 *   - `fetchHomepage` uses the node 20 global `fetch` with the same
 *     user-agent as `detectPlatform` so server logs consistently
 *     identify GboxCloneBot. An 8s timeout matches the detector.
 *   - `persistAll` threads a single `runCloneImport` around every
 *     persister so one SERIALIZABLE transaction covers the whole
 *     phase. The individual persisters never see raw `db`, only the
 *     `tx` handle — that's the contract they're written against.
 *   - `mountPreview` is a stub for PR1: it inserts a `cloned_previews`
 *     row with a deterministic subdomain. Real DNS wiring happens in
 *     PR2/3. The returned URL still threads through the route-check
 *     and DESIGN.md so the downstream code doesn't fork on
 *     PR1-vs-later.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { PipelineDeps } from './pipeline.js'
import type { FlaggedMenuTree } from './validate/guardrails.js'
import type {
  ScrapedProduct,
  ScrapedCollection,
  ScrapedPage,
  ThemeTokens,
} from './types.js'

import { detectPlatform } from './platform-detect.js'
import { scrapeShopifyProducts } from './scrapers/shopify-products.js'
import { scrapeShopifyCollections } from './scrapers/shopify-collections.js'
import { scrapeSitemapPages } from './scrapers/sitemap-pages.js'
import { parseMenuTree } from './scrapers/menu-parser.js'
import { extractThemeTokens } from './scrapers/theme-tokens.js'
import { routeCheck } from './verify/route-check.js'

import { runCloneImport } from './persisters/import-transaction.js'
import { persistProducts } from './persisters/products-persist.js'
import { persistCollections } from './persisters/collections-persist.js'
import { persistPages } from './persisters/pages-persist.js'
import { persistMenus } from './persisters/menus-persist.js'
import { persistTheme } from './persisters/theme-persist.js'

const USER_AGENT = 'GboxCloneBot/1.0 (+https://gbox.co/bot)'
const HOMEPAGE_TIMEOUT_MS = 8000

export interface BuildDepsOpts {
  /**
   * Override the preview host for local dev. Production should leave
   * this unset so the canonical `.clone-preview.gbox.local` domain
   * lands in the DB + DESIGN.md.
   */
  readonly previewHost?: string
}

/**
 * Assembles a live `PipelineDeps` bundle. Call once per job — the
 * returned object is cheap to construct and holds no per-job state.
 */
export function buildV5Deps(
  db: Kysely<Database>,
  opts: BuildDepsOpts = {},
): PipelineDeps {
  const previewHost = opts.previewHost ?? 'clone-preview.gbox.local'

  return {
    scrapers: {
      detectPlatform,
      fetchHomepage: async (url) => {
        // Plain GET on the provided URL. 8s timeout matches the
        // platform detector so a stalled origin fails fast in phase ②.
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), HOMEPAGE_TIMEOUT_MS)
        try {
          const res = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'user-agent': USER_AGENT },
          })
          if (!res.ok) {
            throw new Error(`fetchHomepage: HTTP ${res.status} for ${url}`)
          }
          return await res.text()
        } finally {
          clearTimeout(timer)
        }
      },
      scrapeProducts: (url) => scrapeShopifyProducts(url) as Promise<readonly ScrapedProduct[]>,
      scrapeCollections: (url) =>
        scrapeShopifyCollections(url) as Promise<readonly ScrapedCollection[]>,
      scrapePages: (url) => scrapeSitemapPages(url) as Promise<readonly ScrapedPage[]>,
      parseMenu: parseMenuTree,
      extractTokens: extractThemeTokens,
    },

    persisters: {
      persistAll: async (args) => {
        // One SERIALIZABLE tx covers the entire persist phase — see
        // `runCloneImport`. If any persister throws, the tx rolls
        // back and `clone_checkpoints` is NOT written, so restart
        // logic knows this phase is incomplete.
        return runCloneImport(db, args.jobId, async (tx) => {
          const prod = await persistProducts(tx, args.shopId, args.products)
          const coll = await persistCollections(tx, args.shopId, args.collections)
          const pages = await persistPages(tx, args.shopId, args.pages)
          const menus = await persistMenus(tx, args.shopId, args.menuTree as FlaggedMenuTree)
          await persistTheme(tx, args.shopId, args.themeTokens as ThemeTokens)
          return {
            productsInserted: prod.inserted,
            collectionsInserted: coll.inserted,
            pagesInserted: pages.inserted,
            menuItems: menus.itemsInserted,
          }
        })
      },

      mountPreview: async (jobId) => {
        // PR1 stub: persist a `cloned_previews` row + return the
        // canonical URL. Real DNS / reverse-proxy wiring is PR2/3.
        //
        // Schema note: `cloned_previews` stores only (job_id, subdomain,
        // expires_at, approved_at). The `preview_url` itself lives on
        // `storefront_clone_jobs` — wired-runner persists it there via
        // `updateStorefrontCloneJob`. Here we only own the subdomain
        // registry row.
        //
        // Idempotent: the UNIQUE constraint is on `subdomain`, and our
        // subdomain is a deterministic hash of the jobId prefix, so a
        // retry of the same job re-uses the same row. ON CONFLICT on
        // `subdomain` refreshes the TTL.
        const subdomain = `clone-${jobId.slice(0, 8)}`
        const url = `https://${subdomain}.${previewHost}`
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        await (db as any)
          .insertInto('cloned_previews')
          .values({
            job_id: jobId,
            subdomain,
            expires_at: expiresAt,
          })
          .onConflict((oc: any) =>
            oc.column('subdomain').doUpdateSet({
              job_id: jobId,
              expires_at: expiresAt,
            }),
          )
          .execute()
        return url
      },
    },

    verify: {
      routeCheck: async (urls) => routeCheck(urls),
    },
  }
}
