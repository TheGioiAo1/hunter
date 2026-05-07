/**
 * Clone Pro v4 — Execution orchestrator tests
 *
 * The orchestrator is the glue between Phase 1 (Discovery) and the final
 * stored theme + imported content. It needs to:
 *
 *   1. Run each sub-step (asset download / layout / templatize / rewrite /
 *      persist-theme / import) in the right order and surface failures as
 *      `errors[]` without aborting the whole pipeline.
 *   2. Skip re-templatizing 'home' when `cloneHomepage` already produced
 *      a `templates/index.liquid`.
 *   3. Apply the asset rewrite map to every templated output.
 *   4. Pass pages / blog-posts / collections to the right persist helper,
 *      converting the deep-crawler `DiscoveredPage` shape into the
 *      `Scraped*` DTOs the persist helpers expect.
 *   5. Keep the `CloneV4Callbacks` progress stream monotonic and capped.
 *
 * Fakes:
 *   - All scraper + persistence helpers are `vi.mock`ed at the module
 *     level. `htmlToLiquid` is NOT mocked — it's a pure function and
 *     letting it run gives more realistic template output in assertions.
 *   - `Kysely<Database>` is replaced with a stub object; no mock DB
 *     shape is needed because persist helpers are mocked end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted module mocks
// ---------------------------------------------------------------------------
// vi.mock calls are hoisted to the top of the file before any import, so we
// can safely describe the mocks here and then import `runExecution` below.

vi.mock('./scrapers/index.js', () => ({
  downloadAllAssets: vi.fn(),
  rewriteUrlsToLocal: vi.fn((html: string, _map: Map<string, string>) => html),
  cloneHomepage: vi.fn(),
}))

vi.mock('./theme-gen/persist-theme.js', () => ({
  persistDynamicTheme: vi.fn(),
}))

vi.mock('./persist/persist-pages.js', () => ({
  persistClonePages: vi.fn(),
}))

vi.mock('./persist/persist-blog.js', () => ({
  persistCloneBlogPosts: vi.fn(),
}))

vi.mock('./persist/persist-collections.js', () => ({
  persistCloneCollections: vi.fn(),
}))

import { runExecution } from './execution-v4.js'
import { downloadAllAssets, rewriteUrlsToLocal, cloneHomepage } from './scrapers/index.js'
import { persistDynamicTheme } from './theme-gen/persist-theme.js'
import { persistClonePages } from './persist/persist-pages.js'
import { persistCloneBlogPosts } from './persist/persist-blog.js'
import { persistCloneCollections } from './persist/persist-collections.js'
import type { DiscoveryResult, CloneV4Callbacks } from './pipeline-v4.js'
import type { CloneProConfig } from './types.js'
import type { DiscoveredPage } from './discovery/deep-crawler.js'
import type { DetectedTemplate, TemplateDetectionResult } from './discovery/template-detector.js'

// ---------------------------------------------------------------------------
// Helpers / Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid CloneProConfig for testing. */
function makeConfig(overrides?: Partial<CloneProConfig>): CloneProConfig {
  return {
    sourceUrl: 'https://example-store.com',
    shopId: 'shop_test_1',
    scope: {
      products: true,
      collections: true,
      pages: true,
      blog: true,
      navigation: true,
      theme: true,
      media: true,
      seo: true,
    },
    ...overrides,
  } as CloneProConfig
}

/** Build a `DiscoveredPage` given a pageType and path. */
function makePage(pageType: DiscoveredPage['pageType'], path: string, bodyHtml = ''): DiscoveredPage {
  const url = `https://example-store.com${path}`
  const html = `<!DOCTYPE html><html><head><title>${pageType} page</title>
    <meta name="description" content="desc for ${path}">
    <meta property="og:image" content="https://cdn/${pageType}.jpg">
  </head><body><main>${bodyHtml || `<h1>${pageType}</h1>`}</main></body></html>`
  return {
    url,
    title: `${pageType} ${path}`,
    pageType,
    statusCode: 200,
    html,
    outLinks: [],
    depth: 1,
  }
}

