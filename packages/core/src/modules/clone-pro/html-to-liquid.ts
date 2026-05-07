/**
 * Clone Pro v4 — HTML → Liquid Templatizer
 *
 * Converts a scraped page's raw HTML into a Liquid template that preserves
 * the original CSS classes, structure, and layout while swapping hardcoded
 * content for dynamic Liquid expressions.
 *
 * This is the core primitive for v4's "pixel-perfect" cloning strategy:
 * instead of generating templates from design tokens, we take the actual
 * HTML of a representative page per pageType, keep every class/id/attr
 * intact, and inject `{{ product.title }}`-style bindings where the source
 * had hardcoded data. The downloaded CSS then applies to the template
 * verbatim, yielding genuine 1:1 visual fidelity.
 *
 * Scope (per-type):
 *   product     → product.title / price / description / images / variants / add-to-cart form
 *   collection  → collection.title / description, products loop {% for product in collection.products %}
 *   page/policy → page.title, page.content (or RTE area)
 *   blog        → {% for article in blog.articles %}, article.title / excerpt / date
 *   blog-post   → article.title / content / published_at / author
 *   cart        → {% for item in cart.items %} loop, cart.total_price, checkout button
 *   search      → {% for item in search.results %}, search.performed, search.terms
 *   home        → no substitution (home is handled by homepage-cloner's section splitting)
 *   others      → pass-through with tracking-script cleanup
 *
 * Design rules:
 *   - NEVER mutate structure. We replace CONTENT of matched elements, not the
 *     elements themselves. `<h1 class="product-title">Old title</h1>` becomes
 *     `<h1 class="product-title">{{ product.title }}</h1>` — same h1, same class.
 *   - If a selector finds nothing, emit a warning and move on. Partial
 *     templatization is vastly better than throwing — downstream verification
 *     catches fidelity issues.
 *   - Return `changes[]` for diagnostics: the caller can render "replaced
 *     5 of 6 expected fields" reports in the admin UI.
 *   - Strip tracking scripts (gtm, fbq, klaviyo, etc.) but KEEP theme JS
 *     (swiper, slider, accordion). Reuses the same rules as `homepage-cloner`.
 *
 * Integration:
 *   htmlToLiquid(candidate.html, 'product')
 *     → { template: '<div class="product-page">{{ product.title }} ...', changes: [...] }
 *
 *   Then the caller writes `template` to `templates/product.liquid`.
 */

import * as cheerio from 'cheerio'
import type { PageType } from './discovery/deep-crawler.js'

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** A single substitution applied during templatization. */
export interface TemplateChange {
  /** Logical field name, e.g. 'product.title', 'collection.products_loop'. */
  readonly field: string
  /** CSS selector that matched the source element. */
  readonly selector: string
  /** The Liquid snippet injected. */
  readonly liquid: string
}

/** Result of converting an HTML page to a Liquid template. */
export interface TemplatizeResult {
  /** Body-only Liquid template string — layout.liquid wraps this via {{ content_for_layout }}. */
  readonly template: string
  /** Page type the templatizer was invoked with. */
  readonly pageType: PageType
  /** Substitutions applied — useful for "coverage" reports. */
  readonly changes: readonly TemplateChange[]
  /** Warnings for selectors that did not match (partial templatization). */
  readonly warnings: readonly string[]
}

