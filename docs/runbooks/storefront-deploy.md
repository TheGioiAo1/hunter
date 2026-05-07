# Gbox Storefront — Deploy Runbook

**Stage 5.7 — Draft (includes Phase 3B Cart & Checkout, Phase 3C Customer Accounts, Phase 3D SEO, Phase 3E Analytics, Phase 3F Theme Preview, Phase 3G AI Expert + Theme Cloner primitives, Phase 4 Marketing & Automation primitives, and Phase 5 Theme Builder + i18n primitives)**
**Target:** Test server 1 (`192.168.1.13`) running Ubuntu, nginx as the
reverse proxy, PM2 as the Node.js process manager.
**Audience:** You, six months from now, at 3 am.

---

## 1. Topology recap

```
[ visitor ] ── https://<shop-host> ──▶ [ server 1 · 192.168.1.13 ]
                                              │
                                              ▼
                                         nginx :443
                                              │
                                              ▼
                     ┌─────────────────────────────────────┐
                     │ route → upstream (see nginx_routing │
                     │         memory file for full map)   │
                     └─────────────────────────────────────┘
                                              │
                                              ▼
                                pm2 → storefront :4326
                                              │
                                              ▼
                           [ server 2 · gbox_platform Postgres ]
```

- The storefront process binds to **`127.0.0.1:4326`** — nginx is the
  only thing on the public network that can reach it.
- Platform API (4321), Admin (4322), Accounts (4323) and Storefront
  (4326) all live on Server 1 under PM2.
- Postgres lives on Server 2. Credentials are in
  `~/.claude/memory/server_credentials.md`. Use the `gbox_platform`
  database, **not** `gbox_test` (see `smoke_test_runbook`).

---

## 2. Pre-requisites

```bash
node --version   # v20.x or newer
pm2  --version   # v5.x
nginx -v         # 1.24.x+ (anything with http2 + brotli)
```

- Node 20 LTS is installed via NodeSource on Server 1 — do **not**
  use the distro package, it ships Node 12.
- PM2 is installed globally via `npm i -g pm2`. Startup script must
  already be wired to systemd (`pm2 startup systemd` then
  `pm2 save`) — don't reinstall, it re-prompts the startup step.
- nginx site files live under `/etc/nginx/sites-available/` with
  symlinks in `sites-enabled/`.

---

## 3. Environment variables

Write `/opt/gbox/storefront/.env` (mode 600, owned by `gbox:gbox`)
with the following keys. Values marked **REQUIRED** will blow up the
boot; the others have documented defaults.

```bash
# ── Network ──────────────────────────────────────────────
STOREFRONT_PORT=4326

# ── Database ─────────────────────────────────────────────
# REQUIRED — must be gbox_platform on Server 2, not gbox_test.
DATABASE_URL=postgres://gbox_app:<password>@192.168.1.14:5432/gbox_platform

# ── Logging ──────────────────────────────────────────────
LOG_LEVEL=info          # debug | info | warn | error
SERVICE_NAME=gbox-storefront

# ── Multi-tenancy ────────────────────────────────────────
# Dev-only slug override so `localhost:4326` resolves to a real shop
# without editing /etc/hosts. Leave UNSET in production.
# STOREFRONT_DEV_SHOP_SLUG=demo

# ── Cart / Checkout handoff (Phase 3B) ───────────────────
# REDIS_URL is read by the cart + checkout services. If this is
# unset / unreachable the cart falls back to a per-process Map,
# which means carts vanish on PM2 restart — fine for dev, NOT
# for production. Run `redis-cli -u $REDIS_URL ping` before a
# deploy.
REDIS_URL=redis://127.0.0.1:6379

# Base URL of the checkout subdomain that POST /checkout 303s
# to. The path template is `<CHECKOUT_PUBLIC_URL>/c/<id>?hop=<token>`.
# MUST be https in production — a plain-http redirect would leak
# the handoff token through the referer header on the first hop.
CHECKOUT_PUBLIC_URL=https://checkout.gbox.co

# HMAC secret used by the handoff token signer. 32+ bytes, random.
# If this changes, in-flight hand-off tokens issued before the
# swap will fail the signature check on the next hop → buyers
# land on a 5xx. Rotate in a quiet window or dual-sign.
CHECKOUT_HANDOFF_SECRET=change-me-to-32-plus-byte-random-hex

# ── Trust proxy ──────────────────────────────────────────
# The storefront trusts the single hop from nginx by default
# (`app.set('trust proxy', 1)` in app.ts). Do NOT add additional
# hops unless a second reverse proxy lands in front of nginx.
```

The `.env` is read by `dotenv/config` at the top of `server.ts`.
Secret rotation only requires a `pm2 restart gbox-storefront` —
no rebuild.

---

## 4. Build + install

Clone and build **on the server** (not via rsync — keeps the repo
history and `pnpm` lockfile consistent with the one tests ran
against locally):

```bash
sudo -iu gbox
cd /opt/gbox
git clone https://github.com/GBox-Company/gbox-platform.git
cd gbox-platform

# Install via pnpm (workspaces). If pnpm isn't on PATH:
#   corepack enable && corepack prepare pnpm@9 --activate
pnpm install --frozen-lockfile

# Compile the storefront (uses project references, so core + db
# are built transitively).
pnpm --filter @gbox/storefront build

# Verify the compiled output exists.
ls apps/storefront/dist/server.js
```

> **Known quirk (see `deployment_quirks.md`):** if the build errors
> with `Cannot find module @gbox/core/...`, re-run
> `pnpm -r build` from the repo root — workspace file: refs
> sometimes need a fresh round-trip after a clean checkout.

---

## 5. PM2 ecosystem entry

The storefront is one block inside the repo's
`ops/pm2/ecosystem.config.cjs`. If that file doesn't exist yet,
create it — one ecosystem file for the whole platform keeps
`pm2 save` outputs reproducible.

```js
// ops/pm2/ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'gbox-storefront',
      cwd: '/opt/gbox/gbox-platform/apps/storefront',
      script: 'dist/server.js',
      interpreter: 'node',
      exec_mode: 'fork',          // Express + pino; cluster adds no value here yet
      instances: 1,
      env: {
        NODE_ENV: 'production',
      },
      // Respect the .env file managed outside of version control.
      env_file: '/opt/gbox/storefront/.env',
      // Restart policy
      max_memory_restart: '512M',
      min_uptime: '10s',
      max_restarts: 5,
      restart_delay: 2000,
      // Log rotation via pm2-logrotate (install globally once).
      out_file: '/var/log/gbox/storefront-out.log',
      error_file: '/var/log/gbox/storefront-err.log',
      merge_logs: true,
      time: true,
    },
  ],
}
```

Bring it up:

```bash
pm2 start ops/pm2/ecosystem.config.cjs --only gbox-storefront
pm2 save        # persist across reboots
pm2 ls
pm2 logs gbox-storefront --lines 100
```

Rolling restart after a deploy:

```bash
pnpm --filter @gbox/storefront build
pm2 reload gbox-storefront   # zero-downtime in cluster mode; graceful SIGHUP in fork
```

---

## 6. nginx site block

The storefront is a catch-all for any host that isn't `accounts.`,
`admin.`, or `api.`. Keep it LAST in `sites-enabled/` so the more
specific server blocks win on host match.

