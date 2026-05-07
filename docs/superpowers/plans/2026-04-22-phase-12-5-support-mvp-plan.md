# Phase 12.5 Support MVP — Implementation Plan

**Date:** 2026-04-22
**Branch:** `feat/phase-12-5-support-mvp` (off master @ `0060f2c`)
**Spec:** `docs/superpowers/specs/2026-04-21-phase-13-support-chat-tickets.md` (v3 LOCKED)
**Effort:** ~10 engineering days, 6 PRs, ship parallel with beta week 1
**Authority:** Standing directive "làm 1 mạch, anh cho em toàn quyền" (2026-04-22)

---

## Goal in one sentence

Ship a Shopify/Zendesk-class seller ↔ Gbox support chat + ticket system with
AES-256-GCM encryption at rest, dedicated staff portal at `supporter.gbox.co`,
AI Support layer 1 (Hybrid Sonnet 4.5 + Opus 4), SLA engine, and CSAT loop —
all parallel with beta week 1, with zero external bridges (no Telegram, Zalo,
SMS, or inbound email), and with Iron Rule 5 compliance (zero "god admin" leaks
in seller UI).

---

## PR sequence + dependencies

```
PR1 (DB + crypto + rate limit + service) ─┬─ PR2 (seller widget + merchant API)
                                            ├─ PR3 (supporter.gbox.co staff portal)
                                            ├─ PR4 (AI Support Hybrid)
                                            ├─ PR5 (SLA cron + notifications + CSAT)
                                            └─ PR6 (polish + smoke E2E + deploy)

PR1 is the foundation — every subsequent PR imports from it.
PR2, PR3, PR4, PR5 can ship in any order once PR1 is green.
PR6 depends on PR2 + PR3 + PR5 at minimum (AI is optional at deploy time via C2 null-key fallback).
```

---

## Migration numbering (reserved)

Last landed migration: **073_oauth_token_encryption**. Phase 12.5 reserves 074–082:

| # | Migration | PR |
|---|-----------|----|
| 074 | `074_support_tickets_and_messages` (aggregates + events + edits + mentions) | PR1 |
| 075 | `075_support_canned_replies_and_templates` | PR1 |
| 076 | `076_support_agent_profiles` | PR1 |
| 077 | `077_support_csat_and_preferences` | PR1 |
| 078 | `078_support_retention_cleanup_schedule` (cron config + 1yr retention) | PR1 |
| 079 | `079_support_staff_invitations` | PR3 |
| 080 | `080_support_audit_log` | PR3 |
| 081 | `081_support_ai_usage` (budget tracking + per-call costs) | PR4 |
| 082 | `082_support_notifications_prefs` | PR5 |

Phase 13 reserves 083+ for attachments, full-text search, reactions, presence, etc.

---

## PR1 — Core DB + crypto + rate limit + service (2 days)

### Files to create

```
packages/db/src/migrations/074_support_tickets_and_messages.ts
packages/db/src/migrations/075_support_canned_replies_and_templates.ts
packages/db/src/migrations/076_support_agent_profiles.ts
packages/db/src/migrations/077_support_csat_and_preferences.ts
packages/db/src/migrations/078_support_retention_cleanup_schedule.ts

packages/core/src/modules/support/
├── crypto.ts                          # AES-256-GCM wrapper (reuses pattern from oauth-token-crypto)
├── crypto.test.ts                     # encrypt/decrypt round-trip + key rotation
├── types.ts                           # TypeScript models (Ticket, Message, Event, etc.)
├── service.ts                         # createTicket, addMessage, changeStatus, claim, etc.
├── service.test.ts                    # 30+ tests covering happy + sad paths
├── queries.ts                         # Kysely query builders (scoped by shop_id)
├── queries.test.ts                    # cross-shop leak tests
├── rate-limit.ts                      # tokenBucket: 10 tickets/hour/shop, 60 msgs/hour/user
├── rate-limit.test.ts                 # burst, drip, reset
├── sla-calc.ts                        # SLA deadline computation (payment 2h vs others 4h, BH hybrid)
├── sla-calc.test.ts                   # timezone edge cases (ICT, UTC boundary, weekend)
├── safe-message.ts                    # safeMessage() returning "Please contact Gbox support." for seller-facing errors
└── index.ts                           # public exports

packages/db/src/schema.ts              # add SupportTickets, SupportMessages, etc. interfaces
```

### Files to modify

```
packages/db/src/migrations/run.ts       # register migrations 074-078
```

### Acceptance

