---
name: plan
description: "Turn a decision or feature request into a phased, file-owned implementation plan — auto-routing between fast (one-shot) and hard (research + red-team) modes based on scope signals. Use when work is beyond a 2-file fix and you want the path written down before anyone opens an editor."
license: MIT
argument-hint: "[task description] OR [--fast | --hard | --two]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Planning

You convert a problem statement into an executable plan. Not prose, not a wishlist — a folder of phase files, each with file ownership, success criteria, and a todo list. The plan is the contract: whoever picks it up (`cook` skill, `developer` agent, or the user themselves) can execute without re-deciding anything.

Plans live at `plans/<YYMMDD>-<HHmm>-<slug>/` in the current working project. Reports go to `plans/reports/`.

## <HARD-GATE> Workspace State Sync (FIRST, NON-NEGOTIABLE)
Before ANY other tool call, run:
```bash
node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-sync.cjs" --check --skill=plan
```
- **Exit 0 + empty stdout** → proceed.
- **Exit 1** → print stdout verbatim inside a fenced code block and STOP. No preamble, no AskUserQuestion, no chain continuation. See `.claude/rules/workspace-state-sync.md` for full contract.

## Stack-aware references

Before estimating scope, glance at the project root and note which stack-pattern skills *could* help downstream `cook`. Detection is cheap (check a single manifest file):

| Marker at project root | Skill with canonical patterns |
|---|---|
| `go.mod` | `/go-backend` (Echo + GORM + Redis) |
| `package.json` with `@nestjs/*` | `/node-backend` (NestJS + Prisma + Mongoose) |
| `package.json` with `react` / `next` / `vite` | `/frontend-development` + `/react-best-practices` |
| `pyproject.toml` / `requirements.txt` | `/python-backend` (FastAPI + Flask) |
| `composer.json` | `/php-backend` (Laravel + Eloquent + Sanctum) |
| `wails.json` | `/wails` (+ `/go-backend` for Go side, `/frontend-development` for React side) |

**Lazy rule:** do NOT read these SKILL.md upfront. Just mention the relevant skill(s) in the plan's phase files so `cook` knows where to look when a specific pattern question appears (auth middleware, ORM query, job queue, DTO validation, etc.). A reference mention costs ~0 tokens; reading a full stack SKILL.md costs 2-3K. Respect the context budget — let `cook` load on-demand.

## Auto-Mode Routing (the part you asked about)

Default is `--auto`. The skill picks the mode on its own using signals from the task description and a quick codebase scan. You only override with a flag when you disagree with the auto-pick.

### Signal scoring

Rate the task on these axes, add up the score:

| Signal | +0 | +1 | +2 |
|--------|----|----|----|
| Estimated files touched | ≤3 | 4-8 | 9+ |
| New tech / unfamiliar library | None | One new dep | New stack or architecture shift |
| Architectural decision required | None | Minor (pattern choice) | Major (data model, auth flow, infra) |
| Ambiguity in approach | Clear path | 2 reasonable paths | 3+ paths, no clear winner |
| Cross-repo / cross-service impact | Single project | 1 boundary crossed | Multi-service / multi-repo |
| Reversibility | Easy rollback | Migration involved | Data loss risk, hard rollback |

### Mode table

| Total score | Mode | What runs |
|-------------|------|-----------|
| 0-2 | **fast** | Scan docs → write plan → done. No research agents, no red-team. |
| 3-5 | **hard** | 2× `researcher` agents parallel → `planner` agent → self red-team pass → write plan. |
| 6+ | **hard + two** | Same as hard, but `planner` produces 2 structurally different approaches; user picks. |
| Any score with 3+ independent subsystems | **parallel** | Force parallel mode regardless — file-ownership matrix becomes mandatory. |

### Manual override flags

When the user passes an explicit flag, **respect it fully** — skip auto-scoring. User intent wins.

| Flag | Effect | Notes |
|------|--------|-------|
| `--fast` | Force fast mode | Skip research, skip red-team, skip scope challenge |
| `--hard` | Force hard mode | 2 researchers, red-team on, validate optional |
| `--two` | Force two-approach mode | Planner produces 2 approaches for comparison |
| `--parallel` | Force parallel mode | File-ownership matrix mandatory |
| `--red-team` | Force red-team ON | Runs even in `fast` mode — use when task is small but risky |
| `--no-red-team` | Force red-team OFF | Skips even in `hard` mode — use when user trusts the plan |
| `--validate` | Force validation interview ON | 3-5 critical questions before finalizing |
| `--no-validate` | Force validation OFF | Skip even in high-stakes plans |
| `--no-tasks` | Skip task hydration | Plan files only, no TodoWrite creation |

