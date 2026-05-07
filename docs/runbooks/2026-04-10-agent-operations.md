# Gbox God-Admin Agent — Operations Runbook

**Date:** 2026-04-10
**Owner:** Thai Bui (buithai3107@gmail.com / thaibq@gbox.co)
**Scope:** `apps/god-admin-agent` sidecar, `apps/god-admin` dashboard chat panel,
`scripts/cron/agent-daily-digest.ts`, `scripts/deploy/blue-green-swap.ts`.

This runbook is the first stop when the agent misbehaves. It is short on
theory and long on exact commands. Most operations run on **server 1
(192.168.1.13)** unless noted.

---

## 1. Day-one cheat sheet

| I want to… | Command / URL |
| --- | --- |
| Check sidecar health | <http://192.168.1.13/god-admin/agent/health> |
| See the last 50 sessions | <http://192.168.1.13/god-admin/agent/sessions> |
| Replay one session | Click any row on the sessions page |
| Chat with the agent | <http://192.168.1.13/god-admin/agent> |
| Stop a runaway turn | Click **Kill** in the chat panel |
| Stop the whole sidecar | `touch /var/lib/gbox/.agent-killswitch` |
| Re-enable the sidecar | `rm /var/lib/gbox/.agent-killswitch` |
| Tail sidecar logs | `pm2 logs gbox-god-admin-agent --lines 200` |
| Restart sidecar | `pm2 restart gbox-god-admin-agent` |
| See which prompt is loaded | Agent Health page → "System prompt" card |
| Run the smoke test | `npx tsx scripts/smoke/agent-smoke.ts` |

---

## 2. Architecture refresher (just enough context)

```
┌─────────────┐       ┌──────────────────────┐       ┌──────────────────┐
│  browser    │──SSE─▶│ apps/god-admin       │──SSE─▶│ apps/god-admin-  │
│ (chat UI)   │       │   :4324 (dashboard)  │  JWT  │   agent :4326    │
└─────────────┘       └──────────────────────┘       └──────────────────┘
                                                               │
                                                               ▼
                                                       ┌──────────────────┐
                                                       │ Claude Agent SDK │
                                                       │  Anthropic API   │
                                                       └──────────────────┘
                                                               │
                                                               ▼
                                                       ┌──────────────────┐
                                                       │ Postgres         │
                                                       │  agent_sessions  │
                                                       └──────────────────┘
```

- **Dashboard (4324)** — server-rendered HTML chat panel. Mints a short-lived
  HS256 JWT and proxies `/god-admin/agent/chat` to the sidecar.
- **Sidecar (4326)** — Express app bound to `127.0.0.1`. Never exposed to the
  public internet. Holds the runtime, tool belt, killswitch, circuit breaker,
  and prompt hot-reload watcher.
- **Prompt file** — `packages/agent-core/prompts/god-admin-default.md`. Edit
  and save to hot-reload (no restart).
- **Database** — `agent_sessions` table in the `gbox_platform` Postgres
  database on server 2 (see `memory/smoke_test_runbook.md` for why you run
  smoke tests from server 2, not the local Windows box).

---

## 3. Daily operations

### 3.1. Morning digest email

A cron on server 1 runs `scripts/cron/agent-daily-digest.ts` every day at
**06:00 GMT+7** (= 23:00 UTC the previous day). The digest emails Thai the
previous 24 hours of agent activity: sessions, prompts, tool calls, cost,
top error reasons.

**Check that it ran last night:**

```bash
# On server 1, as root:
journalctl -u gbox-agent-digest.timer --since yesterday
# Or tail the systemd service log:
journalctl -u gbox-agent-digest.service --since yesterday | tail -50
```

**Run it manually (dry run — no email sent):**

```bash
cd /opt/gbox-platform
npx tsx scripts/cron/agent-daily-digest.ts --dry-run
```

**Run it manually and email Thai:**

```bash
cd /opt/gbox-platform
npx tsx scripts/cron/agent-daily-digest.ts --to=buithai3107@gmail.com
```

**Change the window:**

```bash
# Last 6 hours only:
npx tsx scripts/cron/agent-daily-digest.ts --window-hours=6 --dry-run
```

### 3.2. Health check

Open <http://192.168.1.13/god-admin/agent/health>.

Three possible banner states:

- **HEALTHY** (green) — sidecar up, killswitch disengaged, circuit breaker
  closed. Nothing to do.
- **DEGRADED** (yellow) — sidecar up, but circuit breaker has tripped open
  after a run of errors. Chat requests will be refused with `503
  circuit_breaker_open`. Investigate via session replay + pm2 logs, then
  see §4.3 to reset it.
- **DOWN** (red) — sidecar is not responding. Follow §4.1.

### 3.3. Session audit

Open <http://192.168.1.13/god-admin/agent/sessions>. Look for rows where
"Status" is anything other than `active` or `complete`:

- `killswitch` — expected after the operator hit Kill or touched the
  killswitch file. Not an incident.
- `timeout` — the runtime gave up waiting for the SDK. Click through to the
  replay to see how far the turn got.