```nginx
# /etc/nginx/sites-available/gbox-storefront
server {
    listen      443 ssl http2;
    listen      [::]:443 ssl http2;

    # Wildcard — SNI routing. Add specific storefront hosts here or
    # rely on default_server once HTTPS certs cover the full set.
    server_name ~^(?<shop>[^.]+)\.gbox\.test$
                ~^(?<shop>[^.]+)\.gbox\.co$;

    # TLS (share cert with the rest of the platform to reduce surface)
    ssl_certificate     /etc/letsencrypt/live/gbox.co/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gbox.co/privkey.pem;
    include             /etc/nginx/snippets/ssl-params.conf;

    # Access + error logs with the storefront-specific format.
    access_log /var/log/nginx/storefront.access.log combined_with_reqid;
    error_log  /var/log/nginx/storefront.error.log  warn;

    # Body size limit — uploads go through the API, not the
    # storefront, so this can stay small.
    client_max_body_size 2m;

    # Forward everything to the PM2-managed Node process.
    location / {
        proxy_pass              http://127.0.0.1:4326;
        proxy_http_version      1.1;

        # Headers the storefront middleware reads.
        proxy_set_header        Host                $host;
        proxy_set_header        X-Forwarded-Host    $host;
        proxy_set_header        X-Forwarded-Proto   $scheme;
        proxy_set_header        X-Forwarded-For     $proxy_add_x_forwarded_for;
        proxy_set_header        X-Real-IP           $remote_addr;
        proxy_set_header        X-Request-ID        $request_id;

        # Buffering off for streaming pages (SSE / server-sent events
        # aren't used today but they're free to enable here).
        proxy_buffering         off;
        proxy_read_timeout      30s;
        proxy_connect_timeout   5s;

        # WebSocket / HTTP/1.1 upgrade (future-proof).
        proxy_set_header        Upgrade $http_upgrade;
        proxy_set_header        Connection "upgrade";
    }

    # Short-circuit health probes — bypass the Node hop so a Node
    # crash doesn't flip the LB.
    location = /nginx_health {
        access_log off;
        return 200 "ok\n";
        add_header Content-Type text/plain;
    }
}
```

After editing:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

> The storefront's own `/_health` endpoint is mounted **above**
> resolve-shop, so PM2/LB health probes should hit
> `http://127.0.0.1:4326/_health` directly rather than routing
> through nginx for host resolution.

---

## 7. Smoke tests

```bash
# 1. Health check (direct — proves PM2 is alive)
curl -sS http://127.0.0.1:4326/_health

# 2. Host resolution (proves resolve-shop + domain table work)
curl -sS -H 'X-Forwarded-Host: demo.gbox.test' \
         http://127.0.0.1:4326/ | head

# 3. Asset cache headers (proves asset middleware + immutable cache)
curl -sI -H 'X-Forwarded-Host: demo.gbox.test' \
         http://127.0.0.1:4326/assets/theme.css | grep -iE 'cache-control|etag'

# 4. Public HTTPS round trip (nginx → storefront → back)
curl -sI https://demo.gbox.test/_health

# 5. Cart add → GET round trip (proves Redis + routes)
curl -sS -c /tmp/cart.jar -b /tmp/cart.jar \
     -H 'X-Forwarded-Host: demo.gbox.test' \
     -H 'Content-Type: application/json' \
     -d '{"id":"<real variant id>","quantity":1}' \
     http://127.0.0.1:4326/cart/add.js | head

curl -sS -c /tmp/cart.jar -b /tmp/cart.jar \
     -H 'X-Forwarded-Host: demo.gbox.test' \
     http://127.0.0.1:4326/cart.js

# 6. Checkout hand-off (expect 303 Location: checkout.gbox.co/c/...)
curl -sSI -c /tmp/cart.jar -b /tmp/cart.jar \
     -X POST \
     -H 'X-Forwarded-Host: demo.gbox.test' \
     http://127.0.0.1:4326/checkout | grep -iE 'HTTP|location'
```

If the smoke fails, see the smoke_test_runbook memory file — the
common gotcha is the local box can't reach the PG cluster on
Server 2, so you must run integration smokes from Server 2, not
from your laptop.

---

## 8. Log locations

| What                          | Path                                     |
| ----------------------------- | ---------------------------------------- |
| storefront stdout (pino JSON) | `/var/log/gbox/storefront-out.log`       |
| storefront stderr             | `/var/log/gbox/storefront-err.log`       |
| nginx access                  | `/var/log/nginx/storefront.access.log`   |
| nginx error                   | `/var/log/nginx/storefront.error.log`    |
| PM2 metadata                  | `~gbox/.pm2/logs/`                       |

Tail both Node + nginx side-by-side during a deploy:

```bash
sudo tail -f /var/log/gbox/storefront-out.log /var/log/nginx/storefront.access.log
```

---

## 9. Rollback

```bash
cd /opt/gbox/gbox-platform
git fetch --all
git log --oneline -10     # pick the last known-good commit
git checkout <sha>
pnpm install --frozen-lockfile
pnpm --filter @gbox/storefront build
pm2 reload gbox-storefront
```

If a rollback target predates Stage 3A (before the storefront app
even existed), stop the process with `pm2 stop gbox-storefront`
and disable the nginx site block so requests 503 instead of
500'ing against an ancient build.

---

## 10. Observability checklist

- [ ] `/_health` returns 200 from both `127.0.0.1:4326` and through nginx.
- [ ] Known shop host → 200 HTML, unknown host → 404.
- [ ] `/assets/theme.css` → 200 with `cache-control: ... immutable`.
- [ ] Second request with `If-None-Match: <etag>` → 304.
- [ ] `X-Request-ID` header round-trips from nginx → Node → log line.
- [ ] `pm2 ls` shows `online`, 0 restarts in the last 10 minutes.
- [ ] Free memory > 200 MB, storefront RSS < 400 MB.
- [ ] Postgres connection pool not saturated (`SELECT count(*) FROM
      pg_stat_activity WHERE application_name LIKE 'gbox-storefront%'`).

When any of these flips red, grep for the failing `req_id` across
the three log streams above — the request-context middleware
stamps the same id on the nginx log line and every downstream
storefront log line, so you can reconstruct the full path of a
single bad request in seconds.

---

## 11. Cart + Checkout (Phase 3B)

The storefront now exposes the Shopify-compatible cart Ajax API
and a single checkout hand-off endpoint. None of these touch
Postgres on the happy path — the cart lives in Redis and the
checkout session is Redis-cached + durably committed to Postgres
only on `completeCheckout` (which runs inside the checkout
subdomain, not the storefront).

### Endpoints

| Method | Path               | Behaviour                                                       |
| ------ | ------------------ | --------------------------------------------------------------- |
| GET    | `/cart.js`         | Return current cart, mint on cookie miss                        |
| POST   | `/cart/add.js`     | Add one line (`{id, quantity}`) or bulk `{items: [...]}`        |
| POST   | `/cart/change.js`  | Set quantity of a line (`quantity: 0` removes)                  |
| POST   | `/cart/update.js`  | Bulk `{updates: {...}}`, `{note}`, `{attributes}`               |
| POST   | `/cart/clear.js`   | Empty lines, keep token                                         |
| POST   | `/checkout`        | Create `CheckoutSession`, sign handoff token, 303 to subdomain  |

All cart endpoints return a Shopify-shaped JSON body with
`token`, `item_count`, `items[]`, `note`, `attributes`. They
refresh the `cart=<token>` cookie on every mutating request with
a 30-day sliding window (`Max-Age=2592000; Path=/; SameSite=Lax;
Secure` in production).

