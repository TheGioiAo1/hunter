# Custom Domain Verification — Runbook

**Stage:** Shipped 2026-04-18 (commit `05846e0`). Replaces the
Cloudflare-mandatory flow that shipped earlier in Phase 3A.
**Target:** Server 1 (`192.168.1.13`, public `14.224.236.129`) running Ubuntu,
nginx + PM2. Same deploy pattern applies to prod when we migrate.
**Audience:** You, six months from now, when a seller opens a ticket that
their custom domain isn't verifying.

---

## 1. What this is

Sellers want to point their own domain (`mystore.com`, `shop.example.vn`) at
their Gbox storefront — same story as Shopify's "custom domain" feature.

Before this shipped, the flow hard-required a full Cloudflare nameserver
move. Fine for people who live on Cloudflare; a wall of concrete for
everyone else. And nginx returned `444` on unknown `Host:` headers, so even
a correctly-pointed domain hit a closed TCP connection.

Now sellers follow a single Cloudflare-based path (§3), and nginx
forwards every named `Host` to the storefront where `resolve-shop`
middleware decides whether to serve content (`verified = true`) or
return a clean 404 page ("Store Not Found").

## 2. Topology

```
 seller's registrar                seller's Cloudflare zone
 ──────────────────                 ────────────────────────
                                                │
  NS mystore.com → *.ns.cloudflare.com ─────────┤
                                                │
                                 CNAME @   → cdn.<platform>  🟠
                                 CNAME www → cdn.<platform>  🟠
                                 SSL mode: Flexible
                                                │
                                                ▼
                     ┌──────────────────────────────────┐
                     │ platform's own Cloudflare zone   │
                     │   cdn.<platform> A <origin IP>   │
                     │   (grey cloud ⚪ · DNS only)      │
                     └──────────────────────────────────┘
                                      │
                                      ▼
                  ┌────────────────────────────────────────────────┐
                  │ server 1 · 192.168.1.13 · public 14.224.236.129│
                  │                                                │
                  │       nginx :80 / :443                         │
                  │   server_name mystore.com → explicit block     │
                  │   server_name _            → catch-all         │
                  │                         ──────────┐            │
                  │                                   ▼            │
                  │                        127.0.0.1:4326          │
                  │                        (gbox-storefront)       │
                  │                                   │            │
                  │     lookupShopByHost($host)       │            │
                  │     WHERE shop_domains.verified = true         │
                  │         match → 200 shop page                  │
                  │         miss  → 404 "Store Not Found"          │
                  └────────────────────────────────────────────────┘
                                      │
                                      ▼
                         postgres (server 2) · shop_domains
```

`cdn.<platform>` (i.e. `cdn.gbox.co`) is the
Shopify-style indirection. Sellers who CNAME to it follow us to any new
origin IP by just flipping this one record — we never touch their zone.
If the CNAME env is unset, the UI has sellers use `A @/www → origin IP`
inside the CF zone instead; still works, but rotation becomes a support
task.

Key invariants to hold in your head:

- storefront only binds `127.0.0.1:4326`. Nginx is the only public path.
- The **nginx catch-all** (`server_name _`) is what makes direct-A verify
  possible. Remove it and unknown Hosts hit a black hole.
- The **`verified = true`** filter on `shop_domains` is load-bearing — once
  nginx forwards every named Host, that SQL guard is the only thing
  stopping an unverified domain from serving content. Do not remove it
  without replacing it with something equivalent.

## 3. The verification path (Cloudflare-only)

Sellers have **one** supported path: move NS to Cloudflare, put both apex
and `www` behind an orange-cloud proxy, point them at our platform
hostname `cdn.<platform>` (or at the raw origin IP if the env var is
unset — progressive fallback). Why Cloudflare-only:

- Cloudflare gives sellers **edge HTTPS + DDoS for free**. Automatic
  origin-side TLS (ACME) is still roadmap (§12.1), and serving the
  storefront over plain HTTP is not acceptable for a production launch.
- Single supported path = one thing to document, one thing to support
  tickets against, one thing to teach non-technical sellers.
- The Shopify pattern (CNAME @ + CNAME www → platform hostname) lets us
  rotate origins by flipping one DNS record instead of emailing every
  seller when we move data centers.

Seller steps (abridged; full walkthrough in §4):