**Flags combine.** `--fast --red-team` = fast plan but still red-team it. `--hard --no-red-team` = hard plan but trust the draft.

### Auto-detection (when no flag passed)

If user didn't pass any of the above, run auto-detection:

**Mode** — from the 6-signal score table above (0-2 fast, 3-5 hard, 6+ two, 3+ subsystems → parallel).

**Red-team** — independent risk score, runs if ≥2 points:

| Risk signal | +points |
|-------------|---------|
| Data migration / schema change | +2 |
| Auth / security / permissions | +2 |
| Payment / billing / money flow | +2 |
| Rollback is hard or destructive | +1 |
| Effort ≥ 1 week | +1 |
| Multi-developer team | +1 |

Red-team trigger is **independent of mode** — a `fast` plan still gets red-teamed if it touches something dangerous. A `hard` plan with zero risk signals can skip red-team.

**Validation** — runs automatically if red-team ran AND risk score ≥3, or user explicitly asked via `--validate`.

### Natural-language shortcuts

Not quite flags, but pattern-match user intent:

- "quick plan", "just map it out", "don't overthink" → force `fast`
- "I'm stuck", "multiple options", "architecture question" → force `hard` minimum
- "high stakes", "production", "can't afford to break" → force `--red-team` on
- "skip review", "I trust it", "just write the plan" → `--no-red-team`
- "just todos", "I don't need phases" → `--fast --no-tasks`

### Edge cases

- Task < 20 words AND clearly trivial ("fix typo in README") → force `fast`, skip scoring
- Mode score lands on boundary (2/3 or 5/6) → call `AskUserQuestion` with the two candidates, don't guess
- User passes conflicting flags (`--fast --parallel`) → warn once, pick the more specific one (parallel), proceed

### Priority order

When signals conflict, this is the tiebreaker:

1. **Explicit flag** (`--fast`, `--red-team`, etc.) — always wins
2. **Natural-language shortcut** in the user's message — overrides auto-detection
3. **Hard rules** (e.g. 3+ subsystems → parallel, trivial task → fast)
4. **Auto-scoring** — the 6-signal table for mode, risk table for red-team
5. **Default** — `--auto` equivalent

### Announce the decision

Before doing research or writing anything, output a one-line verdict so the user can course-correct early:

```
Mode: hard (score 4 — 6 files, new Redis pattern, data migration risk)
Red-team: on (risk 3 — data migration + auth)
Validate: off
```

Three lines max. If the user passed flags, show them explicitly:

```
Mode: fast (user flag --fast)
Red-team: on (user flag --red-team)
```

If the user disagrees, they'll say so. Don't negotiate — re-run with the corrected flag.

## Pre-flight checks

- [ ] Scanned `plans/` for unfinished plans that overlap in scope
- [ ] Plan mode announced and matches task reality
- [ ] Each phase has file ownership — no two phases touch the same file
- [ ] Each phase has a stated success criterion (not vibes)
- [ ] Dependencies between phases are explicit (A blocks B, C runs parallel to A)
- [ ] Non-goals listed — what the plan deliberately does NOT do
- [ ] Rollback plan exists for anything destructive (migrations, schema changes, file deletions)
- [ ] Every file in the "create" list has a parent directory that exists OR a phase step that creates it

## Operating laws

**YAGNI** — if it's not needed for the stated goal, cut it. **KISS** — fewer moving parts beats clever ones. **DRY** — duplication you can see today is a bug you ship tomorrow. Plans that violate these get simplified before finalizing.

## Workflow

### 1 — Read the room

Before scoring or writing:

- Check `## Plan Context` if injected by hooks — is there an active plan? a suggested one?
- Scan `plans/` for unfinished plans (`status != completed | cancelled`). If any overlap with the new task, note the relationship (blocks / blockedBy)
- Read `docs/codebase-summary.md`, `docs/system-architecture.md`, `docs/code-standards.md` if they exist — the plan inherits their conventions

### 2 — Score and announce

Apply the signal table. Output the one-line mode verdict. If the user explicitly passed a flag, skip scoring and honor the flag.

### 3 — Scope challenge (skip if `fast`)

Three questions, in order:

1. **What already exists?** Anything in the codebase that partially solves this? If yes — reuse, don't rebuild.
2. **What's the minimum change set?** Which bits could be deferred to a v2 without blocking the goal?
3. **Complexity check** — Would this touch >8 files? Introduce >2 new services? Span >5 phases? If yes — justify each.

