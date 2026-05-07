# Gbox Platform — Phase 6 Production Hardening Runbook

**Phase 6 — Backups, custom domains, SSL, smoke gating.**
**Target:** Test server 1 (`192.168.1.13`) running Ubuntu, nginx as the
reverse proxy, PM2 as the Node.js process manager.
**Audience:** You, six months from now, at 3 am.

This runbook covers the day-2 ops surface we built in Phase 6:

1. Enhanced `/_health` (Phase 6.1)
2. Postgres backup + restore automation (Phase 6.2)
3. Custom domain DNS TXT verification (Phase 6.3)
4. SSL/ACME provisioning + renewal (Phase 6.4)
5. Unified smoke test orchestrator (Phase 6.5)

The order below is the order you wire them up on a fresh box.

---

## 1. Enhanced `/_health` (Phase 6.1)

Each long-running service now exposes a `/_health` endpoint that does
a **DB ping + Redis ping** before returning 200. The storefront wires
this in `apps/storefront/src/server.ts` via `healthHandler:
healthCheck(db)`.

**Verify:**

```bash
curl -s http://127.0.0.1:4324/_health | jq
# {
#   "status": "ok",
#   "service": "gbox-storefront",
#   "checks": { "db": "ok", "redis": "ok" },
#   "timestamp": "..."
# }
```

If a dependency is down the endpoint returns **503** with the
broken check named in the body. Wire this URL into:

- nginx upstream health checks
- Uptime Kuma / Healthchecks.io
- The `[storefront]` row in `scripts/ops/smoke-all.ts`

---

## 2. Postgres backups (Phase 6.2)

### 2a. Manual backup

```bash
sudo -u postgres bash scripts/ops/backup-postgres.sh
# → /var/backups/gbox/gbox-gbox_platform-20260409T023000Z.sql.gz
# → /var/backups/gbox/gbox-gbox_platform-latest.sql.gz (symlink)
```

Environment variables (all optional):

| Var | Default | Notes |
|---|---|---|
| `PGHOST` | `127.0.0.1` | DB host |
| `PGPORT` | `5432` | |
| `PGUSER` | `postgres` | Must have CONNECT + USAGE on the DB |
| `GBOX_DB` | `gbox_platform` | Use `gbox_platform`, **not** `gbox_test` |
| `BACKUP_DIR` | `/var/backups/gbox` | Created if missing |
| `BACKUP_RETAIN_DAYS` | `14` | Files older than this are deleted |
| `R2_REMOTE` | _(unset)_ | If set (e.g. `cf-r2:gbox-backups`), uploads via `rclone copy` |

### 2b. Cron schedule

Recommended `crontab -e` entry on the DB box:

```cron
15 2 * * * cd /home/gbox/gbox-platform && \
  R2_REMOTE=cf-r2:gbox-backups \
  bash scripts/ops/backup-postgres.sh \
  >> /var/log/gbox/backup.log 2>&1
```

### 2c. Restore (DRY-RUN by default)

```bash
# Dry run — prints what it would do, never touches the DB.
sudo -u postgres bash scripts/ops/restore-postgres.sh \
  /var/backups/gbox/gbox-gbox_platform-20260409T023000Z.sql.gz

# Actual restore — requires --yes.
sudo -u postgres bash scripts/ops/restore-postgres.sh \
  /var/backups/gbox/gbox-gbox_platform-20260409T023000Z.sql.gz --yes
```

The restore is wrapped in `psql --single-transaction --set
ON_ERROR_STOP=1` so a partial failure rolls back instead of leaving
the DB in a half-imported state.

### 2d. Inventory + alerting

The god-admin "Backup status" card calls
`summariseBackups()` from
`packages/core/src/modules/ops/backups.ts` to render:

- Latest snapshot age (`hoursSinceLatest`)
- Health (`healthy` / `stale` / `missing`) — stale at >26h
- Total snapshot count + bytes

The same module ships `pickStaleBackups()` for the prune cron.
**Don't reimplement either of these in the dashboard or the cron** —
share the helper so they can never disagree.

---

## 3. Custom domain DNS TXT verification (Phase 6.3)

### 3a. The flow

1. Merchant adds a domain in god-admin → row inserted into
   `shop_domains` with `verified=false`.
2. We generate a token: `generateVerificationToken()` →
   64 hex chars → stored in `shop_domains.verification_token`.
3. UI shows them the instructions from
   `buildVerificationInstructions()`:
   ```
   Type:  TXT
   Host:  _gbox-verify.<their-domain>
   Value: gbox-site-verification=<token>
   ```
4. Merchant publishes the record at their DNS provider.
5. Background job (or "Verify now" button) calls
   `verifyDomainTxt()` → if `ok: true`, set `verified=true` and
   `verified_at=NOW()`.

### 3b. Result vocabulary

`verifyDomainTxt()` returns one of:

| `reason` | UI message | Operator action |
|---|---|---|
| `ok: true` | "Verified ✓" | Hand off to SSL issuance (§4) |
| `not_found` | "DNS may still be propagating" | Wait + retry |
| `mismatch` | "Wrong value" | Show expected value again |
| `lookup_error` | "Couldn't reach DNS, retrying" | Investigate resolver |
| `invalid_token` | (never shown — internal bug) | Check `verification_token` |

