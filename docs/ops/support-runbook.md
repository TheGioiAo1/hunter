# Support System Runbook — Phase 12.5

The internal ↔ seller support system lives in three processes:

1. **store-admin** (:4322) — seller-facing widget, ticket list, reply UI,
   CSAT prompt. Merchant API under `/api/support/*`.
2. **supporter.gbox.co** (:4328) — dedicated Astro app for Gbox staff
   (L1 / L2 / Lead agents). Full inbox, canned replies, analytics,
   audit log. Port override via `SUPPORTER_PORT` env.
3. **API node + cron** — SLA engine, auto-close, CSAT auto-prompt,
   retention cleanup. All four jobs are wired in `server.ts` boot path
   via `seedSupportCronTasks()` and driven by the existing `cron_tasks`
   poller.

This doc is for **platform engineers and Gbox on-call**. It never
surfaces to sellers (Iron Rule 5).

---

## Cron jobs at a glance

| Handler                      | Schedule        | Module                                            | Purpose                                                                            |
| ---------------------------- | --------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `support_sla_tick`           | every 5 min     | `support-sla/engine.ts::tickSla`                  | Scan non-terminal tickets, detect SLA breach, bump priority, page Lead for >2×.    |
| `support_csat_prompt`        | every 15 min    | `support-notifications/csat-auto-prompt.ts`       | Fire CSAT prompt 60 min after a ticket closes.                                     |
| `support_auto_close`         | every 15 min    | `support-notifications/auto-close.ts`             | Warn at 6 days pending_seller, close at 7 days with 1-day grace post-warning.      |
| `support_retention_cleanup`  | quarterly       | `support-notifications/retention-cleanup.ts`      | Soft-archive tickets whose `closed_at` is older than 365 days.                     |

Handlers are registered as module-level side effects in
`packages/core/src/modules/cron/service.ts`. Rows in `cron_tasks` are
seeded on boot by `seedSupportCronTasks()` (idempotent — re-running is
safe).

Disable all four on a replica node with `DISABLE_SUPPORT_CRON=1`.

---

## Schema cheat sheet

| Table                                   | Migration | Purpose                                                                         |
| --------------------------------------- | --------- | ------------------------------------------------------------------------------- |
| `support_tickets`                       | 074       | One row per ticket. Status machine, SLA deadlines, counters, archive markers.   |
| `support_messages`                      | 074       | AES-256-GCM encrypted bodies. `body_key_version` drives key rotation.           |
| `support_ticket_events`                 | 074       | Append-only audit: `ticket_opened`, `message_added`, `status_changed`, `claimed`, `priority_changed`, `csat_prompted`, `csat_submitted`, `auto_close_warned`, `auto_closed`. |
| `support_mentions`                      | 074       | @-mentions inside internal notes. Fans out to `mention` notifications.          |
| `support_canned_replies` / `_templates` | 075       | Shared vocab of PayPal-onboarding responses + shop-specific overrides.          |
| `support_agent_profiles`                | 076       | Per-agent display name + skill tags + business-hours overrides.                 |
| `support_csat_responses`                | 077       | 1-5 star rating + freeform comment, one row per ticket max.                     |
| `support_notification_preferences`      | 077       | Per-user channel toggles + quiet hours + push subscription.                     |
| `support_retention_policy`              | 078       | Platform-wide knobs (retention days, archive mode).                             |
| `support_staff_invitations`             | 079       | SHA-256 token hash + 7-day TTL.                                                 |
| `support_audit_log`                     | 080       | Every staff-side mutation + permission denial.                                  |
| `support_ai_usage`                      | 081       | Anthropic token + cost ledger (one row per call).                               |
| `support_notifications_log`             | 082       | **Append-only** per-dispatch audit. One row per channel attempt.                |
| `support_retention_runs`                | 082       | One row per retention cron tick. Ledger for ops.                                |

---

## Key rotation (encryption at rest)

Message bodies are AES-256-GCM encrypted with a key referenced by
`body_key_version`. The current version is set by the
`SUPPORT_MESSAGE_KEYS` env var, a JSON map:

```bash
SUPPORT_MESSAGE_KEYS='{"v1":"BASE64_32_BYTES","v2":"BASE64_32_BYTES"}'
SUPPORT_MESSAGE_KEY_CURRENT='v2'
```

To rotate:

1. Generate a new 32-byte key: `openssl rand -base64 32`.
2. Append a new entry to `SUPPORT_MESSAGE_KEYS` (e.g. `"v3": "..."`).
   **Keep old entries** so old messages still decrypt.