`POST /checkout` switches response shape on the `Accept` header:

- **`text/html`** (default, used by `<form action="/checkout">`):
  303 redirect with `Location: $CHECKOUT_PUBLIC_URL/c/<id>?hop=<token>`.
- **`application/json`**: 200 with
  `{checkout_id, checkout_url, handoff_token}` — merchant JS
  decides whether to `window.location.assign()` or pop a modal.

### Cart TTL + eviction

- **Redis key:** `cart:<token>`
- **TTL:** 30 days on every write (matches Shopify behaviour).
- **Eviction on success:** `POST /checkout` calls
  `service.destroyCart(token)` **after** the handoff token has
  been issued. If either step fails, the cart is left intact so
  the visitor can retry without losing items.
- **Fallback:** when Redis is unreachable the service falls back
  to a per-process `Map`. This is fine for dev but DOES NOT
  survive `pm2 reload`, so production deploys MUST have
  `redis-cli -u $REDIS_URL ping` returning `PONG`.

### Checkout hand-off flow

```
[ visitor clicks Checkout ]
          │
          ▼
POST https://demo.gbox.test/checkout      (storefront, port 4326)
          │  cart cookie → service.getCart
          │  service.lines → CheckoutService.createCheckout
          │  issueHandoffToken → HMAC + Redis nonce
          ▼
303 Location: https://checkout.gbox.co/c/<id>?hop=<token>
          │
          ▼
GET  https://checkout.gbox.co/c/<id>?hop=<token>
          │  consumeHandoffToken → verify sig + DEL nonce
          │  mint .gbox.co domain-scoped session cookie
          ▼
302 Location: https://checkout.gbox.co/c/<id>
          │
          ▼
[ checkout app renders, buyer pays ]
```

The handoff token carries `{checkoutId, shopId, customerId,
iat, exp, nonce}` and is HMAC-SHA256 signed with
`CHECKOUT_HANDOFF_SECRET`. TTL is 5 minutes. The nonce is stored
once in Redis under `handoff:nonce:<nonce>` and deleted atomically
on redeem — a replay returns `already_redeemed`.

### Debugging cart issues in production

```bash
# Inspect a visitor's cart (get the token out of their cookie jar)
redis-cli -u "$REDIS_URL" GET cart:ct_...

# See all active carts for a shop (O(N) scan — don't run in loops)
redis-cli -u "$REDIS_URL" --scan --pattern 'cart:*' | head -20

# Force-evict a wedged cart (legit use: customer emails support)
redis-cli -u "$REDIS_URL" DEL cart:ct_...
```

If the cart endpoint returns JSON but the storefront's cart
drawer shows 0 items, the issue is usually in
`hydrateCart`: the cart has variant IDs Postgres no longer
knows about. Check with:

```sql
SELECT id, title FROM product_variants WHERE id IN ('var_...', '...');
```

Missing rows are silently dropped by `hydrateCart` (by design —
we never want a stale cart to 500 the storefront).

---

## 12. Customer accounts (Phase 3C)

The storefront now understands buyer login sessions. A signed-in
visitor sees account-aware Liquid drops (`customer.*`), has their
customer_id forwarded into the checkout hand-off token, and can
use the `/account/*` routes for login / logout.

### Cookie

- **Name:** `gbox_customer_session` (imported from
  `@gbox/core/modules/customer-auth`).
- **Format:** 64-char hex plaintext token. The server stores a
  SHA-256 hash of the token in `customer_sessions.token_hash` —
  the plaintext is never persisted, only ever lives in the
  browser + the Set-Cookie on the wire.
- **TTL:** 30 days, fixed window. Re-login extends by creating a
  new row, it does NOT bump the existing row's `expires_at`.
- **Flags:** `HttpOnly; SameSite=Lax; Path=/`. `Secure` is set
  when `NODE_ENV === 'production'` (override via the
  `accountRoutes.secureCookie` option in tests).
- **Domain:** unscoped by default — the cookie sticks to the shop
  host that minted it. Set `accountRoutes.cookieDomain` if you
  want a single login to span multiple subdomains.

### Endpoints

| Method | Path                        | Behaviour                                                           |
| ------ | --------------------------- | ------------------------------------------------------------------- |
| POST   | `/account/login`            | Issue magic link + OTP. **Always 200** regardless of email validity |
| GET    | `/account/login/verify`     | Click-through from the email, sets cookie, 303 → `/account`         |
| POST   | `/account/otp`              | Paste-the-code fallback, sets cookie, returns JSON                  |
| POST   | `/account/logout`           | Revoke session + clear cookie                                       |

All four live in `apps/storefront/src/middleware/account-routes.ts`
and are dep-injected with the core `issueLoginCode` /
`verifyMagicLink` / `verifyOtpCode` / `revokeSession` functions.

### Account enumeration protection

`POST /account/login` NEVER reveals whether an email exists, is
malformed, or is rate-limited. The response is always:

```
HTTP/1.1 200 OK
Content-Type: application/json
{"ok":true}
```

The underlying error is logged server-side at `info` level so
operators can still spot abuse patterns without leaking the
information to callers. **Do not "fix" this by surfacing the
error to the client.** See `middleware/account-routes.ts` for
the rationale comment.

### Customer session middleware

`customer-session.ts` runs in the Express pipeline BEFORE cart
and checkout routes. It reads the `gbox_customer_session` cookie,
looks it up via `customer-auth.getSessionByToken`, enforces
shop-scoping (`session.shop_id` must match `req.gboxShopId`), and
attaches:

- `req.gboxCustomerId` — always set on a valid session, even if
  the customer row was soft-deleted. Used by audit logs and the
  checkout hand-off attribution.
- `req.gboxCustomer` — the light customer profile (`id`, `email`,
  `first_name`, `last_name`, `orders_count`, `total_spent`,
  `addresses[]`). Null when the customer row has been removed,
  which renders as "anonymous" in Liquid templates.

The middleware NEVER fails a request. A dead DB or a throw from
the lookup turns the visitor anonymous and continues. The
storefront must never 500 because the customer table hiccuped.

### Checkout hand-off integration

The checkout route (Phase 3B.4) now reads `req.gboxCustomerId` and
forwards it into `issueHandoffToken`. The checkout subdomain can
therefore pre-fill the buyer's email and attribute the resulting
order without making the customer re-enter credentials.

- Signed-in → `customerId: "cus_..."` in the handoff token
  payload.
- Anonymous → `customerId: null` (old behaviour, still supported).

### Email delivery (dev vs prod)

`POST /account/login` returns the plaintext magic link and OTP to
the optional `onMagicLinkIssued` hook. In production the server
entrypoint should bind this hook to the BullMQ mailer; in dev /
test the hook just logs the token so developers can click it.
**If you forget to wire the hook in production, login is broken
silently.** Health check idea for a future stage: fail the
`/_health` endpoint when the hook is missing on a prod build.

### Debugging account issues

```bash
# Find every active session for a customer (cleartext token
# NEVER lives in the db, only the hash, so you can't reverse it —
# the only thing to check is "did they log in at all?").
psql -c "SELECT id, expires_at, last_used_at, ip_address
         FROM customer_sessions
         WHERE customer_id = '<cus_...>' ORDER BY last_used_at DESC;"

# Force-logout a specific customer everywhere
psql -c "DELETE FROM customer_sessions WHERE customer_id = '<cus_...>';"

# Check issued-but-unclaimed magic links
psql -c "SELECT email, kind, expires_at, consumed_at, attempts
         FROM customer_otp_codes
         WHERE shop_id = '<shop_...>'
         AND consumed_at IS NULL
         AND expires_at > NOW();"
```

