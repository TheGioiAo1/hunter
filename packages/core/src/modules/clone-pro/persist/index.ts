/**
 * Clone Pro — Persistence barrel export
 *
 * All database persistence modules for the Clone Pro pipeline:
 * - Pages (about, contact, policies, custom)
 * - Blog posts
 * - Navigation menus (main + footer with hierarchy)
 * - Collections (with product linking)
 * - SEO metadata (shop_settings)
 */

export { persistClonePages } from './persist-pages.js'
export type { PersistPagesResult } from './persist-pages.js'

export { persistCloneBlogPosts } from './persist-blog.js'
export type { PersistBlogResult } from './persist-blog.js'

export { persistCloneMenus } from './persist-menus.js'
export type { PersistMenusResult } from './persist-menus.js'

export { persistCloneCollections } from './persist-collections.js'
export type { PersistCollectionsResult } from './persist-collections.js'

export { persistCloneSEO } from './persist-seo.js'
export type { CloneSEOData } from './persist-seo.js'