export interface TemplatizeOptions {
  /**
   * Source site URL — used to rewrite absolute links back to relative
   * paths. Optional; when omitted, link rewriting is skipped.
   */
  readonly sourceUrl?: string
  /**
   * When true, the template still includes the site's `<header>` / `<footer>`
   * landmarks as-is (no extraction). Default false — v4 pipeline extracts
   * those into dedicated section snippets via `shared-components`.
   */
  readonly keepHeaderFooter?: boolean
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a scraped HTML page to a Liquid template.
 *
 * @param html     Raw HTML string (full document or body fragment).
 * @param pageType Detected page type (routes the per-type templatizer).
 * @param options  Optional tweaks — see `TemplatizeOptions`.
 * @returns        Liquid template + diagnostics.
 */
export function htmlToLiquid(
  html: string,
  pageType: PageType,
  options?: TemplatizeOptions,
): TemplatizeResult {
  const $ = cheerio.load(html, { decodeEntities: false })

  // Strip tracking scripts across the document — the theme JS gets re-injected
  // via layout.liquid, so we don't need any inline <script> in the page template.
  stripScripts($)

  // Pull the body-only fragment — if there's no <body>, use the whole doc.
  // We ALSO strip headers/footers/navs unless the caller asked to keep them;
  // the v4 pipeline materializes those as separate section snippets.
  const root = $('body').length > 0 ? $('body') : $.root()
  if (!options?.keepHeaderFooter) {
    root.find('header, footer, nav[role="navigation"], [id^="shopify-section-header"], [id^="shopify-section-footer"]').remove()
  }

  const changes: TemplateChange[] = []
  const warnings: string[] = []

  switch (pageType) {
    case 'product':
      templatizeProduct($, root, changes, warnings)
      break
    case 'collection':
      templatizeCollection($, root, changes, warnings)
      break
    case 'list-collections':
      templatizeListCollections($, root, changes, warnings)
      break
    case 'page':
    case 'policy':
      templatizePage($, root, changes, warnings)
      break
    case 'blog':
      templatizeBlog($, root, changes, warnings)
      break
    case 'blog-post':
      templatizeBlogPost($, root, changes, warnings)
      break
    case 'cart':
      templatizeCart($, root, changes, warnings)
      break
    case 'search':
      templatizeSearch($, root, changes, warnings)
      break
    case 'home':
      // Home pages are templatized by the homepage section extractor —
      // the Liquid template here is essentially the cleaned body.
      warnings.push('home page type: no Liquid bindings applied (use homepage-cloner for section split)')
      break
    default:
      // account / login / register / password / 404 / other:
      // pass through, stripped. The theme ships sane defaults for auth pages.
      warnings.push(`pageType '${pageType}' has no per-type templatizer; passing through as static HTML`)
      break
  }

  // Extract just the inner HTML of <body> (or the whole doc root) — callers
  // put this inside a layout.liquid that already provides <html>/<head>/<body>.
  let template: string
  if ($('body').length > 0) {
    template = $('body').html() ?? ''
  } else {
    template = root.html() ?? ''
  }

  // Cheerio's serializer encodes `>` inside text nodes to `&gt;` — fine for
  // genuine HTML but it mangles Liquid expressions like `{% if x > 1 %}`.
  // Undo the encoding inside Liquid tags only; leave raw HTML entities alone.
  template = unescapeLiquidEntities(template)

  // Rewrite absolute source URLs → root-relative paths so links don't
  // accidentally send the user back to the source site when they browse
  // the cloned storefront.
  if (options?.sourceUrl) {
    template = rewriteAbsoluteLinksToRelative(template, options.sourceUrl)
  }

  return {
    template: template.trim(),
    pageType,
    changes,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Per-page-type templatizers
// ---------------------------------------------------------------------------

/**
 * Product page templatizer.
 *
 * Substitutions:
 *   title        → {{ product.title }}
 *   price        → {{ product.price | money }}
 *   description  → {{ product.description }}
 *   images       → {% for image in product.images %}<img src="{{ image | img_url: 'large' }}" alt="{{ product.title }}">{% endfor %}
 *   featured img → {{ product.featured_image | img_url: 'large' }}
 *   variants     → {% for variant in product.variants %}<option>{{ variant.title }} — {{ variant.price | money }}</option>{% endfor %}
 *   add-to-cart  → <input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">
 */
function templatizeProduct(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<any>,
  changes: TemplateChange[],
  warnings: string[],
): void {
  // --- Title ---
  const titleSelectors = [
    '[class*="product-title"]',
    '[class*="product__title"]',
    '[class*="productTitle"]',
    'h1[class*="product"]',
    'h1',
  ]
  const titleEl = findFirst($, root, titleSelectors)
  if (titleEl) {
    titleEl.text('{{ product.title }}')
    changes.push({ field: 'product.title', selector: selectorLabel(titleEl), liquid: '{{ product.title }}' })
  } else {
    warnings.push('product: no title element found')
  }

  // --- Price ---
  const priceSelectors = [
    '[class*="product-price"] [class*="money"]',
    '[class*="product__price"] [class*="money"]',
    '[class*="product-price"]',
    '[class*="product__price"]',
    '[data-product-price]',
    '.price',
    '[class*="Price"]',
  ]
  const priceEl = findFirst($, root, priceSelectors)
  if (priceEl) {
    priceEl.html('{{ product.price | money }}')
    changes.push({ field: 'product.price', selector: selectorLabel(priceEl), liquid: '{{ product.price | money }}' })
  } else {
    warnings.push('product: no price element found')
  }

  // --- Description ---
  const descSelectors = [
    '[class*="product-description"]',
    '[class*="product__description"]',
    '[class*="ProductDescription"]',
    '[data-product-description]',
    '[class*="rte"]',
  ]
  const descEl = findFirst($, root, descSelectors)
  if (descEl) {
    descEl.html('{{ product.description }}')
    changes.push({ field: 'product.description', selector: selectorLabel(descEl), liquid: '{{ product.description }}' })
  } else {
    warnings.push('product: no description element found')
  }

  // --- Featured image (first product image) + gallery loop ---
  const gallerySelectors = [
    '[class*="product-gallery"]',
    '[class*="product__media"]',
    '[class*="ProductGallery"]',
    '[data-product-media-group]',
    '[class*="product-images"]',
  ]
  const galleryEl = findFirst($, root, gallerySelectors)
  if (galleryEl) {
    // Replace inner with a Liquid loop; preserve the wrapper class.
    galleryEl.html(
      `{% for image in product.images %}
        <img src="{{ image | img_url: 'large' }}"
             srcset="{{ image | img_url: '400x' }} 400w, {{ image | img_url: '800x' }} 800w, {{ image | img_url: '1200x' }} 1200w"
             alt="{% if image.alt %}{{ image.alt | escape }}{% else %}{{ product.title | escape }}{% endif %}"
             loading="lazy">
      {% endfor %}`,
    )
    changes.push({ field: 'product.images', selector: selectorLabel(galleryEl), liquid: '{% for image in product.images %}...{% endfor %}' })
  } else {
    // No gallery — at least rewrite the single product image's src if we can find one.
    const imgEl = root.find('img[class*="product"], img[data-product-image]').first()
    if (imgEl.length > 0) {
      imgEl.attr('src', "{{ product.featured_image | img_url: 'large' }}")
      imgEl.attr('alt', '{{ product.title | escape }}')
      imgEl.removeAttr('srcset')
      imgEl.removeAttr('data-src')
      imgEl.removeAttr('data-srcset')
      changes.push({ field: 'product.featured_image', selector: 'img[class*="product"]', liquid: "{{ product.featured_image | img_url: 'large' }}" })
    } else {
      warnings.push('product: no image gallery or product image found')
    }
  }

  // --- Variant selector (single <select>) ---
  const variantSelect = root.find('select[name*="id"], select[class*="variant"], [class*="product-form__input"] select').first()
  if (variantSelect.length > 0) {
    variantSelect.html(`
      {% for variant in product.variants %}
        <option value="{{ variant.id }}"
                {% if variant == product.selected_or_first_available_variant %}selected="selected"{% endif %}
                {% unless variant.available %}disabled{% endunless %}>
          {{ variant.title }} - {{ variant.price | money }}
        </option>
      {% endfor %}
    `)
    // Ensure the select is correctly wired to the cart form by name="id"
    variantSelect.attr('name', 'id')
    changes.push({ field: 'product.variants', selector: 'select[name="id"]', liquid: '{% for variant in product.variants %}...{% endfor %}' })
  }

  // --- Add-to-cart form ---
  const formEl = root.find('form[action*="/cart/add"], form[class*="add-to-cart"], form[class*="product-form"]').first()
  if (formEl.length > 0) {
    formEl.attr('action', '/cart/add')
    formEl.attr('method', 'post')
    formEl.attr('accept-charset', 'UTF-8')
    formEl.attr('enctype', 'multipart/form-data')
    // If there's no <select name="id"> inside, inject a hidden input so the
    // cart endpoint receives a variant ID.
    if (formEl.find('select[name="id"], input[name="id"]').length === 0) {
      formEl.prepend(
        '<input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">',
      )
    }
    changes.push({ field: 'product.cart_form', selector: 'form[action="/cart/add"]', liquid: '<input type="hidden" name="id" value="{{ ... }}">' })
  } else {
    warnings.push('product: no add-to-cart form found')
  }
}

/**
 * Collection page templatizer.
 *
 * Substitutions:
 *   title / description → {{ collection.title / description }}
 *   product grid        → wraps the FIRST product card in {% for product in collection.products %}...{% endfor %}
 *                         and swaps its inner content for product.title / price / featured_image.
 */
function templatizeCollection(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<any>,
  changes: TemplateChange[],
  warnings: string[],
): void {
  // --- Collection title + description ---
  const titleSelectors = [
    '[class*="collection-title"]',
    '[class*="collection__title"]',
    '[class*="collection-hero__title"]',
    'h1',
  ]
  const titleEl = findFirst($, root, titleSelectors)
  if (titleEl) {
    titleEl.text('{{ collection.title }}')
    changes.push({ field: 'collection.title', selector: selectorLabel(titleEl), liquid: '{{ collection.title }}' })
  } else {
    warnings.push('collection: no title element found')
  }

  const descSelectors = [
    '[class*="collection-description"]',
    '[class*="collection__description"]',
    '[class*="collection-hero__description"]',
  ]
  const descEl = findFirst($, root, descSelectors)
  if (descEl) {
    descEl.html('{{ collection.description }}')
    changes.push({ field: 'collection.description', selector: selectorLabel(descEl), liquid: '{{ collection.description }}' })
  }

  // --- Product grid ---
  // Strategy: find the first product card, clone its wrapper, wrap with for-loop,
  // replace its inner content with product.* liquid, then remove the remaining
  // siblings so the template doesn't duplicate itself.
  const cardSelectors = [
    '[class*="product-card"]',
    '[class*="product__card"]',
    '[class*="ProductCard"]',
    '[class*="product-item"]',
    'a[href*="/products/"]',
  ]
  const firstCard = findFirst($, root, cardSelectors)
  if (firstCard && firstCard.length > 0) {
    // Collect all siblings that look like the same card shape so we can
    // remove them after the loop replacement.
    const siblings = firstCard.parent().children().filter((_i, el) => {
      return $(el).is(firstCard) || matchesAny($, $(el), cardSelectors)
    })

    // Build a minimal product-card template that preserves the original
    // classes of the first card.
    const cardClass = firstCard.attr('class') ?? 'product-card'
    const cardTag = (firstCard as any)[0]?.tagName ?? 'div'

    // Replace first card inner with a minimal liquid representation that
    // preserves the outer shell's class/attrs.
    firstCard.html(`
      <a href="{{ product.url | within: collection }}" class="product-card__link">
        {% if product.featured_image %}
          <img src="{{ product.featured_image | img_url: 'medium' }}"
               srcset="{{ product.featured_image | img_url: '300x' }} 300w, {{ product.featured_image | img_url: '600x' }} 600w"
               alt="{{ product.featured_image.alt | default: product.title | escape }}"
               loading="lazy">
        {% endif %}
        <h3 class="product-card__title">{{ product.title }}</h3>
        <div class="product-card__price">{{ product.price | money }}</div>
      </a>
    `)

    // Wrap with for-loop. We use a plain HTML comment (safe in Liquid) to
    // anchor the opening/closing tags.
    const cardHtml = $.html(firstCard)
    firstCard.replaceWith(
      `{% for product in collection.products %}\n${cardHtml}\n{% endfor %}`,
    )

    // Remove duplicate siblings — the loop now emits them.
    siblings.each((_i, el) => {
      const $el = $(el)
      // The first card has been replaced by a text node, so `is(firstCard)`
      // no longer works. We match by tag+class instead.
      if ($el.is(cardTag) && ($el.attr('class') ?? '') === cardClass) {
        $el.remove()
      }
    })

    changes.push({
      field: 'collection.products_loop',
      selector: cardSelectors.join(', '),
      liquid: '{% for product in collection.products %}...{% endfor %}',
    })
  } else {
    warnings.push('collection: no product card found — product grid not templatized')
  }

  // --- Pagination ---
  const pagEl = findFirst($, root, [
    '[class*="pagination"]',
    '.pagination',
    'nav[aria-label*="pagination" i]',
  ])
  if (pagEl) {
    pagEl.html(`
      {% if paginate.pages > 1 %}
        {% if paginate.previous %}<a href="{{ paginate.previous.url }}" class="page-prev">{{ paginate.previous.title }}</a>{% endif %}
        {% for part in paginate.parts %}
          {% if part.is_link %}<a href="{{ part.url }}">{{ part.title }}</a>{% else %}<span class="page-current">{{ part.title }}</span>{% endif %}
        {% endfor %}
        {% if paginate.next %}<a href="{{ paginate.next.url }}" class="page-next">{{ paginate.next.title }}</a>{% endif %}
      {% endif %}
    `)
    changes.push({ field: 'paginate', selector: selectorLabel(pagEl), liquid: '{% if paginate.pages > 1 %}...{% endif %}' })
  }
}

/**
 * list-collections page templatizer.
 * Wraps the first collection card in a {% for collection in collections %} loop.
 */
function templatizeListCollections(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<any>,
  changes: TemplateChange[],
  warnings: string[],
): void {
  const cardSelectors = [
    '[class*="collection-card"]',
    '[class*="collection-item"]',
    'a[href*="/collections/"]',
  ]
  const firstCard = findFirst($, root, cardSelectors)
  if (firstCard) {
    firstCard.html(`
      <a href="{{ collection.url }}" class="collection-card__link">
        {% if collection.image %}
          <img src="{{ collection.image | img_url: 'medium' }}" alt="{{ collection.title | escape }}" loading="lazy">
        {% endif %}
        <h3 class="collection-card__title">{{ collection.title }}</h3>
      </a>
    `)
    const cardHtml = $.html(firstCard)
    firstCard.replaceWith(
      `{% for collection in collections %}\n${cardHtml}\n{% endfor %}`,
    )
    changes.push({
      field: 'collections_loop',
      selector: cardSelectors.join(', '),
      liquid: '{% for collection in collections %}...{% endfor %}',
    })
  } else {
    warnings.push('list-collections: no collection card found')
  }
}

/**
 * Static page / policy templatizer.
 * Substitutes the main heading with page.title and the rich-text body with page.content.
 */
function templatizePage(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<any>,
  changes: TemplateChange[],
  warnings: string[],
): void {
  const titleSelectors = [
    '[class*="page-title"]',
    '[class*="page__title"]',
    'h1',
  ]
  const titleEl = findFirst($, root, titleSelectors)
  if (titleEl) {
    titleEl.text('{{ page.title }}')
    changes.push({ field: 'page.title', selector: selectorLabel(titleEl), liquid: '{{ page.title }}' })
  } else {
    warnings.push('page: no title element found')
  }

  const contentSelectors = [
    '[class*="rte"]',
    '[class*="page-content"]',
    '[class*="page__content"]',
    '[class*="entry-content"]',
    'main [class*="content"]',
    'article',
    'main',
  ]
  const contentEl = findFirst($, root, contentSelectors)
  if (contentEl) {
    replaceContentPreservingJsonLd($, contentEl, '{{ page.content }}')
    changes.push({ field: 'page.content', selector: selectorLabel(contentEl), liquid: '{{ page.content }}' })
  } else {
    warnings.push('page: no content area found')
  }
}

/**
 * Blog index templatizer.
 * Wraps the first article card in {% for article in blog.articles %}.
 */
function templatizeBlog(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<any>,
  changes: TemplateChange[],
  warnings: string[],
): void {
  const titleEl = findFirst($, root, ['[class*="blog-title"]', '[class*="blog__title"]', 'h1'])
  if (titleEl) {
    titleEl.text('{{ blog.title }}')
    changes.push({ field: 'blog.title', selector: selectorLabel(titleEl), liquid: '{{ blog.title }}' })
  }

  const cardSelectors = [
    'article',
    '[class*="article-card"]',
    '[class*="blog-post"]',
    '[class*="post-card"]',
    '[class*="blog-item"]',
  ]
  const firstCard = findFirst($, root, cardSelectors)
  if (firstCard) {
    firstCard.html(`
      <a href="{{ article.url }}" class="article-card__link">
        {% if article.image %}
          <img src="{{ article.image | img_url: 'medium' }}" alt="{{ article.title | escape }}" loading="lazy">
        {% endif %}
        <h3 class="article-card__title">{{ article.title }}</h3>
        <time datetime="{{ article.published_at | date: '%Y-%m-%d' }}">{{ article.published_at | date: '%B %d, %Y' }}</time>
        <p class="article-card__excerpt">{{ article.excerpt_or_content | strip_html | truncate: 200 }}</p>
      </a>
    `)
    const cardHtml = $.html(firstCard)
    firstCard.replaceWith(
      `{% for article in blog.articles %}\n${cardHtml}\n{% endfor %}`,
    )
    changes.push({
      field: 'blog.articles_loop',
      selector: cardSelectors.join(', '),
      liquid: '{% for article in blog.articles %}...{% endfor %}',
    })
  } else {
    warnings.push('blog: no article card found')
  }
}

/**
 * Single blog post (article) templatizer.
 */
function templatizeBlogPost(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<any>,
  changes: TemplateChange[],
  warnings: string[],
): void {
  const titleEl = findFirst($, root, [
    '[class*="article-title"]',
    '[class*="article__title"]',
    '[class*="post-title"]',
    'h1',
  ])
  if (titleEl) {
    titleEl.text('{{ article.title }}')
    changes.push({ field: 'article.title', selector: selectorLabel(titleEl), liquid: '{{ article.title }}' })
  } else {
    warnings.push('blog-post: no title element found')
  }

  const dateEl = findFirst($, root, [
    'time[datetime]',
    '[class*="article-date"]',
    '[class*="published"]',
    '[class*="post-date"]',
  ])
  if (dateEl) {
    dateEl.attr('datetime', "{{ article.published_at | date: '%Y-%m-%d' }}")
    dateEl.text("{{ article.published_at | date: '%B %d, %Y' }}")
    changes.push({ field: 'article.published_at', selector: selectorLabel(dateEl), liquid: "{{ article.published_at | date: '%B %d, %Y' }}" })
  }

  const authorEl = findFirst($, root, [
    '[class*="author-name"]',
    '[class*="article-author"]',
    '[rel="author"]',
    '[class*="byline"]',
  ])
  if (authorEl) {
    authorEl.text('{{ article.author }}')
    changes.push({ field: 'article.author', selector: selectorLabel(authorEl), liquid: '{{ article.author }}' })
  }

  // Selector order matters: prefer the innermost body container (e.g. `.rte`)
  // before falling back to outer wrappers. Matching the outer wrapper first
  // would wipe out the title/date/author substitutions we just made above
  // (they live inside the wrapper).
  const bodyEl = findFirst($, root, [
    '[class*="rte"]',
    '[class*="article__content"]',
    '[class*="post-content"]',
    '[class*="entry-content"]',
    '[class*="article-content"]',
    'article',
    'main',
  ])
  if (bodyEl) {
    replaceContentPreservingJsonLd($, bodyEl, '{{ article.content }}')
    changes.push({ field: 'article.content', selector: selectorLabel(bodyEl), liquid: '{{ article.content }}' })
  } else {
    warnings.push('blog-post: no article body found')
  }
}

/**
 * Cart page templatizer.
 *   items → {% for item in cart.items %}<row>{% endfor %}
 *   totals → {{ cart.total_price | money }}
 */
function templatizeCart(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<any>,
  changes: TemplateChange[],
  warnings: string[],
): void {
  const firstItem = findFirst($, root, [
    '[class*="cart-item"]',
    '[class*="cart__item"]',
    '[class*="line-item"]',
    'tr[class*="cart"]',
  ])
  if (firstItem) {
    firstItem.html(`
      <a href="{{ item.url }}" class="cart-item__link">
        {% if item.image %}<img src="{{ item.image | img_url: 'small' }}" alt="{{ item.title | escape }}" loading="lazy">{% endif %}
        <div class="cart-item__title">{{ item.product.title }}</div>
        {% if item.variant.title != 'Default Title' %}<div class="cart-item__variant">{{ item.variant.title }}</div>{% endif %}
      </a>
      <div class="cart-item__qty">
        <input type="number" name="updates[]" value="{{ item.quantity }}" min="0" data-line="{{ forloop.index }}">
      </div>
      <div class="cart-item__price">{{ item.line_price | money }}</div>
    `)
    const itemHtml = $.html(firstItem)
    firstItem.replaceWith(
      `{% for item in cart.items %}\n${itemHtml}\n{% endfor %}`,
    )
    changes.push({
      field: 'cart.items_loop',
      selector: selectorLabel(firstItem),
      liquid: '{% for item in cart.items %}...{% endfor %}',
    })
  } else {
    warnings.push('cart: no cart-item element found')
  }

  const totalEl = findFirst($, root, [
    '[class*="cart-total"]',
    '[class*="cart__total"]',
    '[class*="subtotal"]',
    '[data-cart-subtotal]',
  ])
  if (totalEl) {
    totalEl.html('{{ cart.total_price | money }}')
    changes.push({ field: 'cart.total_price', selector: selectorLabel(totalEl), liquid: '{{ cart.total_price | money }}' })
  }

  // Wrap the outer form action properly so "checkout" submits through the
  // platform's cart endpoint.
  const formEl = root.find('form[action*="cart"], form[class*="cart"]').first()
  if (formEl.length > 0) {
    formEl.attr('action', '/cart')
    formEl.attr('method', 'post')
  }
}

/**
 * Search results templatizer.
 *   terms → {{ search.terms }}
 *   results → {% for item in search.results %}...{% endfor %}
 */
function templatizeSearch(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<any>,
  changes: TemplateChange[],
  warnings: string[],
): void {
  const termsEl = findFirst($, root, [
    '[class*="search-terms"]',
    '[class*="search-query"]',
    '[class*="search__query"]',
  ])
  if (termsEl) {
    termsEl.text('{{ search.terms }}')
    changes.push({ field: 'search.terms', selector: selectorLabel(termsEl), liquid: '{{ search.terms }}' })
  }

  const inputEl = root.find('input[type="search"], input[name="q"]').first()
  if (inputEl.length > 0) {
    inputEl.attr('name', 'q')
    inputEl.attr('value', '{{ search.terms | escape }}')
  }

  const firstResult = findFirst($, root, [
    '[class*="search-result"]',
    '[class*="search__result"]',
    '[class*="SearchResult"]',
  ])
  if (firstResult) {
    firstResult.html(`
      <a href="{{ item.url }}" class="search-result__link">
        {% if item.object_type == 'product' and item.featured_image %}
          <img src="{{ item.featured_image | img_url: 'small' }}" alt="{{ item.title | escape }}" loading="lazy">
        {% endif %}
        <h3 class="search-result__title">{{ item.title }}</h3>
        {% if item.object_type == 'product' %}
          <div class="search-result__price">{{ item.price | money }}</div>
        {% else %}
          <p class="search-result__excerpt">{{ item.content | strip_html | truncate: 150 }}</p>
        {% endif %}
      </a>
    `)
    const resultHtml = $.html(firstResult)
    firstResult.replaceWith(
      `{% if search.performed and search.results_count > 0 %}
        {% for item in search.results %}\n${resultHtml}\n{% endfor %}
      {% else %}
        <p class="search-empty">No results for "{{ search.terms }}".</p>
      {% endif %}`,
    )
    changes.push({
      field: 'search.results_loop',
      selector: selectorLabel(firstResult),
      liquid: '{% for item in search.results %}...{% endfor %}',
    })
  } else {
    warnings.push('search: no result card found')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip tracking and analytics scripts; keep theme-adjacent scripts. Matches
 * the rules used by `homepage-cloner.cleanupHtml` so the two paths stay in
 * sync. Inline JSON-LD is preserved (SEO value).
 */
function stripScripts($: cheerio.CheerioAPI): void {
  const trackingSrcPatterns = /gtm|gtag|googletagmanager|hotjar|clarity\.ms|klaviyo|facebook|fbq|monorail|analytics|pixel|bogos|sellup|hcaptcha/i
  const themeSrcPatterns = /swiper|theme|jquery|main|vendor|app/i
  const trackingInlinePatterns = /gtag|dataLayer|fbq|_hjSettings|clarity|klaviyo/i
  const themeInlinePatterns = /Swiper|slider|accordion|menu|toggle/i

  $('script').each((_, el) => {
    const $el = $(el)
    const type = ($el.attr('type') ?? '').toLowerCase()
    if (type === 'application/ld+json' || type === 'application/json') return

    const src = $el.attr('src') ?? ''
    if (src) {
      if (trackingSrcPatterns.test(src)) {
        $el.remove()
        return
      }
      if (themeSrcPatterns.test(src)) return
      // Default: strip unknown external scripts — the platform ships its own JS.
      $el.remove()
      return
    }

    const content = ($el.html() ?? '').trim()
    if (!content) {
      $el.remove()
      return
    }
    if (trackingInlinePatterns.test(content)) {
      $el.remove()
      return
    }
    if (themeInlinePatterns.test(content)) return
    // Default: strip unknown inline scripts
    $el.remove()
  })

  // Remove tracking <noscript> fallbacks too (Facebook pixel, GA noscript).
  $('noscript').each((_, el) => {
    const $el = $(el)
    const content = ($el.html() ?? '').toLowerCase()
    if (/fbq|google-analytics|googletagmanager|clarity/.test(content)) {
      $el.remove()
    }
  })
}

/**
 * Rewrite absolute URLs pointing at the source site back to root-relative paths.
 * Preserves hash/query. Leaves foreign-domain links untouched.
 */
function rewriteAbsoluteLinksToRelative(html: string, sourceUrl: string): string {
  let origin: string
  try {
    origin = new URL(sourceUrl).origin
  } catch {
    return html
  }
  // href="https://source.com/path" → href="/path"
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`href="${escapedOrigin}(/[^"]*)"`, 'g')
  return html.replace(pattern, 'href="$1"')
}

/**
 * Return the first element inside `root` matching any selector in order.
 * Returns null when nothing matches.
 */
function findFirst(
  _$: cheerio.CheerioAPI,
  root: cheerio.Cheerio<any>,
  selectors: readonly string[],
): cheerio.Cheerio<any> | null {
  for (const sel of selectors) {
    try {
      const match = root.find(sel).first()
      if (match.length > 0) return match
    } catch {
      // Skip invalid selectors silently — an upstream bug shouldn't break cloning.
    }
  }
  return null
}

/**
 * Return true if `element` matches any selector in the list.
 */
function matchesAny(
  _$: cheerio.CheerioAPI,
  element: cheerio.Cheerio<any>,
  selectors: readonly string[],
): boolean {
  for (const sel of selectors) {
    try {
      if (element.is(sel)) return true
    } catch {
      // skip
    }
  }
  return false
}

/**
 * Cheap human-readable selector label from a cheerio element (tag + first
 * class or id), used only in `changes[].selector` for diagnostics.
 */
function selectorLabel(el: cheerio.Cheerio<any>): string {
  const node = (el as any)[0]
  if (!node) return '?'
  const tag = node.tagName ?? node.name ?? 'unknown'
  const id = el.attr('id')
  if (id) return `${tag}#${id}`
  const cls = (el.attr('class') ?? '').split(/\s+/)[0]
  if (cls) return `${tag}.${cls}`
  return tag
}

/**
 * Cheerio's HTML serializer encodes `<`, `>`, and `&` in text nodes — which
 * is correct for real HTML but mangles Liquid expressions that legitimately
 * use those characters, e.g. `{% if paginate.pages > 1 %}` becomes
 * `{% if paginate.pages &gt; 1 %}`. We walk the output and selectively
 * decode entities *only inside* Liquid tags/outputs, leaving actual HTML
 * entities alone.
 *
 * Liquid syntax we protect:
 *   {% ... %}   — tag form (control flow)
 *   {{ ... }}   — output form (variable/filter)
 */
function unescapeLiquidEntities(html: string): string {
  return html.replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g, (match) =>
    match
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&'),
  )
}

/**
 * Replace an element's inner HTML with a Liquid snippet while preserving any
 * JSON-LD / JSON script blocks that lived inside it. Shopify best-practice
 * is to regenerate structured data from Liquid, but when we're still figuring
 * out the source's schema we'd rather keep their JSON-LD than drop it —
 * it's meaningful SEO signal, not tracking noise.
 *
 * After substitution the element looks like:
 *   <div class="rte">{{ page.content }}<script type="application/ld+json">...</script></div>
 */
function replaceContentPreservingJsonLd(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<any>,
  liquid: string,
): void {
  const preserved: string[] = []
  el.find('script[type="application/ld+json"], script[type="application/json"]').each((_i, node) => {
    preserved.push($.html(node))
  })
  if (preserved.length === 0) {
    el.html(liquid)
    return
  }
  el.html(`${liquid}\n${preserved.join('\n')}`)
}
