# Accounts Portal Deployment Runbook — `gbox-accounts` (PM2)

**Filed:** 2026-04-24
**Status:** Canonical runbook (Phase 14 PR8 bug 5 fix)
**Scope:** How `gbox-accounts` (port 4323) runs on server 1, why it
matters for signup email delivery, and how to recover when it's down.

Platform-internal only. Sellers must never see this file or any of its
paths (Iron Rule 5).

---

## TL;DR

- `gbox-accounts` is a PM2-managed Node/Express process on **server 1
  (`192.168.1.13`)** bound to `127.0.0.1:4323`.
- Nginx at `http://192.168.1.13/accounts/*` proxies to it **without**
  stripping the `/accounts` prefix (the app sets `BASE_PATH='/accounts'`).
- **Phase 14 PR8 moved signup-OTP email delivery into the in-process
  `@gbox/core/modules/email` stack.** If this process is not running,
  signup verification emails never leave the box — there is no longer an
  external SMTP-Gbox relay to pick up the slack.
- When sellers report "I never got my signup code," the first question
  is always: **is `pm2 status gbox-accounts` showing `online`?**

## Why this file exists

Phase 14 PR8 post-mortem (April 2026): user `lamdiepanh1903@gmail.com`
finished the signup form but never received the OTP email. Root cause
cluster A (bugs 1–4) was that signup was calling an HTTP shim
(`smtp-gbox.ts`) instead of the in-process email module — we fixed that
by routing `POST /accounts/signup` through
`sendTemplatedEmail({ key: 'email_verify_otp' })` directly.

That fix has a hidden dependency: **the process that serves
`/accounts/signup` is the same process that must complete the SMTP
handshake to Gmail.** If PM2 has `gbox-accounts` stopped, Nginx returns
a 502 upstream error on the signup form itself — but the more insidious
failure mode is a PM2 process that's been sitting in `errored` state
for hours: the old pre-PR8 signup path would silently post to
SMTP-Gbox anyway, so nobody noticed. Post-PR8 the silence is the bug.

This doc locks in the expectation that `gbox-accounts` is a **critical
path service**, not an optional auth UI.

## Topology

```
 Internet  ─┐
            │  http://192.168.1.13/accounts/*
            ▼
 ┌──────────────────────────────────────────┐
 │ Nginx :80 on server 1                    │   /etc/nginx/sites-enabled/gbox
 │ proxy_pass → 127.0.0.1:4323              │   (no rewrite — BASE_PATH stays)
 └──────────────┬───────────────────────────┘
                │
                ▼
 ┌──────────────────────────────────────────┐
 │ gbox-accounts (PM2, server 1)            │   apps/accounts/src/server.ts
 │   Express + pages/signup.ts              │   port 4323, fork mode, 1 inst
 │   @gbox/core/modules/email/send.ts       │   in-process SMTP → Gmail
 └──────────────┬───────────────────────────┘
                │
                │  SMTP (nodemailer, STARTTLS)
                ▼
 ┌──────────────────────────────────────────┐
 │ smtp.gmail.com:587                       │   credentials from env:
 │   AUTH: EMAIL_SMTP_USER / _PASS          │   EMAIL_SMTP_HOST, _PORT,
 │   FROM: notifications@gbox.co            │   _USER, _PASS
 └──────────────────────────────────────────┘
```

Key invariants:

- **Single instance, fork mode.** Not clustered. Signup rate is tiny
  (~3% of total traffic per ecosystem comment); more replicas buys us
  nothing and complicates the cron landscape.
- **`NODE_OPTIONS='--import tsx'`** — the entrypoint is
  `apps/accounts/src/server.ts` (TypeScript, not compiled). PM2 starts
  it through the tsx loader. Forgetting this (or tsx not being
  installed) is a common post-pull failure mode.
- **`PORT=4323`** hardcoded in PM2 env. Nginx must match.
- **`NODE_ENV=production`** — this is what flips the new bug-6 guard
  in `resolveTransport()` from "silent ConsoleTransport fallback" to
  "refuse to boot if SMTP creds are missing." If a future ops engineer
  "helpfully" sets `NODE_ENV=development` to see more logs, signup OTPs
  will start going to stdout instead of to the user — and the bug will
  look like the pre-PR8 bug all over again.

## PM2 entry (canonical)

From `ecosystem.config.cjs`:

