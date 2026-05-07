import 'dotenv/config'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const THEME_ID = '3684ebc6-c6a4-46cc-aed0-bf004b206f90'

const sectionLiquid = `<section class="featured-collection page-width">
  <header class="section-header">
    <h2>{{ section.settings.heading }}</h2>
    {%- if section.settings.subheading != blank -%}
      <p>{{ section.settings.subheading }}</p>
    {%- endif -%}
  </header>

  {%- assign collection_handle = section.settings.collection_handle -%}
  {%- if collection_handle != blank and collections[collection_handle] -%}
    {%- assign featured = collections[collection_handle] -%}
    <ul class="product-grid">
      {%- for product in featured.products limit: section.settings.products_to_show -%}
        <li>{% render 'product-card', product: product %}</li>
      {%- endfor -%}
    </ul>
  {%- else -%}
    <p class="placeholder">{{ 'sections.featured_collection.empty' | t }}</p>
  {%- endif -%}
</section>

{% schema %}
{
  "name": "Featured collection",
  "settings": [
    { "type": "text", "id": "heading", "label": "Heading", "default": "Featured collection" },
    { "type": "text", "id": "subheading", "label": "Subheading" },
    { "type": "collection", "id": "collection_handle", "label": "Collection" },
    { "type": "range", "id": "products_to_show", "label": "Products to show", "min": 2, "max": 24, "step": 1, "default": 8 }
  ]
}
{% endschema %}`

async function main() {
  const client = await pool.connect()
  try {
    await client.query(
      `UPDATE theme_assets SET value = $1, updated_at = NOW() WHERE theme_id = $2 AND key = $3`,
      [sectionLiquid, THEME_ID, 'sections/featured-collection.liquid'],
    )
    console.log('Updated sections/featured-collection.liquid')
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(console.error)
