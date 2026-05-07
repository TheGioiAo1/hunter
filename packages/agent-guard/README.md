# @gbox/agent-guard

6-layer defense chain wrapping every Claude Agent SDK tool call in the
god-admin pair programmer. Pure stateless layers composed by
`composeGuards()`. Layers never hit the DB — the caller loads a
`SessionContext` and passes it in.

Layers (in composition order):

1. `pathWhitelist`     — absolute path + traversal + symlink + cross-repo check
2. `commandParser`     — parses bash.run input via shell-quote AST walker
3. `blocklist`         — ~60 dangerous command patterns (rm -rf, sudo, dd, pipe-to-shell…)
4. `resourceLimits`    — wraps the command with ulimit / nice / timeout (builds string only, does not exec)
5. `rateLimit`         — 100/session, 20/5min tier-3, 3 consecutive edit fails, 1 bash in flight
6. `approvalGate`      — emits `approval_required` and awaits resolution or 120s timeout
7. `deploymentSafety`  — path classification + maintenance window + traffic level + circuit breaker

Short-circuits on first `{ allowed: false }`. Rejection carries the
layer name + reason for `audit_logs.guard_layer` / `guard_reason`.

Do NOT import this package from storefront or customer-facing code —
its only consumer is `apps/god-admin-agent` (PR 5 sidecar).
