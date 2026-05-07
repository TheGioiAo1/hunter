-- Update Biblio Bloom clone theme to match original store styling
-- Theme ID: 3684ebc6-c6a4-46cc-aed0-bf004b206f90
-- Shop ID: 8baf2545-d37c-4d57-a6f7-601e0b234b6a

-- ============================================================
-- 1. Update theme CSS — Biblio Bloom style
-- ============================================================
UPDATE theme_assets SET value = '/* ---------------------------------------------------------------------------
 * Biblio Bloom — Storefront Theme CSS
 * Elegant literary decor store. Serif typography, dark green + gold palette.
 * --------------------------------------------------------------------------- */

@import url(''https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Neuton:ital,wght@0,400;0,700;1,400&display=swap'');

:root {
  --color-bg: #ffffff;
  --color-fg: #161d25;
  --color-heading: #0c3223;
  --color-muted: #6b7c74;
  --color-border: #e0e7e4;
  --color-accent: #0c3223;
  --color-accent-fg: #ffffff;
  --color-btn-bg: #f2cb4b;
  --color-btn-fg: #0c3223;
  --color-topbar-bg: #e0e7e4;
  --color-topbar-fg: #0c3223;
  --color-sale: #c0392b;
  --font-body: ''Neuton'', Georgia, ''Times New Roman'', serif;
  --font-heading: ''Playfair Display'', Georgia, serif;
  --page-width: 1200px;
  --space-xs: 0.25rem;
  --space-sm: 0.5rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2.5rem;
  --space-2xl: 4rem;
  --radius: 4px;
}

* { box-sizing: border-box; }

html, body { margin: 0; padding: 0; }
body {
  font-family: var(--font-body);
  color: var(--color-fg);
  background: var(--color-bg);
  line-height: 1.7;
  font-size: 17px;
  -webkit-font-smoothing: antialiased;
}

a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; }
img { max-width: 100%; height: auto; display: block; }
h1, h2, h3, h4 {
  font-family: var(--font-heading);
  color: var(--color-heading);
  font-weight: 500;
  line-height: 1.25;
}

/* --- Buttons --- */
.button, button[type="submit"] {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 14px 36px; border: none; border-radius: var(--radius);
  font-family: var(--font-heading); font-size: 15px; font-weight: 600;
  letter-spacing: 0.04em; text-transform: uppercase;
  cursor: pointer; transition: all 0.25s;
}
.button--primary, button[type="submit"] {
  background: var(--color-btn-bg); color: var(--color-btn-fg);
}
.button--primary:hover, button[type="submit"]:hover {
  background: #e6b93d; text-decoration: none;
}
.button--secondary {
  background: transparent; color: var(--color-heading);
  border: 2px solid var(--color-heading);
}
.button--secondary:hover { background: var(--color-heading); color: #fff; text-decoration: none; }

/* --- Announcement / Topbar --- */
.announcement-bar {
  background: var(--color-topbar-bg); color: var(--color-topbar-fg);
  text-align: center; padding: 10px 16px;
  font-size: 14px; letter-spacing: 0.03em;
}

/* --- Skip link --- */
.skip-link {
  position: absolute; top: -100px; left: 16px;
  background: var(--color-accent); color: #fff;
  padding: 8px 16px; z-index: 9999; border-radius: var(--radius);
}
.skip-link:focus { top: 8px; }
.visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }

/* --- Page width --- */
.page-width { max-width: var(--page-width); margin: 0 auto; padding: 0 24px; }
.page-width--narrow { max-width: 720px; }

/* --- Header --- */
.site-header {
  background: #fff; border-bottom: 1px solid var(--color-border);
  padding: 16px 0; position: sticky; top: 0; z-index: 100;
}
.site-header__inner {
  display: flex; align-items: center; gap: 24px;
}
.site-header__logo {
  font-family: var(--font-heading);
  font-size: 26px; font-weight: 600;
  color: var(--color-heading); letter-spacing: 0.02em;
}
.site-header__logo:hover { text-decoration: none; }
.site-header__logo-text { display: inline-block; }
.site-header__nav { flex: 1; }
.site-header__nav ul {
  list-style: none; margin: 0; padding: 0;
  display: flex; gap: 28px; justify-content: center;
}
.site-header__nav a {
  font-family: var(--font-heading); font-size: 14px;
  font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--color-heading); transition: color 0.2s;
}
.site-header__nav a:hover { color: var(--color-btn-bg); text-decoration: none; }
.site-header__actions {
  display: flex; align-items: center; gap: 16px;
}
.site-header__search { display: none; }
.site-header__icon { color: var(--color-heading); }
.site-header__icon svg { width: 22px; height: 22px; }
.site-header__cart { position: relative; }
.site-header__cart-count {
  position: absolute; top: -6px; right: -8px;
  background: var(--color-btn-bg); color: var(--color-btn-fg);
  font-size: 11px; font-weight: 700; min-width: 18px; height: 18px;
  border-radius: 9px; display: flex; align-items: center; justify-content: center;
}