If a buyer complains "login link doesn't work":

1. Check `customer_otp_codes` — is there an unconsumed
   `kind='magic_link'` row for their email?
2. If not, the mailer dropped it — check the BullMQ dead-letter
   queue.
3. If yes, verify they're clicking within 15 minutes
   (`MAGIC_LINK_TTL_MINUTES`) and on the same host the link was
   issued for (the verify endpoint reads the resolved shop from
   the URL, not from the token).

---

## 13. SEO (Phase 3D)

The storefront exposes two crawler-facing endpoints and a set of
pure helpers the theme engine uses to emit structured data +
meta tags. All of it is shop-scoped: the resolve-shop middleware
has already 404ed unknown hosts by the time either endpoint
runs, so there's no risk of a cross-shop sitemap leak.

### Endpoints

| Method | Path           | Cache-Control        | Notes                                         |
| ------ | -------------- | -------------------- | --------------------------------------------- |
| GET    | `/robots.txt`  | `public, max-age=300`  | Shopify-compatible disallow list + `Sitemap:` |
| GET    | `/sitemap.xml` | `public, max-age=600`  | Flat `<urlset>` of every indexable URL        |

- **Private / password-protected stores.** When
  `getShopCrawlPolicy(shopId)` returns `{crawlable:false}` or
  `{passwordProtected:true}`, `robots.txt` emits a wholesale
  `Disallow: /` with NO `Sitemap:` line, and `/sitemap.xml`
  returns a 404. This matches Shopify — a locked store advertising
  its full URL list defeats the password wall.

- **Data sources.** The routes do NOT read from the
  `StorefrontDataSource` (which is page-request shaped). Instead
  the storefront entrypoint injects narrow source functions —
  `listProductsForSeo`, `listCollectionsForSeo`, `listPagesForSeo`,
  `listBlogsForSeo`, `getShopCrawlPolicy` — each bound to a
  shop-scoped query in `@gbox/core/modules/{products,collections,
  content}`. A later stage will split into `/sitemap_products-1.xml`
  children when `maxUrlsPerFile` (default 50 000) is exceeded.

- **Sitemap contents.** Flat, one-file. Includes the shop root,
  every active product, every published collection, every page,
  every blog, and every blog article. `lastmod` is rendered as
  `YYYY-MM-DD` so timezone skew never shifts the date.

- **XML hardening.** Handles with `& < > " '` are escaped via a
  dedicated `escapeXml` helper. Covered by the "escapes special
  characters in handles" test in `seo-routes.test.ts`.

### nginx considerations

nginx should proxy `/robots.txt` and `/sitemap.xml` to the
storefront upstream unchanged — do NOT short-circuit either path
with a static `root` directive, because the response depends on
the resolved shop. The upstream already sets `Cache-Control`, so
a plain `proxy_pass` is sufficient:

```nginx
location = /robots.txt   { proxy_pass http://storefront; }
location = /sitemap.xml  { proxy_pass http://storefront; }
```

### Structured data + meta helpers

`@gbox/core/modules/seo` ships pure functions that templates can
call to produce schema.org JSON-LD and head-tag strings. These
are consumed by the theme's `<head>` include and never touch the
network:

- `buildProductJsonLd({name, handle, description, sku, brand,
  price, currency, available, imageUrls, baseUrl, shopName})` —
  emits a schema.org `Product` with nested `Offer` and optional
  `Brand`. HTML is stripped from the description and `</script>`
  sequences are escaped so the JSON can sit directly inside a
  `<script type="application/ld+json">` block.
- `buildOrganizationJsonLd({name, baseUrl, logoUrl, description,
  sameAs})` — for the site-wide Organization card. `sameAs`
  takes the shop's social profile URLs.
- `buildBreadcrumbListJsonLd({baseUrl, items})` — drops a
  `BreadcrumbList` with 1-indexed positions.
- `buildWebSiteJsonLd({name, baseUrl})` — includes a `SearchAction`
  pointing at `/search?q={search_term_string}` so Google can wire
  up sitelinks search.
- `buildCanonicalUrl(baseUrl, path)` — strips the Gbox-internal
  `preview_theme_id` and `design_mode` query params so the
  canonical form never leaks the theme editor state.
- `buildMetaTags({title, description, canonical, imageUrl,
  siteName, type, locale, twitterHandle, index})` — returns a
  newline-delimited bundle of `<meta>` + `<link rel="canonical">`
  tags covering OpenGraph, Twitter Cards, and optional `robots:
  noindex, nofollow` when `index === false`.

### Verifying a new deploy

```bash
# robots.txt — public store
curl -sSI https://demo.gbox.test/robots.txt | grep -i cache
curl -sS  https://demo.gbox.test/robots.txt | grep -E '^(User-agent|Disallow|Sitemap)'

# sitemap.xml — count URLs
curl -sS https://demo.gbox.test/sitemap.xml | grep -c '<loc>'

# robots.txt — private store MUST have no Sitemap: directive
curl -sS https://private.gbox.test/robots.txt
# Expected:
#   # Gbox Storefront — crawl disabled (shop is private)
#   User-agent: *
#   Disallow: /
```

---

## 14. Analytics & tracking (Phase 3E)

The storefront writes four event types into the `events` table
so the admin dashboard's conversion funnel (read via
`@gbox/core/modules/analytics.getConversionFunnel`) has
something to aggregate. All writes are fire-and-forget: a
broken database or recorder MUST NEVER 500 the buyer.

### Event types + subject encoding

| Verb             | subject_type | subject_id        | Body fields                                             |
| ---------------- | ------------ | ----------------- | ------------------------------------------------------- |
| `page_view`      | `page`       | request path      | `session_id`, `user_agent`, optional `referrer`         |
| `add_to_cart`    | `variant`    | variant id        | `product_id`, `quantity`, `price`, `currency`           |
| `checkout_start` | `checkout`   | checkout id       | `total`, `currency`, `item_count`                       |
| `purchase`       | `order`      | order id          | `total`, `currency`, `item_count`                       |

All rows also carry `customer_id` in the JSON body when the
visitor is signed in, and `session_id` is either the cart
cookie token (stable across anonymous sessions that touch the
cart) or the request id (for first-touch anonymous views).
User agent strings are capped at 512 bytes before insertion —
adversarial clients sometimes send multi-kilobyte UAs to blow
up downstream log pipelines.

### Write paths

1. **Automatic `page_view`** — the `buildTrackingMiddleware`
   middleware attaches a `res.on('finish')` listener on every
   request. After the response flushes, if the request was a
   GET returning 2xx AND the path is not on the skip list
   (`/_health`, `/assets/*`, `/cart.js`, `/cart/*`, `/checkout`,
   `/account*`, `/events`, `/robots.txt`, `/sitemap.xml`), the
   middleware calls `recordPageView(shopId, {...})`.

2. **`add_to_cart`** — the cart router's `onLineAdded` hook
   fires once per line after `POST /cart/add.js` succeeds. The
   entrypoint binds it to `recordAddToCart(db, shopId, {...})`.

3. **`checkout_start`** — the checkout router's `onCheckoutStart`
   hook fires after the checkout session is created and the
   handoff token is signed, but BEFORE the cart is destroyed.
   This is the last moment the cart token is still valid as a
   session id.

