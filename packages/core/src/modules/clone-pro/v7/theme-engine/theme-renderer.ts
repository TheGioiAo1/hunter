/**
 * Clone Pro v7 — Theme renderer + bundler
 *
 * Two pure-ish entry points:
 *
 *   renderTheme(opts) — given DesignTokens, returns a `ThemeBundle`:
 *     a `theme_id` (UUIDv4), `version`, the rendered file map (Liquid
 *     pre-substituted with token vars), and the chosen manifest. No
 *     I/O — purely consumes the on-disk template-base library and
 *     returns in-memory strings. Lets Stage 15 unit-test render
 *     correctness without S3 / Postgres mocks.
 *
 *   bundleTheme({ bundle, shopId, upload }) — zips the file map into
 *     a `theme.zip` buffer (JSZip) and hands it to the caller-supplied
 *     S3 upload function. Returns the canonical key
 *     `<shopId>/theme/theme.zip`.
 *
 * The bundle includes:
 *   - layout/theme.liquid          (rendered with token vars)
 *   - templates/{5 files}.liquid   (rendered with token vars)
 *   - sections/{selected variants}.liquid  (only the ones the manifest picked)
 *   - snippets/{header,footer}.liquid (variant-resolver shells)
 *   - assets/theme.css             (token-applier output prepended to base CSS)
 *   - assets/theme.js              (static — no template substitution)
 *
 * Why filter sections to ONLY the selected variants instead of
 * shipping all 20? Theme.zip stays small (storefront downloads
 * faster), and the storefront can't accidentally render an unselected
 * variant. The trade-off is the seller can't preview alternative
 * variants without a Stage 15 re-run; OK for v7 (theme picker is
 * Sprint 5+ work).
 */

import { Liquid } from 'liquidjs'
import JSZip from 'jszip'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import crypto from 'node:crypto'
import { applyTokens } from './token-applier.js'
import { selectComponents, type ComponentManifest } from './component-builder.js'
import type { DesignTokens } from './token-schema.js'
import { safeMessage } from '../../../support/safe-message.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE_BASE_DIR = path.join(__dirname, 'template-base')

/** All 5 page templates Stage 15 emits. */
const PAGE_TEMPLATES = ['index', 'product', 'collection', 'cart', 'page'] as const

/** Layout files to render (excluding the variant-resolver snippets). */
const LAYOUT_FILES = ['theme.liquid'] as const

export interface ThemeBundle {
  /** Stable per-bundle UUID. Stage 16 retry bumps `version`, not `theme_id`. */
  theme_id: string
  /** 1 on first render, 2/3/... on Stage 16 retry. */
  version: number
  /** Map of relative-path → rendered content. */
  files: Record<string, string>
  /** The selected component variants (informational; same as bundle.manifest in tests). */
  manifest: ComponentManifest
  /** Stage 16 feedback applied to this iteration (empty on first render). */
  feedback_applied: string[]
}

export interface RenderOptions {
  tokens: DesignTokens
  /** Override default version=1 (Stage 16 retry sets version=2,3,...). */
  version?: number
  /** Stage 16 may pass score-failure feedback; recorded for diagnostics. */
  previousFeedback?: string[]
}

/**
 * Reads a file from `template-base/` and returns the source. Throws
 * with a generic message via Iron rule 5 if the file is missing
 * (would indicate a deploy-time bug, not seller-actionable).
 */
async function readTemplateFile(relPath: string): Promise<string> {
  const fullPath = path.join(TEMPLATE_BASE_DIR, relPath)
  return fs.readFile(fullPath, 'utf8')
}

/**
 * Build a fresh LiquidJS engine pointed at the on-disk template-base
 * root. Section files use `{% include %}` to reach sibling files;
 * pointing the root here means the renderer can resolve include paths
 * the way the storefront would at runtime.
 */
function makeEngine(): Liquid {
  return new Liquid({
    root: TEMPLATE_BASE_DIR,
    extname: '.liquid',
    // Strict filters off — section files use `{{ var | default: '...' }}`
    // which is fine even when the var is undefined.
    strictFilters: false,
    strictVariables: false,
  })
}