- [ ] `npm test -- support/` → 50+ tests pass
- [ ] `DROP DATABASE gbox_test; npm run db:migrate` → 074-078 apply clean
- [ ] Encrypt message body → insert → select → decrypt → roundtrip OK
- [ ] Cross-shop query test: `queries.listTicketsForShop('A')` returns zero rows for shop B
- [ ] Rate limit test: 11th ticket in 1h from shop X throws RateLimitExceeded
- [ ] `safeMessage()` never returns god-admin terminology
- [ ] Release-check green

### Smoke

`scripts/smoke-phase12-5-pr1.ts` — creates a ticket via service, inserts encrypted message, asserts encryption + cross-shop + rate-limit + event log.

---

## PR2 — Seller widget + merchant API + polling + CSAT (1.5 days)

### Files to create

```
apps/store-admin/src/pages/support/
├── widget.tsx                         # floating "G" button bottom-right, Messenger blue #0084FF
├── panel.tsx                          # 3-tab slide panel: Open / Resolved / KB
├── ticket-list.tsx                    # Option B full-list + search + filter
├── ticket-detail.tsx                  # thread view with reply box
├── new-ticket-form.tsx                # create form with 6 categories
├── csat-prompt.tsx                    # star rating + comment
└── poll-hook.ts                       # 3s polling on ticket-detail

apps/store-admin/src/components/support/
├── pulse-ring.tsx                     # gentle radial ring animation on badge
├── MessengerTheme.css                 # #0084FF + #44BEC7 gradient tokens
└── BadgeCounter.tsx                   # unread count dot

apps/store-admin/src/server/routes/support.ts   # merchant API:
# POST   /api/support/tickets
# GET    /api/support/tickets
# GET    /api/support/tickets/:id
# POST   /api/support/tickets/:id/messages
# POST   /api/support/tickets/:id/close
# POST   /api/support/tickets/:id/reopen
# POST   /api/support/tickets/:id/csat

apps/store-admin/src/server/routes/support.test.ts  # integ tests
```

### Files to modify

```
apps/store-admin/src/layouts/ShopLayout.tsx   # mount SupportWidget in bottom-right
```

### Acceptance

- [ ] Seller creates ticket from widget → appears in DB
- [ ] Poll every 3s returns new messages
- [ ] CSAT post-close prompts 1h later (client-side timer)
- [ ] Internal note (`agent_internal_note`) FILTERED from seller API response
- [ ] Widget badge shows unread count + pulse ring when agent replies
- [ ] No audio (C1: silent)
- [ ] Iron Rule 5 grep: seller API response JSON contains zero "god" / "admin" strings

### Smoke

`scripts/smoke-phase12-5-pr2.ts` — simulates seller create + message, hits all 7 endpoints.

---

## PR3 — supporter.gbox.co staff portal + permission presets + invitations (2 days)

### Files to create

```
apps/supporter/                              # NEW Astro app, port 4325
├── astro.config.mjs                        # SSR, output: 'server'
├── package.json
├── src/
│   ├── pages/
│   │   ├── index.astro                    # landing: login or inbox
│   │   ├── login.astro                    # email + password + 2FA (mandatory for Lead)
│   │   ├── invite/[token].astro           # accept invite, set password
│   │   ├── inbox.astro                    # ticket queue
│   │   ├── tickets/[id].astro             # ticket detail + reply + internal note
│   │   ├── canned-replies.astro           # manage canned replies (L2+ only)
│   │   ├── analytics.astro                # self + team (Lead only)
│   │   └── settings/profile.astro         # display name, avatar, skill tags, BH
│   ├── layouts/
│   │   └── StaffLayout.astro              # top-nav with AgentPresence + notifications
│   └── server.ts                           # Express wrapper if needed
└── README.md

packages/core/src/modules/support-staff/
├── permissions.ts                          # requireSupportPermission() middleware + preset matrix
├── permissions.test.ts                     # L1 denied orders etc. + L2 partial cross-shop
├── presets.ts                              # L1, L2, Lead preset constants
├── invitations.ts                          # createInvite, acceptInvite, expireInvite
├── invitations.test.ts                     # SHA-256 hash, 7-day TTL, duplicate-email guard
├── audit-log.ts                            # logStaffAction(), writes to support_audit_log
└── index.ts

packages/db/src/migrations/
├── 079_support_staff_invitations.ts
└── 080_support_audit_log.ts

scripts/deploy/nginx/supporter.gbox.co.conf  # nginx upstream config
scripts/deploy/pm2/supporter.ecosystem.cjs   # PM2 config
```