Ask the user once via `AskUserQuestion` if the scope is unclear:

| Option | Meaning |
|--------|---------|
| Expansion | Go big — explore deeper, research adjacent features |
| Hold | Scope is right — focus on bulletproof execution |
| Reduction | Strip to essentials — minimal phases, defer the rest |

Once chosen, respect it. Don't silently re-argue.

### 3.5 — Reuse scout (always, unless `--no-reuse-scout`)

Full contract: `.claude/rules/reuse-first.md`. Summary below.

Before writing phase files, spawn `reuse-scout` agent (haiku, cheap) to map what already exists for the task's domain keywords. This is where cross-surface duplication gets detected — the #1 driver of divergence between public / admin / user APIs and web / mobile UIs.

**Spawn once per distinct domain keyword in the task.** For a multi-domain task ("add notifications to auth flow"), spawn two scouts in parallel: one for `auth`, one for `notification`.

**Spawn template:**

```
Task: Scout reusable code for "<keyword>"
Agent: reuse-scout
Context:
  - Keyword(s): <primary + 2-3 variants>
  - Target layer(s): <from task — handler/service/repository/util/hook/component>
  - Entry points / surfaces: <from task — api/public, api/admin, api/user, web, mobile>
  - Work context: <project root>
Acceptance: report at plans/reports/reuse-scout-<YYMMDD>-<HHmm>-<slug>.md
```

**How the verdict shapes the plan:**

| Verdict | Plan adjustment |
|---|---|
| REUSE-AS-IS | Drop the "create new X" phase. Replace with a thin "wire existing X into new surface" phase. |
| REUSE-EXTEND | "Create X" phase becomes "Extend X with new param/enum" phase. Smaller scope, fewer files. |
| EXTRACT-SHARED | **Add a shared-layer phase at the front** before any surface-specific phase. Shared phase refactors existing callers. New feature phase depends on it. This is mandatory, not optional. |
| FORK-NEW | Plan proceeds as normal. Document WHY reuse wasn't viable in the phase's `## Reuse strategy`. |

**Skip the scout when:**
- `--fast` mode AND task is < 3 files AND single surface → scout overhead not worth it.
- User passed `--no-reuse-scout`.
- Task is pure config / migration / infra (no app-level domain logic).

### 4 — Research (skip if `fast`)

Delegate to `researcher` agents in parallel. Max 2 in `hard`, up to 3 in `parallel` / `two`.

Each researcher gets:
- One specific question (not "research auth" — "compare Passport.js vs NextAuth v5 for Next.js App Router with a NestJS backend")
- Acceptance: written findings at `plans/<plan-dir>/research/researcher-<NN>-<slug>.md`
- Work context path (the project root)

Wait for all researchers to return before writing the plan.

### 5 — Write the plan

Delegate to `planner` agent. Hand it:
- The task description
- The mode (fast/hard/parallel/two)
- The scope decision (Expansion/Hold/Reduction)
- Paths to researcher reports (if any)
- Paths to relevant docs

The agent produces:
- `plan.md` — overview, phase list with status, dependencies, non-goals, under 80 lines
- `phase-01-*.md` through `phase-NN-*.md` — detailed per the structure in `documentation-management.md`

Full phase file spec: see `## Phase file structure` below.

### 6 — Red-team (when risk score ≥2, or `--red-team`)

A self-review pass. For light reviews, use the quick 3-angle table:

| Angle | Question |
|-------|----------|
| Hostile reviewer | What's the weakest assumption? What breaks under load / edge input / partial failure? |
| New engineer | Could someone who wasn't in the meeting execute this from the file alone? |
| Future maintainer | In 6 months when this breaks, will the phase file tell me what was intended? |

Fix what you find. Don't rubber-stamp. If a phase can't survive the red-team pass, rewrite it.

**For high-stakes plans** (risk score ≥4, or plan touches auth / payments / migrations) — load `references/review-templates.md` and use the 4-persona framework (Security Adversary, Failure Mode Analyst, Assumption Destroyer, Scope & Complexity Critic). That file has reviewer prompts, finding format, and adjudication template.

### 7 — Validate (auto when risk ≥3, or `--validate`)

Surface **unstated decisions** via `AskUserQuestion` — not flaw-hunting (that's red-team's job).

Quick validation (risk 3-4): ask 3-5 targeted questions on blast radius, rollback path, downstream consumers.

**For richer validation** — load `references/review-templates.md` Part 2. It has question categories (Architecture / Assumptions / Tradeoffs / Risks / Scope), keyword-to-question mapping, validation log format, and section-propagation rules.