```js
{
  name: 'gbox-accounts',
  script: 'apps/accounts/src/server.ts',
  interpreter: 'node',
  instances: 1,
  exec_mode: 'fork',
  max_memory_restart: '512M',

  env: {
    NODE_ENV: 'production',
    NODE_OPTIONS: '--import tsx',
    PORT: 4323,
    DATABASE_URL: DB_URL,
  },

  kill_timeout: 5000,
  listen_timeout: 5000,
  max_restarts: 10,
  restart_delay: 1000,
  autorestart: true,

  error_file: '/var/log/gbox/accounts-error.log',
  out_file:   '/var/log/gbox/accounts-out.log',
  merge_logs: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
}
```

The env vars listed there are only the PM2-injected ones.
`gbox-accounts` also reads `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`,
`EMAIL_SMTP_USER`, `EMAIL_SMTP_PASS`, and `EMAIL_FROM_ADDRESS` from
`/etc/gbox/env` (loaded into the pm2 user's shell profile). Without
those the PR8 transport resolver throws `EmailTransportMisconfiguredError`
at first send attempt — by design.

## Standard operations

All commands run as the `gbox` pm2 user on server 1 (`192.168.1.13`).
Credentials live in `server_credentials.md` (internal memory).

### Check status

```bash
pm2 status gbox-accounts
# Expect:  status=online, uptime>0, restart count low (<3)
```

### Start / stop / restart

```bash
# Start (first boot after a clean deploy):
pm2 start ecosystem.config.cjs --only gbox-accounts

# Restart (after code change / after fixing env):
pm2 restart gbox-accounts --update-env
#   --update-env reloads /etc/gbox/env; without it PM2 keeps the old values

# Stop (maintenance window — note: signup stops working for sellers):
pm2 stop gbox-accounts
```

### Verify health

Two layered checks — run both, in order:

```bash
# 1. Process answers on loopback
curl -sS http://127.0.0.1:4323/health
#    expect: {"status":"ok","service":"gbox-accounts","timestamp":"..."}

# 2. Nginx is actually proxying
curl -sS -I http://192.168.1.13/accounts/login | head -1
#    expect: HTTP/1.1 200 OK    (not 502, not 404)
```

If (1) passes but (2) fails, the app is fine — check Nginx config and
`sudo systemctl reload nginx`. If (1) fails, go to logs.

### Tail logs

```bash
pm2 logs gbox-accounts --lines 200

# or direct:
sudo tail -f /var/log/gbox/accounts-out.log
sudo tail -f /var/log/gbox/accounts-error.log
```

What to look for:

| Symptom in logs                                              | Likely cause                                                  | Action                                                                 |
|--------------------------------------------------------------|---------------------------------------------------------------|------------------------------------------------------------------------|
| `EmailTransportMisconfiguredError`                           | PR8 bug-6 guard fired: `NODE_ENV=production` but no SMTP env  | Populate `EMAIL_SMTP_*` in `/etc/gbox/env` and `pm2 restart --update-env` |
| `Cannot find module 'tsx'`                                   | `NODE_OPTIONS='--import tsx'` but tsx not installed           | `cd /path/to/gbox-platform && npm install` then restart                |
| `listen EADDRINUSE 127.0.0.1:4323`                           | Stale process from a prior `pm2 start` without `--only`       | `pm2 delete gbox-accounts` then start fresh                            |
| `PoolTimeoutError` from `@gbox/db`                           | Postgres on server 1 is the bottleneck, not accounts          | Escalate to DB oncall, `psql -U gbox gbox_platform -c 'select 1'`      |
| Process restart count climbing (`pm2 status` shows 10, 20+)  | Crash loop — usually a TS compile error or missing env        | `pm2 logs gbox-accounts --err --lines 500` and read the stack          |
| Signups succeed but no email lands                           | `gbox-accounts` up, SMTP creds wrong OR Gmail auth expired    | Check `email_deliveries` for `status='failed'` rows, see email runbook |

### First-boot checklist after a clean pull / redeploy

1. `git pull` on server 1.
2. `npm install` at repo root (shared node_modules — a `tsx` version
   bump would affect all apps).
3. Check migrations: `cd packages/db && npx tsx src/migrations/run.ts`
   (idempotent — Phase 11 PR1 migration-ledger guards against drift).
4. Sanity-check env: `grep EMAIL_SMTP /etc/gbox/env` should show four
   non-empty values.
5. `pm2 restart gbox-accounts --update-env`.
6. Run the two-layer verify (`curl /health` + `curl /accounts/login`).
7. End-to-end smoke: submit a real signup at
   `http://192.168.1.13/accounts/signup` with a disposable Gmail
   address, confirm the OTP email lands within ~10 s, check
   `email_deliveries` for the `status='sent'` row.

## Why this process is signup-critical (PR8 context)

Before PR8, `apps/accounts/src/pages/signup.ts` posted the OTP to an
internal HTTP relay (`smtp-gbox.ts` shim → server 1:4328). That relay
did its own SMTP dial. The accounts process could restart, redeploy,
or even be offline briefly, and the relay kept buffering/retrying.

PR8 cluster-A (commit `b925dae`) removed the shim. Signup now calls
`sendTemplatedEmail({ key: 'email_verify_otp', ... })` in-process,
which:

1. Inserts a `queued` row in `email_deliveries` with an
   `idempotency_key` (so retries don't double-send).
2. Resolves the transport (`resolveTransport()` — Gmail SMTP in prod).
3. Dials the SMTP server and sends.
4. Updates the row to `sent` (with `smtp_message_id`) or `failed`
   (with `failed_reason`).

All four steps happen inside the `gbox-accounts` Node process. If the
process dies between step 1 and step 4, the row is a **zombie** —
PR8 cluster-D (commit `4d3f856`) added a cron janitor that sweeps
zombie rows older than 10 minutes and marks them `failed` so the user
can re-request. But a dead process does not revive by itself. The
janitor runs in `gbox-api` (server 1:4321), not in `gbox-accounts`,
so zombie cleanup survives — but **new signup attempts against a dead
`gbox-accounts` return 502 immediately** because Nginx has no upstream.

This is the correct failure mode (loud, user-visible, ticket-able)
versus the previous silent-drop. But it means ops must now treat
`gbox-accounts` uptime with the same seriousness as `gbox-api`.

## When a seller reports "I didn't get my signup code"

Triage order (Iron Rule 5 applies to anything you say back to them —
"Please contact Gbox support" is the only acceptable seller-facing copy):

1. **Is `gbox-accounts` running?** `pm2 status gbox-accounts`. If not:
   start it, then ask them to retry signup. The old OTP is dead (30 s
   TTL in signup.ts — long dead by the time this conversation happens).

2. **Did the signup form actually submit?** Query:
   ```sql
   SELECT id, email, status, created_at
   FROM   email_deliveries
   WHERE  template_key = 'email_verify_otp'
     AND  to_address   = '<seller@example.com>'
   ORDER  BY created_at DESC
   LIMIT  5;
   ```
   - No row → form never posted, or `sendTemplatedEmail` threw before
     insert. Check `/var/log/gbox/accounts-error.log` for the signup
     request timestamp.
   - `status='queued'` and old → zombie, janitor hasn't run yet
     (runs every 5 min, 10 min grace). Wait or force a run manually.
   - `status='failed'` → read `failed_reason`. Common ones: Gmail
     rate limit, expired app password, recipient on SES suppression
     list (for future-migration tenants).
   - `status='sent'` → email actually left the box. Ask the seller to
     check spam, check primary/promotions tabs, confirm the address.

3. **If unclear**: the seller can safely re-submit signup (the
   idempotency key includes a timestamp bucket, so they'll get a fresh
   OTP). Never tell them "SMTP is down" or "our accounts service
   restarted" — say "Please try requesting a new code; if it still
   doesn't arrive please contact Gbox support."

## Cross-references

- Ecosystem config: `ecosystem.config.cjs` (search `gbox-accounts`).
- Signup helper: `apps/accounts/src/lib/send-signup-otp.ts`.
- Transport resolver + prod guard: `packages/core/src/modules/email/transport.ts`.
- Zombie janitor: `packages/core/src/modules/email/zombie-janitor.ts`
  (handler registered in `packages/core/src/modules/cron/service.ts`,
  seeded by `seedEmailZombieJanitorCron()` in `server.ts`).
- SMTP-Gbox relay (historical — no longer in signup path):
  `docs/ops/smtp-gbox-integration.md`.
- Release gates (run before touching any of this): `docs/ops/release-checklist.md`.
