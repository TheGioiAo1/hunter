/**
 * Clone Pro — Theme Template Generator
 *
 * Generates a complete Liquid theme from extracted design data.
 * Takes CSS/design extraction results + scraped heroes/brand/menus
 * and produces a set of Liquid templates + CSS + JS ready to
 * be persisted as theme assets.
 *
 * Architecture:
 *   1. Load base templates from ./base-templates/
 *   2. Generate style.css from extracted design tokens
 *   3. Generate script.js with basic interactivity
 *   4. Customize layout.liquid with brand data (logo, favicon, fonts)
 *   5. Customize index.liquid with hero data
 *   6. Customize header/footer with menu data
 *   7. Return complete ThemeTemplateSet
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import type { ExtractedCSS } from '../scrapers/css-extractor.js'
import type { ScrapedHero } from '../scrapers/hero-scraper.js'
import type { ScrapedBrand } from '../scrapers/brand-scraper.js'
import type { ScrapedMenus } from '../scrapers/menu-scraper.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThemeTemplateSet {
  readonly layout: string
  readonly index: string
  readonly product: string
  readonly collection: string
  readonly page: string
  readonly blog: string
  readonly cart: string
  readonly header: string
  readonly footer: string
  readonly product_card: string
  readonly 'style.css': string
  readonly 'script.js': string
  readonly [key: string]: string
}

export interface ThemeGeneratorInput {
  readonly design: ExtractedCSS
  readonly heroes: ScrapedHero[]
  readonly brand: ScrapedBrand
  readonly menus: ScrapedMenus
}

// ---------------------------------------------------------------------------
// Base template loader
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = join(__dirname, 'base-templates')

function loadBaseTemplate(name: string): string {
  try {
    return readFileSync(join(TEMPLATES_DIR, name), 'utf-8')
  } catch {
    console.warn(`[theme-gen] Base template "${name}" not found, using empty`)
    return ''
  }
}

// ---------------------------------------------------------------------------
// CSS Generator
// ---------------------------------------------------------------------------

function generateStyleCSS(design: ExtractedCSS, brand: ScrapedBrand): string {
  const { palette, fonts, google_fonts_urls, max_width, grid_columns, spacing_unit, border_radius, button_styles, card_styles } = design

  const googleFontsImports = google_fonts_urls
    .map(url => `@import url('${url}');`)
    .join('\n')

  return `${googleFontsImports}

/* ═══════════════════════════════════════════════════════════════════
   Gbox Cloned Theme — Generated CSS
   ═══════════════════════════════════════════════════════════════════ */

:root {
  /* Colors */
  --color-primary: ${palette.primary};
  --color-secondary: ${palette.secondary};
  --color-background: ${palette.background};
  --color-surface: ${palette.surface};
  --color-text: ${palette.text};
  --color-text-muted: ${palette.text_muted};
  --color-border: ${palette.border};
  --color-success: ${palette.success};
  --color-error: ${palette.error};

  /* Typography */
  --font-heading: ${fonts.heading_family};
  --font-body: ${fonts.body_family};
  --font-heading-weight: ${fonts.heading_weight};
  --font-body-weight: ${fonts.body_weight};
  --font-size-base: ${fonts.base_size};
  --line-height-base: ${fonts.line_height};

  /* Layout */
  --page-width: ${max_width};
  --grid-columns: ${grid_columns};
  --spacing: ${spacing_unit};
  --radius: ${border_radius};
}

/* ── Reset ──────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font-body);
  font-weight: var(--font-body-weight);
  font-size: var(--font-size-base);
  line-height: var(--line-height-base);
  color: var(--color-text);
  background-color: var(--color-background);
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-heading);
  font-weight: var(--font-heading-weight);
  line-height: 1.2;
}

a { color: var(--color-primary); text-decoration: none; }
a:hover { text-decoration: underline; }

img { max-width: 100%; height: auto; display: block; }

/* ── Container ──────────────────────────────────────────────────── */
.container {
  max-width: var(--page-width);
  margin: 0 auto;
  padding: 0 calc(var(--spacing) * 1.5);
}