4. **`purchase`** — fires on the checkout subdomain after
   payment capture (Phase 3E next stage — out of scope here).
   The recorder is the same; the call site lives in the
   checkout app.

5. **Client-side beacon** — `POST /events` accepts JSON of the
   form `{type, ...}` where `type` is one of the four verbs.
   Theme JS uses this for events the server can't observe on
   its own (carousel clicks, video plays, time-on-page pings).
   Validation errors return 400; successful inserts return 204.
   Unknown verbs are rejected before the recorder is called.

### nginx + infra notes

- **Skip the body-parser limit.** The beacon route caps JSON
  bodies at 4 KiB via `express.json({limit:'4kb'})`. Larger
  payloads get a 400. nginx should pass `Content-Length`
  through unchanged; no special location block is needed.
- **`X-Forwarded-For` is already honoured** by the `trust proxy`
  setting at the top of `buildApp()`, so `req.ip` resolves to
  the visitor IP when events are captured. The current
  recorders do not persist IP — revisit if we ever need it for
  fraud detection.
- **Bursty traffic.** The `events` table is unindexed on
  `verb` + `created_at` today. If beacon volume grows past
  ~100 rows/sec, add a composite index on
  `(shop_id, created_at DESC, verb)` before the analytics
  aggregates start to slow down.

### Verifying a new deploy

```bash
# 1. Fetch the homepage — should write exactly one page_view
curl -sS https://demo.gbox.test/ -o /dev/null
psql -c "select verb, subject_type, subject_id from events
         where shop_id='shop_demo' order by created_at desc limit 5;"

# 2. Add-to-cart — should write one add_to_cart
curl -sS -X POST https://demo.gbox.test/cart/add.js \
  -H 'content-type: application/json' \
  -d '{"id":"var_1","quantity":1}'

# 3. Beacon event — should 204 + write one page_view
curl -sS -X POST https://demo.gbox.test/events \
  -H 'content-type: application/json' \
  -d '{"type":"page_view","path":"/collections/hats"}'

# 4. Funnel snapshot (same query the admin dashboard runs)
psql -c "select verb, count(*) from events
         where shop_id='shop_demo'
           and created_at > now() - interval '1 hour'
         group by verb;"
```

If the funnel query comes back empty after a known add-to-cart,
first check that the hook is wired in the entrypoint — the
hooks are optional and silently skipped when unset.

---

## 15. Theme preview (Phase 3F)

The theme preview pipeline lets a merchant open a DRAFT
(`unpublished`) theme on the live storefront without publishing it.
It is the flat equivalent of Shopify's "Preview" button in the
theme library — the same storefront host, the same shop data, a
different theme bundle for one request.

### How a preview URL looks

```
https://brand.gbox.co/?preview_theme_id=<themeId>&preview_token=<hmac>
```

The admin dashboard mints the token via
`signPreviewToken(secret, {shopId, themeId, adminId})` from
`@gbox/core/modules/themes/preview-token.js`. The storefront
verifies it in the `theme-preview` middleware
(`apps/storefront/src/middleware/theme-preview.ts`), which sits
AFTER `resolve-shop` and BEFORE `storefront.handler`.

### Verification rules (all four must pass)

1. `secret` matches — the storefront and the admin must share the
   same HMAC key (`THEME_PREVIEW_SECRET`).
2. The token has not expired (`PREVIEW_TOKEN_TTL_MINUTES = 60`).
3. `payload.shopId === req.gboxShopId` — a token minted for one
   shop must never flip the theme on another.
4. `payload.themeId === ?preview_theme_id` — the query param and
   the sealed payload must agree. Stops an admin from reusing a
   token for a different theme by rewriting the URL.

Any failure is logged at `warn` level and silently ignored — the
published theme renders as if the preview params were absent.
Broken preview links MUST NOT 500.

### What happens on a verified preview

- `req.gboxPreviewThemeId` is stamped so the storefront handler's
  `getHandlerOptions(req)` can swap in the unpublished theme's
  engine bundle.
- `X-Robots-Tag: noindex, nofollow` is set on the response so
  Google / Bing never cache draft pages.
- The canonical URL helper already strips `preview_theme_id` +
  `preview_token` from `<link rel="canonical">` (see §13), so the
  preview render still announces its "real" URL.
- `robots.txt` disallows `*?preview_theme_id=*` anyway (belt-and-
  braces; see §13).

### Environment variable

```bash
# ── Theme preview (Phase 3F) ─────────────────────────────
# HMAC secret that MUST match the admin-dashboard signer. 32+
# bytes of randomness. Leaving it unset (or empty) disables
# preview entirely — the middleware installs a no-op handler
# and preview URLs fall through to the published theme.
# Rotating this value invalidates every in-flight preview link;
# do it during a quiet window.
THEME_PREVIEW_SECRET=$(openssl rand -hex 32)
```

Wire it into `buildApp({ themePreview: { secret: process.env.THEME_PREVIEW_SECRET ?? '' } })`
in `apps/storefront/src/server.ts` (entrypoint).

### Verifying a new deploy

```bash
# 1. Mint a token from a node REPL on the admin box.
node -e '
  const { signPreviewToken } = require("@gbox/core/modules/themes/preview-token.js");
  console.log(signPreviewToken(process.env.THEME_PREVIEW_SECRET, {
    shopId: "shop_demo",
    themeId: "theme_draft_1",
    adminId: "admin_alice",
  }));
'

# 2. Hit the storefront with the token and confirm X-Robots-Tag
#    is present. A 200 WITHOUT the header means the token was
#    rejected and the published theme rendered instead.
curl -sI \
  "https://demo.gbox.co/?preview_theme_id=theme_draft_1&preview_token=<paste>" \
  | grep -i x-robots-tag
# → x-robots-tag: noindex, nofollow
```

If the header is missing, grep the storefront logs for
`theme-preview:` to see the specific rejection reason
(`signature`, `expired`, `future`, shop mismatch, or theme
mismatch).

### Why middleware instead of a dedicated route

A preview URL needs to hit EVERY template the published theme
renders — product, collection, cart, account, 404 — not just a
single preview page. Installing the preview flag as a request-
level property means the entire handler pipeline keeps working
unchanged; `getHandlerOptions` is the only code that needs to
know preview exists.

---

## 16. AI Expert + Theme Cloner (Phase 3G)

Phase 3G lays down the DETERMINISTIC floor of the AI Expert
System (masterplan §7 Module F) and the Theme Cloner (§8 Module
G). The live Claude API call and the web crawler are entrypoint
glue — they belong in the admin API and are wired in a later
stage. Everything shipped in 3G runs offline, in unit tests, and
on Cloudflare Workers.

### Modules

| Module | Path | What it gives you |
| --- | --- | --- |
| AI prompt builders | `@gbox/core/modules/ai/prompts.js` | `buildProductDescriptionPrompt`, `buildSeoMetaPrompt`, `buildThemeClonePrompt`, `buildAnalyticsInsightPrompt` — each returns an Anthropic Messages request payload with pinned `model`, `system`, `max_tokens`, and `temperature`. |
| Theme cloner extractors | `@gbox/core/modules/themes/cloner.js` | `extractColorPalette`, `extractFontConfig`, `extractSectionHints`, `buildCloneReport` — pure HTML/CSS analysis returning a typed `CloneReport`. |

### AI model pin

```ts
import { AI_MODEL } from '@gbox/core/modules/ai/prompts.js'
// → 'claude-sonnet-4-20250514'
```

