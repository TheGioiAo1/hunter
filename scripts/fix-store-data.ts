/**
 * Fix store data: product-card template, price snippet, and create missing pages
 */
import 'dotenv/config'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const THEME_ID = '3684ebc6-c6a4-46cc-aed0-bf004b206f90'

const productCardLiquid = `<article class="product-card">
  <a class="product-card__link" href="{{ product.url }}">
    <div class="product-card__media">
      {%- if product.featured_image -%}
        <img src="{{ product.featured_image }}" alt="{{ product.title | escape }}" loading="lazy">
      {%- else -%}
        <div class="product-card__placeholder"></div>
      {%- endif -%}
    </div>
    <h3 class="product-card__title">{{ product.title }}</h3>
    {% render 'price', product: product %}
    {%- unless product.available -%}
      <span class="product-card__badge">{{ 'product.sold_out' | t }}</span>
    {%- endunless -%}
  </a>
</article>
`

const priceLiquid = `<div class="price{% if product.compare_at_price and product.compare_at_price > product.price %} price--on-sale{% endif %}">
  {%- if product.compare_at_price and product.compare_at_price > product.price -%}
    <span class="price__sale">{{ product.price | money }}</span>
    <s class="price__compare">{{ product.compare_at_price | money }}</s>
  {%- else -%}
    <span class="price__regular">{{ product.price | money }}</span>
  {%- endif -%}
</div>
`

const aboutPageHtml = `<div class="page-content">
  <div class="about-hero">
    <h2>Our Story</h2>
    <p>At Biblio Bloom, we believe that books are more than just stories — they're works of art that deserve to be celebrated. Our unique collection of acrylic book vases, bookmarks, and literary-inspired decor brings the magic of your favorite stories into your everyday life.</p>
  </div>
  <div class="about-section">
    <h3>What We Do</h3>
    <p>Each piece in our collection is carefully designed to capture the essence of beloved literary works. From our signature acrylic book vases featuring classic novel covers to our delicate bookmarks, every item is crafted with attention to detail and a deep love for literature.</p>
  </div>
  <div class="about-section">
    <h3>Our Mission</h3>
    <p>We're on a mission to help book lovers express their passion for reading through beautiful, functional decor. Whether you're looking for a statement piece for your bookshelf or a thoughtful gift for a fellow reader, Biblio Bloom has something special for you.</p>
  </div>
</div>`

const contactPageHtml = `<div class="page-content">
  <h2>Get In Touch</h2>
  <p>We'd love to hear from you! Whether you have a question about our products, need help with an order, or just want to chat about your favorite books, we're here for you.</p>
  <div class="contact-info">
    <div class="contact-method">
      <h3>Email Us</h3>
      <p><a href="mailto:hello@bibliobloom.com">hello@bibliobloom.com</a></p>
    </div>
    <div class="contact-method">
      <h3>Follow Us</h3>
      <p>Stay connected on social media for new arrivals, behind-the-scenes content, and book-inspired inspiration.</p>
    </div>
  </div>
  <div class="contact-form-placeholder">
    <h3>Send Us a Message</h3>
    <form class="contact-form">
      <div class="form-group">
        <label for="name">Name</label>
        <input type="text" id="name" name="name" required>
      </div>
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" required>
      </div>
      <div class="form-group">
        <label for="message">Message</label>
        <textarea id="message" name="message" rows="5" required></textarea>
      </div>
      <button type="submit" class="button button--primary">Send Message</button>
    </form>
  </div>
</div>`

async function main() {
  const client = await pool.connect()
  try {
    // 1. Fix product-card.liquid
    await client.query(
      `UPDATE theme_assets SET value = $1, updated_at = NOW() WHERE theme_id = $2 AND key = $3`,
      [productCardLiquid, THEME_ID, 'snippets/product-card.liquid'],
    )
    console.log('✓ Updated snippets/product-card.liquid')

    // 2. Fix price.liquid (add money filter)
    await client.query(
      `UPDATE theme_assets SET value = $1, updated_at = NOW() WHERE theme_id = $2 AND key = $3`,
      [priceLiquid, THEME_ID, 'snippets/price.liquid'],
    )
    console.log('✓ Updated snippets/price.liquid')

    // 3. Get shop ID
    const shopRow = await client.query(
      `SELECT id FROM shops WHERE slug = 'diepanhtest'`,
    )
    const shopId = shopRow.rows[0]?.id
    if (!shopId) {
      console.error('Shop not found!')
      return
    }

    // 4. Create about page
    const aboutResult = await client.query(
      `INSERT INTO pages (id, shop_id, title, slug, body_html, published, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'About', 'about', $2, true, NOW(), NOW())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [shopId, aboutPageHtml],
    )
    console.log(aboutResult.rowCount ? '✓ Created About page' : '→ About page already exists')

    // 5. Create contact page
    const contactResult = await client.query(
      `INSERT INTO pages (id, shop_id, title, slug, body_html, published, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Contact', 'contact', $2, true, NOW(), NOW())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [shopId, contactPageHtml],
    )
    console.log(contactResult.rowCount ? '✓ Created Contact page' : '→ Contact page already exists')

    // 6. Verify
    const pageCount = await client.query(
      `SELECT COUNT(*) FROM pages WHERE shop_id = $1`,
      [shopId],
    )
    console.log(`\nTotal pages for shop: ${pageCount.rows[0].count}`)

    const productSample = await client.query(
      `SELECT p.title, v.price, pi.src
       FROM products p
       JOIN product_variants v ON v.product_id = p.id
       LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.position = 1
       WHERE p.shop_id = $1
       LIMIT 3`,
      [shopId],
    )
    console.log('\nSample products with prices and images:')
    for (const row of productSample.rows) {
      console.log(`  ${row.title}: $${row.price} | img: ${row.src ? 'yes' : 'no'}`)
    }
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(console.error)
