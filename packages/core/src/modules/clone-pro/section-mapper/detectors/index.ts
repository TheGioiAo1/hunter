/**
 * Clone Pro v4 — Homepage section detectors barrel.
 *
 * Each detector returns either a `DetectedSection` or `null`. The
 * composer runs all four on the same cheerio root and assembles a
 * Shopify-style `templates/index.json` from the non-null results,
 * sorted by their source DOM position so the homepage layout order
 * is preserved.
 */

export { detectHero } from './hero.js'
export { detectFeaturedCollection } from './featured-collection.js'
export { detectImageWithText } from './image-with-text.js'
export { detectNewsletter } from './newsletter.js'
export type { DetectorContext, DetectorFn } from './shared.js'