/* ── Buttons ────────────────────────────────────────────────────── */
.btn, button, [type="submit"] {
  display: inline-block;
  background-color: ${button_styles.primary.background};
  color: ${button_styles.primary.color};
  border: ${button_styles.primary.border};
  border-radius: ${button_styles.primary.borderRadius};
  padding: ${button_styles.primary.padding};
  font-size: ${button_styles.primary.fontSize};
  font-weight: ${button_styles.primary.fontWeight};
  text-transform: ${button_styles.primary.textTransform};
  cursor: pointer;
  transition: opacity 0.2s;
  text-align: center;
  line-height: 1.4;
}
.btn:hover, button:hover, [type="submit"]:hover {
  opacity: 0.85;
  text-decoration: none;
}
.btn-secondary {
  background: transparent;
  color: ${button_styles.secondary.background};
  border: 1px solid ${button_styles.secondary.background};
}

/* ── Header ─────────────────────────────────────────────────────── */
.site-header {
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  padding: calc(var(--spacing) * 0.75) 0;
  position: sticky;
  top: 0;
  z-index: 100;
}
.header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing);
}
.logo { display: flex; align-items: center; }
.logo-img { max-height: 40px; width: auto; }
.logo-text { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: 1.5rem; color: var(--color-text); }
.nav-list { display: flex; list-style: none; gap: calc(var(--spacing) * 1.5); }
.nav-link { color: var(--color-text); font-weight: 500; font-size: 0.9rem; padding: 0.5rem 0; }
.nav-link:hover, .nav-link.active { color: var(--color-primary); text-decoration: none; }
.nav-item { position: relative; }
.dropdown { display: none; position: absolute; top: 100%; left: 0; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); min-width: 200px; list-style: none; padding: 0.5rem 0; box-shadow: 0 4px 12px rgba(0,0,0,0.1); z-index: 101; }
.nav-item:hover .dropdown { display: block; }
.dropdown li a { display: block; padding: 0.5rem 1rem; color: var(--color-text); font-size: 0.85rem; }
.dropdown li a:hover { background: var(--color-background); text-decoration: none; }
.header-actions { display: flex; align-items: center; gap: var(--spacing); }
.header-icon { color: var(--color-text); position: relative; }
.cart-count { position: absolute; top: -6px; right: -8px; background: var(--color-primary); color: #fff; font-size: 0.65rem; width: 16px; height: 16px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }

/* ── Hero ────────────────────────────────────────────────────────── */
.hero-section { position: relative; overflow: hidden; }
.hero-slide { position: relative; }
.hero-image { width: 100%; height: 60vh; min-height: 400px; object-fit: cover; }
.hero-overlay { position: absolute; inset: 0; display: flex; align-items: center; background: rgba(0,0,0,0.3); }
.hero-heading { font-size: 3rem; color: #fff; margin-bottom: 0.5rem; }
.hero-subheading { font-size: 1.25rem; color: rgba(255,255,255,0.9); margin-bottom: 1.5rem; }
.hero-cta { background: #fff; color: #000; }

/* ── Section Titles ─────────────────────────────────────────────── */
.section-title { font-size: 1.75rem; text-align: center; margin: calc(var(--spacing) * 3) 0 calc(var(--spacing) * 2); }

/* ── Product Grid ───────────────────────────────────────────────── */
.product-grid {
  display: grid;
  grid-template-columns: repeat(var(--grid-columns), 1fr);
  gap: var(--spacing);
}
@media (max-width: 768px) { .product-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 480px) { .product-grid { grid-template-columns: 1fr; } }

/* ── Product Card ───────────────────────────────────────────────── */
.product-card {
  background: ${card_styles.background};
  border: ${card_styles.border};
  border-radius: ${card_styles.borderRadius};
  box-shadow: ${card_styles.boxShadow};
  overflow: hidden;
  transition: box-shadow 0.2s;
}
.product-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.1); }
.product-card-link { display: block; color: inherit; text-decoration: none; }
.product-card-image { aspect-ratio: 1; overflow: hidden; background: var(--color-background); }
.product-card-image img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s; }
.product-card:hover .product-card-image img { transform: scale(1.05); }
.product-card-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--color-text-muted); }
.product-card-info { padding: ${card_styles.padding}; }
.product-card-vendor { font-size: 0.75rem; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }
.product-card-title { font-size: 0.95rem; font-weight: 500; margin-bottom: 0.5rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.product-card-price { font-size: 0.9rem; }
.price-sale { color: var(--color-error); font-weight: 600; }
.price-compare { color: var(--color-text-muted); text-decoration: line-through; font-size: 0.85rem; margin-left: 0.5rem; }
.price-regular { font-weight: 600; }
.product-badge { position: absolute; top: 0.5rem; left: 0.5rem; padding: 0.25rem 0.5rem; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; border-radius: var(--radius); }
.product-badge.sale { background: var(--color-error); color: #fff; }
.product-badge.sold-out { background: var(--color-text-muted); color: #fff; }

/* ── Product Page ───────────────────────────────────────────────── */
.product-page { padding: calc(var(--spacing) * 3) 0; }
.product-layout { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--spacing) * 3); }
@media (max-width: 768px) { .product-layout { grid-template-columns: 1fr; } }
.product-main-image { width: 100%; border-radius: var(--radius); }
.gallery-thumbs { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
.gallery-thumbs .thumb { width: 64px; height: 64px; border: 2px solid transparent; border-radius: var(--radius); overflow: hidden; cursor: pointer; padding: 0; background: none; }
.gallery-thumbs .thumb.active { border-color: var(--color-primary); }
.gallery-thumbs .thumb img { width: 100%; height: 100%; object-fit: cover; }
.product-title { font-size: 2rem; margin-bottom: 0.75rem; }
.product-vendor { font-size: 0.85rem; color: var(--color-text-muted); text-transform: uppercase; margin-bottom: 0.5rem; }
.product-price { font-size: 1.25rem; margin-bottom: 1.5rem; }
.product-option { margin-bottom: 1rem; }
.product-option label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.25rem; }
.product-option select { width: 100%; padding: 0.5rem; border: 1px solid var(--color-border); border-radius: var(--radius); font-size: 0.9rem; }
.product-quantity { margin-bottom: 1rem; }
.product-quantity label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.25rem; }
.product-quantity input { width: 80px; padding: 0.5rem; border: 1px solid var(--color-border); border-radius: var(--radius); text-align: center; }
.add-to-cart { width: 100%; padding: 1rem; font-size: 1rem; }
.product-description { margin-top: 2rem; }
.rte h2, .rte h3 { margin: 1.5rem 0 0.75rem; }
.rte p { margin-bottom: 1rem; }
.rte ul, .rte ol { margin-bottom: 1rem; padding-left: 1.5rem; }