- `error` — something inside the sidecar threw. Replay + pm2 logs.
- `compact_failed` — compaction failed mid-turn. The row still has the
  conversation; we just couldn't shrink it.

---

## 4. Incident playbook

### 4.1. "Sidecar is DOWN"

1. **Confirm.** From server 1:

   ```bash
   curl -s http://127.0.0.1:4326/_health | jq .
   # On DOWN you get curl: connection refused
   ```

2. **Check pm2:**

   ```bash
   pm2 list | grep gbox-god-admin-agent
   # expected: online
   ```

   If `errored` or missing, inspect the last crash:

   ```bash
   pm2 logs gbox-god-admin-agent --err --lines 200
   ```

3. **Restart:**

   ```bash
   pm2 restart gbox-god-admin-agent
   # or, if PM2 has lost the app entirely:
   cd /opt/gbox-platform/apps/god-admin-agent && pm2 start ecosystem.config.cjs
   ```

4. **Re-verify:**

   ```bash
   curl -s http://127.0.0.1:4326/_health | jq .status
   # "ok"
   ```

5. **If it won't start**, the most common culprits (see
   `memory/deployment_quirks.md`):
   - Workspace `workspace:*` references not resolved → `pnpm install`.
   - Missing `AGENT_INTERNAL_JWT_SECRET` in `/etc/gbox-platform/env` —
     regenerate with `openssl rand -hex 32`.
   - Port 4326 already taken — `lsof -i :4326` and kill the squatter.

### 4.2. "Runaway turn — the agent won't stop"

Two levels of escalation:

1. **Cancel this one turn.** In the chat panel, click **Kill**. The
   dashboard POSTs `/god-admin/agent/kill` which forwards to
   `/agent/kill` on the sidecar. The session row gets `ended_reason =
   killswitch` and the SSE stream closes.

2. **Stop the whole sidecar without killing the process.** Touch the
   killswitch file:

   ```bash
   ssh server1 'touch /var/lib/gbox/.agent-killswitch'
   ```

   Within 2 seconds the sidecar refuses all chat requests with
   `503 killswitch_engaged`. The process is still running — session list
   + replay still work — but no new turns land.

   Re-enable:

   ```bash
   ssh server1 'rm /var/lib/gbox/.agent-killswitch'
   ```

### 4.3. "Circuit breaker open, but the root cause is fixed"

The breaker opens after 5 errors in 60s (see `AGENT_CB_THRESHOLD` /
`AGENT_CB_WINDOW_MS` in `/etc/gbox-platform/env`). It resets to closed on
the next successful turn, OR on a sidecar restart:

```bash
pm2 restart gbox-god-admin-agent
```

If it keeps re-opening, the SDK calls are still failing. Check:

- `ANTHROPIC_API_KEY` not rotated/revoked.
- Sidecar can reach `api.anthropic.com` (proxy/firewall).
- The system prompt hasn't been edited into nonsense (see §5.1).

### 4.4. "The chat panel is rendering garbled SSE"

Most likely cause historically: a code path writing the wrong thing to
`res.write()`. The current chat route passes the `.bytes` field of the
encoded SSE frame — if you see this recur, grep for
`res.write(encodeSseEvent` without a trailing `.bytes` and fix it.

To reproduce locally without a browser:

```bash
npx tsx scripts/smoke/agent-smoke.ts
```

All 8 scenarios should pass. Scenario 5 exercises the SSE wire format
end-to-end.

---

## 5. Prompt management

### 5.1. Editing the system prompt

The prompt lives at
`packages/agent-core/prompts/god-admin-default.md`. On server 1 this is
under `/opt/gbox-platform/packages/agent-core/prompts/god-admin-default.md`.

Edit and save. The `fs.watch` inside the sidecar fires a debounced reload
(~100ms). Verify:

```bash
curl -s http://127.0.0.1:4326/_health | jq .prompt
# {
#   "hash": "sha256:abc1234def5678",
#   "loadedAt": "2026-04-10T06:12:34.567Z"
# }
```

The hash changes on every meaningful content edit. `{{TIMESTAMP}}`,
`{{CURRENT_PHASE}}`, and `{{RECENT_COMMITS}}` are expanded at load time
and do not affect the raw hash (the hash is of the file bytes, before
interpolation).

### 5.2. Rolling back a bad prompt

```bash
cd /opt/gbox-platform
git log -10 packages/agent-core/prompts/god-admin-default.md
git checkout <good-sha> -- packages/agent-core/prompts/god-admin-default.md
```

Hot-reload picks it up. No restart needed.

### 5.3. Temporarily swapping prompts for an experiment

Edit `/etc/gbox-platform/env`:

```
AGENT_PROMPT_NAME=god-admin-experiment
AGENT_PROMPTS_DIR=/opt/gbox-platform/packages/agent-core/prompts
```

Create `packages/agent-core/prompts/god-admin-experiment.md`, then
`pm2 restart gbox-god-admin-agent`. Revert the env to roll back.

---

## 6. Credential rotation

### 6.1. Internal JWT secret (`AGENT_INTERNAL_JWT_SECRET`)

The dashboard and sidecar must share this value. If they disagree, chat
requests fail with `401 invalid_jwt`.