1. Add their domain as a free site on Cloudflare.
2. Change NS at their registrar to the two Cloudflare nameservers.
3. Once CF shows the zone as **Active**, add two DNS records:
   - `CNAME @   → cdn.<platform>` (orange cloud 🟠, CF auto-flattens apex)
   - `CNAME www → cdn.<platform>` (orange cloud 🟠)
4. In **SSL/TLS → Overview**, set mode to **Flexible**
   (client ↔ CF is HTTPS, CF ↔ origin is HTTP; switch to **Full** once
   origin-side TLS ships).
5. Back in store-admin, click **Verify**.

When `GBOX_PLATFORM_CNAME_TARGET` is **unset**, the UI falls back to
`A @` + `A www` pointing directly at the origin IP inside the CF zone.
Still works, but sellers see the raw IP and origin rotation becomes a
per-seller support task instead of a single DNS flip. Set the env var.

`verifyDomain` (in `cloudflare-service.ts`) tries A-record first because
the proxied A record resolves to Cloudflare edge IPs, which won't match
our platform IP list — so the fast path fails and it falls back to the
NS check, which matches `*.ns.cloudflare.com` and succeeds. On success,
`shop_domains.verification_method = 'cloudflare'` and
`cloudflare_proxied = true`. The `'a_record'` verification branch remains
in the code for future use (e.g. an ACME-backed direct-A option) but is
not reachable from the current seller UI.

## 4. Seller walkthrough (what they see)

1. Log into store-admin → **Online store → Domains**
2. **Connect existing domain** → type their domain
3. The setup card ("How to connect your domain") walks them through:
   1. Sign up for a free Cloudflare account, add their domain as a site.
   2. At their registrar, replace the nameservers with the two CF
      assigned (e.g. `dara.ns.cloudflare.com` + a pair).
   3. Wait for Cloudflare to report the zone as **Active** (usually
      minutes; worst case 24 h).
   4. In the CF **DNS** tab, add:
      - `CNAME @   → cdn.<platform>` with orange cloud 🟠
      - `CNAME www → cdn.<platform>` with orange cloud 🟠

      (If `GBOX_PLATFORM_CNAME_TARGET` is unset on our server, the UI
      shows `A @` + `A www` → `<origin IP>` instead; sellers follow the
      same orange-cloud-on step.)
   5. In **SSL/TLS → Overview**, set encryption mode to **Flexible**.
   6. Back in store-admin, click **Verify** on the domain row.
4. On success: status flips to "Verified", success copy reads
   "Verified via Cloudflare", `ssl_status = 'active'`, storefront is
   now reachable at `https://<their-domain>/`.