The `not_found` vs `lookup_error` split matters: `not_found` means
NXDOMAIN (the merchant just hasn't published yet) and the cron
should keep polling. `lookup_error` means SERVFAIL/timeout — likely
our resolver is broken, alert ops.

### 3c. Subdomain pattern

We **never** read the apex TXT. The lookup is always at
`_gbox-verify.<domain>` so:

- We don't conflict with SPF/DKIM/DMARC/Google site verification.
- The merchant can leave the record in place forever as a "this
  domain belongs to gbox" breadcrumb.

---

## 4. SSL/ACME provisioning (Phase 6.4)

### 4a. One-time setup (per box)

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
```

### 4b. Issue a cert manually

```bash
sudo ACME_EMAIL=ops@gbox.co \
  bash scripts/ops/issue-ssl-cert.sh shop.example.com
```

For first-time wiring on a new merchant, use staging first to avoid
burning Let's Encrypt rate limits while you fix DNS:

```bash
sudo CERTBOT_STAGING=1 ACME_EMAIL=ops@gbox.co \
  bash scripts/ops/issue-ssl-cert.sh shop.example.com
```

When DNS is correct, drop `CERTBOT_STAGING=1` and re-run.

### 4c. Daily renewal cron

```cron
30 3 * * * cd /home/gbox/gbox-platform && \
  SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
  bash scripts/ops/renew-ssl-certs.sh \
  >> /var/log/gbox/ssl-renew.log 2>&1
```

The script runs `certbot renew` then hands off to the TypeScript
reconciler that updates `shop_domains.ssl_*` columns. Failures
fire a Slack alert but never block other domains.

### 4d. Decision logic

Both the cron and the god-admin "SSL fleet status" card call
`planCertAction()` from
`packages/core/src/modules/ops/ssl-cert.ts`:

| State | Action |
|---|---|
| `verified=false` | `wait_verification` (do nothing) |
| `verified=true`, no cert | `issue` |
| `verified=true`, expires > 30d | `skip` |
| `verified=true`, expires ≤ 30d | `renew` |
| `verified=true`, already expired | `renew` |

The 30-day window is configurable via the `renewBeforeDays` option
but **don't lower it without thinking**: it's our buffer against a
long weekend of failed renewals.

`summariseSslFleet()` rolls up the same shape into the dashboard
counts (healthy / expiringSoon / expired / missing / unverified).

---

## 5. Smoke test gating (Phase 6.5)

### 5a. Run before declaring a release done

```bash
pnpm tsx scripts/ops/smoke-all.ts
```

Output:

```
== gbox smoke ==
host: 127.0.0.1

  [PASS] api                              http://127.0.0.1:4321/_health → 200 (12ms)
  [PASS] admin                            http://127.0.0.1:4322/_health → 200 (8ms)
  [PASS] accounts                         http://127.0.0.1:4323/_health → 200 (9ms)
  [PASS] storefront                       http://127.0.0.1:4324/_health → 200 (11ms)
  [PASS] checkout                         http://127.0.0.1:4326/_health → 200 (7ms)
  [PASS] pg                               select from shops ok (14ms)
  [PASS] redis                            ping → PONG (3ms)

  7 passed, 0 failed (64ms total)
```

### 5b. From a remote workstation

```bash
SMOKE_HOST=192.168.1.13 pnpm tsx scripts/ops/smoke-all.ts
```

Note: only works if those ports are exposed off-box. By default
they're not — run from on-box, or via `ssh srv1 'cd ~/gbox-platform
&& pnpm tsx scripts/ops/smoke-all.ts'`.

### 5c. Exit codes

- `0` — every probe green. Safe to proceed.
- `1` — at least one probe red. Read the report row-by-row.
- `2` — orchestrator itself crashed. Likely a missing dependency
  or an import-time error in the new code.

### 5d. The slow per-feature smokes

`scripts/smoke-*.ts` (thank-you, liquidjs, storage, i18n, etc.)
exercise specific features end-to-end and are too slow to run on
every deploy. Run them by hand when:

- You touch the file paths they cover.
- A user reports a feature-specific bug.
- You're qualifying a release candidate.

---

## 6. On-call cheat sheet

| Alert | First step |
|---|---|
| `/_health` 503 | `curl /_health \| jq` to see which dependency |
| Backup stale > 26h | Tail `/var/log/gbox/backup.log`, check disk space |
| SSL fleet has `expired > 0` | `bash scripts/ops/renew-ssl-certs.sh` manually |
| New merchant stuck on "verifying" | TXT lookup the `_gbox-verify.<domain>` host yourself |
| Smoke `[pg]` red | `pg_isready -h <db-host>`, then check pg_hba |
| Smoke `[redis]` red | `redis-cli ping`, check `REDIS_URL` env on the box |

---

## 7. What's NOT in Phase 6 (and where to find it)

- **Read replica routing** → Phase 8.2 (`getReadDb()` in core/db).
- **Cache wrappers around storefront drops** → Phase 8.1.
- **Sanitize-response middleware** → Phase 7.1.
- **Admin hierarchy / RBAC** → Phase 7.2.
- **k6 load tests** → Phase 8.4.