/* --- Hero --- */
.hero {
  position: relative; display: flex; align-items: center;
  justify-content: center; text-align: center;
  min-height: 520px; padding: 80px 24px;
  background: linear-gradient(135deg, #0c3223 0%, #1a5c40 50%, #0c3223 100%);
  color: #fff; overflow: hidden;
}
.hero::before {
  content: ""; position: absolute; inset: 0;
  background: url(''https://cdn.shopify.com/s/files/1/0680/8738/2255/files/AcrylicVaseAnneFrank-mockup01.jpg?v=1773732253'') center/cover no-repeat;
  opacity: 0.15;
}
.hero__content { position: relative; z-index: 1; max-width: 640px; }
.hero__heading {
  font-family: var(--font-heading); font-size: 48px;
  font-weight: 500; color: #fff; margin-bottom: 16px;
  line-height: 1.15; letter-spacing: -0.01em;
}
.hero__subheading {
  font-size: 19px; color: rgba(255,255,255,0.85);
  margin-bottom: 32px; line-height: 1.6;
}
.hero .button--primary {
  background: var(--color-btn-bg); color: var(--color-btn-fg);
  padding: 16px 44px; font-size: 14px;
}

/* --- Featured Collection --- */
.featured-collection { padding: var(--space-2xl) 0; }
.featured-collection header { text-align: center; margin-bottom: var(--space-xl); }
.featured-collection h2 { font-size: 32px; color: var(--color-heading); }
.product-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 24px;
}

/* --- Product card --- */
.product-card {
  background: #fff; border-radius: var(--radius);
  overflow: hidden; transition: transform 0.2s, box-shadow 0.2s;
  border: 1px solid var(--color-border);
}
.product-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 32px rgba(12,50,35,0.08);
}
.product-card__media {
  aspect-ratio: 1; overflow: hidden; background: #f7f7f5;
}
.product-card__media img {
  width: 100%; height: 100%; object-fit: cover;
  transition: transform 0.4s;
}
.product-card:hover .product-card__media img { transform: scale(1.05); }
.product-card__info { padding: 16px; text-align: center; }
.product-card__title {
  font-family: var(--font-heading); font-size: 16px; font-weight: 500;
  color: var(--color-heading); margin: 0 0 6px;
}
.product-card__vendor {
  font-size: 12px; color: var(--color-muted);
  text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px;
}
.product-card__price { font-size: 15px; font-weight: 600; }
.product-card a { text-decoration: none; }
.product-card a:hover { text-decoration: none; }

/* --- Price --- */
.price { font-size: 18px; }
.price--on-sale .price__sale { color: var(--color-sale); font-weight: 700; }
.price--on-sale .price__compare {
  color: var(--color-muted); text-decoration: line-through;
  font-size: 0.85em; margin-left: 8px;
}

