# Decision #2 — checkout.gbox.co Split (PCI Scope Reduction)

**Status:** plan — awaiting owner approval before implementation
**Owner:** Thai Bui
**Date:** 2026-04-08
**Depends on:** Decision #4 (customer sessions) ✅, Decision #3 (PayPal Partner) ✅
**Blocks:** Decision #1 (liquidjs themes) — lighter, because checkout UI can live outside the theme system

---

## 1. Why split checkout to its own subdomain?

1. **PCI scope reduction.** Today all storefront traffic (home, PDP, cart, checkout)
   is served from a single Express app (`storefront-server.ts`) — or, in the
   future, from a merchant's own custom domain (`my-shop.com`). If any payment
   fields are ever rendered on those pages, the entire storefront (themes,
   third-party JS, ad pixels) drops into PCI-DSS SAQ-A-EP scope. Splitting the
   payment step onto a dedicated, Gbox-controlled subdomain (`checkout.gbox.co`)
   keeps the storefront at SAQ-A: it only has to serve an `<iframe>` / redirect
   to a page Gbox owns.

2. **Consistent checkout UX across 100% of stores.** Merchants on custom domains
   (`shop.acme.com`) don't need to install an SSL cert for their checkout page
   — Gbox handles it. One certificate, one code path, one audit.

3. **Third-party JS isolation.** Meta Pixel, Google Tag Manager, TikTok pixel,
   Klaviyo, etc. commonly get dropped into storefront themes by merchants.
   None of that runs inside `checkout.gbox.co` — the CSP explicitly blocks it.
   This is how Shopify does it (shopify.com → `checkout.shopify.com`).

4. **Clean PayPal Partner attribution.** The PayPal JS SDK
   `data-partner-attribution-id="Gbox_Ecom"` attribute only has value if the
   surrounding page is clean of other PayPal integrations. Split checkout
   guarantees no conflicting PayPal snippets from merchant themes.

5. **Custom-domain → Gbox-domain handoff** is a known, well-understood pattern
   (Shopify, Stripe Checkout, BigCommerce all do this). We already have
   Decision #4's customer sessions; the handoff is purely a one-shot token
   + 302 redirect.

---

## 2. What already exists in the monorepo

| Capability | Status | File |
| --- | --- | --- |
| Customer auth (magic link + OTP + 30-day cookie) | ✅ Decision #4 | `packages/core/src/modules/customer-auth/{service,middleware}.ts` |
| Customer cookie options helper | ✅ but **no `domain` attribute** | `packages/core/src/modules/customer-auth/middleware.ts:111` |
| Checkout API (create / email / shipping / discount / complete / gateways) | ✅ | `server.ts` lines 3655–4348 under `/api/store/:slug/checkout/*` |
| Redis-backed checkout session (1h TTL) | ✅ | `packages/core/src/modules/checkout/service.ts` |
| PayPal Partner create/capture/cancel/refund | ✅ Decision #3 + Step A of audit | `modules/payments/paypal-partner/gateway.ts`, routes in `server.ts` |
| PayPal browser SDK loader | ✅ Step B | `modules/payments/paypal-partner/storefront-loader.ts` |
| PayPal browser buttons JS (Venmo + PayPal, vanilla ES2020) | ✅ Step C | `modules/payments/paypal-partner/browser/paypal-buttons.js` |
| CORS auto-allow for `*.gbox.co` | ✅ | `modules/security/cors.ts:49` |
| Dynamic CORS for verified custom domains | ✅ | `modules/security/cors.ts:110` |
| Express skeleton app pattern | ✅ | `apps/accounts/src/server.ts` |
| Page handler pattern (CSRF + session + audit log) | ✅ | `apps/accounts/src/pages/login.ts` |

**Gap analysis:**
1. `buildCustomerCookieOptions()` has no `domain` field → cookies are host-only,
   so `accounts.gbox.co` / `storefront.gbox.co` / `checkout.gbox.co` cannot
   share a customer session today.
2. No handoff token mechanism exists for custom-domain → checkout.gbox.co
   transitions.
3. No `apps/checkout/` skeleton.
4. No nginx route for `checkout.gbox.co`.
5. No CSP hardening helpers (different from `adminSecurityHeaders`, which is
   for the admin panel).

---

## 3. Architecture

### 3.1 Two entry modes

