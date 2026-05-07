/**
 * Gbox Platform — Shopify Object-Model Types
 *
 * These interfaces describe the shape of every "drop" (Shopify's term for a
 * Liquid context object) that a theme template can read from. They match
 * Shopify's Liquid object reference as closely as the Gbox data model allows,
 * so that a theme ported from Shopify's theme store only has to touch the
 * filters/tags layer — the variable names stay the same.
 *
 * This file is a pure TYPE module: no imports, no runtime code, no side
 * effects. It is safe to import from anywhere — Node origin, Cloudflare
 * Workers, browser build, tests — because it compiles to an empty JS module.
 *
 * Why these live outside `engine.ts`:
 *   Decision #1 Step 1.1 — the old Nunjucks engine and the new LiquidJS
 *   engine both need the same types. Keeping them in `engine.ts` meant the
 *   new engine code couldn't import them without pulling the old Nunjucks
 *   runtime along for the ride. After this extraction `engine.ts` re-exports
 *   everything here for back-compat, so no existing caller breaks.
 *
 * Reference:
 *   https://shopify.dev/docs/api/liquid/objects
 */

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

export interface ShopData {
  id: string
  name: string
  slug: string
  email: string | null
  domain: string | null
  custom_domain: string | null
  currency: string
  logo_url: string | null
}

// ---------------------------------------------------------------------------
// Product / Variant / Image / Option
// ---------------------------------------------------------------------------

export interface ProductData {
  id: string
  title: string
  slug: string
  body_html: string | null
  vendor: string | null
  product_type: string | null
  status: string
  tags: string[] | null
  published_at: string | null
  images: ProductImageData[]
  variants: VariantData[]
  options: ProductOptionData[]
  featured_image: string | null
  price: string
  compare_at_price: string | null
  available: boolean
  url: string
}

export interface VariantData {
  id: string
  title: string | null
  price: string
  compare_at_price: string | null
  sku: string | null
  inventory_quantity: number
  available: boolean
  option1: string | null
  option2: string | null
  option3: string | null
  image_url: string | null
  weight: string | null
  weight_unit: string
}

export interface ProductImageData {
  id: string
  src: string
  alt: string | null
  width: number | null
  height: number | null
  position: number
}

export interface ProductOptionData {
  name: string
  values: string[]
  position: number
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface CollectionData {
  id: string
  title: string
  slug: string
  body_html: string | null
  image_url: string | null
  products_count: number
  url: string
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export interface CartData {
  token: string
  item_count: number
  total_price: string
  items: CartItemData[]
}

export interface CartItemData {
  id: string
  variant_id: string
  product_id: string
  title: string
  variant_title: string | null
  price: string
  quantity: number
  image_url: string | null
  url: string
  line_price: string
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export interface CustomerData {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  name: string
  orders_count: number
  total_spent: string
}

// ---------------------------------------------------------------------------
// Navigation (menus + linklists)
// ---------------------------------------------------------------------------

export interface MenuData {
  title: string
  slug: string
  items: MenuItemData[]
}

export interface MenuItemData {
  title: string
  url: string
  active: boolean
  children: MenuItemData[]
}

// ---------------------------------------------------------------------------
// CMS content
// ---------------------------------------------------------------------------

export interface PageData {
  id: string
  title: string
  slug: string
  body_html: string | null
  author: string | null
}

export interface BlogPostData {
  id: string
  title: string
  slug: string
  body_html: string | null
  excerpt: string | null
  author: string | null
  tags: string[] | null
  image_url: string | null
  published_at: string | null
  url: string
}

// ---------------------------------------------------------------------------
// Theme settings (from config/settings_data.json)
// ---------------------------------------------------------------------------

export interface ThemeSettings {
  [key: string]: any
}

// ---------------------------------------------------------------------------
// Render context — the top-level object every template sees
// ---------------------------------------------------------------------------
//
// The new LiquidJS engine (Decision #1 Step 1.10) will build a richer
// context with Shopify ambient globals (`routes`, `linklists`, `template`
// as an object, etc.). For back-compat with the old Nunjucks engine, the
// shape below is preserved verbatim and the new engine extends it rather
// than replacing it.

export interface RenderContext {
  shop: ShopData
  page_title: string
  page_description?: string
  canonical_url: string
  template: string

  // Page-specific data
  product?: ProductData
  collection?: CollectionData
  collections?: CollectionData[]
  products?: ProductData[]
  cart?: CartData
  customer?: CustomerData | null
  page?: PageData
  blog_post?: BlogPostData
  blog_posts?: BlogPostData[]
  search?: { query: string; results: ProductData[]; total: number }

  // Navigation
  menus: Record<string, MenuData>

  // Theme
  settings: ThemeSettings

  // Pagination
  paginate?: {
    current_page: number
    total_pages: number
    per_page: number
    total: number
    previous_url: string | null
    next_url: string | null
    pages: number[]
  }

  // Request
  current_url: string
  current_path: string
  request: { path: string; params: Record<string, string>; query: Record<string, string> }

  // Additional data (escape hatch for page-specific drops not yet typed)
  [key: string]: any
}