/* ── Collection Page ────────────────────────────────────────────── */
.collection-page { padding: calc(var(--spacing) * 2) 0 calc(var(--spacing) * 4); }
.collection-header { text-align: center; margin-bottom: calc(var(--spacing) * 2); }
.collection-hero-image { width: 100%; max-height: 300px; object-fit: cover; border-radius: var(--radius); margin-bottom: var(--spacing); }
.collection-title { font-size: 2rem; margin-bottom: 0.5rem; }
.collection-controls { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--spacing); }
.collection-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--spacing); }
@media (max-width: 768px) { .collection-grid { grid-template-columns: repeat(2, 1fr); } }
.collection-card { display: block; border-radius: var(--radius); overflow: hidden; position: relative; text-decoration: none; color: var(--color-text); }
.collection-image { width: 100%; aspect-ratio: 4/3; object-fit: cover; }
.collection-name { padding: 0.75rem; font-size: 1rem; text-align: center; }

/* ── Page Content ───────────────────────────────────────────────── */
.page-content { padding: calc(var(--spacing) * 3) 0; }
.page-article { max-width: 800px; margin: 0 auto; }
.page-title { font-size: 2rem; margin-bottom: 1.5rem; }

/* ── Blog ───────────────────────────────────────────────────────── */
.blog-page { padding: calc(var(--spacing) * 2) 0 calc(var(--spacing) * 4); }
.blog-title { font-size: 2rem; text-align: center; margin-bottom: calc(var(--spacing) * 2); }
.blog-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(var(--spacing) * 1.5); }
@media (max-width: 768px) { .blog-grid { grid-template-columns: 1fr; } }
.blog-card { background: var(--color-surface); border-radius: var(--radius); overflow: hidden; border: 1px solid var(--color-border); }
.blog-card-image img { width: 100%; aspect-ratio: 16/9; object-fit: cover; }
.blog-card-content { padding: 1.25rem; }
.blog-date { font-size: 0.75rem; color: var(--color-text-muted); }
.blog-card-title { font-size: 1.1rem; margin: 0.5rem 0; }
.blog-card-title a { color: var(--color-text); }
.blog-excerpt { font-size: 0.85rem; color: var(--color-text-muted); margin-bottom: 0.75rem; }
.read-more { font-size: 0.85rem; font-weight: 600; }

