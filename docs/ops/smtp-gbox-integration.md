# SMTP-Gbox Integration Plan (Phase 12 Beta + Phase 14 Marketing)

**Filed:** 2026-04-21  
**Status:** Draft — Sprint 0 decision  
**Scope:** Where SMTP-Gbox sits in the beta email path, what stays on
direct SES, and what we defer to Phase 14.

---

## TL;DR

- **Phase 12 beta (weeks 1–4):** platform sends email via
  `packages/core/src/modules/email/service.ts` → nodemailer → AWS SES
  (`email-smtp.ap-southeast-1.amazonaws.com:587`). No SMTP-Gbox in the
  critical path.
- **SMTP-Gbox stays deployed** on server 1 (`192.168.1.13:4328`) as an
  idle-but-running service so the Phase 14 marketing engine can cut
  over without a fresh deploy.
- **Phase 14 cutover:** point marketing cron handlers at SMTP-Gbox;
  transactional traffic stays on the direct SES path.

## Why not put everything through SMTP-Gbox for beta

SMTP-Gbox is currently a thin Node/Express relay (nodemailer → SES). It
adds:

1. An extra network hop on the critical path of order confirmations +
   password resets.
2. A single point of failure that needs its own health check + PM2
   cluster + oncall alert before we'd trust it for transactional mail.
3. A place where per-shop branding, DKIM signing, unsubscribe
   footers, and bounce handling will eventually live — but none of
   that is built today.

None of this is required to ship the beta. Our existing
`email/service.ts` already handles:

- Template rendering (10 built-ins + DB override via `email_templates`).
- Per-shop Reply-To (order confirmations use the shop's support email).
- Bounce/complaint handling by relying on SES's own webhook (set up
  out-of-band via SNS → a Lambda that writes to `email_bounces`).

For beta scale (5K-10K sellers, ~20K stores, conservative email volume
estimated at 500K/month), SES direct comfortably handles the load
inside the 200 msg/sec Gbox-tier account limit.

## Deployment topology (beta)

```
┌──────────────────────────┐        ┌────────────────────┐
│ gbox-api (PM2, server 1) │───SMTP─→│  AWS SES           │
│   email/service.ts       │        │  ap-southeast-1    │
│   nodemailer             │        │  :587 STARTTLS     │
└────────────┬─────────────┘        └────────────────────┘
             │
             │ (idle, not in critical path)
             ↓
┌──────────────────────────┐
│ SMTP-Gbox (PM2, s1:4328) │   — deployed + healthy
│   Node + Express         │   — ready for Phase 14 cutover
│   nodemailer → SES       │   — NOT wired into email/service.ts yet
└──────────────────────────┘
```

Server 1 PM2 gains one extra app (`smtp-gbox`) in `ecosystem.config.cjs`.
The existing nginx config adds a **private** location block for
`/internal/smtp-gbox/*` that only accepts connections from `127.0.0.1`
(to be used by future marketing jobs that sit on the same host).

## Phase 14 cutover shape (future work, not Sprint 0)

When the marketing engine graduates from "campaign drafts" to
"multi-step drip + SMS + branded templates":

1. Add `EMAIL_RELAY_URL` env var (defaults to empty → nodemailer → SES).
2. When set, `email/service.ts` detects marketing templates
   (`category = 'marketing'`) and POSTs to `${EMAIL_RELAY_URL}/send`
   instead of calling nodemailer directly.
3. Transactional categories (`category IN ('order','auth','account')`)
   stay on direct nodemailer — same code path as today.
4. SMTP-Gbox grows:
   - Per-shop DKIM (one DNS record per shop's sending domain).
   - Bounce/complaint webhook receiver (writes to `email_bounces`).
   - Unsubscribe link rewrite (signed token → `/unsubscribe/<t>`).
   - Rate limiting per shop (protect sender reputation).

None of this is shipping in Phase 12. It's listed here so the split
between "beta path" and "Phase 14 path" is explicit.

## Sprint 0 action items (blocking)

- [ ] **Deploy SMTP-Gbox to server 1 on port 4328.** Add a PM2 entry
      in `ecosystem.config.cjs` pointing at
      `/home/botesty/SMTP-Gbox/dist/server.js`. Reload PM2 + save.
- [ ] **Health check** — add `http://192.168.1.13:4328/health` to
      `scripts/deploy/deploy-production.sh --health` endpoints list so
      the service's up/down state is visible during every deploy.
- [ ] **Nginx internal block** — copy
      `scripts/deploy/nginx-server1.conf.template` and add:
      ```
      location /internal/smtp-gbox/ {
        allow 127.0.0.1;
        deny all;
        proxy_pass http://127.0.0.1:4328/;
      }
      ```
      to be ready for Phase 14 internal calls.
- [ ] **Document env vars** — add `SMTP_GBOX_URL` (empty for beta) to
      `.env.example` with a comment explaining it's a Phase 14 hook.

## Sprint 0 action items (non-blocking)

- [ ] Add a 1-line smoke test to `scripts/ops/smoke-matrix.ts` that
      probes the health endpoint. Marked `expectedPass=true` — if it
      flips to fail we know the service died without a deploy touching
      it.
- [ ] File Phase 14 ticket to migrate SMTP-Gbox from plain relay to
      the DKIM + bounce + unsubscribe service described above.

## Open questions (answer before Phase 14 starts)

1. Do we want one SMTP-Gbox instance per region, or a single
   Singapore instance serving the whole fleet? (Marketing latency is
   less sensitive than transactional, so single-region is probably
   fine.)
2. Bounce handling: SES SNS → Lambda → DB write, OR SES SNS →
   SMTP-Gbox webhook → DB write? Second keeps all email logic in one
   service; first is simpler. Decision before Phase 14 kickoff.
3. Unsubscribe token scheme: per-shop signed JWT or single-platform
   opaque-random token? JWT is faster to validate but shop key
   rotation is painful; opaque-random is simpler but requires DB
   lookup on every unsubscribe click. Pick during Phase 14 design.
