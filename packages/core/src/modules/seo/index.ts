/**
 * Gbox Platform — SEO module barrel (Stage 3D.3 + 3D.4)
 *
 * Pure helpers for generating SEO artefacts:
 *
 *   json-ld.ts    Structured data builders (Product, Organization,
 *                 BreadcrumbList, WebSite) that emit schema.org
 *                 JSON-LD ready for a `<script type="application/ld+json">`
 *                 block.
 *
 *   meta-tags.ts  Head-tag builders: canonical URL / link, OG
 *                 properties, Twitter Card properties, and the
 *                 combined `buildMetaTags()` helper.
 *
 * Nothing in this module touches the DB, HTTP, or the theme
 * engine — every function is a deterministic transform on plain
 * input objects, which keeps unit tests trivial and the helpers
 * reusable from the storefront, the admin preview, and future
 * server-rendered surfaces.
 */

export {
  buildProductJsonLd,
  buildOrganizationJsonLd,
  buildBreadcrumbListJsonLd,
  buildWebSiteJsonLd,
  type ProductJsonLdInput,
  type OrganizationJsonLdInput,
  type BreadcrumbListJsonLdInput,
  type BreadcrumbItem,
  type WebSiteJsonLdInput,
} from './json-ld.js'

export {
  buildCanonicalUrl,
  buildCanonicalLinkTag,
  buildOpenGraphTags,
  buildTwitterCardTags,
  buildMetaTags,
  type MetaTagInput,
} from './meta-tags.js'
