/**
 * Reserved shop slugs — Phase 20 P0.
 *
 * A slug becomes the shop's default subdomain via `<slug>.gbox.co`
 * (populated by `create-store` post-2026-04-25). We therefore MUST
 * prevent a seller from minting a slug that collides with a platform
 * subdomain — otherwise `admin.gbox.co` or `checkout.gbox.co` would
 * suddenly resolve to a seller-owned shop row via the storefront's
 * `lookupShopByHost` third-fallback branch. That'd be a security +
 * brand-trust incident.
 *
 * Source-of-truth for "which hosts MUST NOT resolve to a tenant shop"
 * is the nginx config on server 1 (`/etc/nginx/sites-enabled/gbox`) +
 * the env-driven `ACCOUNTS_BASE_URL` / `STORE_ADMIN_BASE_URL` /
 * `GOD_ADMIN_BASE_URL` / `CHECKOUT_BASE_URL` / `CDN_BASE_URL` values.
 * We mirror those here as a hand-maintained list because:
 *
 *   1. The nginx config is on a separate box and we can't reliably
 *      parse it at create-store time.
 *   2. This list needs to be available client-side (slug picker
 *      preview / validation error surface), where process.env isn't.
 *   3. Adding a new platform subdomain is a deliberate ops action;
 *      adding a slug to this list is a 1-line PR.
 *
 * Iron Rule 5: the error message surfaced to sellers who try to use
 * a reserved slug says only "This name isn't available. Please choose
 * another." — never discloses WHICH platform slot it collides with.
 */

/**
 * The canonical reserved list. Everything here is lowercase, matches
 * the shape of slugs produced by `slugify()` (alnum + hyphens only,
 * no leading / trailing hyphens).
 *
 * Categories:
 *   - Platform subdomains we publicly run (accounts, admin, api, ...)
 *   - Common infra subdomains we may run in the future (www, mail,
 *     ftp, smtp, imap, webmail, ns, dns, mx)
 *   - Names that would confuse sellers (support, help, docs, blog,
 *     status, system, gbox, gbox-platform)
 *   - Internal tooling (god, god-admin, supporter)
 *
 * Any collision with a legitimate seller brand (e.g. "support") is a
 * tradeoff — sellers who want that name pick a modifier like
 * `my-support` or `example-support`.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Platform subdomains actively routed by nginx (2026-04-25 snapshot).
  'accounts',
  'admin',
  'api',
  'cdn',
  'checkout',
  'god',
  'god-admin',
  'supporter',
  'www',
  // Apex variants (only reachable via `gbox.co` itself but listed to
  // prevent slug-to-apex confusion).
  'root',
  // Common infra subdomains reserved for future use.
  'mail',
  'smtp',
  'imap',
  'webmail',
  'ftp',
  'sftp',
  'ns',
  'ns1',
  'ns2',
  'dns',
  'mx',
  'vpn',
  'proxy',
  // Staging / environment names.
  'staging',
  'dev',
  'test',
  'preview',
  'sandbox',
  'qa',
  // Platform brand + product names.
  'gbox',
  'gbox-platform',
  'gbox-co',
  'help',
  'support',
  'docs',
  'status',
  'system',
  'blog',
  'assets',
  'static',
  'img',
  'images',
  'media',
  'files',
  // Security / legal surfaces.
  'security',
  'privacy',
  'terms',
  'legal',
  'abuse',
  'postmaster',
  'hostmaster',
  'webmaster',
  // Auth / billing surfaces commonly scraped by competitors.
  'login',
  'logout',
  'signup',
  'signin',
  'register',
  'billing',
  'payments',
  'account',
  'settings',
])

/**
 * True iff `slug` is on the reserved list. Case-insensitive — callers
 * typically pass the output of `slugify()` which is already lower,
 * but defense in depth.
 */
export function isReservedSlug(slug: string): boolean {
  if (typeof slug !== 'string') return false
  return RESERVED_SLUGS.has(slug.toLowerCase())
}

/**
 * Iron-Rule-5-safe message for the seller. Avoid naming which
 * subdomain slot the reserved slug hits — that's information leakage.
 */
export const RESERVED_SLUG_MESSAGE =
  "This store name isn't available. Please choose another."
