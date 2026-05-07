import { describe, it, expect, vi } from 'vitest'
import { renderTheme, bundleTheme, type ThemeBundle, type S3UploadFn } from './theme-renderer.js'
import type { DesignTokens } from './token-schema.js'

const TOKENS: DesignTokens = {
  fonts: {
    primary: { family: 'Cormorant Garamond', google_font: 'Cormorant Garamond', weights: [400, 600] },
    secondary: { family: 'Inter', google_font: 'Inter', weights: [400] },
  },
  colors: {
    primary: '#3b2f2f',
    secondary: '#f5ebe0',
    accent: null,
    background: '#fffaf3',
    foreground: '#241a1a',
    muted: null,
  },
  spacing: { base_unit: 8, scale: [4, 8, 16, 24, 32] },
  breakpoints: { mobile: 480, tablet: 768, desktop: 1024, wide: 1440 },
  components: {
    header: { height: 80, background: '#fffaf3', variant: 'minimal' },
    product_card: { aspect_ratio: '3/4', border_radius: 0, variant: 'editorial' },
    button: { border_radius: 2, padding_x: 24, padding_y: 12, variant: 'minimal' },
    navigation: { variant: 'horizontal', placement: 'top' },
  },
  layout: { container_max_width: 1240, grid_columns: 12, hero_pattern: 'editorial' },
  style_keywords: ['editorial', 'warm'],
  aesthetic_score: 8.4,
}