### Acceptance

- [ ] `apps/supporter` builds + `pm2 start` on :4325
- [ ] L1 login, visit `/god-admin/orders` equivalent → 403 + audit log row
- [ ] L2 partial cross-shop: sees assigned ticket, not random other shop's
- [ ] Lead sees team analytics, L1 sees only own scorecard
- [ ] Invite flow: generate token, email link, accept within 7d, expire after
- [ ] 2FA mandatory for Lead (TOTP secret stored)
- [ ] Staff audit log: every permission denial + every mutation → `support_audit_log`

### Smoke

`scripts/smoke-phase12-5-pr3.ts` — creates invite, accepts, verifies permission gate, asserts L1 cannot read orders.

---

## PR4 — AI Support Hybrid Sonnet+Opus (2 days)

### Files to create

```
packages/core/src/modules/support-ai/
├── pick-model.ts                           # Sonnet vs Opus decision tree
├── pick-model.test.ts                      # 15+ tests covering all branches
├── client.ts                               # Anthropic SDK adapter (reuse from Phase 10)
├── redact-pii.ts                           # strip CC, SSN, VN CMND, email from prompts
├── redact-pii.test.ts                      # Luhn validator, regex coverage
├── budget.ts                               # monthly cap check, kill-switch at $200
├── budget.test.ts
├── suggest-reply.ts                        # AI surface: suggest next agent reply
├── summarize-thread.ts                     # AI surface: 3-bullet summary
├── auto-categorize.ts                      # AI surface: suggest category on create
├── sentiment-flag.ts                       # AI surface: batch every 5min
├── null-key-fallback.ts                    # graceful degrade when key not set
├── usage-tracker.ts                        # writes support_ai_usage rows
└── index.ts

packages/db/src/migrations/
└── 081_support_ai_usage.ts

apps/god-admin/src/pages/settings/ai.astro  # god-only: paste Anthropic key + budget knob
apps/god-admin/src/server/routes/ai-config.ts
```

### Acceptance

- [ ] `pickModel()` unit tests covering payment→Opus, dispute→Opus, confidence≥0.85→Opus, else Sonnet
- [ ] Budget kill-switch: mock $201 burn → `isAIEnabled()` returns false
- [ ] Null key: AI buttons disabled, tooltip "chưa cấu hình"
- [ ] PII redaction: CC `4242-4242-4242-4242` → `[REDACTED-CC]` before prompt send
- [ ] Usage row inserted with (model, input_tokens, output_tokens, cost_usd, ticket_id)
- [ ] God-admin `/settings/ai` page saves key encrypted under `platform_settings.ai`

### Smoke

`scripts/smoke-phase12-5-pr4.ts` — invokes `suggestReply` with mock Anthropic client, verifies model selection and cost logging.

---

## PR5 — SLA cron + notifications + CSAT auto-prompt (1.5 days)

### Files to create

```
packages/core/src/modules/support-sla/
├── engine.ts                               # tick(): scan tickets, compute deadlines, escalate
├── engine.test.ts                          # timezone, business hours, payment 2h vs others 4h
├── business-hours.ts                       # 8-18 ICT, Mon-Fri, holidays stubbed
├── business-hours.test.ts
├── escalation.ts                           # breach → escalate chain + event log
└── index.ts

packages/core/src/modules/support-notifications/
├── sender.ts                               # in-app + email (reuse mail module) + browser push
├── sender.test.ts
├── preferences.ts                          # load user prefs, filter channels
├── csat-auto-prompt.ts                     # 1h-after-close scheduler
└── index.ts

packages/db/src/migrations/
└── 082_support_notifications_prefs.ts

packages/core/src/modules/cron/tasks/
├── support-sla-tick.ts                     # every 5min
├── support-csat-prompt.ts                  # every 15min, fires prompts for tickets closed >1h ago
└── support-retention-cleanup.ts            # quarterly: archive >1yr tickets to cold
```

### Files to modify

```
packages/core/src/modules/cron/service.ts   # register the 3 new tasks
```

### Acceptance

- [ ] SLA cron tick on staging fires, detects breach on test ticket, emits `sla_breached` event
- [ ] CSAT prompt sent 1h after close (not immediately)
- [ ] Email notification rate-limited to 1/hour/ticket
- [ ] Business hours: payment ticket opened Saturday 10pm → SLA counter runs 24/7 (hybrid)
- [ ] Non-payment ticket opened Saturday 10pm → SLA paused until Monday 8am ICT
- [ ] Retention cleanup dry-run logs targets without deleting

