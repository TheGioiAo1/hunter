/**
 * theme_section_schemas — built-in section definitions.
 *
 * 16 Shopify-style section types that the customizer's "+ Add section"
 * modal can drop into any template. Each schema declares the editable
 * settings the right-panel form renders, plus optional preset blocks.
 *
 * The shape mirrors Shopify Online Store 2.0 schema JSON exactly so a
 * theme exported from Shopify Liquid imports cleanly:
 *
 *   {
 *     name: "Hero banner",
 *     settings: [{ id, type, label, default, info?, options? }, ...],
 *     blocks?: [{ type, name, settings: [...] }, ...],
 *     presets?: [{ name, settings, blocks }, ...]
 *   }
 *
 * Why a code seed instead of a SQL migration:
 *   - The schemas are platform-managed, not per-shop. Re-seeding from
 *     code keeps them in sync with the CLIENT_JS catalog (DEFAULT_
 *     SECTION_CATALOG) — both live in the repo, both update together.
 *   - On startup the orchestrator calls `ensureBuiltinSchemas(db)` which
 *     UPSERTs every entry. New types added in code show up after a
 *     deploy without a migration round-trip.
 *
 * IMPORTANT: keep `type` in this file aligned with section_type values
 * the bundled default theme references (DEFAULT_THEME_FILES) AND with
 * DEFAULT_SECTION_CATALOG in apps/store-admin/.../server-render.ts.
 * If they drift, the customizer offers section types that addSection
 * inserts but the storefront engine can't render.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

interface SchemaSettingDef {
  id: string
  type: string
  label?: string
  default?: unknown
  info?: string
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
  step?: number
  placeholder?: string
}

interface SchemaBlockDef {
  type: string
  name: string
  limit?: number
  settings: SchemaSettingDef[]
}

interface SchemaPresetDef {
  name: string
  category?: string
  settings?: Record<string, unknown>
  blocks?: Array<{ type: string; settings?: Record<string, unknown> }>
}

interface BuiltinSchemaDef {
  type: string
  name: string
  description?: string
  category: 'content' | 'commerce' | 'navigation' | 'social'
  icon: string
  max_blocks?: number
  schema: {
    name: string
    settings: SchemaSettingDef[]
    blocks?: SchemaBlockDef[]
    presets?: SchemaPresetDef[]
  }
}

// ─── 16 built-in sections ─────────────────────────────────────────────

const TEXT_SETTINGS: SchemaSettingDef[] = [
  { id: 'heading', type: 'text', label: 'Heading', default: 'Welcome' },
  { id: 'subheading', type: 'text', label: 'Subheading', default: '' },
]

export const BUILTIN_SECTION_SCHEMAS: readonly BuiltinSchemaDef[] = [
  {
    type: 'hero',
    name: 'Hero banner',
    category: 'content',
    icon: 'banner',
    schema: {
      name: 'Hero banner',
      settings: [
        { id: 'heading', type: 'text', label: 'Heading', default: 'Welcome to your shop' },
        { id: 'subheading', type: 'textarea', label: 'Subheading', default: 'Tell customers what you sell.' },
        { id: 'cta_label', type: 'text', label: 'Button label', default: 'Shop now' },
        { id: 'cta_url', type: 'url', label: 'Button URL', default: '/collections/all' },
        { id: 'background_image', type: 'image_picker', label: 'Background image' },
        { id: 'overlay_opacity', type: 'range', label: 'Overlay opacity', min: 0, max: 100, step: 5, default: 30 },
      ],
      presets: [{ name: 'Default', category: 'Content' }],
    },
  },
  {
    type: 'image-with-text',
    name: 'Image with text',
    category: 'content',
    icon: 'image',
    schema: {
      name: 'Image with text',
      settings: [
        { id: 'image', type: 'image_picker', label: 'Image' },
        { id: 'image_position', type: 'select', label: 'Image position', default: 'left',
          options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }] },
        { id: 'heading', type: 'text', label: 'Heading', default: 'Tell your story' },
        { id: 'body', type: 'richtext', label: 'Body text', default: '<p>Use this section to talk about your brand.</p>' },
      ],
      presets: [{ name: 'Default' }],
    },
  },
  {
    type: 'rich-text',
    name: 'Rich text',
    category: 'content',
    icon: 'text',
    schema: {
      name: 'Rich text',
      settings: [
        { id: 'heading', type: 'text', label: 'Heading', default: 'Tell your story' },
        { id: 'body', type: 'richtext', label: 'Body', default: '<p>Use rich text to share information.</p>' },
        { id: 'text_align', type: 'select', label: 'Alignment', default: 'left',
          options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }] },
      ],
      presets: [{ name: 'Default' }],
    },
  },
  {
    type: 'featured-product',
    name: 'Featured product',
    category: 'commerce',
    icon: 'star',
    schema: {
      name: 'Featured product',
      settings: [
        { id: 'product', type: 'product', label: 'Product' },
        { id: 'show_vendor', type: 'checkbox', label: 'Show vendor', default: false },
        { id: 'show_price', type: 'checkbox', label: 'Show price', default: true },
      ],
      presets: [{ name: 'Default' }],
    },
  },
  {
    type: 'featured-collection',
    name: 'Featured collection',
    category: 'commerce',
    icon: 'collection',
    schema: {
      name: 'Featured collection',
      settings: [
        { id: 'collection', type: 'collection', label: 'Collection' },
        { id: 'heading', type: 'text', label: 'Heading', default: 'Featured products' },
        { id: 'products_to_show', type: 'range', label: 'Products to show', min: 2, max: 12, step: 1, default: 4 },
      ],
      presets: [{ name: 'Default' }],
    },
  },
  {
    type: 'collection-list',
    name: 'Collection list',
    category: 'commerce',
    icon: 'grid',
    schema: {
      name: 'Collection list',
      settings: [
        { id: 'heading', type: 'text', label: 'Heading', default: 'Collections' },
        { id: 'collections_to_show', type: 'range', label: 'Collections to show', min: 2, max: 12, step: 1, default: 6 },
      ],
      presets: [{ name: 'Default' }],
    },
  },
  {
    type: 'product-recommendations',
    name: 'Product recommendations',
    category: 'commerce',
    icon: 'sparkle',
    schema: {
      name: 'Product recommendations',
      settings: [
        { id: 'heading', type: 'text', label: 'Heading', default: 'You may also like' },
        { id: 'products_to_show', type: 'range', label: 'Products to show', min: 2, max: 10, step: 1, default: 4 },
      ],
      presets: [{ name: 'Default' }],
    },
  },
  {
    type: 'blog-posts',
    name: 'Blog posts',
    category: 'content',
    icon: 'blog',
    schema: {
      name: 'Blog posts',
      settings: [
        { id: 'blog', type: 'blog', label: 'Blog' },
        { id: 'heading', type: 'text', label: 'Heading', default: 'Latest posts' },
        { id: 'posts_to_show', type: 'range', label: 'Posts to show', min: 1, max: 6, step: 1, default: 3 },
      ],
      presets: [{ name: 'Default' }],
    },
  },
  {
    type: 'newsletter',
    name: 'Newsletter',
    category: 'content',
    icon: 'mail',
    schema: {
      name: 'Newsletter',
      settings: [
        { id: 'heading', type: 'text', label: 'Heading', default: 'Subscribe to our emails' },
        { id: 'subheading', type: 'text', label: 'Subheading', default: 'Be the first to know about new collections and exclusive offers.' },
        { id: 'placeholder', type: 'text', label: 'Email placeholder', default: 'Email' },
        { id: 'cta_label', type: 'text', label: 'Button label', default: 'Subscribe' },
      ],
      presets: [{ name: 'Default' }],
    },
  },
  {
    type: 'announcement-bar',
    name: 'Announcement bar',
    category: 'content',
    icon: 'megaphone',
    schema: {
      name: 'Announcement bar',
      settings: [
        { id: 'message', type: 'text', label: 'Message', default: 'Free shipping on orders over $50' },
        { id: 'link', type: 'url', label: 'Link (optional)' },
      ],
      presets: [{ name: 'Default' }],
    },
  },
  {
    type: 'testimonials',
    name: 'Testimonials',
    category: 'social',
    icon: 'quote',
    max_blocks: 9,
    schema: {
      name: 'Testimonials',
      settings: [
        { id: 'heading', type: 'text', label: 'Heading', default: 'What customers say' },
      ],
      blocks: [
        { type: 'testimonial', name: 'Testimonial', limit: 9, settings: [
          { id: 'quote', type: 'textarea', label: 'Quote', default: 'This brand changed my life.' },
          { id: 'author', type: 'text', label: 'Author', default: 'Happy Customer' },
          { id: 'avatar', type: 'image_picker', label: 'Avatar' },
        ]},
      ],
      presets: [{ name: 'Default', blocks: [
        { type: 'testimonial' }, { type: 'testimonial' }, { type: 'testimonial' },
      ]}],
    },
  },
  {
    type: 'faq',
    name: 'FAQ',
    category: 'content',
    icon: 'help',
    max_blocks: 12,
    schema: {
      name: 'FAQ',
      settings: [
        { id: 'heading', type: 'text', label: 'Heading', default: 'Frequently asked questions' },
      ],
      blocks: [
        { type: 'qa', name: 'Question', limit: 12, settings: [
          { id: 'question', type: 'text', label: 'Question', default: 'What is your return policy?' },
          { id: 'answer', type: 'richtext', label: 'Answer', default: '<p>Returns within 30 days.</p>' },
        ]},
      ],
      presets: [{ name: 'Default', blocks: [{ type: 'qa' }, { type: 'qa' }, { type: 'qa' }] }],
    },
  },
  {
    type: 'page-content',
    name: 'Page content',
    category: 'content',
    icon: 'document',
    schema: {
      name: 'Page content',
      settings: [
        { id: 'page', type: 'page', label: 'Page' },
      ],
      presets: [{ name: 'Default' }],
    },
  },
  {
    type: 'search',
    name: 'Search',
    category: 'navigation',
    icon: 'search',
    schema: {
      name: 'Search',
      settings: [
        { id: 'heading', type: 'text', label: 'Heading', default: 'Search' },
        { id: 'placeholder', type: 'text', label: 'Placeholder', default: 'Search the store…' },
      ],
      presets: [{ name: 'Default' }],
    },
  },
  {
    type: 'contact-form',
    name: 'Contact form',
    category: 'content',
    icon: 'envelope',
    schema: {
      name: 'Contact form',
      settings: [
        { id: 'heading', type: 'text', label: 'Heading', default: 'Get in touch' },
        { id: 'subheading', type: 'text', label: 'Subheading', default: "We'll get back to you within 24 hours." },
      ],
      presets: [{ name: 'Default' }],
    },
  },
  {
    type: 'breadcrumbs',
    name: 'Breadcrumbs',
    category: 'navigation',
    icon: 'compass',
    schema: {
      name: 'Breadcrumbs',
      settings: [
        { id: 'show_home_link', type: 'checkbox', label: 'Show "Home" link', default: true },
      ],
      presets: [{ name: 'Default' }],
    },
  },
] as const

void TEXT_SETTINGS // referenced for future shared schemas; keep silenced

/**
 * Idempotent UPSERT of every built-in schema. Safe to call on every
 * server boot — onConflict on `type` updates name + schema_json + icon
 * + category so seed edits propagate without a migration. Existing
 * shop edits to schemas (none today, but planned for theme exporters)
 * stay untouched on rows where `is_builtin = false`.
 */
export async function ensureBuiltinSchemas(db: Kysely<Database>): Promise<void> {
  const now = new Date()
  for (const def of BUILTIN_SECTION_SCHEMAS) {
    await (db as any)
      .insertInto('theme_section_schemas')
      .values({
        type: def.type,
        name: def.name,
        description: def.description ?? null,
        schema_json: def.schema,
        default_html: null,
        category: def.category,
        icon: def.icon,
        max_blocks: def.max_blocks ?? 50,
        is_builtin: true,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc: any) =>
        oc.columns(['type']).doUpdateSet({
          name: def.name,
          description: def.description ?? null,
          schema_json: def.schema,
          category: def.category,
          icon: def.icon,
          max_blocks: def.max_blocks ?? 50,
          updated_at: now,
        }),
      )
      .execute()
  }
}