describe('renderTheme', () => {
  it('returns a ThemeBundle with files, version=1, theme_id (uuid), and a non-empty file map', async () => {
    const bundle = await renderTheme({ tokens: TOKENS })
    expect(bundle.theme_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(bundle.version).toBe(1)
    expect(Object.keys(bundle.files).length).toBeGreaterThan(0)
  })

  it('renders the 5 page templates (index/product/collection/cart/page) into files', async () => {
    const bundle = await renderTheme({ tokens: TOKENS })
    expect(bundle.files['templates/index.liquid']).toBeDefined()
    expect(bundle.files['templates/product.liquid']).toBeDefined()
    expect(bundle.files['templates/collection.liquid']).toBeDefined()
    expect(bundle.files['templates/cart.liquid']).toBeDefined()
    expect(bundle.files['templates/page.liquid']).toBeDefined()
  })

  it('renders the base layout file with token variables substituted', async () => {
    const bundle = await renderTheme({ tokens: TOKENS })
    expect(bundle.files['layout/theme.liquid']).toBeDefined()
    // Google Fonts URL should be inlined as resolved (not still {{ font_primary_url }}).
    expect(bundle.files['layout/theme.liquid']).toContain('https://fonts.googleapis.com/css2?')
  })

  it('renders only the section variants the manifest selected (no orphans)', async () => {
    const bundle = await renderTheme({ tokens: TOKENS })
    // editorial hero, editorial product_card, minimal header, horizontal nav,
    // editorial footer (style_keywords includes 'editorial' so footer-editorial wins).
    expect(bundle.files['sections/hero-editorial.liquid']).toBeDefined()
    expect(bundle.files['sections/product-card-editorial.liquid']).toBeDefined()
    expect(bundle.files['sections/header-minimal.liquid']).toBeDefined()
    expect(bundle.files['sections/nav-horizontal.liquid']).toBeDefined()
    expect(bundle.files['sections/footer-editorial.liquid']).toBeDefined()
    // Variants NOT selected should not be in the output.
    expect(bundle.files['sections/hero-fullbleed.liquid']).toBeUndefined()
    expect(bundle.files['sections/product-card-classic.liquid']).toBeUndefined()
  })

  it('emits assets/theme.css with :root block + base styles', async () => {
    const bundle = await renderTheme({ tokens: TOKENS })
    const css = bundle.files['assets/theme.css']
    expect(css).toBeDefined()
    expect(css).toMatch(/:root\s*\{/)
    expect(css).toMatch(/--color-primary:\s*#3b2f2f/)
    // Base styles appended after the :root block.
    expect(css).toContain('.container')
    expect(css).toContain('.product-card')
  })

  it('emits snippets/header.liquid + snippets/footer.liquid + assets/theme.js', async () => {
    const bundle = await renderTheme({ tokens: TOKENS })
    expect(bundle.files['snippets/header.liquid']).toBeDefined()
    expect(bundle.files['snippets/footer.liquid']).toBeDefined()
    expect(bundle.files['assets/theme.js']).toBeDefined()
  })

  it('exposes the manifest used so the orchestrator can persist it', async () => {
    const bundle = await renderTheme({ tokens: TOKENS })
    expect(bundle.manifest.hero).toBe('editorial')
    expect(bundle.manifest.product_card).toBe('editorial')
    expect(bundle.manifest.header).toBe('minimal')
  })

  it('honours the version arg for retry iterations', async () => {
    const bundle = await renderTheme({ tokens: TOKENS, version: 3 })
    expect(bundle.version).toBe(3)
  })

  it('supports passing previousFeedback for the retry loop (recorded but does not crash)', async () => {
    const bundle = await renderTheme({
      tokens: TOKENS,
      previousFeedback: ['Header is too short', 'Hero feels generic'],
    })
    expect(bundle.feedback_applied).toEqual([
      'Header is too short',
      'Hero feels generic',
    ])
  })
})

describe('bundleTheme', () => {
  it('uploads a zip buffer to S3 with the canonical key and returns the key', async () => {
    const upload: S3UploadFn = vi.fn().mockResolvedValue(undefined)
    const bundle: ThemeBundle = {
      theme_id: '11111111-2222-3333-4444-555555555555',
      version: 1,
      files: {
        'layout/theme.liquid': '<!doctype html>',
        'templates/index.liquid': '<main></main>',
        'assets/theme.css': ':root {}',
      },
      manifest: { hero: 'minimal', product_card: 'classic', header: 'classic', footer: 'classic', navigation: 'horizontal' },
      feedback_applied: [],
    }
    const key = await bundleTheme({ bundle, shopId: 'shop-1', upload })
    expect(key).toBe('shop-1/theme/theme.zip')
    expect(upload).toHaveBeenCalledTimes(1)
    const args = (upload as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.key).toBe('shop-1/theme/theme.zip')
    expect(Buffer.isBuffer(args.body)).toBe(true)
    // Sanity: the buffer is non-trivial in size.
    expect((args.body as Buffer).length).toBeGreaterThan(50)
  })

  it('propagates upload errors via Iron rule 5 wrapper (safeMessage)', async () => {
    const upload: S3UploadFn = vi.fn().mockRejectedValue(new Error('S3 5xx'))
    const bundle: ThemeBundle = {
      theme_id: '11111111-2222-3333-4444-555555555555',
      version: 1,
      files: { 'a.txt': 'hi' },
      manifest: { hero: 'minimal', product_card: 'classic', header: 'classic', footer: 'classic', navigation: 'horizontal' },
      feedback_applied: [],
    }
    await expect(bundleTheme({ bundle, shopId: 'shop-2', upload })).rejects.toThrow(/Please contact Gbox support/)
  })

  it('zip contains every file from the bundle (decode roundtrip)', async () => {
    let captured: Buffer | null = null
    const upload: S3UploadFn = vi.fn().mockImplementation(async (args: { body: Buffer }) => {
      captured = args.body
    })
    const bundle: ThemeBundle = {
      theme_id: '11111111-2222-3333-4444-555555555555',
      version: 1,
      files: {
        'layout/theme.liquid': '<!doctype html>',
        'templates/index.liquid': '<main>HOME</main>',
        'assets/theme.css': ':root { --x: 1; }',
        'snippets/header.liquid': '<header>HEAD</header>',
      },
      manifest: { hero: 'minimal', product_card: 'classic', header: 'classic', footer: 'classic', navigation: 'horizontal' },
      feedback_applied: [],
    }
    await bundleTheme({ bundle, shopId: 'shop-3', upload })
    expect(captured).not.toBeNull()
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(captured as unknown as Buffer)
    const names = Object.keys(zip.files)
    expect(names).toEqual(
      expect.arrayContaining([
        'layout/theme.liquid',
        'templates/index.liquid',
        'assets/theme.css',
        'snippets/header.liquid',
      ]),
    )
    const css = await zip.files['assets/theme.css'].async('string')
    expect(css).toBe(':root { --x: 1; }')
  })
})