Capture answers in `plan.md` under `## Validation Log` — use the format in the references file.

### 8 — Hand off

Output:
- Absolute path to `plan.md`
- One-line summary: N phases, mode, scope decision, next action
- **Fork-aware next-step options** via `AskUserQuestion` (see "Post-plan fork" below)

**DO NOT implement anything.** The plan ends here. `cook` (or `test --tdd` → `cook`) picks it up next.

#### Post-plan fork (TDD decision)

This is the authorized override of the generic rule in `.claude/rules/workflow-chaining.md`. Plan's Hand off decides **at runtime** whether to offer the TDD path.

**Step 1 — Run the two checker scripts** (both live in `.claude/scripts/`):

```bash
node .claude/scripts/detect-tests.js        # → { hasTests, framework, testDirs, configFile, manifestHasTestRunner }
node .claude/scripts/test-eligibility.js <plan-dir>   # → { eligible, score, reasons }
```

**Step 2 — If `detect-tests.js` returns `hasTests: true`** → flip `workflow.hasTests = true` in `.claude/.claude-config.json` (idempotent).

**Step 3 — Build `AskUserQuestion` options:**

Always include first:
- `"Cook luôn"` — invoke `/cook` with plan-dir context. Normal post-cook chain follows (filtered by `hasTests`).

Include **only** if `detect-tests.js.framework != null` AND `test-eligibility.js.eligible == true`:
- `"Viết test trước, cook sau"` — flip `workflow.hasTests = true`, invoke `/test --tdd` with plan-dir context. After `/test` finishes, auto-invoke `/cook` (this is a forced chain, skips the usual test-skill chain lookup).

Always include last:
- `"Stop here"` — end here, no further skills.

**Step 4 — If the plan has 1+ phases eligible for TDD**, planner agent should have pre-populated `## Test Spec` in those phase files (hybrid rule — see "Phase file structure" below). `/test --tdd` reads those directly. If not pre-populated, `/test --tdd` falls back to extracting spec from Requirements + Success Criteria and confirming with user.

