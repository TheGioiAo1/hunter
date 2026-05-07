---
name: docs
description: "Analyze codebase and manage project documentation — init, update, summarize."
argument-hint: "init|update|summarize"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Documentation Management

Analyze codebase and manage `./docs/` through scouting, analysis, and structured doc generation. Delegates heavy writing to the `docs-manager` agent and heavy reading to `Explore` / `explore` subagents for parallelism.

## Default (No Arguments)

If invoked without arguments, use `AskUserQuestion` to present operations:

| Operation | Description |
|-----------|-------------|
| `init` | Analyze codebase & create initial docs |
| `update` | Analyze changes & update existing docs |
| `summarize` | Quick codebase summary refresh |

Present via `AskUserQuestion` with:

- **header:** `"Documentation Operation"`
- **question:** `"What would you like to do with docs?"`
- **multiSelect:** `false`
- **options:** 3 items above

Do NOT auto-run `init` when args are empty.

## Subcommands

| Subcommand | Reference | Purpose |
|------------|-----------|---------|
| `/docs init` | `references/init-workflow.md` | Create initial documentation from codebase scan |
| `/docs update` | `references/update-workflow.md` | Update existing docs against current codebase |
| `/docs summarize` | `references/summarize-workflow.md` | Quick refresh of `codebase-summary.md` |

## Routing

Parse `$ARGUMENTS` first word:

- `init` → Load `references/init-workflow.md`
- `update` → Load `references/update-workflow.md`
- `summarize` → Load `references/summarize-workflow.md`
- empty / unclear → `AskUserQuestion` (never auto-run `init`)

## Shared Context

Documentation lives in `./docs/` (configured in `.claude-config.json` → `paths.docs`):

```
./docs/
├── project-overview-pdr.md      # PDR, feature scope, success metrics
├── code-standards.md            # Conventions, stack rules
├── codebase-summary.md          # Auto-generated overview (refresh >2 days stale)
├── system-architecture.md       # Components, data flow, integration points
├── development-roadmap.md       # Phases, milestones, progress
├── project-changelog.md         # Dated changelog entries
├── deployment-guide.md          # [optional] How to deploy, rollback
└── design-guidelines.md         # [optional] Design tokens, component patterns
```

**Size cap:** 800 LOC per file. Split into topic directory if approaching (see `docs-manager` agent workflow step 4).

**README.md** stays at project root, cap 300 LOC.

## Delegation

Heavy work is delegated, never inline in this skill:

| Work | Delegate to |
|------|-------------|
| Codebase scouting (structure, LOC per dir, entry points) | `explore` skill (via Task tool, subagent_type matches project convention) |
| Parallel doc reading (4+ existing files) | `Explore` built-in subagent (2-3 parallel) |
| Writing / updating doc files | `docs-manager` agent (owns `./docs/`, verifies every reference) |
| Hallucination check | `.claude/scripts/validate-docs.cjs` (if present) |

## Hard rules

- **Do not** start implementing feature code — this skill only manages docs.
- **Do not** write to `./docs/` directly from the main agent — always go through `docs-manager`.
- `docs-manager` verifies every code reference, env var, internal link before writing.
- No AI attribution in doc files.
- Sacrifice grammar for concision.