On failure, the error message is method-aware (e.g. "We couldn't detect
Cloudflare nameservers — make sure your zone status is Active"). Most
common cause: seller hasn't waited long enough after the NS change.

### 4.1 Onboarding wizard nudge (Phase E2, 2026-04-18)

**When it fires:** successful verification AND the shop's
`onboarding_state` is still `'pending'` (seller hit the wizard-origin
state machine but hadn't completed or skipped it). New sellers who
added a custom domain *before* touching the clone-or-skip choice fall
into this branch.

**What the seller sees:**
- Normal Verify flow runs (green pill, `ssl_status='active'`, etc).
- Instead of landing back on `/admin/store/<slug>/online-store/
  domains?tab=custom&success=...`, they get 302 → `/admin/store/<slug>/
  onboarding/first-run?from=domain-verified`. The welcome page reads
  the `from=domain-verified` breadcrumb and nudges "nice — your
  domain is live; want to clone a design or start from scratch?"

**When it does NOT fire:** `onboarding_state` is one of
`completed | skipped | cloning`, or the column is NULL (legacy
pre-migration-050 rows). Those sellers see the usual success banner.
This is strict-by-design: a veteran shop shouldn't suddenly get
bounced into the wizard just because a new custom domain verifies.

**Code:** `apps/store-admin/src/pages/domains.ts` `postVerifyDomain`,
guarded branch inside `if (result.ok)` before the existing `?success=`
redirect. The `onboarding_state` field is populated onto `req.store`
by `store-auth` middleware (same SELECT that reads plan/currency).

**Why it's safe:** the nudge only changes the *redirect target* — the
DB write from `verifyDomain` is already committed when this branch
decides. Turning the env flag `GBOX_ONBOARDING_WIZARD_ENABLED=false`
does NOT short-circuit this branch directly, but the gate middleware
(which owns the wizard pages) becomes a no-op so a hit to
`/onboarding/first-run` falls through to regular routing. Safer: the
gate is the one to flip, not this branch.

## 5. Data model — `shop_domains`

Columns that matter for this feature (see full schema with `\d shop_domains`):

| Column | Type | Role |
|--------|------|------|
| `domain` | varchar(255) UNIQUE | Customer-facing hostname (`mystore.com`) |
| `verified` | boolean NOT NULL | **Load-bearing.** Storefront only serves when true |
| `verification_method` | varchar(16) | `'a_record'` · `'cloudflare'` · `'txt'` (legacy) |
| `cloudflare_proxied` | boolean | true when NS on Cloudflare |
| `dns_target` | text | For `a_record`: matched IP. For `cloudflare`: an NS host |
| `ssl_status` | varchar(50) | `'pending'` after A verify; `'active'` when CF-proxied |
| `nameservers` | jsonb | Observed NS at last verify (audit) |
| `last_checked_at` | timestamptz | Last verify attempt |

Peek rows:
```bash
ssh botesty@192.168.1.13 'PGPASSWORD=GboxPlatform2026 psql -h localhost -U gbox -d gbox_platform -c \
  "SELECT domain, verified, verification_method, ssl_status, last_checked_at \
   FROM shop_domains ORDER BY last_checked_at DESC NULLS LAST LIMIT 10"'
```

## 6. Code map

**`packages/core/src/modules/ops/`**

- `a-record-detect.ts` — resolves A records for a domain, reports which
  (if any) match the configured `GBOX_PLATFORM_IP_V4` list. Pure function
  with a `DnsAResolver` injection point so tests can stub the resolver.
  Exports `detectARecord`, `parsePlatformIpEnv`.
- `cloudflare-detect.ts` — resolves NS records and **walks up the zone
  apex**: `www.mystore.com` → `mystore.com` → … — stops on the first
  non-empty NS response or bottoms out at 2 labels (so `.com` itself is
  never treated as a zone). Matches against `*.ns.cloudflare.com`. The
  apex walk was a bug fix; before, `www.<something>` with NS at the apex
  always failed to verify.

**`packages/core/src/modules/domains/cloudflare-service.ts`**

- `verifyDomain(db, {shopId, domainId, resolvers, platformIps})` — unified
  entry point used by the store-admin. Tries A first, CF fallback.
  Persists `verification_method`, `cloudflare_proxied`, `dns_target`,
  `ssl_status`, `nameservers`, `verified`, `verified_at`, `last_checked_at`.
  Returns a typed result the handler renders.
- `verifyViaCloudflare` — kept for backward compat. New callers should
  use `verifyDomain`.

**`apps/store-admin/src/pages/domains.ts`**

- `platformIpsForDisplay()` — reads `GBOX_PLATFORM_IP_V4`, splits CSV,
  returns list for UI rendering.
- `platformCnameTarget()` — reads `GBOX_PLATFORM_CNAME_TARGET`, trims.
  Empty string means "ops hasn't provisioned the DNS record yet" and
  `renderSetupInstructions` gracefully falls back to A-records-only copy.
  Non-empty string enables the Shopify-style CNAME pattern (see §3/§4).
- `postVerifyDomain` — POST handler invoked by the Verify button.
  Phase E Task E2 (2026-04-18) added the onboarding-wizard nudge: when
  the shop's `onboarding_state='pending'` and verify succeeds, the
  handler redirects the seller into the welcome page with
  `?from=domain-verified` instead of firing the normal success banner.
  Non-pending shops (completed/skipped/cloning/NULL) fall through.
  See §4.1 for the seller-visible behaviour.
- `renderSetupInstructions` — produces the single Cloudflare setup card.
  Progressive enhancement: when `hasCnamePath` is true, the DNS step
  shows `CNAME @/www → cdn.<platform>`; when false, it shows
  `A @/www → <origin IP>` inside the CF zone. Either way the seller
  still moves NS to Cloudflare and orange-clouds both records. The
  bring-your-own-DNS (Option 1) path was removed 2026-04-18 per Thai's
  decision: HTTPS-without-Cloudflare isn't viable until ACME ships.
- `messageForVerifyError` — maps `verifyDomain` error codes to
  method-aware user copy.

**`apps/storefront/src/server.ts`**

- `lookupShopByHost($host)` — the resolve-shop middleware. SQL now
  includes `WHERE shop_domains.verified = true`. Load-bearing; see §2.

**`infra/nginx/`**

- `custom-domain-catchall.conf` — the catch-all server block (§7).
- `_replace-default-server.py` — idempotent helper that swaps the legacy
  `return 444` block for the catch-all on an existing server. Safe to
  re-run; skips if already installed.

## 7. Nginx catch-all

The default_server block on port 80/443 receives every request whose
`Host` header doesn't match an explicit `server_name`. Before this feature:

```nginx
server {
    listen 80 default_server;
    server_name _;
    return 444;
}
```

Which hard-closes the TCP connection for unknown Hosts. Fine when the only
way to reach the server was via a specifically-named upstream; useless now
that we want pointed-but-unverified domains to get a clean 404 page.

Current block (full file at `infra/nginx/custom-domain-catchall.conf`):

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    if ($host ~* "^[0-9.]+$") { return 444; }   # bare-IP scans
    if ($host ~* "^\[.*\]$")  { return 444; }   # literal IPv6

    location / {
        proxy_pass http://127.0.0.1:4326;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 60s;
    }
}
```

Bare-IP probes still 444 — we don't want bots hitting
`http://14.224.236.129/` to see a storefront.

**Rollback:** restore the `return 444` block. The helper script does not
write a backup (it's a fresh-safe regex swap), so if you need to revert on
a box where you've lost history, paste the 4-line block above. Nginx
`-t` + reload and you're done.

## 8. Environment variables

| Var | Dev value | Read by | Purpose |
|-----|-----------|---------|---------|
| `GBOX_PLATFORM_IP_V4` | `14.224.236.129` | store-admin | Apex A-record target shown to sellers + matched during verify. Comma-separated accepted for multi-origin. |
| `GBOX_PLATFORM_CNAME_TARGET` | `cdn.gbox.co` | store-admin | Shopify-style platform hostname for the `CNAME www → …` step in the UI. Ops must own this DNS record and point it (grey cloud / DNS only) at `GBOX_PLATFORM_IP_V4`. Unset ⇒ UI falls back to A records on both apex and www. |
| `GBOX_ONBOARDING_WIZARD_ENABLED` | `true` (unset ⇒ treated as `true`) | store-admin, accounts | Store-onboarding wizard kill-switch (Phase E/F, 2026-04-18). Set to the literal `false` to disable: the onboarding-gate middleware becomes a no-op (no forced redirects from the dashboard for pending shops), and the accounts portal reverts `POST /create-store` to the legacy `/accounts/store-created` bounce (skipping `/welcome-to-admin`). Any other value keeps the wizard live. The domain-verify nudge in §4.1 is not gated by this flag directly — see that section for rationale. |

Both are read from `/home/botesty/gbox-platform/.env` via `dotenv/config`
in `apps/store-admin/src/server.ts`. `pm2 restart --update-env` is required
after changes; plain `pm2 restart` will NOT re-read the file.

`GBOX_PLATFORM_IP_V4` accepts a comma-separated list for multi-origin:
`14.224.236.129,203.0.113.5`. The verifier matches any IP in the list, so
we can add a backup origin without downtime.

`GBOX_PLATFORM_CNAME_TARGET` is a single hostname. To rotate origins
atomically across every seller's custom domain, flip the A record this
hostname points at, wait for TTL, done — no seller action required. (If
the env is unset and sellers fell back to direct-A inside their CF zone,
flipping requires reaching out to each of them; plan accordingly.)

**Prod values** (when we migrate to `gbox.co`):
- `GBOX_PLATFORM_IP_V4` → prod server public IP(s)
- `GBOX_PLATFORM_CNAME_TARGET` → `cdn.gbox.co` (or whichever platform
  hostname ops provisions — `shops.gbox.co` is an equally valid choice).

Verify the values actually reached the runtime:
```bash
ssh botesty@192.168.1.13 'cd /home/botesty/gbox-platform && \
  NODE_OPTIONS="--import tsx" node -e \
  "import(\"dotenv/config\").then(()=>console.log(process.env.GBOX_PLATFORM_IP_V4, process.env.GBOX_PLATFORM_CNAME_TARGET))"'
# Expect: 14.224.236.129 cdn.gbox.co
```

(`pm2 env <id>` won't show them — PM2 only snapshots the ecosystem.config
env dict, not dotenv's runtime mutations.)

## 9. Deploying to a fresh server

Checklist for prod or any additional origin.

1. **Provision the platform CNAME target** (Cloudflare dashboard, owner's
   zone). Add `cdn.gbox.co A <public IP>` (grey cloud / DNS only — this
   record must resolve to the raw origin so seller CNAMEs terminate at
   our nginx). Subdomain doesn't affect whatever the apex currently
   serves. Once live, `dig cdn.gbox.co +short` should return the IP.
   *Dev equivalent: use a sub-record in the dev platform zone, e.g.
   `cdn.gbox.co A 14.224.236.129`.*

2. **Install the nginx catch-all.**
   ```bash
   scp infra/nginx/custom-domain-catchall.conf botesty@HOST:/tmp/gbox-catchall.conf
   scp infra/nginx/_replace-default-server.py  botesty@HOST:/tmp/gbox-replace-ds.py
   ssh botesty@HOST 'sudo python3 /tmp/gbox-replace-ds.py && sudo nginx -t && sudo nginx -s reload'
   ```
   Expected: `OK: replaced default_server block` → `nginx: ... test is successful` → reload ok.
   If the script says `SKIP: catch-all already installed`, you're good too.

3. **Set env vars in `.env`.** Append:
   ```
   GBOX_PLATFORM_IP_V4=<public IP>
   GBOX_PLATFORM_CNAME_TARGET=cdn.gbox.co
   ```
   If you haven't provisioned the CNAME yet, leave `GBOX_PLATFORM_CNAME_TARGET`
   unset — the UI falls back to A-records-only and keeps working.

4. **Restart with `--update-env`.**
   ```bash
   ssh botesty@HOST 'pm2 restart gbox-storefront gbox-store-admin --update-env'
   ```

5. **Smoke test** — §10.

## 10. Smoke tests

Run from the origin (or any host that can reach it on port 80):

```bash
# Unknown Host → catch-all → storefront → 404 "Store Not Found"
curl -sS -H "Host: doesnt-exist-yet.example" http://127.0.0.1/ \
  -o /dev/null -w "HTTP %{http_code}\n"
# Expect: HTTP 404

# Bare IP → 444 (empty reply — this is CORRECT)
curl -sS http://14.224.236.129/ -o /dev/null -w "HTTP %{http_code}\n"
# Expect: HTTP 000 ("Empty reply from server")

# A known verified domain → 200 shop content
curl -sS -H "Host: lifeasy.org" http://127.0.0.1/ -o /dev/null -w "HTTP %{http_code}\n"
# Expect: HTTP 200
```

Body-level smoke:
```bash
curl -sS -H "Host: does-not-exist.example" http://127.0.0.1/ | grep -oE "Store Not Found"
# Expect: Store Not Found
```

SQL peek after a seller verification attempt:
```sql
SELECT domain, verified, verification_method, cloudflare_proxied, ssl_status,
       dns_target, last_checked_at
FROM shop_domains
WHERE domain = '<seller-domain>';
```

## 11. Troubleshooting

**"I added the DNS records but Verify still fails"**
1. `dig <domain> NS +short` — are the nameservers the two Cloudflare
   gave them? If still pointing at the old registrar / host, the NS
   move hasn't propagated yet. Registrar changes can take minutes to
   hours (TTL-dependent). Come back in a bit.
2. `dig <domain> +short` — did they add the CNAME/A on *both* apex and
   `www`? Most common screwup: only added `www`.
3. On Cloudflare, is the zone showing **Active** (not "Pending
   nameserver update")? If pending, CF still isn't authoritative and
   verification will find stale NS.
4. Are both records **orange-clouded**? If they're grey-clouded, the
   verifier sees their actual origin IP (not CF edge IPs) — that can
   still pass the A-record branch if they grey-cloud `cdn.<platform>`
   directly, but NS-branch detection expects proxied records.
5. Check `shop_domains.last_checked_at` — if very recent, the verifier
   ran but nothing matched. Try again in 5 minutes.

**HTTP 000 / empty reply for a valid Host**
1. Storefront running? `pm2 list | grep gbox-storefront`
2. Direct hit bypassing nginx:
   `curl http://127.0.0.1:4326/ -H "Host: does-not-exist.example"`
   — expect the 404 HTML. If this fails, the storefront crashed; check
   `pm2 logs gbox-storefront`.
3. Nginx error log: `sudo tail /var/log/nginx/error.log`

**Nginx reload fails with "duplicate default server"**
Somebody left a `.bak` or duplicated config file in
`/etc/nginx/sites-enabled/`. Move backups outside that dir:
`sudo mv /etc/nginx/sites-enabled/*.bak-* /tmp/`.

**Unverified domain serves content (SECURITY)**
The `WHERE verified = true` filter is the only guard. Check
`apps/storefront/src/server.ts` `lookupShopByHost` — if it's missing,
revert immediately and file an incident.

**Seller sees "God Admin" or internal path in an error**
Iron Rule #5: seller-facing UI must never leak god-admin. Replace the
message with "Please contact Gbox support" and log the real reason
server-side.

## 12. Roadmap / known gaps

1. **Origin-side TLS (ACME).** Even with Cloudflare in front, the
   CF ↔ origin leg is currently HTTP — hence **Flexible** SSL mode. The
   next phase wires ACME (Let's Encrypt HTTP-01) so nginx serves HTTPS
   at the origin; sellers (and we) can then bump CF SSL mode to **Full**
   (or **Full Strict**) for end-to-end TLS. The `acme_challenge_token` /
   `cert_path` columns are already in the schema; missing is the ACME
   client + nginx cert-reload hook. Once this ships, we can also offer a
   **bring-your-own-DNS** option (apex A + CNAME www → platform host,
   no Cloudflare required) which was dropped on 2026-04-18.

2. **Prod rollout.**
   - Provision `cdn.gbox.co A <prod-IP>` in Cloudflare (grey cloud).
   - Flip env: `GBOX_PLATFORM_IP_V4=<prod-IP>`,
     `GBOX_PLATFORM_CNAME_TARGET=cdn.gbox.co`.
   - Apply catch-all patch to prod nginx (§9 step 2).
   - Confirm every currently-verified domain (including `lifeasy.org`)
     still serves before deprecating dev.

3. **Verification cooldown / retries.** There is no rate limit on the
   Verify button. Not critical (DNS lookups are cheap) but abusable.

4. **`verification_method = 'txt'` migration.** Some legacy rows still
   have `'txt'` (pre-Phase-3A TXT challenge). They're `verified = true`
   and serve fine, but a future migration should re-verify them via the
   new flow and normalize the column.

5. **Origin rotation playbook.** `GBOX_PLATFORM_CNAME_TARGET` means
   sellers on the CNAME path (the default once ops has set the env var)
   follow us automatically when we flip `cdn.<platform>`'s A record. The
   A-records-only fallback path does NOT — those sellers pin the IP in
   their own zone and need outreach. Keep an audit query ready:
   `SELECT domain FROM shop_domains WHERE verified = true AND
    cloudflare_proxied = true AND dns_target NOT LIKE '%cloudflare%';`
   (adapt once we persist the chosen record shape).

6. **Cloudflare-dependency acknowledgement.** The current flow makes
   Cloudflare a hard dependency for every custom domain. If Cloudflare
   has an outage, custom-domain HTTPS goes with it. Acceptable tradeoff
   for launch; revisit once we have origin TLS + a diverse CDN/WAF
   story (ACME-via-nginx as fallback, eventually a multi-CDN strategy).

---

**Files touched (commit `05846e0`):**
- `packages/core/src/modules/ops/a-record-detect.ts` (new, 181 LOC)
- `packages/core/src/modules/ops/a-record-detect.test.ts` (new, 16 tests)
- `packages/core/src/modules/ops/cloudflare-detect.ts` (zone-apex walk)
- `packages/core/src/modules/ops/cloudflare-detect.test.ts` (+11 tests)
- `packages/core/src/modules/domains/cloudflare-service.ts` (unified
  `verifyDomain`)
- `apps/store-admin/src/pages/domains.ts` (two-tab UI)
- `apps/storefront/src/server.ts` (`verified = true` filter)
- `infra/nginx/custom-domain-catchall.conf` (new)
- `infra/nginx/_replace-default-server.py` (new)

**Cross-references:**
- `docs/runbooks/storefront-deploy.md` — storefront topology, PM2 layout
- `~/.claude/memory/nginx_routing.md` — full nginx route table
- `~/.claude/memory/dev_platform_domain.md` — dev vs prod domain split