```bash
# Generate a new one:
openssl rand -hex 32

# Edit /etc/gbox-platform/env on BOTH the dashboard host (server 1) and
# the sidecar host (server 1 — same box in our layout, but the two
# processes read the env independently).
sudo -e /etc/gbox-platform/env

# Restart both processes (order matters — restart the sidecar FIRST so
# in-flight dashboard requests don't briefly see the new secret on one
# side and the old on the other):
pm2 restart gbox-god-admin-agent
pm2 restart gbox-god-admin
```

Old tokens expire in 5 minutes naturally — there is no token revocation.

### 6.2. Anthropic API key (`ANTHROPIC_API_KEY`)

Rotate in `/etc/gbox-platform/env`, then `pm2 restart gbox-god-admin-agent`.
The sidecar reads the env on boot. No dashboard restart needed — the
dashboard never sees the Anthropic key.

---

## 7. Deploy operations

### 7.1. Blue-green swap (sidecar + dashboard)

```bash
cd /opt/gbox-platform
npx tsx scripts/deploy/blue-green-swap.ts \
  --target=god-admin \
  --to=blue \
  --health-probe=http://127.0.0.1:4324/health \
  --reload-nginx
```

Flags:

- `--target` — `god-admin`, `api`, `storefront`, or `agent-sidecar`.
- `--to` — `blue` or `green`.
- `--dry-run` — print the plan, do not execute.
- `--reload-nginx` — reload nginx after a successful swap.

Customer-facing targets (`storefront`, `api`) are refused outside the
maintenance window (daily 03:00-04:00 GMT+7, Sunday 02:00-05:00 GMT+7).
Override with `--force-window` only if you understand the blast radius.

### 7.2. Pipeline stages (for debugging a stuck swap)

The orchestrator calls these in order. Each has a standalone script you
can run alone:

```bash
npx tsx scripts/deploy/check-deploy-window.ts        # window gate
npx tsx scripts/deploy/drain-slot.ts --pm2=god-admin # quiet period
pm2 reload god-admin                                  # pm2-reload step
npx tsx scripts/deploy/health-probe.ts --url=...      # health probe
npx tsx scripts/deploy/smoke-probe.ts --url=...       # smoke probe
npx tsx scripts/deploy/nginx-reload.ts                # nginx -t + reload
```

If a stage fails, the pipeline stops and returns a non-zero exit. The
stages before the failure have already executed — there is no automatic
rollback for drain-slot or pm2-reload, but no publicly-visible change
happens until nginx-reload.

---

## 8. Database operations

### 8.1. Inspecting a session row directly

```bash
ssh server2 'psql gbox_platform -c "
  SELECT id, god_admin_id, started_at, ended_reason, prompt_count,
         tool_call_count, cost_usd
  FROM agent_sessions
  ORDER BY started_at DESC
  LIMIT 20;
"'
```

### 8.2. Pruning old sessions

Sessions older than 90 days are kept for audit but can be cold-archived:

```sql
-- Dry run: count first.
SELECT count(*) FROM agent_sessions WHERE started_at < now() - interval '90 days';

-- Archive then delete (do this in a transaction):
BEGIN;
INSERT INTO agent_sessions_archive SELECT * FROM agent_sessions
  WHERE started_at < now() - interval '90 days';
DELETE FROM agent_sessions WHERE started_at < now() - interval '90 days';
COMMIT;
```

The digest job will still see yesterday's rows because it filters by
`started_at >= now() - 24h`.

---

## 9. Smoke test

`scripts/smoke/agent-smoke.ts` boots the sidecar in-process with an
in-memory `SessionManager` and a scripted `SdkQueryFn`, then fires real
HTTP requests against the Express app. It covers 8 scenarios:

1. `GET /_health` → 200 + killswitch closed
2. `POST /agent/chat` without JWT → 401
3. `POST /agent/chat` with bad JWT → 401
4. `POST /agent/chat` with empty text → 400
5. `POST /agent/chat` happy path → SSE stream: `session_opened`,
   `assistant_delta`, `done`
6. `GET /agent/sessions` lists the newly-opened session
7. `GET /agent/sessions/:aid` returns the replay row w/ user message
8. `POST /agent/kill` closes the session with `ended_reason=killswitch`

**Run:**

```bash
cd /opt/gbox-platform
npx tsx scripts/smoke/agent-smoke.ts
```

Exit code 0 = all 8 passed. Non-zero = at least one failed, read the
console output. This is the **fastest pre-deploy check** for the sidecar
— run it before every `blue-green-swap.ts` on the agent target.

---

## 10. Escalation

If none of the above helps, page the owner (Thai Bui) with:

- The exact error message from `pm2 logs gbox-god-admin-agent`.
- The `aid` of a session that reproduces the problem.
- A link to `/god-admin/agent/sessions/<aid>` so he can replay it.
- The output of `curl -s http://127.0.0.1:4326/_health` (if the sidecar
  is up at all).

The golden rule from `CLAUDE.md` applies: **clone Shopify exactly**. If a
behavior diverges from what Shopify's admin agent would do, that is a bug
worth fixing, not a feature worth keeping.
