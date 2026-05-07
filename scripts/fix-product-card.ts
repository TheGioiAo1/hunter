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

async function main() {
  const client = await pool.connect()
  try {
    await client.query(
      `UPDATE theme_assets SET value = $1, updated_at = NOW() WHERE theme_id = $2 AND key = $3`,
      [productCardLiquid, THEME_ID, 'snippets/product-card.liquid'],
    )
    console.log('Updated snippets/product-card.liquid')

    await client.query(
      `UPDATE theme_assets SET value = $1, updated_at = NOW() WHERE theme_id = $2 AND key = $3`,
      [priceLiquid, THEME_ID, 'snippets/price.liquid'],
    )
    console.log('Updated snippets/price.liquid (added money filter)')
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(console.error)