export async function renderTheme(opts: RenderOptions): Promise<ThemeBundle> {
  const { tokens } = opts
  const version = opts.version ?? 1
  const previousFeedback = opts.previousFeedback ?? []

  const manifest = selectComponents(tokens)
  const { css: tokenCss, liquid_vars } = applyTokens(tokens)

  // Override the default footer variant chosen by token-applier with
  // the manifest's selection (component-builder uses style_keywords
  // hint that token-applier can't see).
  const ctx: Record<string, unknown> = {
    ...liquid_vars,
    component_footer_variant: manifest.footer,
    component_hero_variant: manifest.hero,
    component_header_variant: manifest.header,
    component_product_card_variant: manifest.product_card,
    component_nav_variant: manifest.navigation,
  }

  const engine = makeEngine()
  const files: Record<string, string> = {}

  // 1. Layout files.
  for (const layoutFile of LAYOUT_FILES) {
    const src = await readTemplateFile(`layout/${layoutFile}`)
    files[`layout/${layoutFile}`] = await engine.parseAndRender(src, ctx)
  }

  // 2. Page templates.
  for (const tpl of PAGE_TEMPLATES) {
    const src = await readTemplateFile(`templates/${tpl}.liquid`)
    files[`templates/${tpl}.liquid`] = await engine.parseAndRender(src, ctx)
  }

  // 3. Selected section variants only.
  const selectedSections: Array<{ slot: string; variant: string }> = [
    { slot: 'hero', variant: manifest.hero },
    { slot: 'product-card', variant: manifest.product_card },
    { slot: 'header', variant: manifest.header },
    { slot: 'footer', variant: manifest.footer },
    { slot: 'nav', variant: manifest.navigation },
  ]
  for (const { slot, variant } of selectedSections) {
    const rel = `sections/${slot}-${variant}.liquid`
    const src = await readTemplateFile(rel)
    // Section files render with the same context.
    files[rel] = await engine.parseAndRender(src, ctx)
  }

  // 4. Snippets — variant resolvers (header / footer) used by layout.
  for (const snippet of ['header', 'footer']) {
    const src = await readTemplateFile(`snippets/${snippet}.liquid`)
    files[`snippets/${snippet}.liquid`] = await engine.parseAndRender(src, ctx)
  }

  // 5. Assets — theme.css with :root block prepended; theme.js verbatim.
  const baseCssRaw = await readTemplateFile('assets/theme.css.liquid')
  const baseCss = await engine.parseAndRender(baseCssRaw, ctx)
  files['assets/theme.css'] = `${tokenCss}\n${baseCss}`
  files['assets/theme.js'] = await readTemplateFile('assets/theme.js')

  return {
    theme_id: crypto.randomUUID(),
    version,
    files,
    manifest,
    feedback_applied: previousFeedback,
  }
}

// ---------------------------------------------------------------------------
// bundleTheme — JSZip → S3 upload
// ---------------------------------------------------------------------------

export interface S3UploadInput {
  key: string
  body: Buffer
  contentType: string
}

export type S3UploadFn = (input: S3UploadInput) => Promise<unknown>

export interface BundleOpts {
  bundle: ThemeBundle
  shopId: string
  upload: S3UploadFn
}

export async function bundleTheme(opts: BundleOpts): Promise<string> {
  const { bundle, shopId, upload } = opts
  const zip = new JSZip()
  for (const [filePath, content] of Object.entries(bundle.files)) {
    zip.file(filePath, content)
  }
  const body = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
  const key = `${shopId}/theme/theme.zip`
  try {
    await upload({ key, body, contentType: 'application/zip' })
  } catch (err) {
    const { safe, diagnostic } = safeMessage(err)
    // Server-side log keeps the raw diagnostic; thrown error is seller-safe.
    console.warn(`[v7-renderer] theme.zip upload failed for shop ${shopId}: ${diagnostic}`)
    throw new Error(safe)
  }
  return key
}