/* ── Cart ────────────────────────────────────────────────────────── */
.cart-page { padding: calc(var(--spacing) * 3) 0; }
.cart-title { font-size: 2rem; margin-bottom: 1.5rem; }
.cart-table { width: 100%; border-collapse: collapse; }
.cart-table th { text-align: left; padding: 0.75rem; border-bottom: 2px solid var(--color-border); font-size: 0.85rem; color: var(--color-text-muted); text-transform: uppercase; }
.cart-item td { padding: 1rem 0.75rem; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
.cart-product-inner { display: flex; align-items: center; gap: 1rem; }
.cart-item-image { width: 64px; height: 64px; object-fit: cover; border-radius: var(--radius); }
.cart-item-title { color: var(--color-text); font-weight: 500; }
.cart-item-variant { font-size: 0.8rem; color: var(--color-text-muted); }
.cart-quantity input { width: 60px; padding: 0.4rem; text-align: center; border: 1px solid var(--color-border); border-radius: var(--radius); }
.remove-item { color: var(--color-text-muted); font-size: 1.25rem; }
.cart-footer { display: flex; justify-content: space-between; margin-top: 2rem; gap: 2rem; }
@media (max-width: 768px) { .cart-footer { flex-direction: column; } }
.cart-note textarea { width: 100%; padding: 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius); font-family: inherit; }
.cart-summary { text-align: right; }
.cart-subtotal { display: flex; justify-content: space-between; gap: 2rem; font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
.cart-shipping-note { font-size: 0.8rem; color: var(--color-text-muted); margin-bottom: 1rem; }
.cart-empty { text-align: center; padding: calc(var(--spacing) * 4) 0; }
.cart-empty p { font-size: 1.1rem; margin-bottom: 1.5rem; color: var(--color-text-muted); }

/* ── Footer ─────────────────────────────────────────────────────── */
.site-footer { background: var(--color-surface); border-top: 1px solid var(--color-border); padding: calc(var(--spacing) * 3) 0 calc(var(--spacing) * 1.5); margin-top: calc(var(--spacing) * 4); }
.footer-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(var(--spacing) * 2); margin-bottom: calc(var(--spacing) * 2); }
@media (max-width: 768px) { .footer-grid { grid-template-columns: 1fr; } }
.footer-logo { max-height: 32px; margin-bottom: 0.75rem; }
.footer-title { font-size: 1.25rem; margin-bottom: 0.5rem; }
.footer-description { font-size: 0.85rem; color: var(--color-text-muted); }
.footer-heading { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; }
.footer-links { list-style: none; }
.footer-links li { margin-bottom: 0.5rem; }
.footer-links a { color: var(--color-text-muted); font-size: 0.85rem; }
.footer-links a:hover { color: var(--color-primary); }
.footer-bottom { border-top: 1px solid var(--color-border); padding-top: calc(var(--spacing) * 1.5); display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--color-text-muted); }
@media (max-width: 768px) { .footer-bottom { flex-direction: column; gap: 0.5rem; text-align: center; } }

