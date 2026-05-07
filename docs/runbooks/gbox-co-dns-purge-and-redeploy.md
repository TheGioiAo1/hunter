# gbox.co DNS — Purge + Redeploy Runbook

> **Status: EXECUTED 2026-04-19** — Platform v4 has been cut over
> from `thaibeotit.com` → `gbox.co` with a **full replacement** (no
> grace period). The code, CORS whitelist, env defaults, scripts and
> docs no longer reference `thaibeotit.com`. The sections below are
> preserved as the historical plan; see §8 change log for the execution
> record.

Single source of truth for what DNS records `gbox.co` needs when we
flip Platform v4 to production. Written the moment Thai decided to
purge the messy legacy zone (April 2026) — so we have a clean list to
re-add later without second-guessing.

Related specs:
- `docs/superpowers/specs/2026-04-18-shopify-parity-s3-media-pipeline.md` §10 (Cloudflare CDN)
- `docs/superpowers/specs/2026-04-08-decision-6-cloudflare-pages-storefront.md` (apex + www)
- `docs/superpowers/specs/2026-04-08-checkout-subdomain-split.md` (checkout.gbox.co)
- `docs/runbooks/custom-domain-verification.md` (merchant CNAME target)

---

## 1. What's safe to delete from the legacy zone

Confirmed by owner (Thai) 2026-04-19 — the following can be wiped without
consequence:

| Subdomain | Legacy purpose | Safe? |
|---|---|---|
| `api-auth.gbox.co` | Gbox-Auth-Service (C# .NET microservice) | ✅ sunset, no live data |
| `api-shop.gbox.co` | Gbox-Shop-Service | ✅ sunset |
| `api-email.gbox.co` | Gbox-Email-Service | ✅ sunset |
| `api-cdn.gbox.co` | Gbox-CDN-V6 | ✅ sunset (replaced by `cdn.gbox.co`) |
| `api-app.gbox.co` | Gbox-App-Service | ✅ sunset |
| `api-product.gbox.co` | Product-Service-V2 | ✅ sunset |
| `api-customer.gbox.co` | Customer-Service | ✅ sunset |
| `api-order.gbox.co` | Order-Service | ✅ sunset |
| `api-payment.gbox.co` | Payment-Service | ✅ sunset |
| `api-shipping.gbox.co` | Shipping-Service | ✅ sunset |
| `api-page.gbox.co` | Page-Service | ✅ sunset |
| `api-layout.gbox.co` | Layout-Service | ✅ sunset |
| `store.gbox.co` | Legacy storefront | ✅ replaced by `*.gbox.co` wildcard |
| `unsubscribe-email.gbox.co` | Legacy email unsubscribe | ✅ sunset |
| `gbox.co` MX/SPF/DKIM/DMARC | Email (placeholder only — `thaibq@gbox.co` never had an active mailbox; owner's real mail is `buithai3107@gmail.com`) | ✅ no active inbound |
| Third-party verification TXTs (Google/Stripe/FB/Apple) | Various — not actively used | ✅ will re-verify per service when needed |

**Translation:** the zone can go to zero records. Everything below is what
to add back when ready.

---

## 2. The 8 production records to re-add

Add these to Cloudflare zone `gbox.co` (must be on Cloudflare — spec §10
assumes Cloudflare CDN in front of everything):

| # | Record | Type | Target | Proxied | Purpose |
|---|---|---|---|---|---|
| 1 | `gbox.co` | A | (Cloudflare Pages assigned) | ✅ | Marketing apex (Decision #6) |
| 2 | `www.gbox.co` | CNAME | `gbox-marketing.pages.dev` | ✅ | Marketing alias → 301 to apex |
| 3 | `accounts.gbox.co` | A | `<server 1 public IP>` | ✅ | Accounts Portal (login/signup/OTP/stores) |
| 4 | `admin.gbox.co` | A | `<server 1 public IP>` | ✅ | Store Admin Dashboard (EmDash) |
| 5 | `api.gbox.co` | A | `<server 2 public IP>` | ✅ | Platform REST API |
| 6 | `checkout.gbox.co` | A | `<server 2 public IP>` | ✅ | PCI-isolated checkout (Decision #2) |
| 7 | `cdn.gbox.co` | CNAME | imgproxy origin hostname (Cloudflare-managed) | ✅ | Media CDN — S3 + imgproxy routing per spec §10 |
| 8 | `*.gbox.co` | A | `<server 3 public IP>` | ✅ | Storefront wildcard (Mode A: `my-shop.gbox.co`) |

**Ordering matters** when provisioning:
1. Add zone to Cloudflare → note NS records from CF
2. Update NS at registrar → wait for propagation (`dig NS gbox.co +short`)
3. Add records 3–7 first (platform surfaces) — takes effect immediately behind the orange cloud
4. Add record 8 (`*.gbox.co`) last so stale wildcard lookups don't mask specific subdomains during setup
5. Add records 1+2 (marketing) when Cloudflare Pages project is live

---

## 3. Deferred records (add when the feature ships)

Not needed for initial launch, document here so they're not missed:

| Record | When | Reference |
|---|---|---|
| `status.gbox.co` | When status page project is built | decision-6 §329 |
| `design-cdn.gbox.co` | When design library ships | plan 2026-04-18-design-library-integration |

---

## 4. Amazon SES records (add when transactional email is ready)

If/when `noreply@gbox.co` sender is configured for SES (`.env.example`
has `EMAIL_FROM=noreply@gbox.co`), add:

| Record | Type | Purpose |
|---|---|---|
| `_amazonses.gbox.co` | TXT | SES domain verification |
| `<sel1>._domainkey.gbox.co` | CNAME → `<id1>.dkim.amazonses.com` | DKIM signing #1 |
| `<sel2>._domainkey.gbox.co` | CNAME → `<id2>.dkim.amazonses.com` | DKIM signing #2 |
| `<sel3>._domainkey.gbox.co` | CNAME → `<id3>.dkim.amazonses.com` | DKIM signing #3 |
| `gbox.co` | TXT | `v=spf1 include:amazonses.com ~all` |
| `_dmarc.gbox.co` | TXT | `v=DMARC1; p=quarantine; rua=mailto:dmarc@gbox.co` |

**Note:** SES verification tokens come from the SES console at the moment
you verify the domain — don't pre-populate.

---

## 5. Dev-first rollout strategy

Platform v4 is being built on **`thaibeotit.com`** as a stand-in for
`gbox.co`. When ready to flip to production:

### 5.1 Cloudflare side

- Copy zone config (Origin Rules, Cache Rules, Transform Rules, Workers)
  from `thaibeotit.com` → `gbox.co`. All rules are scoped by hostname,
  so a search-replace of `thaibeotit.com` → `gbox.co` inside each rule
  body is sufficient — no semantic changes.
- The Worker that stamps the `User-Agent` header (spec §10.4, §5.4) has
  `+https://thaibeotit.com/edge` hardcoded; swap to `+https://gbox.co/edge`.

### 5.2 S3 bucket policy (spec §5.4)

The bucket policies on the 4 primary buckets + 4 DR buckets currently
allow the Cloudflare IP CIDR block with the edge User-Agent. **No change
needed** when hostname swaps — same Cloudflare IPs front both zones, same
edge UA. The policy enforces "request came from CF" + "UA matches edge",
both survive the hostname swap.

### 5.3 App config (`.env` production)

Swap these env vars when flipping prod:

```
COOKIE_DOMAIN=.gbox.co                          # was .thaibeotit.com
PLATFORM_URL=https://gbox.co                    # was https://thaibeotit.com
ACCOUNTS_URL=https://accounts.gbox.co
API_URL=https://api.gbox.co
CHECKOUT_URL=https://checkout.gbox.co
CHECKOUT_BASE_URL=https://checkout.gbox.co
CDN_PUBLIC_BASE_URL=https://cdn.gbox.co
CDN_THEME_LIBRARY_BASE_URL=https://cdn.gbox.co
GBOX_PLATFORM_CNAME_TARGET=cdn.gbox.co          # merchants' custom-domain CNAME target
STOREFRONT_CNAME_TARGET=storefront.gbox.co      # used by ssl-provisioner
```

### 5.4 CORS whitelist (`packages/core/src/modules/security/cors.ts`)

Add `https://gbox.co`, `https://admin.gbox.co`, `https://accounts.gbox.co`,
`https://checkout.gbox.co`, `https://api.gbox.co` to the allowed-origins
list. **Executed 2026-04-19** with NO grace period: the thaibeotit.com
variants were removed in the same commit that added gbox.co (Thai's 2
"merchant" domains on thaibeotit.com were his own test-only domains, so
bookmark breakage was not a concern).

### 5.5 Cookie invalidation warning

Cookie domain flip `.thaibeotit.com` → `.gbox.co` means **every active
session is logged out** on cutover (browsers don't share cookies across
apex domains). This is correct behavior, not a bug — announce it to
early testers so they're not surprised.

### 5.6 Email sender swap

`EMAIL_FROM=noreply@gbox.co` is already the default in `.env.example`.
Production needs SES to have both domains verified if we want a grace
period; otherwise flip `EMAIL_FROM` at cutover. SES DKIM CNAMEs take
24–72h to propagate on first verify — plan ahead.

---

## 6. Post-cutover smoke tests

After NS swap + record add-back, run these in order:

```bash
# DNS propagation
dig +short NS gbox.co
dig +short cdn.gbox.co
dig +short admin.gbox.co
dig +short api.gbox.co

# Cloudflare edge responding
curl -I https://gbox.co/                   # Marketing 200
curl -I https://admin.gbox.co/health       # Platform v4 200
curl -I https://accounts.gbox.co/login     # Accounts portal 200
curl -I https://api.gbox.co/health         # API 200
curl -I https://checkout.gbox.co/health    # Checkout 200

# CDN pipeline (spec §10.5)
curl -I "https://cdn.gbox.co/shops/test/misc/hello.txt"       # 200 via S3
curl -I "https://cdn.gbox.co/shops/test/videos/x/master.m3u8" # 200 via S3 direct
curl -I "https://cdn.gbox.co/img/<sig>/rs:fit:800:0/f:webp/<src>"  # 200 via imgproxy

# Storefront wildcard
curl -I https://demo.gbox.co/                # Mode A storefront 200
```

All 200? Cutover done.

---

## 7. Rollback plan

If anything breaks after cutover:

1. **Quickest undo:** change NS at registrar back to the old provider
   (pre-Cloudflare). Legacy resolution resumes in 5–30 min. Platform
   v4 apps don't stop working — they just go unreachable via public DNS.
2. **Cloudflare-level undo:** pause the zone in CF dashboard → DNS
   resolves to the origin IPs but edge features (Rules/Workers/cache)
   turn off. Useful if a specific Worker is breaking traffic.
3. **Per-record undo:** if only one subdomain is broken (say
   `cdn.gbox.co` not resolving imgproxy), set its record to grey-cloud
   (DNS only) while debugging — rest of the platform stays on the
   orange cloud path.

---

## 8. Change log

- 2026-04-19 — Thai confirmed legacy C# system has no live data; zone
  can be zero'd. Dev-first approach chosen (`thaibeotit.com` → `gbox.co`
  later). Inventory captured before purge so nothing is lost in the sweep.
- 2026-04-19 — **Cutover executed.** Full replacement — no grace period.
  All code hardcoded fallbacks, `.env.example` defaults, CORS whitelist,
  shell scripts, smoke-test slugs, and cross-doc references flipped
  `thaibeotit.com` → `gbox.co` in one commit. Cookie domain change
  `.thaibeotit.com` → `.gbox.co` forces a universal logout on cutover
  (expected).
