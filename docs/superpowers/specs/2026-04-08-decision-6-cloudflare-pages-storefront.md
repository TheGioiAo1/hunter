# Decision #6 — Cloudflare Pages for `gbox.co` Marketing Site

**Status:** plan — awaiting owner approval; **MUST NOT START** until Decision #1 is green
**Owner:** Thai Bui
**Date:** 2026-04-08
**Depends on:** Decision #1 (liquidjs themes) — for the optional theme-component reuse path
**Blocks:** nothing — this is a deployment-only decision

---

## 0. Owner-locked answers (Q1–Q4 from chat, session 1)

| Q | Choice | What it means here |
|---|---|---|
| Q1 | **(c)** | **CF Pages hosts ONLY `gbox.co` (and `www.gbox.co`).** Every `*.gbox.co` storefront — and every merchant custom domain — keeps hitting origin Node on server 3 via the existing nginx wildcard. **No storefront page is ever served from CF Pages.** |
| Q2 | **(b)** | The optional bridge: if a marketing landing page wants to embed a real product card from a featured store, it can `import` from a Worker-runtime build of the Decision #1 theme engine. This is forward-compat plumbing only — Decision #6 ships without using it. |
| Q3 | **(a)** | n/a here (Liquid runs on origin). |
| Q4 | **(a)** | Decision #6 starts only after Decision #1 is fully green. |

> **Critical:** The phrase "Cloudflare Pages storefront" earlier in chat was misleading. Under Q1=(c), CF Pages is **not** a storefront — it's the marketing site (`gbox.co`). Storefronts (`*.gbox.co`) stay on origin Node forever (or until we explicitly flip Q1).

## 0.5. Owner-locked answers (§8 open questions, session 2)