### Smoke

`scripts/smoke-phase12-5-pr5.ts` — seeds 3 tickets, runs SLA tick, asserts escalation + event log + notification queue.

---

## PR6 — Polish + E2E smoke + release-check + deploy (1 day)

### Files to create

```
scripts/smoke-phase12-5-support.ts          # E2E: seller creates → agent replies → seller rates CSAT → close
scripts/ops/smoke-baseline.json             # update to include phase12-5 smokes
```

### Files to modify

```
apps/store-admin/src/i18n/vi.json           # add seller-facing Vietnamese strings
apps/store-admin/src/i18n/en.json
apps/supporter/src/i18n/vi.json             # add staff Vietnamese strings
apps/supporter/src/i18n/en.json

scripts/deploy/deploy-production.sh         # add supporter.gbox.co to deploy targets
scripts/deploy/nginx/main.conf              # include supporter upstream

docs/ops/release-checklist.md               # add supporter.gbox.co health check
docs/ops/support-runbook.md                 # NEW: how to invite staff, rotate keys, handle SLA breach
```

### Acceptance

- [ ] E2E smoke green end-to-end
- [ ] `release-check` green: drift detector + node floor + git-clean
- [ ] `smoke-matrix` green including the 6 new phase12-5 smokes
- [ ] `supporter.gbox.co` reachable in staging via curl
- [ ] Seller widget visible on store-admin shop page (manual visual check)
- [ ] Iron Rule 5 grep pass
- [ ] PM2 shows 5 processes online (accounts + god-admin + store-admin + storefront + supporter)

### Deploy

1. Merge PR6 to master
2. SSH server 1: `bash scripts/deploy/deploy-production.sh` (includes git pull + npm install + db migrate + pm2 restart all)
3. Update nginx: `sudo cp scripts/deploy/nginx/supporter.gbox.co.conf /etc/nginx/sites-available/ && sudo ln -s ... && sudo nginx -t && sudo nginx -s reload`
4. DNS: add CNAME `supporter.gbox.co` → Cloudflare proxy → server 1
5. Cloudflare: issue TLS cert for supporter.gbox.co (same zone, automatic with proxied)
6. Verify from browser: `https://supporter.gbox.co/login`
7. Seed canned replies: `npm run seed:support-canned-replies` (10 PayPal-onboarding templates)
8. Sanity: create test ticket in seed shop, reply from supporter, close, verify audit trail

---

## Risk register (execution-time)

| # | Risk | Mitigation |
|---|------|------------|
| R1 | Migration collision with a latent PR on master | Reserved 074-082, checked `_migrations` ledger; use `DEFAULT_ACCEPTED_COLLISIONS` if needed |
| R2 | Anthropic SDK rate limit during beta burst | Budget cap + null-key fallback + retry with exponential backoff |
| R3 | Staff portal TLS not ready day 1 | Can serve via IP + self-signed for internal use until Cloudflare cert issues |
| R4 | Seller widget blocks shop page rendering | Widget is async-loaded, no blocking fetch on mount |
| R5 | Cross-shop leak via AI prompt (L1 agent sees other shop's data) | AI prompts scoped to current ticket's shop only; redact PII; log prompt hash for audit |
| R6 | Server 1 load: existing 4 PM2 + new 1 PM2 + cron | Supporter is low-QPS; PM2 cluster mode if needed |
| R7 | DNS propagation delays | Use Cloudflare; TTL 300s; test via curl with --resolve flag |

---

## Test matrix totals

| PR | Unit | Integration | Smoke |
|----|-----:|------------:|------:|
| PR1 | 50+ | — | 1 |
| PR2 | — | 15 | 1 |
| PR3 | — | 30 | 1 |
| PR4 | 25 | — | 1 |
| PR5 | 15 | — | 1 |
| PR6 | — | — | 1 E2E |
| **Total** | **90+** | **45** | **6** |

---

## Iron Rule compliance checklist (executed at PR6)

- [ ] Rule 1 Security: encryption at rest, bcrypt 2FA, CSRF on all mutations, rate limits
- [ ] Rule 2 Admin Hierarchy: L1/L2/Lead presets + god-admin override; seller cannot see staff
- [ ] Rule 3 Workflow-First: spec v3 locked 2026-04-22, plan approved via standing directive
- [ ] Rule 4 Logging: `support_ticket_events` + `support_audit_log` + pino for all mutations
- [ ] Rule 5 No god-admin leak: grep seller API responses + UI strings → 0 hits; `safeMessage()` enforced

---

## END OF PLAN