Every builder hard-codes the model documented in the masterplan.
The HTTP layer MUST NOT silently swap the model — doing so would
drift every test. Rotate by editing `AI_MODEL` and updating the
tests in the same PR.

### Prompt-injection posture

Merchant input is ALWAYS wrapped in XML-style tags inside the
user turn (`<product_title>…</product_title>`) — never
concatenated into the system prompt. The system prompt is the
only place we set behavioural rules, and it never echoes
merchant-supplied text. Inputs longer than
`MAX_MERCHANT_INPUT_CHARS` (24_000) are truncated with a
`…[truncated]` marker so the model knows the content was clipped.

### Theme cloner extractor contract

The extractors are defensive on purpose:

- Empty / garbage CSS returns the default palette + fonts
  (`DEFAULT_FONT_CONFIG`) instead of throwing.
- Hex shorthand (`#f60`) is normalised to `#ff6600`.
- `rgb()` and `rgba()` are normalised to canonical lowercase
  `#rrggbb`.
- `<script>` and `<style>` content is stripped before scanning
  for section landmarks so a fake `<section class="hero">` in a
  JS string can't spoof a hint.
- `buildCloneReport` is deterministic: same input → identical
  output byte-for-byte (there is a pin test for this).

### Wiring into the admin API (future stage)

When the live call lands, the admin API will look like:

```ts
import { buildThemeClonePrompt } from '@gbox/core/modules/ai/prompts.js'
import { buildCloneReport } from '@gbox/core/modules/themes/cloner.js'

// 1. fetch the source URL (headless browser / HTTP)
// 2. run the deterministic extractors
const report = buildCloneReport(html, css)

// 3. send the prompt to Claude for the fuzzy parts
const req = buildThemeClonePrompt({
  sourceUrl,
  htmlSnippet: html.slice(0, 8_000),
  cssSnippet: css.slice(0, 8_000),
})
const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.ANTHROPIC_API_KEY!,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
  body: JSON.stringify(req),
})
```

`report` gives you the deterministic palette / fonts / sections
for free; Claude is only consulted for judgement calls the
extractors can't make (layout mapping, subjective naming).

### Environment variable (future)

```bash
# ── AI Expert (Phase 3G → live call in a later stage) ────
# Anthropic API key. Only read by the admin-api entrypoint;
# the prompt builders in `@gbox/core/modules/ai` NEVER touch
# this value and are safe to call from any surface.
ANTHROPIC_API_KEY=sk-ant-...
```

### Verifying a new deploy

The 3G modules have no runtime surface yet — they are only
imported by tests and by future code. To confirm the bundle
shipped intact, check that `ai/prompts.js` and `themes/cloner.js`
exist under `packages/core/dist`:

```bash
ls packages/core/dist/modules/ai/prompts.js
ls packages/core/dist/modules/themes/cloner.js
```

Smoke test (requires no network):

```bash
node -e '
  const { buildProductDescriptionPrompt, AI_MODEL } =
    require("./packages/core/dist/modules/ai/prompts.js");
  const req = buildProductDescriptionPrompt({
    productTitle: "Test",
    category: "Misc",
    keywords: [],
    tone: "neutral",
    locale: "en",
  });
  if (req.model !== AI_MODEL) throw new Error("model drift");
  console.log("ok", req.model);
'
```

---

## 17. Marketing & Automation (Phase 4)

Phase 4 lands the deterministic floor of every marketing surface
the masterplan §11 calls for. Four **pure** modules live under
`packages/core/src/modules/marketing/` plus a **single**
request-surface route in the storefront:

| File                                         | Role                                                              |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `marketing/segments.ts`                      | Rule-based customer classifier → `prospect/new/returning/vip/at_risk/inactive` |
| `marketing/discounts.ts`                     | `generateDiscountCode`, `validateDiscount`, `applyDiscount` (cents-only math) |
| `marketing/email-flows.ts`                   | Flow definitions (welcome, abandoned cart, post-purchase, win-back, VIP early access) + `nextStepDue` + `renderEmailStep` |
| `marketing/popups.ts`                        | `evaluatePopup(rule, snapshot)` — exit-intent / time / scroll / page-view triggers with path + audience gating |
| `apps/storefront/.../marketing-routes.ts`    | `POST /marketing/subscribe` — normalises + validates and hands off to caller-provided `subscribe` dep |

Every core helper is pure, deterministic, and dependency-free.
No DB, no SMTP, no network — the caller wires those in from the
admin-api or the storefront server entrypoint. That means the
admin UI can preview a discount code, or a welcome email, or a
popup decision, without mutating any state.

### Segmentation precedence

`segmentCustomer` applies rules in this order (top wins):

1. `prospect` — no orders at all
2. `vip` — `totalSpent >= VIP_SPEND_THRESHOLD (500)` OR `ordersCount >= VIP_ORDER_THRESHOLD (4)`
3. `inactive` — last order ≥ `INACTIVE_DAYS_NO_ORDER (180)` days
4. `at_risk` — last order ≥ `AT_RISK_DAYS_NO_ORDER (60)` days
5. `new` — first order < `NEW_DAYS_SINCE_FIRST_ORDER (30)` days AND `ordersCount < 2`
6. `returning` — anyone else

**VIP is sticky** — a big spender who has been quiet for 70 days
is still VIP, not at_risk. The masterplan §7.2 #10 pins this
behaviour.

### Discount math posture

All money is stored as **integer cents** inside the engine —
`applyDiscount` never touches floats until the last round. This
matters because `3.33 * 10 / 100` silently becomes
`0.33299999999999996` in JavaScript, which is how you eat a
customer's money. `roundCents` funnels every conversion through
`Math.round` so there is a single place to audit.

`generateDiscountCode` is **deterministic** — same seed + opts
produce the same code. This lets the admin UI render a "preview"
code without writing it to the DB yet. The alphabet excludes
`0/O/1/I` so merchants reading a code over the phone don't get
bitten.

### Email flow scheduling

Delays are measured from the **enrolment timestamp**, NOT from
the previous step's send time. `nextStepDue` takes
`{ flow, enrolledAt, lastSentStepId, now }` and returns the next
step whose `delayMinutes` has elapsed. When the last step has
already been sent it returns `null`, which is how the worker
knows to close the enrolment row.

`renderEmailStep` HTML-escapes every interpolated value so a
hostile `customer_name` can never smuggle a `<script>` tag into
a sent email. The template text itself is trusted.

### Popup decision contract

`evaluatePopup(rule, snapshot)` is the only entry point. It
returns a discriminated union so the caller (either the admin UI
preview or the storefront JS) gets a machine-readable reason when
the popup is suppressed: `inactive | already_shown_session |
cooldown | path_excluded | path_not_included | audience_mismatch |
trigger_not_met`.

### Storefront subscribe endpoint

```
POST /marketing/subscribe
Content-Type: application/json

{ "email": "a@b.co", "name": "Alice", "source": "exit_intent_popup" }
```

- Shop-scoped — 404 if `req.gboxShopId` isn't stamped.
- Normalises email (trim + lowercase) and validates against a
  strict regex.
- Caps payload at 2 KiB, field length at 200 chars.
- 204 on success, **200 + `{ status: "already_subscribed" }`** on
  dupe (so popup JS can show a friendly message), **429/403** on
  rate limit / block, **500 `{error:"internal error"}`** on
  unexpected failure (never leaks stack details).

### Wiring into `buildApp`