/* ── Pagination ─────────────────────────────────────────────────── */
.pagination { display: flex; justify-content: center; gap: 0.5rem; margin-top: calc(var(--spacing) * 3); }
.pagination a, .pagination span { display: inline-flex; align-items: center; justify-content: center; min-width: 36px; height: 36px; border: 1px solid var(--color-border); border-radius: var(--radius); font-size: 0.85rem; color: var(--color-text); }
.pagination .current { background: var(--color-primary); color: #fff; border-color: var(--color-primary); }
`
}

// ---------------------------------------------------------------------------
// JS Generator
// ---------------------------------------------------------------------------

function generateScriptJS(): string {
  return `/* Gbox Cloned Theme — Generated JavaScript */

/* Product gallery thumbnail switching */
document.querySelectorAll('.gallery-thumbs .thumb').forEach(function(thumb) {
  thumb.addEventListener('click', function() {
    var mainImg = document.getElementById('product-main-image');
    if (mainImg) {
      mainImg.src = this.dataset.image;
      document.querySelectorAll('.gallery-thumbs .thumb').forEach(function(t) { t.classList.remove('active'); });
      this.classList.add('active');
    }
  });
});

/* Sort by selector */
var sortSelect = document.getElementById('sort');
if (sortSelect) {
  sortSelect.addEventListener('change', function() {
    var url = new URL(window.location.href);
    url.searchParams.set('sort_by', this.value);
    window.location.href = url.toString();
  });
}

/* Mobile menu toggle (if needed) */
var menuToggle = document.querySelector('.menu-toggle');
var mainNav = document.querySelector('.main-nav');
if (menuToggle && mainNav) {
  menuToggle.addEventListener('click', function() {
    mainNav.classList.toggle('open');
    this.classList.toggle('active');
  });
}
`
}

// ---------------------------------------------------------------------------
// Template customization
// ---------------------------------------------------------------------------

function customizeLayout(
  template: string,
  brand: ScrapedBrand,
  design: ExtractedCSS,
): string {
  // Inject Google Fonts link
  const googleFontsLink = design.google_fonts_urls.length > 0
    ? design.google_fonts_urls.map(url => `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="${url}" rel="stylesheet">`).join('\n  ')
    : ''

  let result = template.replace('{{ google_fonts_link }}', googleFontsLink)

  // Inject favicon
  if (brand.favicon_url) {
    result = result.replace(
      '{% if favicon_url %}',
      '',
    ).replace(
      '{% endif %}',
      '',
    ).replace(
      '{{ favicon_url }}',
      brand.favicon_url,
    )
  }

  return result
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a complete Liquid theme from extracted design data.
 *
 * @param input - Design data, heroes, brand, and menus from scraping
 * @returns ThemeTemplateSet with all templates, CSS, and JS
 */
export function generateThemeFromDesign(input: ThemeGeneratorInput): ThemeTemplateSet {
  const { design, heroes, brand, menus } = input

  // Load base templates
  const layoutBase = loadBaseTemplate('layout.liquid')
  const headerBase = loadBaseTemplate('header.liquid')
  const footerBase = loadBaseTemplate('footer.liquid')
  const indexBase = loadBaseTemplate('index.liquid')
  const productBase = loadBaseTemplate('product.liquid')
  const collectionBase = loadBaseTemplate('collection.liquid')
  const pageBase = loadBaseTemplate('page.liquid')
  const blogBase = loadBaseTemplate('blog.liquid')
  const cartBase = loadBaseTemplate('cart.liquid')
  const productCardBase = loadBaseTemplate('product-card.liquid')

  // Customize layout with brand data
  const layout = customizeLayout(layoutBase, brand, design)

  // Generate CSS and JS
  const styleCss = generateStyleCSS(design, brand)
  const scriptJs = generateScriptJS()

  return {
    layout,
    index: indexBase,
    product: productBase,
    collection: collectionBase,
    page: pageBase,
    blog: blogBase,
    cart: cartBase,
    header: headerBase,
    footer: footerBase,
    product_card: productCardBase,
    'style.css': styleCss,
    'script.js': scriptJs,
  }
}