```
Mode A: Gbox-hosted storefront (gbox.co subdomain, e.g. my-shop.gbox.co)
  1. Buyer clicks "Checkout" on cart page served by storefront.
  2. Browser navigates to https://checkout.gbox.co/c/chk_xxx
  3. The customer_session cookie (Domain=.gbox.co) is AUTOMATICALLY sent.
  4. No handoff token needed.

Mode B: Custom-domain storefront (e.g. shop.acme.com)
  1. Buyer clicks "Checkout" on cart page served by storefront.
  2. Storefront calls POST /api/store/:slug/checkout/handoff-token
     with the checkoutId. Server mints a signed, one-shot nonce,
     stores it in Redis (60s TTL, SETNX), returns { token, redirect_url }.
  3. Browser navigates to https://checkout.gbox.co/c/chk_xxx?hop=<token>
  4. checkout.gbox.co verifies the token (HMAC + Redis DEL), then
     mints the Domain=.gbox.co session cookie and 302s to
     https://checkout.gbox.co/c/chk_xxx (no token in URL).
  5. From that point on it behaves like Mode A.
```

The handoff token carries:
```ts
{
  checkoutId: string       // chk_xxx
  shopId: string
  customerId: string | null
  iat: number              // issued-at (ms)
  exp: number              // iat + 5*60*1000
  nonce: string            // 16-byte hex, used as Redis key
}
```
Signed with HMAC-SHA256 using `CHECKOUT_HANDOFF_SECRET` (new env var — 32-byte
random). Stored in Redis as `handoff:nonce:<nonce>` with TTL 300s. First
successful `DEL` wins (one-shot). This is the same pattern as our OTP claim
in customer-auth.

### 3.2 Cookie domain strategy

Modify `buildCustomerCookieOptions()` to accept an optional `domain` parameter,
default `undefined` (preserve current behavior):

```ts
export function buildCustomerCookieOptions(
  expiresAt: Date,
  opts: { domain?: string } = {},
) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
    ...(opts.domain ? { domain: opts.domain } : {}),
  }
}
```

Callers:
- `apps/checkout` passes `domain: '.gbox.co'` in production (always), none in
  dev (host-only on localhost is fine).
- `apps/accounts` eventually the same — deferred to a follow-up commit so we
  don't break Decision #4 tests in this PR.
- Storefront Mode A (when we serve `my-shop.gbox.co`) also `.gbox.co`.
- Custom-domain storefronts: NO change — their cookies stay on their own
  domain; crossing happens through the handoff token.

Control this via env var: `CUSTOMER_COOKIE_DOMAIN` (unset → host-only).

### 3.3 File layout (new)

```
gbox-platform/
├── apps/
│   └── checkout/                    # NEW — the subdomain app
│       ├── package.json             # mirrors apps/accounts/package.json
│       ├── tsconfig.json
│       └── src/
│           ├── server.ts            # Express skeleton (port 4326)
│           ├── router.ts            # /c/:checkoutId, /c/:checkoutId/confirm, /c/:checkoutId/thankyou, /health
│           ├── pages/
│           │   ├── checkout.ts      # renders the 3-step checkout HTML
│           │   ├── confirm.ts       # POST handler — finalizes via API
│           │   └── thankyou.ts      # order confirmation page
│           ├── components/
│           │   ├── layout.ts        # HTML shell with strict CSP
│           │   └── paypal-block.ts  # emits sdk <script> + buttons.js loader
│           └── lib/
│               ├── api-client.ts    # thin fetch wrapper → Platform API
│               └── handoff.ts       # verifyHandoffToken()
├── packages/
│   └── core/
│       └── src/
│           └── modules/
│               └── checkout/
│                   ├── handoff.ts   # NEW — signHandoffToken() / verifyHandoffToken()
│                   └── service.ts   # (existing — no changes)
├── server.ts                        # + route: POST /api/store/:slug/checkout/handoff-token
└── tests/
    └── checkout-handoff.test.ts     # NEW — sign/verify + one-shot nonce
```

### 3.4 CSP lockdown for `apps/checkout`

The checkout page is the ONE place where real payment data is handled. It
needs a separate, stricter security header set from `adminSecurityHeaders`:

```
Content-Security-Policy:
  default-src 'self';
  script-src  'self' https://www.paypal.com https://www.paypalobjects.com https://*.venmo.com 'sha256-<inline-init>';
  style-src   'self' 'unsafe-inline';         (inline only for PayPal button iframe embed)
  img-src     'self' data: https://www.paypalobjects.com;
  frame-src   https://www.paypal.com https://www.sandbox.paypal.com https://*.venmo.com;
  connect-src 'self' https://api.gbox.co https://*.paypal.com;
  form-action 'self' https://api.gbox.co;
  frame-ancestors 'none';                      (do NOT allow iframing of checkout)
  base-uri 'none';
  object-src 'none';

Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Referrer-Policy:           no-referrer
X-Frame-Options:           DENY
X-Content-Type-Options:    nosniff
Cross-Origin-Opener-Policy:  same-origin
Cross-Origin-Resource-Policy: same-site
Permissions-Policy:        payment=(self "https://www.paypal.com")
```

Note the **absence** of any merchant-controlled origin (no `https://*.shop.com`,
no merchant analytics). This is the guarantee the split gives us.