3. Bump `SUPPORT_MESSAGE_KEY_CURRENT` to the new version.
4. Restart all API nodes (`pm2 restart api`).
5. Run `scripts/ops/rotate-support-message-keys.ts --batch=500`
   (future PR) to re-encrypt existing rows at leisure. Until then,
   old rows stay on `v1`/`v2` and decrypt transparently on read.

**Never delete an old key** until you can prove every
`support_messages` row has been re-encrypted off it (`SELECT DISTINCT
body_key_version FROM support_messages` should not include it).

---

## Inviting staff

From `supporter.gbox.co`:

1. Sign in as **Lead** (Lead invites are a god-admin function until
   we have a "promote to Lead" UI — ping Thai if a new Lead is needed).
2. Go to **Team → Invite member**.
3. Pick preset: L1 (front-line triage), L2 (escalation + cross-shop
   read), Lead (full access + team analytics + 2FA mandatory).
4. Enter the new agent's Gbox email address. The system generates a
   SHA-256-hashed token and sends an invite email that expires in 7
   days.
5. The new agent clicks the link, sets a password (bcrypt), enables
   TOTP (required for Lead, optional for L1/L2), and lands on the
   inbox.

Invites are idempotent on email: a second invite to the same pending
email replaces the token without creating a duplicate row (enforced by
the UNIQUE partial index).

---

## Handling an SLA breach

The `support_sla_tick` cron logs every breach to
`support_notifications_log` with `notification_type` of
`sla_first_response_breach` or `sla_resolution_breach`. It also bumps
`support_tickets.priority` according to `decideEscalation`:

| State                                 | Action                                                     |
| ------------------------------------- | ---------------------------------------------------------- |
| Assigned + overdueRatio ≤ 2           | `mild` — log + notify assignee.                            |
| Assigned + overdueRatio > 2           | `bumpPriority` + page Lead.                                |
| Unassigned (no agent claimed)         | `bumpPriority` + page Lead, regardless of ratio.           |
| `sla_resolution_at` overdue, ratio >1 | `bumpPriority` + page Lead.                                |

The priority ladder is `low → normal → high → urgent` (caps at urgent).

On page:

1. Check **supporter.gbox.co → Inbox filter "Breached"**.
2. If Lead is on leave, escalate manually via Slack #support-ops.
3. Reply from the supporter UI. The ticket's
   `sla_first_response_notified_at` / `sla_resolution_notified_at`
   marker prevents duplicate pages for the same breach.

SLA breach notifications **bypass quiet hours** (Q2.10 — an overdue
ticket is operationally urgent). They are also **rate-limited to 1
email/hour/ticket/type** via `support_notifications_log` so a
persistently breached ticket doesn't hammer an inbox.

---

## Auto-close lifecycle

Once an agent replies and the ticket moves to `pending_seller`,
`setStatus()` stamps `pending_seller_since`. The `support_auto_close`
cron then:

- **T+6 days** (6d pending, no warning yet) → send
  `auto_close_warning` notification, stamp `auto_close_warned_at`,
  write `auto_close_warned` event.
- **T+7 days** (7d pending, warning sent ≥24h ago) → transition
  status → `closed`, stamp `closed_at`, clear `pending_seller_since`,
  write `auto_closed` + `status_changed` events, send `auto_close`
  notification.

The **24-hour grace window after warning** is enforced by the
`warningStaleThreshold` check in `auto-close.ts` — a ticket that hits
7d without ever being warned will be warned on the next tick but
**not closed in the same tick**. This prevents the warn-and-close-in-
same-tick anti-pattern.

Seller can reopen within the reopen window (7d) — that path lives in
`support/service.ts::reopenTicket` and clears both
`pending_seller_since` and `auto_close_warned_at`.

---

## Retention cleanup

Quarterly cron reads tickets with `closed_at < now() - 365d` and
`archived_at IS NULL`, then:

- `mode='archive'` (default): stamps `archived_at`,
  `archive_location='local_soft'`, `archive_manifest` (JSON with DJB2
  subject hash). Archived rows disappear from default queries (every
  support query filters `archived_at IS NULL`).
- `mode='dry_run'`: counts candidates without touching. Useful from
  `/god-admin/support/retention` to preview the next run.
- `mode='delete'` and `'archive_and_delete'`: intentionally **not
  wired**. Future PR will add S3/Glacier uploader then flip the
  default. Soft-archive first, measure, only then hard-delete.

Every run writes one row to `support_retention_runs` — ops can
reconstruct any quarter's sweep by SQL:

```sql
SELECT run_started_at, mode, candidates_found, tickets_archived, error_message
FROM support_retention_runs
ORDER BY run_started_at DESC
LIMIT 20;
```

---

## Channel routing