/** Build a `DetectedTemplate` pointing at a sample page. */
function makeTemplate(pageType: DiscoveredPage['pageType'], templateName: string, samplePage: DiscoveredPage): DetectedTemplate {
  return {
    pageType,
    templateName,
    samplePage: {
      url: samplePage.url,
      title: samplePage.title,
      html: samplePage.html,
      score: 100,
      reason: 'test fixture',
    },
    allCandidates: [],
    count: 1,
    hasVariants: false,
  }
}

/** Build a minimal `DiscoveryResult` from a list of pages + templates. */
function makeDiscovery(
  pages: DiscoveredPage[],
  templates: DetectedTemplate[],
): DiscoveryResult {
  const tdr: TemplateDetectionResult = {
    templates,
    totalTemplateTypes: templates.length,
    warnings: [],
  }
  return {
    platform: { platform: 'shopify', confidence: 90 },
    pages,
    siteMap: {} as any,
    templates: tdr,
    assets: {} as any,
    report: {} as any,
    durationMs: 1000,
  }
}

/** A homepage DiscoveredPage used across tests. */
const homepage = makePage('home', '/', '<section class="hero">HERO</section>')

// ---------------------------------------------------------------------------
// Default mock responses — reset in beforeEach so tests are independent
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(downloadAllAssets).mockReset().mockResolvedValue({
    assets: [],
    rewriteMap: new Map([
      ['https://cdn.example-store.com/img.jpg', '/clone-assets/shop_test_1/img.jpg'],
    ]),
    stats: {
      found: 1,
      downloaded: 1,
      failed: 0,
      totalBytes: 2048,
      errors: [],
    },
  } as any)

  vi.mocked(rewriteUrlsToLocal).mockReset().mockImplementation((html: string) => html)

  vi.mocked(cloneHomepage).mockReset().mockReturnValue({
    headContent: '',
    sections: [{ id: 'hero', html: '<div class="hero">HERO</div>', position: 0 }],
    indexTemplate: '<!-- templates/index.liquid -->\n{% section "hero" %}',
    layoutTemplate: '<!DOCTYPE html><html><body>{{ content_for_layout }}</body></html>',
    headerHtml: '<header>nav</header>',
    footerHtml: '<footer>copyright</footer>',
    isShopify: true,
  } as any)

  vi.mocked(persistDynamicTheme).mockReset().mockResolvedValue('theme_abc123')

  vi.mocked(persistClonePages).mockReset().mockResolvedValue({
    inserted: 0,
    updated: 0,
    skipped: 0,
  } as any)

  vi.mocked(persistCloneBlogPosts).mockReset().mockResolvedValue({
    inserted: 0,
    skipped: 0,
  } as any)

  vi.mocked(persistCloneCollections).mockReset().mockResolvedValue({
    inserted: 0,
    updated: 0,
    productsLinked: 0,
  } as any)
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runExecution — happy path', () => {
  it('runs every sub-step in order and returns a populated ExecutionResult', async () => {
    const productPage = makePage(
      'product',
      '/products/shirt',
      '<div class="product-page"><h1 class="product-title">Shirt</h1><div class="product-price">$10</div></div>',
    )
    const aboutPage = makePage('page', '/pages/about', '<h1 class="page-title">About</h1><div class="rte">Hi</div>')

    const templates = [
      makeTemplate('product', 'templates/product.liquid', productPage),
      makeTemplate('page', 'templates/page.liquid', aboutPage),
    ]
    const discovery = makeDiscovery([homepage, productPage, aboutPage], templates)

    const db = {} as any
    const result = await runExecution(db, makeConfig(), discovery)

    // Sub-step order — assert each was called at least once.
    expect(downloadAllAssets).toHaveBeenCalledTimes(1)
    expect(cloneHomepage).toHaveBeenCalledTimes(1)
    expect(rewriteUrlsToLocal).toHaveBeenCalled()
    expect(persistDynamicTheme).toHaveBeenCalledTimes(1)

    // downloadAllAssets is called with the homepage HTML, source URL, shopId
    expect(downloadAllAssets).toHaveBeenCalledWith(
      homepage.html,
      'https://example-store.com',
      'shop_test_1',
      expect.objectContaining({ maxConcurrency: 5 }),
    )

    // persistDynamicTheme gets a Record<string,string> of templates — make
    // sure layout, product, page, hero are all keys.
    const themeArgs = vi.mocked(persistDynamicTheme).mock.calls[0]
    expect(themeArgs[1]).toBe('shop_test_1')
    const assets = themeArgs[2] as { templates: Record<string, string> }
    expect(Object.keys(assets.templates)).toEqual(
      expect.arrayContaining([
        'layout/theme.liquid',
        'sections/header.liquid',
        'sections/footer.liquid',
        'templates/index.liquid',
        'templates/product.liquid',
        'templates/page.liquid',
        'sections/hero.liquid',
      ]),
    )

    // Templates ran through htmlToLiquid — product template contains the
    // Liquid binding for product.title.
    expect(assets.templates['templates/product.liquid']).toContain('{{ product.title }}')
    expect(assets.templates['templates/page.liquid']).toContain('{{ page.title }}')

    // Content persist helpers called with mapped pages.
    expect(persistClonePages).toHaveBeenCalledTimes(1)
    const pageArgs = vi.mocked(persistClonePages).mock.calls[0]
    expect(pageArgs[1]).toBe('shop_test_1')
    expect((pageArgs[2] as any[]).length).toBe(1)

    // Return shape
    expect(result.themeId).toBe('theme_abc123')
    expect(result.templatesWritten).toBeGreaterThanOrEqual(4)
    expect(result.assetsDownloaded).toBe(1)
    expect(result.errors).toEqual([])
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('streams progress and phase updates to the callback in monotonic order', async () => {
    const productPage = makePage('product', '/products/a', '<div><h1 class="product-title">A</h1></div>')
    const discovery = makeDiscovery(
      [homepage, productPage],
      [makeTemplate('product', 'templates/product.liquid', productPage)],
    )

    const progressEvents: Array<{ pct: number; msg: string }> = []
    const phaseEvents: Array<{ phase: string; status: string }> = []

    const cb: CloneV4Callbacks = {
      onProgress: (pct, msg) => progressEvents.push({ pct, msg }),
      onPhaseUpdate: (phase, status) => phaseEvents.push({ phase, status }),
    }

    await runExecution({} as any, makeConfig(), discovery, cb)

    // Progress is monotonic non-decreasing and bounded 0..100.
    for (let i = 1; i < progressEvents.length; i++) {
      expect(progressEvents[i].pct).toBeGreaterThanOrEqual(progressEvents[i - 1].pct)
    }
    for (const e of progressEvents) {
      expect(e.pct).toBeGreaterThanOrEqual(0)
      expect(e.pct).toBeLessThanOrEqual(100)
    }

    // Final 100% tick fires.
    expect(progressEvents.at(-1)?.pct).toBe(100)

    // Phase lifecycle: running → succeeded.
    expect(phaseEvents[0]).toEqual({ phase: 'execution', status: 'running' })
    expect(phaseEvents.at(-1)).toEqual({ phase: 'execution', status: 'succeeded' })
  })
})