**Skip the fork entirely** when mode is `--fast` (user explicitly asked for speed, don't add friction) — in that case use the generic chain rule from `workflow-chaining.md`.

## Phase file structure

Every `phase-NN-*.md` contains:

```markdown
# Phase NN — <name>

## Context Links
- Plan: ../plan.md
- Research: ../research/researcher-01-<slug>.md
- Related docs: ../../docs/<file>.md

## Overview
- Priority: critical | high | medium | low
- Status: pending | in-progress | completed | blocked
- Est. effort: <hours or days>

## Key Insights
<what research / scope challenge revealed that shapes this phase>

## Requirements
**Functional:** <what the code must do>
**Non-functional:** <perf, security, observability, a11y>

## Architecture
<how the pieces fit — include ASCII or mermaid if >3 components>

## Related Code Files
**Modify:** <list — exclusive ownership>
**Create:** <list>
**Delete:** <list + reason>

## Existing code audit
<populated from reuse-scout report — required when phase creates any new public export>

**Scout report:** ../reports/reuse-scout-<YYMMDD>-<HHmm>-<slug>.md

**Candidates found:**
| File:line | Signature | Fit | Verdict |
|---|---|---|---|
| src/services/foo.service.ts:42 | createFoo(arg) | 90% | REUSE-EXTEND |
| ... | ... | ... | ... |

**Cross-surface duplication:** <yes/no — if yes, list the N duplicate copies>

## Reuse strategy
<one of: REUSE-AS-IS | REUSE-EXTEND | EXTRACT-SHARED | FORK-NEW>

<one paragraph: what exactly cook should do based on the verdict. E.g. "EXTRACT-SHARED — before implementing the new admin handler, hoist src/services/foo.service.ts into src/shared/services/foo.service.ts with a `source: 'public' | 'admin' | 'user'` param. Refactor existing public + user callers to use the shared version. THEN wire the new admin handler.">

## Implementation Steps
1. <concrete step>
2. <concrete step>
...

## Todo List
- [ ] step 1
- [ ] step 2
...

## Success Criteria
<what "done" looks like — testable, not vibes>

## Test Spec  _(optional — hybrid rule, see below)_
**Unit:**
- `functionName(arg1, arg2)` — cases: happy / boundary / error / edge
- ...

**Integration:**
- `POST /endpoint` with valid payload → 200 + <shape>
- with invalid → 4xx
- ...

**Edge:**
- Race conditions, expired tokens, concurrent writes, etc.

## Risk Assessment
<what could go wrong + mitigation>

## Security Considerations
<auth, validation, data exposure — skip section if n/a>

## Next Steps
<what phase this unblocks, follow-ups>
```

### Hybrid rule for `## Test Spec`

`## Test Spec` is **optional**. Include it only when the phase would score eligible for TDD (per `.claude/scripts/test-eligibility.cjs` signals):

- Auth / security / permissions → write spec
- Payment / billing / money flow → write spec
- Data migration / schema change → write spec
- New public API contract (route / endpoint / SDK export) → write spec
- Business logic / service / domain layer → write spec
- Pure function / algorithm / parser / validator → write spec
- Priority critical or high AND ≥5 implementation steps → write spec

For everything else (UI tweaks, config, docs, trivial fixes) → **omit the section entirely**. Don't pad the phase file.

**Why this matters:** `/test --tdd` reads `## Test Spec` directly if present (zero-friction TDD). If absent but user chose TDD path anyway, `/test --tdd` falls back to extracting spec from `## Requirements` + `## Success Criteria` and confirms with the user before generating tests.

## plan.md structure

Keep under 80 lines. Frontmatter + narrative + phase table.

```markdown
---
title: <task slug>
status: pending | in-progress | completed | cancelled
mode: fast | hard | parallel | two
scope: expansion | hold | reduction
priority: critical | high | medium | low
effort: <total estimate>
created: <YYYY-MM-DD>
blockedBy: []
blocks: []
---

# <Task title>

<2-3 sentence problem statement>

## Goal
<what success looks like, from the user's perspective>

## Non-goals
<what this plan deliberately does NOT do>

## Phases
| # | Name | Status | Depends on | Owner |
|---|------|--------|------------|-------|
| 01 | setup-environment | pending | — | developer |
| 02 | implement-database | pending | 01 | developer |
| ... | | | | |

## Dependencies
<external — libraries, APIs, credentials needed>

## Risks & mitigations
<captured from validate phase if run>

## Rollback
<how to undo this plan's changes if it ships broken>
```

## Agent delegation map

| Phase | Delegate to | Why |
|-------|-------------|-----|
| 3.5 — Reuse scout | `reuse-scout` agent × 1-N (parallel per keyword) | Haiku, cheap; maps existing code before phases are written |
| 4 — Research | `researcher` agent × 1-3 (parallel) | Each owns one focused question |
| 5 — Write plan | `planner` agent | Converts inputs + scout report into phase files |
| 5 — Surface conventions | `docs-manager` agent (optional) | Pulls current project standards |
| 6 — Red team (self) | Main session | Review pass; no delegation needed |
| Post-plan handoff | `cook` skill (next chain step) | Execution, not planning |

**Delegation template** (per `.claude/rules/orchestration-protocol.md`):

```
Task: <specific deliverable>
Files to read for context: <paths>
Acceptance criteria: <what "done" looks like>
Work context: <project root>
Reports: <project root>/plans/reports/
Plans: <project root>/plans/
```

## When things get weird

| Situation | Play |
|-----------|------|
| Overlapping plan already exists | Don't duplicate — either extend the existing plan or mark the new one `blockedBy` the old one |
| User says "just make a plan" with no task | Ask one clarifying question — what problem are we solving? |
| Score lands on the boundary (2/3 or 5/6) | `AskUserQuestion` with the two candidate modes, let the user pick |
| Task is actually 3 unrelated features | Stop. Propose decomposition — each gets its own plan folder |
| Researcher reports conflict | Don't paper over it — surface the conflict in the plan with both views, flag as open question |
| Red-team finds a phase is fundamentally wrong | Rewrite the phase, don't patch it |
| User wants to skip red-team on a `hard` plan | Warn once, note in plan.md that red-team was skipped, proceed |
| Plan has >7 phases | Smell. Collapse, split into multiple plans, or justify each phase explicitly |
| Every phase touches every file | File ownership is wrong — phases aren't independent. Re-cut the work |

## Hard rules

- **Plans don't implement.** You write files under `plans/`, you do NOT touch `src/`.
- **Every phase owns its files exclusively.** Two phases modifying the same file = planning error, fix before finalizing.
- **No plan without success criteria.** "Done when it works" is not a success criterion.
- **Fast mode skips research, not rigor.** A fast plan still has file ownership, success criteria, phase dependencies, and a rollback note. "Fast" cuts research and red-team — it does not cut the bones of a plan.
- **Red-team on anything risky.** Auth, payments, migrations, destructive changes — red-team is mandatory, flag beats speed.
- **No AI attribution** in plan files, phase files, or reports.
- **Sacrifice grammar for concision.** Phase files are scannable, not novelistic.