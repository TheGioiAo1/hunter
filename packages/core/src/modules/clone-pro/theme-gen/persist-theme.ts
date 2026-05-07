/**
 * Clone Pro — Theme Persistence
 *
 * Saves a generated ThemeTemplateSet to the database as a Gbox theme.
 * Creates the theme record + all theme assets (templates, CSS, JS, fonts, images).
 * Theme is created as 'unpublished' — merchant must manually activate.
 *
 * Supports:
 * - Dynamic template keys (arbitrary sections, snippets)
 * - Binary assets (fonts, images from CSS clone)
 * - Text-based assets (Liquid templates, CSS, JS)
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { createTheme, updateThemeAsset } from '../../themes/service.js'
import { sanitizeClonedCss } from '../sanitize.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A complete theme consisting of text templates and binary assets.
 * Keys are Shopify-style asset paths like:
 *   layout/theme.liquid
 *   templates/index.liquid
 *   sections/header.liquid
 *   assets/style.css
 *   assets/fonts/abc123.woff2
 */
export interface DynamicThemeAssets {
  /** Text-based assets (Liquid, CSS, JS) — key → content string */
  readonly templates: Record<string, string>
  /** Binary assets (fonts, images) — key → Buffer */
  readonly binaries: Record<string, Buffer>
}

// Legacy type for backward compat
export interface ThemeTemplateSet {
  layout: string
  index: string
  product: string
  collection: string
  page: string
  blog: string
  cart: string
  header: string
  footer: string
  product_card: string
  'style.css': string
  'script.js': string
  [key: string]: string // Allow dynamic keys
}

// ---------------------------------------------------------------------------
// Legacy Asset key mapping (for backward compat with ThemeTemplateSet)
// ---------------------------------------------------------------------------

const LEGACY_KEY_MAP: Record<string, string> = {
  layout: 'layout/theme.liquid',
  index: 'templates/index.liquid',
  product: 'templates/product.liquid',
  collection: 'templates/collection.liquid',
  page: 'templates/page.liquid',
  blog: 'templates/blog.liquid',
  cart: 'templates/cart.liquid',
  header: 'sections/header.liquid',
  footer: 'sections/footer.liquid',
  product_card: 'snippets/product-card.liquid',
  'style.css': 'assets/style.css',
  'script.js': 'assets/script.js',
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  '.liquid': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

function getContentType(key: string): string {
  for (const [ext, type] of Object.entries(CONTENT_TYPE_MAP)) {
    if (key.endsWith(ext)) return type
  }
  return 'text/plain'
}

// ---------------------------------------------------------------------------
// Public API — Dynamic Assets (new)
// ---------------------------------------------------------------------------

/**
 * Persist a dynamic theme with arbitrary templates and binary assets.
 * This is the preferred method for 1:1 cloning.
 *
 * @param db - Kysely database instance
 * @param shopId - Target shop UUID
 * @param assets - DynamicThemeAssets with templates and binaries
 * @param themeName - Display name for the theme
 * @returns The created theme's ID
 */
export async function persistDynamicTheme(
  db: Kysely<Database>,
  shopId: string,
  assets: DynamicThemeAssets,
  themeName: string,
): Promise<string> {
  // 1. Demote any existing main theme, then create as main
  await db
    .updateTable('themes')
    .set({ role: 'unpublished' } as any)
    .where('shop_id', '=', shopId)
    .where('role', '=', 'main')
    .execute()
    .catch(() => {}) // OK if no existing main theme

  const theme = await createTheme(db, shopId, {
    name: themeName,
    role: 'main',
  })

  // 2. Persist all text-based templates
  for (const [key, value] of Object.entries(assets.templates)) {
    if (!value) continue
    try {
      // Phase 7.4 — CSS assets go through sanitizeClonedCss before
      // landing in the theme. This drops @import rules pointing at
      // non-allowlisted hosts and strips legacy IE expression(...).
      // Liquid templates are our own generated code — no need to
      // sanitize — and JS assets aren't written here for cloned
      // content (Shopify theme JS is handcrafted).
      const content = key.endsWith('.css') ? sanitizeClonedCss(value) : value
      await updateThemeAsset(
        db,
        theme.id,
        key,
        content,
        getContentType(key),
      )
    } catch (err) {
      console.warn(`[persist-theme] Failed to save "${key}":`, (err as Error).message)
    }
  }

  // 3. Persist binary assets (fonts, images) as base64-encoded strings
  for (const [key, buffer] of Object.entries(assets.binaries)) {
    if (!buffer || buffer.length === 0) continue
    try {
      // Store binary as base64 in the value column
      // The storefront asset handler will decode it
      const base64Value = buffer.toString('base64')
      await updateThemeAsset(
        db,
        theme.id,
        key,
        base64Value,
        getContentType(key),
      )
    } catch (err) {
      console.warn(`[persist-theme] Failed to save binary "${key}":`, (err as Error).message)
    }
  }

  return theme.id
}

// ---------------------------------------------------------------------------
// Public API — Legacy (backward compat)
// ---------------------------------------------------------------------------

/**
 * Persist a legacy ThemeTemplateSet (fixed 12 keys).
 * @deprecated Use persistDynamicTheme() for new code.
 */
export async function persistCloneTheme(
  db: Kysely<Database>,
  shopId: string,
  templates: ThemeTemplateSet,
  themeName: string,
): Promise<string> {
  // Convert legacy format to dynamic format
  const dynamicTemplates: Record<string, string> = {}

  for (const [key, value] of Object.entries(templates)) {
    if (!value) continue
    const assetKey = LEGACY_KEY_MAP[key] || key
    dynamicTemplates[assetKey] = value
  }

  return persistDynamicTheme(db, shopId, {
    templates: dynamicTemplates,
    binaries: {},
  }, themeName)
}