```ts
buildApp({
  // ...existing options
  marketingRoutes: {
    subscribe: async (shopId, input) => {
      // Call your newsletter service / DB here.
      // Return `{ ok: true }` or `{ ok: false, reason: 'already_subscribed' }`.
      return { ok: true }
    },
  },
})
```

The route sits in the same band as the cart + events beacons so
it sees the shared shop + cookie middleware.

### Smoke test (no network)

```bash
node -e '
  const {
    segmentCustomer,
  } = require("./packages/core/dist/modules/marketing/segments.js");
  const out = segmentCustomer({
    customerId: "cus_1",
    email: null,
    createdAt: new Date(),
    ordersCount: 5,
    totalSpent: 800,
    currency: "USD",
    firstOrderAt: new Date(),
    lastOrderAt: new Date(),
  }, new Date());
  if (out.segment !== "vip") throw new Error("segmenter drift");
  console.log("ok", out.segment);
'
```

---

## 18. Theme Builder + i18n (Phase 5)

Phase 5 ships the **deterministic core** for the Theme Builder,
marketplace, and multi-locale storefront render path. Every
module in this phase is pure — no DB, no HTTP, no filesystem —
so the same code can run in Node (admin API), in a Cloudflare
Worker (storefront edge), or in a test harness without any
adapter wiring. The live editor UI, the zip adapter, the
marketplace install API, and the wildcard SSL automation land
in follow-up stages (see §18); this runbook only documents the
primitives that are already shipping binaries today.

### 18.1 Module map

| Module                                                      | Purpose                                                                  | Test count |
|-------------------------------------------------------------|--------------------------------------------------------------------------|------------|
| `@gbox/core/modules/themes/settings-validator.js`           | Validate `settings_data.json` against a theme's `settings_schema.json`.  | 19         |
| `@gbox/core/modules/themes/bundle.js`                       | Pure export/import of a theme's file tree with manifest + FNV-1a hashes. | 17         |
| `@gbox/core/modules/themes/marketplace-manifest.js`         | Validate the `theme.json` a theme ships at the bundle root.              | 15         |
| `@gbox/core/modules/themes/section-reorder.js`              | Pure reorder helper for the drag-drop section rail.                      | 21         |
| `@gbox/core/modules/i18n/translate.js`                      | Sync `translateKey` + `buildLocaleFallbackChain` against preloaded bundles. | 15      |
| `@gbox/storefront/middleware/i18n.js`                       | Per-request bundle loader + sync `req.gboxT` wired to the core helper.   | 10         |

All of these are shipped under the workspace's normal build
output — no extra deployment step. The admin and storefront
both import from `@gbox/core`.

### 18.2 Settings validator contract

The Theme Builder stores `settings_data.json` overrides on a
per-shop basis. Before every write, the admin calls
`validateThemeSettings(schema, overrides)`:

```ts
import { validateThemeSettings } from '@gbox/core/modules/themes/settings-validator.js'

const result = validateThemeSettings(schema, incomingOverrides)
if (!result.ok) {
  // result.errors is a list of { path, code, message } —
  // render inline under each field in the editor.
  return res.status(422).json({ errors: result.errors })
}
await db.update(...).set({ settings: result.cleaned })
```

Rules enforced (shared with Shopify's `settings_schema.json`
so an existing theme can be imported without rewrites):

- `color`: normalised to 7-char lowercase hex (`#aabbcc`).
  Shorthand `#abc` becomes `#aabbcc`. Bad input → `invalid_color`.
- `number` / `range`: coerced from string to number, then
  checked against `min`/`max`. Missing number → `invalid_number`;
  out of bounds → `out_of_range`.
- `checkbox`: `true`/`false`/`"true"`/`"false"`/`0`/`1`/`"0"`/`"1"`
  all coerce to boolean. Anything else → `invalid_boolean`.
- `select` / `radio`: value must be one of the schema options.
  Bad option → `invalid_option`.
- `url`: protocol allow-list is `http`, `https`, `mailto`, `tel`.
  Other protocols (`javascript:`, `file:`) → `invalid_url`.
- `text` / `textarea`: capped at 10 KB (`MAX_TEXT_LEN`) so a
  merchant typo doesn't blow up the settings row. Too long →
  `too_long`.

### 18.3 Bundle serializer

The bundle module is the **only** module in the codebase that
decides how a theme's file tree becomes a manifest. Admin CLI
+ theme marketplace install API both go through it.

```ts
import { bundleTheme, parseThemeBundle, hashFileContent } from '@gbox/core/modules/themes/bundle.js'

// Export: files is Record<path, contents>
const { manifest, files: sorted } = bundleTheme(files, {
  name: 'Gbox Minimal',
  version: '1.0.0',
  author: 'Gbox',
  description: 'A clean starting point',
  license: 'MIT',
})

// Import: reverse gate
const out = parseThemeBundle(manifest, uploadedFiles)
if (!out.ok) {
  // out.errors: empty_manifest | missing_file | hash_mismatch |
  //              invalid_version | unsafe_path
  return bail(out.errors)
}
```

Hash: 64-bit FNV-1a (two 32-bit registers mixed), output as a
16-char lowercase hex string. Chosen over `crypto.createHash`
so the module ships to Cloudflare Workers without a polyfill.
If we ever need real integrity (supply-chain attack, signed
themes) a SHA-256 pass lands on top, not replacing this.

`REQUIRED_THEME_FILES = ['layout/theme.liquid']` is the
minimum every theme must ship; bundling without it throws. Add
to this list deliberately — every entry is a breaking change
for merchants with existing custom themes.

**Path safety**: `parseThemeBundle` rejects any entry whose
path starts with `/`, contains `..`, contains a backslash, or
has an empty segment. This is the only defence against a
malicious theme trying to escape the install root, so do NOT
remove the check when refactoring — the zip adapter trusts it.

### 18.4 Marketplace manifest

`theme.json` lives at the root of every bundle uploaded to the
Gbox Theme Marketplace. Call `parseMarketplaceManifest` before
touching the database:

```ts
import { parseMarketplaceManifest } from '@gbox/core/modules/themes/marketplace-manifest.js'

const out = parseMarketplaceManifest(rawThemeJsonString)
if (!out.ok) return respond422(out.errors)

// out.manifest.slug is kebab-case, out.manifest.supported_locales
// is de-duplicated and sorted, out.manifest.required_features is
// an allow-listed subset of KNOWN_THEME_FEATURES.
```

Locked invariants — changing these is a breaking migration:

- `SUPPORTED_MARKETPLACE_SCHEMA_VERSION = 1`. Bumps go through
  a migration that back-fills existing rows.
- `KNOWN_THEME_FEATURES` is the **closed** list of features a
  theme can declare it needs. New entries are added deliberately;
  an unknown feature at validation time **fails** the install
  rather than silently passing through.
- Preview URL is parsed with `new URL(...)` and restricted to
  `http:` / `https:`. Themes cannot ship `ftp://` previews.
- Slug must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Underscores,
  uppercase, and whitespace are all rejected.

### 18.5 Section reorder

The visual editor's drag-drop rail talks to a single admin
endpoint:

```http
POST /admin/themes/:id/sections/reorder
{ "fromId": "featured_products", "toId": "hero", "position": "before" }
```

The handler calls `reorderSections(order, fromId, toId, position, opts)`
from `@gbox/core/modules/themes/section-reorder.js` and
persists the result. The helper is pure — no DB, no HTTP, no
side effects.