### 3.5 CORS changes

None required for `checkout.gbox.co` itself — `corsConfig` in `cors.ts:49`
already auto-matches `/^https?:\/\/([a-z0-9-]+\.)*gbox\.co(:\d+)?$/`.

However, the checkout app's fetch calls to the Platform API (`api.gbox.co`)
will cross-origin from `checkout.gbox.co` — need `credentials: 'include'` and
the API must not send `Access-Control-Allow-Origin: *` (it doesn't — the
`cors` middleware is configured with `credentials: true`).

### 3.6 Nginx routing

Add to server 1 (`192.168.1.13`) nginx config:

```nginx
server {
  listen 443 ssl http2;
  server_name checkout.gbox.co;

  ssl_certificate     /etc/letsencrypt/live/gbox.co/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/gbox.co/privkey.pem;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;

  location / {
    proxy_pass         http://192.168.1.30:4326;   # apps/checkout on server 2
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto https;
    proxy_read_timeout 30s;
  }
}
```

For local/dev testing without DNS: use `--resolve checkout.gbox.co:443:192.168.1.13`
in curl, or add `/etc/hosts` entries.

---

## 4. Sub-step breakdown (implementation order)

Each sub-step ends with a git commit + deploy + smoke test on server 2 before
moving on — same cadence as the PayPal audit.

**Step 2.1 — Handoff token module** (30 min)
- `packages/core/src/modules/checkout/handoff.ts`: `signHandoffToken()` +
  `verifyHandoffToken()` + `redeemHandoffToken()` (SETNX-style via `getRedis()`).
- New env var `CHECKOUT_HANDOFF_SECRET` (fail-fast at import time in prod).
- Unit test: `tests/checkout-handoff.test.ts` with 4 cases —
  (1) sign+verify happy path, (2) expired token rejected, (3) tampered
  signature rejected, (4) replay (second redeem) rejected.

**Step 2.2 — API endpoint to mint handoff tokens** (15 min)
- `POST /api/store/:slug/checkout/handoff-token` in `server.ts`.
- Requires an existing checkout session; pulls `customerId` from the
  customer-auth middleware; returns `{ token, redirect_url, expires_at }`.
- Rate-limited (5/min/IP) via existing `pageLimiter`-style helper.
- Smoke test via curl against server 2.

**Step 2.3 — Cookie domain option** (10 min)
- Modify `buildCustomerCookieOptions()` to accept `{ domain? }`.
- Read `CUSTOMER_COOKIE_DOMAIN` env var in the checkout app.
- Do NOT change existing callers yet — just extend the signature.

**Step 2.4 — `apps/checkout/` skeleton** (1 h)
- Mirror `apps/accounts/` package.json, tsconfig.json, server.ts shape.
- Port 4326. `BASE_PATH=/` (not `/checkout` — the subdomain IS the namespace).
- Routes: `/health`, `/c/:checkoutId`, `/c/:checkoutId/confirm`,
  `/c/:checkoutId/thankyou`. Error page for 4xx/5xx.
- Strict CSP + security headers module (separate from admin).
- Handoff token redemption on GET `/c/:checkoutId?hop=...` → 302 to clean URL.

**Step 2.5 — 3-step checkout HTML** (1.5 h)
- Step 1: email + address (calls `PUT /checkout/:id/email` + `/shipping`).
- Step 2: shipping rate selection (calls `GET /checkout/:id/shipping-rates`
  and `PUT /checkout/:id/shipping-rate`).
- Step 3: payment — renders the PayPal SDK script tag
  (from `GET /api/store/:slug/payments/paypal-partner/sdk-tag`) + loads
  `/api/payments/paypal-partner/buttons.js` + calls
  `window.GboxPayPal.mountButtons({...})`.
- Each POST is a server-side form handler → proxies to Platform API → re-renders.
  No SPA framework, no React — plain HTML forms + minimal JS for the PayPal block.

**Step 2.6 — Confirm + thankyou pages** (30 min)
- `confirm` is hit by the PayPal `onApprove` callback path — but since the
  button calls the API directly, the browser returns here only on non-PayPal
  gateways. For Phase 1 PayPal-only, `/confirm` is a thin fallback that
  re-fetches the checkout from the API and 302s to `/thankyou`.
- `thankyou` displays the order number + next steps. Pure static render.

**Step 2.7 — Tests** (1 h)
- `tests/checkout-handoff.test.ts` (already covered in 2.1)
- `tests/checkout-page-render.test.ts` — smoke: hit `/c/:id`, assert the
  response contains the PayPal SDK script tag + `window.GboxPayPal` loader.
- `tests/checkout-session-cookie.test.ts` — verify `Set-Cookie` includes
  `Domain=.gbox.co` when `CUSTOMER_COOKIE_DOMAIN` is set.