/* --- Product page --- */
.product { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; padding: var(--space-2xl) 0; align-items: start; }
.product__media { border-radius: var(--radius); overflow: hidden; background: #f7f7f5; }
.product__media img { width: 100%; }
.product__info { padding-top: 16px; }
.product__vendor {
  font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--color-muted); margin-bottom: 8px;
}
.product__title {
  font-family: var(--font-heading); font-size: 32px; font-weight: 500;
  color: var(--color-heading); margin: 0 0 16px; line-height: 1.2;
}
.product__description { margin: 20px 0; color: var(--color-fg); line-height: 1.8; }
.product__description p { margin: 0 0 12px; }
.product__submit {
  width: 100%; padding: 16px; font-size: 15px;
  margin-top: 16px;
}
.quantity-input { display: flex; align-items: center; gap: 8px; margin: 16px 0; }
.quantity-input__button {
  width: 40px; height: 40px; border: 1px solid var(--color-border);
  background: #fff; font-size: 18px; border-radius: var(--radius);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}

/* --- Image with text --- */
.image-with-text {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 48px; padding: var(--space-2xl) 0; align-items: center;
}
.image-with-text__placeholder {
  aspect-ratio: 4/3; background: linear-gradient(135deg, #e0e7e4, #c8d5ce);
  border-radius: var(--radius);
}
.image-with-text__copy h2 { font-size: 28px; margin-bottom: 12px; }
.image-with-text__copy p { color: var(--color-muted); margin-bottom: 20px; }

/* --- Newsletter --- */
.newsletter {
  background: var(--color-topbar-bg); padding: var(--space-2xl) 24px;
  text-align: center;
}
.newsletter h2 { font-size: 28px; margin-bottom: 8px; }
.newsletter p { color: var(--color-muted); margin-bottom: 20px; }
.newsletter form {
  display: flex; gap: 8px; max-width: 420px; margin: 0 auto;
}
.newsletter input[type="email"] {
  flex: 1; padding: 12px 16px; border: 1px solid var(--color-border);
  border-radius: var(--radius); font-family: var(--font-body); font-size: 15px;
}
.newsletter button { padding: 12px 28px; }

/* --- Collection page --- */
.collection-header { text-align: center; padding: var(--space-xl) 0; }
.collection-header h1 { font-size: 36px; }
.collection-header p { color: var(--color-muted); }

/* --- List collections --- */
.collection-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 24px; padding: var(--space-xl) 0; }
.collection-card { text-align: center; }
.collection-card__image { aspect-ratio: 1; background: #f7f7f5; border-radius: var(--radius); overflow: hidden; margin-bottom: 12px; }
.collection-card__title { font-family: var(--font-heading); font-size: 18px; font-weight: 500; color: var(--color-heading); }

/* --- Footer --- */
.site-footer {
  background: #0c3223; color: rgba(255,255,255,0.8);
  padding: var(--space-2xl) 0 var(--space-lg);
}
.site-footer a { color: rgba(255,255,255,0.7); }
.site-footer a:hover { color: #f2cb4b; }
.site-footer__grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 32px; margin-bottom: var(--space-xl);
}
.site-footer__heading {
  font-family: var(--font-heading); font-size: 16px;
  font-weight: 600; color: #fff; margin-bottom: 16px;
  text-transform: uppercase; letter-spacing: 0.06em;
}
.site-footer__links { list-style: none; padding: 0; margin: 0; }
.site-footer__links li { margin-bottom: 8px; }
.site-footer__links a { font-size: 14px; }
.site-footer__bottom {
  border-top: 1px solid rgba(255,255,255,0.15);
  padding-top: var(--space-lg); text-align: center;
  font-size: 13px; color: rgba(255,255,255,0.5);
}

/* --- Breadcrumb --- */
.breadcrumb { padding: var(--space-md) 0; font-size: 13px; color: var(--color-muted); }
.breadcrumb a { color: var(--color-muted); }
.breadcrumb a:hover { color: var(--color-heading); }

/* --- Search --- */
.search-form { max-width: 600px; margin: 0 auto; padding: var(--space-xl) 0; }
.search-form input[type="search"] {
  width: 100%; padding: 14px 20px; border: 2px solid var(--color-border);
  border-radius: var(--radius); font-size: 16px; font-family: var(--font-body);
}

/* --- Cart --- */
.cart-table { width: 100%; border-collapse: collapse; margin: var(--space-lg) 0; }
.cart-table th { text-align: left; padding: 12px; border-bottom: 2px solid var(--color-border); font-family: var(--font-heading); font-weight: 500; }
.cart-table td { padding: 12px; border-bottom: 1px solid var(--color-border); }

/* --- 404 --- */
.error-404 { padding: 80px 24px; text-align: center; }
.error-404 h1 { font-size: 48px; color: var(--color-heading); }
.error-404 p { color: var(--color-muted); font-size: 18px; margin: 16px 0 32px; }

/* --- Placeholder --- */
.placeholder { color: var(--color-muted); font-style: italic; padding: var(--space-lg) 0; text-align: center; }

/* --- Responsive --- */
@media (max-width: 768px) {
  .product { grid-template-columns: 1fr; gap: 24px; }
  .image-with-text { grid-template-columns: 1fr; }
  .hero__heading { font-size: 32px; }
  .hero { min-height: 380px; padding: 48px 16px; }
  .site-header__nav { display: none; }
  .site-footer__grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 480px) {
  .product-grid { grid-template-columns: 1fr 1fr; gap: 12px; }
  .site-footer__grid { grid-template-columns: 1fr; }
}
', updated_at = NOW()
WHERE theme_id = '3684ebc6-c6a4-46cc-aed0-bf004b206f90' AND key = 'assets/theme.css';

-- ============================================================
-- 2. Update index.json template — Biblio Bloom content
-- ============================================================
UPDATE theme_assets SET value = '{
  "sections": {
    "hero": {
      "type": "hero",
      "settings": {
        "heading": "Unique Book Vases for Book Lovers",
        "subheading": "Elegant decor inspired by classic literature. Each vase is a love letter to your favorite stories.",
        "cta_label": "Shop All Vases",
        "cta_link": "/collections/acrylic-vases"
      }
    },
    "featured-collection": {
      "type": "featured-collection",
      "settings": {
        "heading": "Best Sellers",
        "collection_handle": "frontpage",
        "products_to_show": 8
      }
    },
    "image-with-text": {
      "type": "image-with-text",
      "settings": {
        "heading": "Crafted for Book Lovers",
        "text": "Every Biblio Bloom vase is designed to celebrate literature. From acrylic book vases to ceramic pieces, we bring stories to life through elegant home decor.",
        "image": "",
        "link_label": "About Biblio Bloom",
        "link_url": "/pages/about"
      }
    },
    "newsletter": {
      "type": "newsletter",
      "settings": {
        "heading": "Join the Biblio Bloom Family",
        "subheading": "Be the first to know about new arrivals, exclusive offers, and literary inspiration."
      }
    }
  },
  "order": ["hero", "featured-collection", "image-with-text", "newsletter"]
}', updated_at = NOW()
WHERE theme_id = '3684ebc6-c6a4-46cc-aed0-bf004b206f90' AND key = 'templates/index.json';

-- ============================================================
-- 3. Update header section — Biblio Bloom navigation
-- ============================================================
UPDATE theme_assets SET value = '<header class="site-header" role="banner">
  <div class="page-width site-header__inner">
    <a class="site-header__logo" href="/" aria-label="{{ shop.name }}">
      <span class="site-header__logo-text">{{ shop.name }}</span>
    </a>

    <nav class="site-header__nav" aria-label="{{ ''header.primary_navigation'' | t }}">
      <ul>
        <li><a href="/">{{ ''header.home'' | t }}</a></li>
        <li><a href="/collections/acrylic-vases">Vases</a></li>
        <li><a href="/collections/acrylic-bookmarks">Bookmarks</a></li>
        <li><a href="/collections/all">Shop All</a></li>
        <li><a href="/pages/about">{{ ''header.about'' | t }}</a></li>
      </ul>
    </nav>

    <div class="site-header__actions">
      <a class="site-header__icon" href="/account/login" aria-label="{{ ''header.login'' | t }}">
        {%- render ''icon-account'' -%}
      </a>
      <a class="site-header__icon site-header__cart" href="/cart" aria-label="{{ ''header.cart'' | t }}">
        {%- render ''icon-cart'' -%}
        <span class="site-header__cart-count" data-cart-count>{{ cart.item_count | default: 0 }}</span>
      </a>
    </div>
  </div>
</header>

{% schema %}
{
  "name": "Header",
  "settings": [
    { "type": "image_picker", "id": "logo", "label": "Logo image" }
  ]
}
{% endschema %}', updated_at = NOW()
WHERE theme_id = '3684ebc6-c6a4-46cc-aed0-bf004b206f90' AND key = 'sections/header.liquid';

-- ============================================================
-- 4. Update footer section — Biblio Bloom dark green footer
-- ============================================================
UPDATE theme_assets SET value = '<footer class="site-footer">
  <div class="page-width">
    <div class="site-footer__grid">
      <div>
        <h2 class="site-footer__heading">{{ ''footer.shop'' | t }}</h2>
        <ul class="site-footer__links">
          <li><a href="/collections/acrylic-vases">Acrylic Vases</a></li>
          <li><a href="/collections/ceramic-vases">Ceramic Vases</a></li>
          <li><a href="/collections/acrylic-bookmarks">Bookmarks</a></li>
          <li><a href="/collections/artificial-flowers">Flowers</a></li>
          <li><a href="/collections/all">{{ ''footer.all_products'' | t }}</a></li>
        </ul>
      </div>
      <div>
        <h2 class="site-footer__heading">{{ ''footer.about'' | t }}</h2>
        <ul class="site-footer__links">
          <li><a href="/pages/about">About Us</a></li>
          <li><a href="/pages/contact">Contact</a></li>
          <li><a href="/policies/shipping-policy">{{ ''footer.shipping'' | t }}</a></li>
          <li><a href="/policies/refund-policy">{{ ''footer.refund'' | t }}</a></li>
        </ul>
      </div>
      <div>
        <h2 class="site-footer__heading">Newsletter</h2>
        <p style="font-size:14px;margin-bottom:12px">Subscribe for new arrivals and exclusive offers.</p>
      </div>
    </div>
    <div class="site-footer__bottom">
      &copy; {{ ''now'' | date: ''%Y'' }} {{ shop.name }}. All rights reserved. {{ ''footer.powered_by'' | t }} Gbox Platform.
    </div>
  </div>
</footer>

{% schema %}
{
  "name": "Footer",
  "settings": []
}
{% endschema %}', updated_at = NOW()
WHERE theme_id = '3684ebc6-c6a4-46cc-aed0-bf004b206f90' AND key = 'sections/footer.liquid';

-- ============================================================
-- 5. Update hero section — elegant literary style
-- ============================================================
UPDATE theme_assets SET value = '<section class="hero">
  <div class="hero__content">
    <h1 class="hero__heading">{{ section.settings.heading }}</h1>
    <p class="hero__subheading">{{ section.settings.subheading }}</p>
    {%- if section.settings.cta_label != blank -%}
      <a class="button button--primary" href="{{ section.settings.cta_link | default: ''/collections/all'' }}">{{ section.settings.cta_label }}</a>
    {%- endif -%}
  </div>
</section>

{% schema %}
{
  "name": "Hero banner",
  "settings": [
    { "type": "text", "id": "heading", "label": "Heading", "default": "Welcome" },
    { "type": "text", "id": "subheading", "label": "Subheading" },
    { "type": "text", "id": "cta_label", "label": "Button label", "default": "Shop now" },
    { "type": "url", "id": "cta_link", "label": "Button link" }
  ]
}
{% endschema %}', updated_at = NOW()
WHERE theme_id = '3684ebc6-c6a4-46cc-aed0-bf004b206f90' AND key = 'sections/hero.liquid';

-- ============================================================
-- 6. Update layout/theme.liquid — add Google Fonts + announcement bar
-- ============================================================
UPDATE theme_assets SET value = '<!doctype html>
<html lang="{{ request.locale | default: ''en'' }}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#0c3223">
    <link rel="canonical" href="https://{{ request.host }}{{ request.path }}">
    {%- render ''meta-tags'' -%}
    <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
    <link rel="stylesheet" href="/assets/theme.css">

    {{ content_for_header }}
  </head>

  <body class="theme-body template-{{ template | default: ''index'' }}">
    <a class="skip-link" href="#main-content">{{ ''accessibility.skip_to_content'' | t }}</a>

    <div class="announcement-bar">Free shipping on orders over $75 | Book-inspired decor for every reader</div>

    {%- section ''header'' -%}

    <main id="main-content" role="main">
      {{ content_for_layout }}
    </main>

    {%- section ''footer'' -%}
  </body>
</html>', updated_at = NOW()
WHERE theme_id = '3684ebc6-c6a4-46cc-aed0-bf004b206f90' AND key = 'layout/theme.liquid';

-- ============================================================
-- 7. Create about page
-- ============================================================
INSERT INTO pages (id, shop_id, title, handle, body_html, published, created_at, updated_at)
VALUES (
  gen_random_uuid(),
  '8baf2545-d37c-4d57-a6f7-601e0b234b6a',
  'About Us',
  'about',
  '<h2>About Biblio Bloom</h2>
<p>Biblio Bloom is a home decor brand dedicated to book lovers and literary enthusiasts. We design unique book-shaped vases, bookmarks, and accessories that celebrate the joy of reading.</p>
<p>Every piece in our collection is carefully crafted to bring literature to life in your home. From acrylic book vases inspired by classic novels to handmade ceramic pieces, we believe that your love for books deserves to be displayed beautifully.</p>
<p>Founded by passionate readers, Biblio Bloom has grown into a community of thousands of book lovers worldwide who share our vision: making literary-inspired decor accessible and elegant.</p>',
  true,
  NOW(),
  NOW()
) ON CONFLICT DO NOTHING;

-- ============================================================
-- 8. Create contact page
-- ============================================================
INSERT INTO pages (id, shop_id, title, handle, body_html, published, created_at, updated_at)
VALUES (
  gen_random_uuid(),
  '8baf2545-d37c-4d57-a6f7-601e0b234b6a',
  'Contact',
  'contact',
  '<h2>Get in Touch</h2>
<p>Have a question about our products, shipping, or returns? We would love to hear from you!</p>
<p><strong>Email:</strong> hello@bibliobloom.com</p>
<p><strong>Response Time:</strong> We typically respond within 24 hours during business days.</p>
<p>Follow us on social media for the latest designs, behind-the-scenes content, and exclusive offers.</p>',
  true,
  NOW(),
  NOW()
) ON CONFLICT DO NOTHING;