| # | Question | Thai's answer | Impact on this spec |
|---|---|---|---|
| 1 | Existing Cloudflare account with `gbox.co`? | **Yes** | Step 6.10/6.11 unblocked. Thai still has to (a) create the Pages project and (b) provision the GitHub API token — documented in those steps. |
| 2 | Marketing copy source | **Template / placeholder** — everything editable | All copy is placeholder text marked with `<!-- EDIT ME: ... -->` HTML comments. I write template copy for each page; Thai edits post-deploy via git. No CMS. |
| 3 | `/blog` at launch | **Coming soon** | Step 6.7 changes: ship **one** `/blog` index page that says "Our engineering blog is coming soon — subscribe at [email]" with a newsletter-hint that POSTs to the contact route. No markdown content collection. No `/blog/[slug].astro`. Fewer moving parts. |
| 4 | Apex canonical | **`gbox.co`** (no www) | `www.gbox.co/*` → 301 → `https://gbox.co/:splat`. DNS table in §3.6 updated: `www.gbox.co` CNAME → Pages, but its first hop is a redirect. |
| 5 | Analytics | **Now**, in Step 6.3 | Use **Cloudflare Web Analytics** (zero-runtime-cost, privacy-friendly, already part of Thai's CF plan, no extra vendor). Injected via one `<script>` in `BaseLayout.astro`. Beacon token provisioned in Step 6.10. |

---

## 1. Why move `gbox.co` to Cloudflare Pages

1. **Free global CDN.** Marketing pages are pure cacheable content. Pages serves them from 300+ edge locations with zero origin load.
2. **Free TLS + DDoS.** Cloudflare manages the cert and absorbs traffic spikes (PR/Hacker News spikes are the worst-case scenario for a marketing site).
3. **Atomic deploys + preview URLs.** Every git push gets its own `*.pages.dev` URL — anyone can review marketing copy changes before they go live.
4. **Decouples marketing from product.** Right now there's no `gbox.co` at all — we own the domain but it points nowhere. A broken `apps/api` deploy currently means `gbox.co` is also broken because they share an origin. Pages cuts that tie.
5. **Zero impact on the rest of the platform.** Because Q1=(c), every storefront, API, admin, accounts, and checkout subdomain stays exactly where it is on the origin nginx box. Only `gbox.co` and `www.gbox.co` change DNS.

---

## 2. What already exists

| Capability | Status | File |
| --- | --- | --- |
| Wildcard nginx for `*.gbox.co` → server 3 storefront | ✅ | `/etc/nginx/sites-enabled/gbox` on server 1 |
| `checkout.gbox.co` → server 2 (Decision #2) | ✅ | same file |
| `api.gbox.co` → server 2 API | ✅ | same file |
| `admin.gbox.co` / `accounts.gbox.co` → server 1 | ✅ | same file |
| `gbox.co` apex | ❌ no record | — |
| `www.gbox.co` | ❌ no record | — |
| `apps/marketing/` | ❌ does not exist | — |
| Cloudflare account / API token | ❓ owner has it | needs to be confirmed |

---

## 3. Architecture

### 3.1 What lives where (after Decision #6)

```
                     [internet]
                         │
              ┌──────────┼──────────────────────────┐
              │          │                           │
      ┌───────▼───────┐  │                  ┌────────▼────────┐
      │ gbox.co       │  │                  │ *.gbox.co       │
      │ www.gbox.co   │  │                  │ checkout.gbox.co│
      │               │  │                  │ api.gbox.co     │
      │ Cloudflare    │  │                  │ admin.gbox.co   │
      │ Pages         │  │                  │ accounts.gbox.co│
      │               │  │                  │ shop1.gbox.co   │
      │ - / (home)    │  │                  │ ...             │
      │ - /pricing    │  │                  │                  │
      │ - /features   │  │                  │ Origin nginx    │
      │ - /blog/*     │  │                  │ on 192.168.1.13 │
      │ - /contact    │  │                  │                  │
      │ - /about      │  │                  │ → server 1/2/3  │
      │ - /terms      │  │                  │   per Host      │
      │ - /privacy    │  │                  └─────────────────┘
      │ - /404        │  │
      └───────────────┘  │
                         │
                  No origin hop.
                  100% edge cached.
```

### 3.2 Repository layout

```
apps/marketing/
├── package.json
├── astro.config.mjs           ← static output, no SSR adapter
├── wrangler.toml              ← CF Pages project config
├── public/
│   ├── _redirects             ← /admin → admin.gbox.co, www → apex, etc.
│   ├── _headers               ← Cache-Control, security headers
│   ├── robots.txt
│   ├── favicon.svg
│   └── og-default.png
├── src/
│   ├── layouts/
│   │   └── BaseLayout.astro   ← imports CF Web Analytics <script> (§0.5 Q5)
│   ├── components/
│   │   ├── Header.astro
│   │   ├── Footer.astro
│   │   ├── Hero.astro
│   │   ├── Pricing.astro
│   │   └── FeatureCard.astro
│   ├── pages/
│   │   ├── index.astro        ← /
│   │   ├── pricing.astro      ← /pricing
│   │   ├── features.astro     ← /features
│   │   ├── about.astro        ← /about
│   │   ├── contact.astro      ← /contact (form posts to api.gbox.co)
│   │   ├── terms.astro
│   │   ├── privacy.astro
│   │   ├── 404.astro
│   │   └── blog.astro         ← /blog — single "coming soon" page (§0.5 Q3)
│   └── styles/
│       └── globals.css         ← Tailwind via Astro
└── tests/
    ├── build.test.ts          ← runs astro build, asserts dist/ contains expected files
    └── routes.test.ts         ← curls every page from the build server, asserts 200 + expected text
```

No `src/content/` — blog is a single static page for now (§0.5 Q3). If Thai wants real posts later, we add the content collection in a follow-up decision without touching anything else.

**Why Astro static (not Next, not pure HTML):**
- Astro static output = `dist/` of pure HTML/CSS/JS that any static host can serve. No runtime needed.
- Component model lets us share `Header.astro` / `Footer.astro` across pages without copy-paste.
- Built-in markdown content collections for `/blog`.
- Tailwind integration is one-line (`@astrojs/tailwind`).
- Already in our skill set — `packages/storefront/` is Astro.

### 3.3 Blog — "coming soon" (§0.5 Q3)

No content collection at launch. `/blog` is a single Astro page with:
- A headline "Engineering blog coming soon".
- One paragraph describing what will be published (platform architecture posts, merchant success stories).
- A reuse of the Contact form styled as "Notify me when we publish" — same `POST /api/marketing/contact` backend, with a hidden `subject=blog-subscribe` field so Thai can triage those leads separately in the DB.

Adding a real blog later is a ~200 LOC follow-up: `content/config.ts` + `pages/blog/[slug].astro` + the index listing. Nothing else in this spec changes.

### 3.4 `_redirects` file (Cloudflare Pages syntax) — apex canonical (§0.5 Q4)

```
# Force apex — www → gbox.co
https://www.gbox.co/*   https://gbox.co/:splat   301!

# Hard subdomain redirects for legacy URLs
/admin           https://admin.gbox.co/         301
/admin/*         https://admin.gbox.co/:splat   301
/accounts        https://accounts.gbox.co/      301
/accounts/*      https://accounts.gbox.co/:splat 301
/login           https://accounts.gbox.co/login 301
/signup          https://accounts.gbox.co/signup 301
/api/*           https://api.gbox.co/:splat     301
/checkout/*      https://checkout.gbox.co/:splat 301

# Old marketing slugs that may exist in google
/plans           /pricing                       301
```

The `301!` force flag on the `www` rule ensures CF Pages applies the redirect even if a file with a matching path exists in the static bundle (belt-and-braces against future regressions).

### 3.5 `_headers` file

```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; img-src 'self' data: https:; script-src 'self' static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' https://api.gbox.co https://cloudflareinsights.com; frame-ancestors 'none'
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload

/blog
  Cache-Control: public, max-age=300, s-maxage=3600

/_astro/*
  Cache-Control: public, max-age=31536000, immutable
```

The CSP above explicitly allows `static.cloudflareinsights.com` (script) and `cloudflareinsights.com` (beacon connect-src) so Cloudflare Web Analytics (§0.5 Q5) can load. No other third-party JS is allowed.

### 3.6 DNS plan (Cloudflare DNS)

| Record | Type | Value | Proxy |
|---|---|---|---|
| `gbox.co` | CNAME (apex flattening) | `gbox-marketing.pages.dev` | ✅ proxied |
| `www.gbox.co` | CNAME | `gbox-marketing.pages.dev` | ✅ proxied |
| `*.gbox.co` | A | (existing origin nginx IP) | ✅ proxied |
| `api.gbox.co` | A | (existing) | ✅ proxied |
| `checkout.gbox.co` | A | (existing) | ✅ proxied |

**Critical:** the wildcard `*.gbox.co` already covers every storefront. We do NOT touch it. We only add the apex + www. Cloudflare's DNS resolves the more specific record (`api.gbox.co`, `checkout.gbox.co`) before the wildcard, so existing subdomains stay on origin.

### 3.7 Build/deploy pipeline

| Trigger | Action |
|---|---|
| Push to `master` (apps/marketing/**) | GitHub Action → `wrangler pages deploy apps/marketing/dist --project-name=gbox-marketing` |
| Push to any other branch | Same Action → preview URL on `*-gbox-marketing.pages.dev` |
| Pull request | Comment with preview URL |

The Action lives at `.github/workflows/deploy-marketing.yml`. The Cloudflare API token + account ID live in GitHub repo secrets (owner provisions).

### 3.8 Contact form

`/contact` POSTs to `https://api.gbox.co/api/marketing/contact` (a new tiny route on origin Node). The route writes to a `marketing_contacts` table + sends a notification email. No CSRF — public form, rate-limited by IP (10/min).

This is the only origin hop from the marketing site, and only on form submit, not on page load.

---

## 4. Step-by-step execution plan

> Same standing rule: từng bước một, every step is a commit + push + verify.

### Step 6.1 — Scaffold `apps/marketing/`
- Bootstrap Astro project with Tailwind integration.
- Add `astro.config.mjs` with `output: 'static'`, `site: 'https://gbox.co'`.
- Add `package.json` workspace entry.
- Verify `npm run -w apps/marketing build` produces a `dist/` folder.

### Step 6.2 — `BaseLayout` + `Header` + `Footer`
- Implement the three core components with Tailwind utility classes matching the rest of the platform's color tokens.
- Use SVG logo committed in `public/`.
- Footer links to all subdomains (admin, accounts, api docs, status).

### Step 6.3 — Home page (`/`) + Cloudflare Web Analytics in `BaseLayout` (§0.5 Q5)
- Hero with primary CTA → `https://accounts.gbox.co/signup`.
- Three feature cards (themes, AI, conversion).
- Pricing teaser with "see all plans" → `/pricing`.
- Trust strip (logos placeholder).
- Footer.
- **CF Web Analytics injection** in `BaseLayout.astro`:
  ```html
  <script defer src="https://static.cloudflareinsights.com/beacon.min.js"
    data-cf-beacon='{"token": "{{ import.meta.env.PUBLIC_CF_BEACON_TOKEN }}"}'></script>
  ```
  - The token comes from an env var set in the GH Action secret (`CF_BEACON_TOKEN`) and exposed as `PUBLIC_CF_BEACON_TOKEN` at build time.
  - If the env var is missing, the `<script>` tag is rendered with an empty token (CF silently drops it) — lets local dev builds work without the secret.
- All copy is placeholder-marked (§0.5 Q2): every heading + paragraph wrapped in `<!-- EDIT ME: home-hero-title --> Welcome to Gbox`. Same for every other page. A quick grep command in the commit message shows Thai where to find them: `grep -r 'EDIT ME' apps/marketing/src/`.

### Step 6.4 — `/pricing`, `/features`, `/about`
- Hand-written content based on existing platform features.
- `/pricing` has a 3-tier table (Basic / Pro / Plus) — values are placeholders for owner to edit.
- Each plan CTA → `accounts.gbox.co/signup?plan=<id>`.

### Step 6.5 — `/contact` form
- Renders form with Tailwind.
- POSTs to `https://api.gbox.co/api/marketing/contact` (server-side, not via JS — `<form action method="post">`).
- Success page = same URL with `?ok=1`.

### Step 6.6 — `/api/marketing/contact` on origin Node
- Add new route in `server.ts`.
- Schema validation (zod): `name`, `email`, `subject?`, `message`.
- Rate limit: 10/min/IP via existing `rate_limits` table.
- Insert into `marketing_contacts` table (new migration `009_marketing_contacts.ts`).
- Send notification email to `thaibq@gbox.co`.
- Return 303 redirect to `${origin}/contact?ok=1` if Origin matches `gbox.co` / `www.gbox.co` / `*.pages.dev`, else 200 JSON for API consumers.
- Test: `tests/marketing-contact.test.ts` (4 cases — happy, missing field, rate-limited, bad origin).

### Step 6.7 — `/blog` "coming soon" page (§0.5 Q3)
- Single `src/pages/blog.astro` — no content collection, no `[slug].astro`.
- Headline "Our engineering blog is launching soon".
- One paragraph of placeholder copy (`<!-- EDIT ME: blog-coming-soon-body -->`) describing what will be published.
- "Notify me" form that reuses the contact form component with a hidden `<input type="hidden" name="subject" value="blog-subscribe">` field, posting to `POST /api/marketing/contact` (same route as regular contact form).
- The contact route in Step 6.6 already handles arbitrary subjects — no backend change needed.

### Step 6.8 — `_redirects` + `_headers`
- Add both files to `public/`.
- Verify `npm run build` copies them into `dist/`.
- Test with `wrangler pages dev dist/` locally that `/admin` → 301 → `admin.gbox.co/`.

### Step 6.9 — `wrangler.toml` + GitHub Action
- `apps/marketing/wrangler.toml` with `name = "gbox-marketing"`, `pages_build_output_dir = "dist"`, `compatibility_date`.
- `.github/workflows/deploy-marketing.yml`:
  - Trigger: push to master + PR + workflow_dispatch.
  - Steps: checkout → setup-node → `npm ci` → `npm run -w apps/marketing build` → `wrangler pages deploy`.
  - Uses secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

### Step 6.10 — Cloudflare Pages project setup (manual, owner-driven)
- **Owner action 1:** Log into Cloudflare dashboard, create Pages project `gbox-marketing` connected to the GBox-Company GitHub repo. Build command: `npm run -w apps/marketing build`. Build output: `apps/marketing/dist`. Root directory: `/` (repo root).
- **Owner action 2:** Generate API token scoped to `Cloudflare Pages: Edit` for the repo and add to GitHub secrets as `CLOUDFLARE_API_TOKEN`. Also add `CLOUDFLARE_ACCOUNT_ID`.
- **Owner action 3 (§0.5 Q5):** Under `Analytics → Web Analytics → Add a site`, register `gbox.co` and copy the beacon token. Add it to GitHub secrets as `CF_BEACON_TOKEN`. The GH Action maps this to `PUBLIC_CF_BEACON_TOKEN` at build time so the `<script>` tag in `BaseLayout.astro` picks it up.
- I write the docs for all three actions in `CLAUDE-EXTENDED.md`; I don't have CF dashboard access.

### Step 6.11 — DNS cutover
- **Owner action:** Add Cloudflare DNS records per §3.6.
- **Owner action:** Confirm `gbox.co` resolves to `*.pages.dev` by `dig +short gbox.co`.
- I verify with `curl -sI https://gbox.co` from server 2 and check the `cf-ray` header.

### Step 6.12 — Smoke test against live `gbox.co`
- `scripts/smoke-marketing.ts` — fetches every page, asserts 200 + expected text + correct CSP header + non-empty `_astro/` asset URLs.
- Run from server 2.

### Step 6.13 — Documentation + commit final
- Add a section to `CLAUDE-EXTENDED.md` mapping all gbox.co/* paths and where they live.
- Push to org + origin.
- Tag: `decision-6-complete`.

---

## 5. Test plan summary

| Step | New tests |
|---|---|
| 6.1 | build smoke (1) |
| 6.6 | marketing-contact route (4) |
| 6.8 | redirects (3 — local wrangler dev) |
| 6.12 | live smoke against gbox.co (~15 pages × 200/CSP/asset assertions) |

**Acceptance gate before marking Decision #6 complete:** smoke test against the *live* `https://gbox.co` returns 200 + expected text on every page; all redirects work; CSP header is present.

---

## 6. Non-goals (explicitly deferred)

- **Storefront on Cloudflare Pages.** Q1=(c) — never. Storefronts stay on origin Node.
- **Marketing CMS.** Blog content is committed `.md` files. No headless CMS integration.
- **i18n marketing site.** English only at launch.
- **A/B testing on landing pages.** No CF Workers logic; pure static.
- **Marketing analytics dashboard.** Plausible / Cloudflare Analytics is fine; no custom dashboard.
- **Status page integration.** `/status` is a deferred subdomain `status.gbox.co` (different decision).
- **Newsletter signup.** Form schema doesn't include newsletter opt-in; that's a follow-up after we choose an ESP.

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Wildcard `*.gbox.co` accidentally catches `gbox.co` apex and routes it to origin | Low | Cloudflare resolves the more specific apex CNAME first. Test with `dig` before flipping DNS. |
| GitHub Action burns through Cloudflare free tier (500 builds/month) | Low | We push <50/month to marketing files. Free tier is fine. |
| Contact form spam | Medium | Rate limit + honeypot field + future Cloudflare Turnstile (deferred). |
| Static content goes stale (e.g. price change not synced to /pricing) | Medium | `/pricing` page has a "Last updated" comment in source; owner edits when plan changes. |
| `gbox.co` apex SSL warning during DNS propagation | Low | Cloudflare provisions cert in <60s after DNS save. Do the cutover off-hours. |
| Owner doesn't have CF account / API token | Unknown | Step 6.10 is owner-blocking; everything before is repo-only and ships independently. |

---

## 8. Open questions — ALL ANSWERED (see §0.5)

| # | Question | Thai's answer |
|---|---|---|
| 1 | Cloudflare account with `gbox.co`? | **Yes** |
| 2 | Marketing copy | **Template/placeholder**, all editable |
| 3 | `/blog` at launch | **Coming soon** (single page) |
| 4 | Apex canonical | **`gbox.co`** (www → 301 → apex) |
| 5 | Analytics | **Cloudflare Web Analytics**, integrated in Step 6.3 |

## 8b. §8b answers (session 3) — all locked

| # | Question | Thai's answer | Implementation |
|---|---|---|---|
| 1 | Pricing tiers | **Shopify-style placeholder** — Thai plans to replace entirely later | `/pricing` ships 3 tiers mirroring Shopify's current public pricing: **Basic $29**, **Shopify $79**, **Advanced $299** (all USD, monthly). Every price + plan name wrapped in `<!-- EDIT ME: pricing-... -->` markers. A prominent `<!-- NOTE TO THAI: replace entire /pricing page before public launch -->` comment at the top of the file. |
| 2 | Contact email | **`contact@gbox.co`** (dedicated) | The origin Node route in Step 6.6 sends notification emails to `contact@gbox.co`. **Owner action:** Thai provisions the `contact@gbox.co` mailbox or forwarder before Step 6.6 deploys. If not ready, we fall back to `thaibq@gbox.co` via env var `CONTACT_EMAIL_TO`. |
| 3 | Astro major version | **5.x for everything** | `apps/marketing` scaffolds on **Astro 5.x** from day one (Step 6.1). `packages/storefront` is currently on 4.x but will be **deleted** as part of Decision #1 Step 1.17 cleanup (once the LiquidJS engine replaces it), so upgrading 4.x → 5.x would be wasted work. **If Thai wants `packages/storefront` to live longer than Decision #1**, add a new Step 6.0 to upgrade it to 5.x first — otherwise it stays as-is until deletion. See §8c below. |

## 8c. One clarification needed before Step 6.0/6.1

**Astro 5.x scope:** Thai said "nên update hết lên 5.x" (update everything to 5.x). Two readings:

- **Reading A (my recommendation):** `apps/marketing` = Astro 5.x. `packages/storefront` is a zombie — `storefront-server.ts` doesn't even import it — and will be deleted in Decision #1 Step 1.17 when the LiquidJS engine ships. No upgrade needed; we just delete it. Total work: minimal.
- **Reading B (literal):** Upgrade `packages/storefront` 4.x → 5.x first as a new Step 6.0 even though it's about to be deleted. Breaks Astro integrations that might not have 5.x releases yet (`@astrojs/tailwind`, `@astrojs/react`). ~1 day of dep untangling for code we throw away.

Unless Thai says otherwise, I'll go with **Reading A**. Please confirm or correct.

---

## 9. Estimated touch surface

| Lines added | Files touched | New files |
|---|---|---|
| ~1,500 | ~3 (server.ts, package.json, .github/workflows) | ~25 (Astro project) |

Much smaller than Decision #1 because the engine and data model are untouched. The risk surface is the DNS cutover, not the code.

---

## 10. Why this is two decisions, not one

Decision #1 (theme engine) and Decision #6 (CF Pages marketing site) sound related but share **almost no code**:

- Decision #1 lives in `packages/core/src/modules/themes/*` and ships on origin Node only.
- Decision #6 lives in `apps/marketing/*` and ships on Cloudflare Pages only.

The single bridge is Q2=(b)'s **theoretical** ability to import the Decision #1 engine into a Worker — but Decision #6 doesn't actually use that bridge. It's pure forward-compat insurance for the day we flip Q1 from (c) to (a)/(b).

Splitting them keeps blast radius small: a broken marketing CSS change can never break a real merchant store, and a broken Liquid filter can never break the marketing blog.