// ---------------------------------------------------------------------------
// Error isolation
// ---------------------------------------------------------------------------

describe('runExecution — error isolation', () => {
  it('captures asset-download failures in errors[] but keeps going', async () => {
    vi.mocked(downloadAllAssets).mockRejectedValueOnce(new Error('network exploded'))

    const productPage = makePage('product', '/products/a', '<div><h1 class="product-title">A</h1></div>')
    const discovery = makeDiscovery(
      [homepage, productPage],
      [makeTemplate('product', 'templates/product.liquid', productPage)],
    )

    const errors: Error[] = []
    const result = await runExecution({} as any, makeConfig(), discovery, {
      onError: (_phase, err) => errors.push(err),
    })

    expect(result.errors.some((e) => e.step === '2.1-assets')).toBe(true)
    expect(result.errors.some((e) => e.message === 'network exploded')).toBe(true)
    // onError callback fired.
    expect(errors.map((e) => e.message)).toContain('network exploded')
    // Layout + persist still ran even though assets failed.
    expect(cloneHomepage).toHaveBeenCalled()
    expect(persistDynamicTheme).toHaveBeenCalled()
  })

  it('captures cloneHomepage failures without aborting the pipeline', async () => {
    vi.mocked(cloneHomepage).mockImplementationOnce(() => {
      throw new Error('layout parse bug')
    })

    const productPage = makePage('product', '/products/a', '<div><h1 class="product-title">A</h1></div>')
    const discovery = makeDiscovery(
      [homepage, productPage],
      [makeTemplate('product', 'templates/product.liquid', productPage)],
    )

    const result = await runExecution({} as any, makeConfig(), discovery)

    expect(result.errors.some((e) => e.step === '2.3-layout')).toBe(true)
    expect(result.errors.some((e) => e.message === 'layout parse bug')).toBe(true)

    // Per-type templatization + persist still happened.
    expect(persistDynamicTheme).toHaveBeenCalled()
    const assets = vi.mocked(persistDynamicTheme).mock.calls[0][2] as { templates: Record<string, string> }
    // No layout key because cloneHomepage failed...
    expect(assets.templates['layout/theme.liquid']).toBeUndefined()
    // ...but the product template was still produced by htmlToLiquid.
    expect(assets.templates['templates/product.liquid']).toContain('{{ product.title }}')
  })

  it('continues past persist-theme failures and still imports content', async () => {
    vi.mocked(persistDynamicTheme).mockRejectedValueOnce(new Error('db write failed'))

    // Include a `page` DiscoveredPage so persistClonePages actually has work
    // to do — the orchestrator short-circuits when the filter is empty.
    const productPage = makePage('product', '/products/a', '<div><h1 class="product-title">A</h1></div>')
    const aboutPage = makePage('page', '/pages/about')
    const discovery = makeDiscovery(
      [homepage, productPage, aboutPage],
      [makeTemplate('product', 'templates/product.liquid', productPage)],
    )

    const result = await runExecution({} as any, makeConfig(), discovery)

    expect(result.errors.some((e) => e.step === 'persist-theme')).toBe(true)
    // Content persist helpers are still invoked after a theme failure.
    expect(persistClonePages).toHaveBeenCalled()
    expect(persistCloneBlogPosts).toHaveBeenCalledTimes(0) // no blog-post pages
    expect(persistCloneCollections).toHaveBeenCalledTimes(0) // no collection pages
  })

  it('ends with phase=failed when any error was captured', async () => {
    vi.mocked(persistDynamicTheme).mockRejectedValueOnce(new Error('db gone'))

    const productPage = makePage('product', '/products/a', '<div><h1 class="product-title">A</h1></div>')
    const discovery = makeDiscovery(
      [homepage, productPage],
      [makeTemplate('product', 'templates/product.liquid', productPage)],
    )

    const phaseEvents: Array<{ phase: string; status: string }> = []
    await runExecution({} as any, makeConfig(), discovery, {
      onPhaseUpdate: (phase, status) => phaseEvents.push({ phase, status }),
    })

    expect(phaseEvents.at(-1)).toEqual({ phase: 'execution', status: 'failed' })
  })
})