- All tests run against real Postgres on server 2 per P22.

**Step 2.8 — Deploy + nginx + verify** (45 min)
- Add PM2 entry `gbox-checkout` on server 2 port 4326.
- Add nginx `checkout.gbox.co` server block on server 1.
- Certbot renewal config (SAN on existing `gbox.co` cert).
- Smoke test via `curl --resolve checkout.gbox.co:443:192.168.1.13 https://checkout.gbox.co/health`.
- End-to-end manual test: create a checkout via API, hit the subdomain,
  render the page, run a PayPal sandbox $1 test charge, refund it.

**Total estimate: ~5.5 hours of focused work across commits.**

---

## 5. What this spec is NOT

- **Not a full Shopify Checkout UI rewrite.** No address autocomplete,
  tax quotes, or discount UI polish — all deferred. This ships a working
  3-step checkout that can take a PayPal/Venmo payment. Everything else
  is iterative.
- **Not a Stripe checkout.** Stripe support is still gated on Decision #3's
  `gateway-selector.ts`. The split is payment-provider-agnostic; only the
  Step 3 HTML differs per gateway.
- **Not migration of `storefront-server.ts`.** That file stays as-is. The
  only change on the storefront side is making the "Checkout" button open
  `https://checkout.gbox.co/c/:id` (Mode A) or POST to `/handoff-token`
  first (Mode B). Mode A/B plumbing happens in Decision #1 (liquidjs themes)
  when we actually render cart pages.

---

## 6. Acceptance checklist

- [ ] `apps/checkout/` package builds and starts on port 4326
- [ ] `GET /health` returns 200
- [ ] Handoff token sign/verify/redeem unit tests pass
- [ ] Replay attack rejected (same nonce DEL'd twice)
- [ ] Expired token rejected
- [ ] Tampered signature rejected
- [ ] `GET /c/:checkoutId` on Gbox-domain returns full checkout HTML
- [ ] `GET /c/:checkoutId?hop=<token>` on custom-domain handoff 302s to clean URL + sets cookie
- [ ] CSP header is strict (no `unsafe-eval`, no wildcard script-src)
- [ ] PayPal SDK tag rendered with `data-partner-attribution-id="Gbox_Ecom"`
- [ ] Venmo button renders for eligible buyers
- [ ] Test $1 sandbox charge → capture → refund flow works end-to-end
- [ ] Nginx `checkout.gbox.co` 443 route live on server 1 (or Host-header
      override documented in smoke test runbook)
- [ ] PM2 entry `gbox-checkout` live on server 2
- [ ] Smoke test runbook updated with `curl --resolve` one-liner

---

## 7. Cross-references

- Decision #3 — PayPal Partner integration (commits `3284772`, `0f9e62a`,
  `b1f7480`, `e5fa5b1`)
- Decision #4 — Customer auth (customer-auth module)
- Decision #8 — Checkout session in Redis
- `docs/superpowers/specs/2026-04-08-paypal-partner-merchant-dashboard.md` —
  the merchant-facing admin UI for this same PayPal integration
- Shopify reference: https://help.shopify.com/en/manual/checkout-settings
- PCI-DSS SAQ-A vs SAQ-A-EP guidance from PCI SSC

---

## 8. Open questions for owner review

1. **`CUSTOMER_COOKIE_DOMAIN` default in prod?** Recommendation: `.gbox.co`.
   This silently enables cross-subdomain sessions for every Gbox-hosted
   storefront going forward. Any objection?

2. **Handoff token TTL = 5 minutes?** Shopify uses ~2. Longer = more forgiving
   of slow networks, shorter = smaller replay window. Default 5, opinions?

3. **Custom domains: do we emit a Domain=.acme.com cookie for `shop.acme.com`
   too?** Recommendation: **no** — custom-domain storefronts DON'T share
   a cookie with `checkout.gbox.co`, so there's no benefit, and it would
   block iframe-embedded checkouts in the future.

4. **Rate limit on `/handoff-token`?** Suggest 10/min/IP + 60/hour/checkoutId.
   A sane default; we can tighten if we see abuse.

5. **Inline `<script>` in checkout HTML?** We need one `<script>` block to
   wire up `GboxPayPal.mountButtons` after the SDK loads. Options:
   (a) allow via `'sha256-...'` hash in CSP (hash the exact content, bump on change);
   (b) extract to `/static/checkout-init.js` served by the same app (no inline at all).
   Recommendation: **(b)** — cleaner CSP, no hash maintenance. Slight extra
   request, but same-origin and HTTP/2 multiplexed.

Please confirm these five answers (or override). Once greenlit I'll begin
Step 2.1 (handoff token module) and proceed one sub-step at a time with
commit + deploy + smoke test at each step, per your "từng bước một" rule.