Lock semantics matter: `opts.locked = ['header', 'footer']`
means neither section can move **and** no reorder is allowed
to displace them. Dropping a section "after footer" is a clean
rejection (`to_locked`), not a silent push-past. The helper
also surfaces `duplicate_ids` for programming errors — a
duplicate id in the stored theme row is never the user's
fault, so the admin handler should log it and bail with a
500 pointing to the theme row id.

For keyboard-driven reordering (accessibility), use
`moveSectionToIndex(order, fromId, targetIndex, opts)` — it
clamps out-of-range indices and still honours the lock set.

### 18.6 Storefront i18n wiring

The core i18n service (`DbI18nService`, `MemoryI18nService`)
is async — it owns DB lookup + cache. That's fine for the
admin side, but the storefront render path wants a SYNC call
per `{% t 'cart.title' %}` against a bundle that was loaded
once at request start. Phase 5.4 ships the pure sync floor;
Phase 5.6 stitches it into the Express pipeline.

Middleware order (see `apps/storefront/src/app.ts`):

```
locale → assets → i18n → mutation routers → storefront handler
```

The i18n middleware is installed **after** the asset handler
so `/assets/theme.css` doesn't pay the loader cost on every
CSS/JS hit. It runs once per HTML request, calls a
caller-provided `loader(ctx)` to fetch the bundles for the
resolved shop, and stamps:

```ts
req.gboxTranslations  // TranslationBundles (empty {} on miss)
req.gboxT             // (key, vars?) => string  — sync
```

Wiring from `server.ts`:

```ts
import { buildApp } from '@gbox/storefront/app.js'
import { loadBundlesForShop } from './translations-loader.js'

const app = buildApp({
  // ... other middleware deps ...
  i18n: {
    loader: async ({ shop, locale, defaultLocale }) => {
      if (!shop) return null
      // Your translation source — DB, CDN JSON, Redis cache, etc.
      return loadBundlesForShop(shop.id, { locale, defaultLocale })
    },
    defaultLocale: 'en',
  },
})
```

**Failure policy is soft**: a thrown loader, a null result, or
a missing key all degrade to `t('key') === 'key'`. The
storefront never 500s because translations are down. This
matches Shopify (missing translations show the key verbatim
in dev, which makes them obvious).

Fallback chain example: `vi-VN` → `vi` → shop default (`en`).
`buildLocaleFallbackChain` normalises case on the way
(`en-us` → `en-US`, `zh-hant` → `zh-Hant`) so a Vietnamese
visitor from Vietnam with `Accept-Language: vi-VN` hits the
regional bundle first, then the base, then English.

### 18.7 What Phase 5 does NOT ship

Deferred to later stages, and explicitly **not** wired up in
the current deploy:

- **Visual theme editor UI**. The admin-panel iframe + drag
  handles + live preview HMR bridge. The core primitives (5.1
  + 5.5) are the data layer for that UI — the React shell
  lands in Phase 5.8.
- **Zip adapter**. `bundleTheme` produces a `files` map; a
  later stage adds a tiny zip/unzip pair (pure JS, no
  `node:zlib` dependency) so the admin can upload/download
  `.gbox-theme` files.
- **Marketplace browse + install API**. The validator lands
  here; the `POST /admin/marketplace/themes/:slug/install`
  endpoint, the S3/R2 download step, and the per-shop install
  record all land in Phase 5.9.
- **Wildcard SSL automation**. Certbot still needs a manual
  renewal step (documented in §18). Automating it per shop
  host list is a Phase 6 infrastructure ticket.

### 18.8 Smoke test

```bash
node --experimental-vm-modules -e '
import("./packages/core/dist/modules/themes/section-reorder.js").then(m => {
  const out = m.reorderSections(
    ["header", "hero", "featured", "footer"],
    "featured",
    "hero",
    "before",
    { locked: ["header", "footer"] },
  );
  if (!out.ok) throw new Error(out.error.code);
  if (out.order.join(",") !== "header,featured,hero,footer") {
    throw new Error("reorder drift: " + out.order.join(","));
  }
  console.log("ok", out.order.join(","));
});

import("./packages/core/dist/modules/i18n/translate.js").then(m => {
  const bundles = { en: { "cart.title": "Cart" }, vi: { "cart.title": "Giỏ hàng" } };
  const out = m.translateKey(bundles, "vi-VN", "cart.title", { defaultLocale: "en" });
  if (out !== "Giỏ hàng") throw new Error("translate drift: " + out);
  console.log("ok", out);
});
'
```

Run it on server 1 after a deploy; both primitives are purely
in-process and do not need the DB, Redis, or nginx to be up.

---

## 19. Open items for later stages

- **3E Analytics (follow-up)**: forward `X-Forwarded-For` into the analytics
  tagger so we don't lose visitor IPs behind the proxy.
- **3F Theme Builder (follow-up)**: scoped preview COOKIE (in
  addition to the query-string token) so deep-linked previews
  survive a full-page navigation inside the theme editor iframe.
- **3G AI Expert (live wiring)**: admin-api entrypoint that binds
  the `@gbox/core/modules/ai/prompts.js` builders to an actual
  `fetch` call against `api.anthropic.com`, with retry + rate
  limit + streaming response support.
- **3G Theme Cloner (crawl layer)**: headless-browser or pure-HTTP
  fetcher that snapshots a target URL into the `(html, css)`
  string pair expected by `buildCloneReport`. Must live in the
  admin-api or a worker, NOT in the storefront.
- **Password fallback flow**: customer-auth is magic-link-first
  today. Add a `/account/password-reset` flow when a merchant
  asks (most never will — see PRINCIPLES.md P3).
- **Certbot automation**: bake the storefront host list into the
  wildcard cert renewal job.
- **Phase 4 Marketing (live wiring)**: bind the pure core helpers
  to real side effects —
  - Admin CRUD for discount rules + popup rules + email flow
    overrides (stored per shop in Postgres).
  - Email worker that polls enrolments, calls `nextStepDue`,
    renders + sends via SMTP/Resend, and writes back
    `lastSentStepId`.
  - Storefront JS that collects `PopupSessionSnapshot` fields
    (exit-intent detector, dwell timer, scroll tracker) and
    calls `evaluatePopup` client-side from the embedded rules.
  - Admin API `POST /marketing/subscribe` dep implementation
    that actually persists to the `newsletter_subscriptions`
    table + enqueues a double opt-in email.
  - `checkoutRoutes` hook that calls `validateDiscount` +
    `applyDiscount` at price time once discount codes land on
    the cart.
- **Phase 5 Theme Builder (live wiring)**: bind the pure core
  helpers to real side effects —
  - Admin React shell for the visual editor — iframe preview,
    section rail (calls `reorderSections`), settings form
    (calls `validateThemeSettings`), live HMR bridge.
  - Zip adapter for `.gbox-theme` bundles — pure-JS
    zip/unzip that wraps `bundleTheme` / `parseThemeBundle`
    so the admin can upload/download in one step.
  - Marketplace install API — `POST /admin/marketplace/themes/:slug/install`
    that calls `parseMarketplaceManifest`, pulls the bundle
    from object storage, hands it to `parseThemeBundle`, and
    writes the install row.
  - Translation bundle loader for the storefront i18n
    middleware — binds `i18n.loader` to the `translations`
    Postgres table (keyed by shop + locale) with a per-shop
    LRU cache that invalidates on publish.
  - Wildcard SSL automation — bake the storefront host list
    into the certbot renewal job so newly-installed themes on
    new shop domains get a cert without a manual step.