// ---------------------------------------------------------------------------
// Homepage detection + skip
// ---------------------------------------------------------------------------

describe('runExecution — homepage handling', () => {
  it('skips asset download when no homepage exists in discovery.pages', async () => {
    // Discovery pages contain ONLY a product page (no home, no matching URL).
    const productPage = makePage('product', '/products/a', '<div><h1 class="product-title">A</h1></div>')
    const discovery = makeDiscovery(
      [productPage],
      [makeTemplate('product', 'templates/product.liquid', productPage)],
    )
    // Use a source URL that matches nothing in the pages array.
    const config = makeConfig({ sourceUrl: 'https://wrong-origin.example.com' })

    // Pipeline picks the first page (productPage) as fallback homepage, so
    // asset download DOES run. To truly skip, we'd need zero pages.
    const emptyDiscovery = makeDiscovery([], [])
    const result = await runExecution({} as any, makeConfig(), emptyDiscovery)

    expect(downloadAllAssets).not.toHaveBeenCalled()
    expect(result.warnings.some((w) => /no homepage/i.test(w))).toBe(true)
    // And since cloneHomepage also needs a homepage, it isn't called either.
    expect(cloneHomepage).not.toHaveBeenCalled()

    // Reference `productPage` / `discovery` / `config` so lint doesn't complain.
    expect(productPage.url).toMatch(/\/products\/a$/)
    expect(discovery.pages.length).toBe(1)
    expect(config.sourceUrl).toBe('https://wrong-origin.example.com')
  })

  it('does NOT re-templatize home when cloneHomepage already produced templates/index.liquid', async () => {
    const discovery = makeDiscovery(
      [homepage],
      [makeTemplate('home', 'templates/index.liquid', homepage)],
    )

    await runExecution({} as any, makeConfig(), discovery)

    // cloneHomepage produced templates/index.liquid already — we should not
    // run htmlToLiquid on the 'home' template, so the persisted
    // templates/index.liquid should match the cloneHomepage output rather
    // than the htmlToLiquid body-only output.
    const args = vi.mocked(persistDynamicTheme).mock.calls[0][2] as { templates: Record<string, string> }
    expect(args.templates['templates/index.liquid']).toContain('templates/index.liquid')
    expect(args.templates['templates/index.liquid']).toContain('{% section "hero" %}')
  })

  it('skips theme persistence when no templates were produced (no homepage + no detected templates)', async () => {
    const emptyDiscovery = makeDiscovery([], [])
    const result = await runExecution({} as any, makeConfig(), emptyDiscovery)

    expect(persistDynamicTheme).not.toHaveBeenCalled()
    expect(result.warnings.some((w) => /no templates produced/i.test(w))).toBe(true)
    expect(result.themeId).toBeNull()
  })

  it('respects ingestMedia:false by skipping asset download', async () => {
    const discovery = makeDiscovery([homepage], [])
    await runExecution({} as any, makeConfig({ ingestMedia: false }), discovery)

    expect(downloadAllAssets).not.toHaveBeenCalled()
    // Layout still produced from the homepage.
    expect(cloneHomepage).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// URL rewriting
// ---------------------------------------------------------------------------

describe('runExecution — URL rewriting', () => {
  it('applies rewriteUrlsToLocal to every emitted template when rewriteMap is non-empty', async () => {
    const productPage = makePage('product', '/products/a', '<div><h1 class="product-title">A</h1></div>')
    const discovery = makeDiscovery(
      [homepage, productPage],
      [makeTemplate('product', 'templates/product.liquid', productPage)],
    )

    await runExecution({} as any, makeConfig(), discovery)

    // rewriteUrlsToLocal must be called at least once per template file we
    // intend to persist (layout, index, header, footer, hero section, product).
    const rewriteCallCount = vi.mocked(rewriteUrlsToLocal).mock.calls.length
    expect(rewriteCallCount).toBeGreaterThanOrEqual(5)
  })

  it('skips URL rewriting entirely when the rewriteMap is empty', async () => {
    vi.mocked(downloadAllAssets).mockResolvedValueOnce({
      assets: [],
      rewriteMap: new Map(),
      stats: { found: 0, downloaded: 0, failed: 0, totalBytes: 0, errors: [] },
    } as any)

    const productPage = makePage('product', '/products/a', '<div><h1 class="product-title">A</h1></div>')
    const discovery = makeDiscovery(
      [homepage, productPage],
      [makeTemplate('product', 'templates/product.liquid', productPage)],
    )

    await runExecution({} as any, makeConfig(), discovery)

    expect(rewriteUrlsToLocal).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Content import mapping (DiscoveredPage → ScrapedPage/ScrapedBlogPost/ScrapedCollection)
// ---------------------------------------------------------------------------

describe('runExecution — content import mapping', () => {
  it('maps page and policy DiscoveredPage into ScrapedPage with correct page_type', async () => {
    const about = makePage('page', '/pages/about')
    const privacy = makePage('policy', '/policies/privacy-policy')
    const shipping = makePage('policy', '/policies/shipping-policy')
    const discovery = makeDiscovery([homepage, about, privacy, shipping], [])

    await runExecution({} as any, makeConfig(), discovery)

    const [, , scraped] = vi.mocked(persistClonePages).mock.calls[0] as unknown as [any, string, any[]]
    expect(scraped).toHaveLength(3)

    const byPath = new Map<string, any>(scraped.map((p) => [p.url, p]))

    expect(byPath.get('https://example-store.com/pages/about')?.page_type).toBe('about')
    expect(byPath.get('https://example-store.com/policies/privacy-policy')?.page_type).toBe('policy')
    expect(byPath.get('https://example-store.com/policies/shipping-policy')?.page_type).toBe('shipping')

    // Meta description was extracted from the HTML head
    expect(byPath.get('https://example-store.com/pages/about')?.meta_description).toMatch(/desc for/)
    // og:image was extracted
    expect(byPath.get('https://example-store.com/pages/about')?.og_image).toBe('https://cdn/page.jpg')
  })

  it('passes blog-post pages to persistCloneBlogPosts with correct ScrapedBlogPost shape', async () => {
    const bp1 = makePage('blog-post', '/blogs/news/hello')
    const discovery = makeDiscovery([homepage, bp1], [])

    await runExecution({} as any, makeConfig(), discovery)

    expect(persistCloneBlogPosts).toHaveBeenCalledTimes(1)
    const [, , posts] = vi.mocked(persistCloneBlogPosts).mock.calls[0] as unknown as [any, string, any[]]
    expect(posts).toHaveLength(1)
    expect(posts[0].slug).toBe('hello')
    expect(posts[0].image_url).toBe('https://cdn/blog-post.jpg')
    // Required fields are present (body_html, title, tags)
    expect(posts[0].title).toBeTruthy()
    expect(Array.isArray(posts[0].tags)).toBe(true)
  })

  it('passes collection pages to persistCloneCollections with correct ScrapedCollection shape', async () => {
    const coll = makePage('collection', '/collections/sale')
    const discovery = makeDiscovery([homepage, coll], [])

    await runExecution({} as any, makeConfig(), discovery)

    expect(persistCloneCollections).toHaveBeenCalledTimes(1)
    const [, , scraped, productMap] = vi.mocked(persistCloneCollections).mock.calls[0] as unknown as [any, string, any[], Map<string, string>]
    expect(scraped).toHaveLength(1)
    expect(scraped[0].slug).toBe('sale')
    expect(scraped[0].product_urls).toEqual([])
    // Empty product map — v4 doesn't wire product→collection yet
    expect(productMap.size).toBe(0)
  })

  it('is a safe no-op for each content type when no matching pages exist', async () => {
    const discovery = makeDiscovery([homepage], [])
    await runExecution({} as any, makeConfig(), discovery)

    // Pages and blog posts and collections all get 0 — persist helpers are
    // NOT called at all, saving unnecessary db roundtrips.
    expect(persistClonePages).not.toHaveBeenCalled()
    expect(persistCloneBlogPosts).not.toHaveBeenCalled()
    expect(persistCloneCollections).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Template changes diagnostics
// ---------------------------------------------------------------------------

describe('runExecution — template change diagnostics', () => {
  it('captures TemplateChange[] from every templatized file into result.templateChanges', async () => {
    const productPage = makePage(
      'product',
      '/products/a',
      '<div><h1 class="product-title">A</h1><div class="product-price">$1</div></div>',
    )
    const discovery = makeDiscovery(
      [homepage, productPage],
      [makeTemplate('product', 'templates/product.liquid', productPage)],
    )

    const result = await runExecution({} as any, makeConfig(), discovery)

    const productChanges = result.templateChanges.find((c) => c.templateName === 'templates/product.liquid')
    expect(productChanges).toBeDefined()
    const fields = productChanges!.changes.map((c) => c.field)
    // htmlToLiquid logged product.title + product.price substitutions.
    expect(fields).toContain('product.title')
    expect(fields).toContain('product.price')
  })
})