Notification → channel mapping lives in `preferences.ts::channelsForType`:

| Notification type                | Default channels  |
| -------------------------------- | ----------------- |
| `sla_first_response_breach`      | in_app + email    |
| `sla_resolution_breach`          | in_app + email    |
| `auto_close_warning`             | in_app + email    |
| `auto_close`                     | in_app + email    |
| `new_message_to_agent`           | in_app + email    |
| `new_message_to_seller`          | in_app + email    |
| `ticket_assigned`                | in_app + email    |
| `mention`                        | in_app + email    |
| `csat_prompt`                    | in_app + email    |

Per-user overrides on `support_notification_preferences` can disable
any channel or enable `browser_push` (MVP stub — PR7 will wire real
Web Push delivery). Quiet hours suppress email + push for non-SLA
types; SLA breaches always fire.

Audit trail: every dispatch attempt (sent / skipped / failed) writes
one row to `support_notifications_log`. To investigate a "why didn't
my user get the email?" report:

```sql
SELECT created_at, notification_type, channel, status, error
FROM support_notifications_log
WHERE ticket_id = '<id>' AND recipient_user_id = '<uid>'
ORDER BY created_at DESC
LIMIT 20;
```

---

## Monitoring quick queries

```sql
-- SLA breach rate (last 24h, by notification_type)
SELECT notification_type, COUNT(*)
FROM support_notifications_log
WHERE created_at > now() - interval '24 hours'
  AND notification_type LIKE 'sla_%'
GROUP BY 1 ORDER BY 2 DESC;

-- Auto-close activity (last 30d)
SELECT date_trunc('day', created_at) AS day,
       COUNT(*) FILTER (WHERE event_type='auto_close_warned') AS warned,
       COUNT(*) FILTER (WHERE event_type='auto_closed') AS closed
FROM support_ticket_events
WHERE created_at > now() - interval '30 days'
GROUP BY 1 ORDER BY 1 DESC;

-- CSAT response rate (last 7d)
SELECT COUNT(*) FILTER (WHERE csat_rated_at IS NOT NULL)::float /
       NULLIF(COUNT(*) FILTER (WHERE csat_prompted_at IS NOT NULL), 0) AS response_rate
FROM support_tickets
WHERE closed_at > now() - interval '7 days';

-- Ticket age distribution
SELECT status,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY now() - created_at) AS p50,
       PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY now() - created_at) AS p90
FROM support_tickets
WHERE archived_at IS NULL
GROUP BY status;
```

---

## Iron rule 5 compliance

Every seller-facing notification body routes through `safeMessage()`
from the support module. Internal staff terminology
(`/god-admin`, "feature flag", "platform settings") is scrubbed by
`assertSellerSafe()` in PR1's `safe-message.ts`. The Phase 12.5 PR5
smoke (`scripts/smoke-phase12-5-pr5.ts`) regex-checks all three
auto-generated body templates on every CI run.

**Never** add a new notification type without also updating
`channelsForType()` and running:

```bash
npx tsx scripts/smoke-phase12-5-pr5.ts
npx tsx scripts/smoke-phase12-5-pr6.ts
```

---

## Incident response

| Symptom                                                | Likely cause                                                              | Fix                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No SLA pages firing despite breaches visible in inbox  | `support_sla_tick` cron not running                                       | Check `pm2 logs api` for `[support-cron]` on boot. Verify `DISABLE_SUPPORT_CRON` env is unset on primary.            |
| Duplicate CSAT prompts                                 | `csat_prompted_at` marker not written (tx rollback)                       | Check `support_notifications_log` for recent `csat_prompt` rows. Confirm `csat_prompted_at` column exists on ticket. |
| Seller reports "I keep getting closed prompts"         | `auto_close_warned_at` not cleared on reply                               | Verify `setStatus('pending_agent')` wrapper clears both markers. Tail `pino` for the ticket id.                      |
| Encrypted body decrypt fails                           | Key version drift between nodes                                           | All API nodes must share the same `SUPPORT_MESSAGE_KEYS` map. Inspect env; restart odd node.                         |
| Retention sweep stalls                                 | Large candidate set + small `batchLimit`                                  | Bump `batchLimit` via admin panel. Each run records its candidate count in `support_retention_runs`.                 |

---

## Related docs

- `docs/superpowers/specs/2026-04-21-phase-13-support-chat-tickets.md` — spec v3 (LOCKED).
- `docs/superpowers/plans/2026-04-22-phase-12-5-support-mvp-plan.md` — 6-PR implementation plan.
- `docs/ops/release-checklist.md` — generic preflight gates.
- `docs/ops/test-matrix.md` — smoke-matrix runbook.
