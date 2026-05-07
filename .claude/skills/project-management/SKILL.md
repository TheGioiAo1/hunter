---
name: project-management
description: Track progress, update plan statuses, generate reports, coordinate docs updates. Use for project oversight, status checks, plan completion, task hydration, cross-session continuity.
argument-hint: "[status | hydrate | sync | report]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Project Management

Manage project progress — track plan status, sync checkboxes, generate reports, trigger doc updates.

**Principles:** Save tokens | Concise reports | Data-driven

## When to Use

- Check progress of plans
- Update plan status after completing a feature
- Hydrate/sync Claude Tasks with plan files (cross-session)
- Generate status reports
- Trigger documentation updates after milestones

## Tool Availability

`TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList` only work on **CLI terminal** — VSCode extension does not support them (`isTTY` check).

| Environment | Task Tools | Fallback |
|-------------|-----------|----------|
| CLI terminal | Yes | — |
| VSCode extension | **No** | `TodoWrite` |

**Fallback:** If Task tools fail → use `TodoWrite`. Plan file sync-back (checkbox updates, YAML frontmatter) works normally without Task tools.

## Core Capabilities

### 1. Task Operations
Load: `references/task-operations.md`

Use `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList` to manage tasks in session (CLI only).
- Create tasks with metadata (phase, priority, effort, planDir, phaseFile)
- Track status: `pending` → `in_progress` → `completed`
- Manage dependencies with `addBlockedBy` / `addBlocks`
- Distribute tasks to parallel agents

### 2. Session Bridging (Hydration Pattern)
Load: `references/hydration-workflow.md`

Tasks are ephemeral (lost when session ends). Plan files are persistent. Hydration pattern bridges both worlds:
- **Hydrate:** Read `[ ]` items from plan → `TaskCreate` for each incomplete item
- **Work:** `TaskUpdate` tracks progress real-time
- **Sync-back:** Compare completed tasks with phase files, update `[ ]` → `[x]`, update YAML frontmatter
- **Resume:** New session re-hydrates from remaining `[ ]` items

### 3. Progress Tracking
Load: `references/progress-tracking.md`

- Scan `./plans/*/plan.md` to find active plans
- Parse YAML frontmatter for status, priority, effort
- Count `[x]` vs `[ ]` in phase files → calculate completion %
- Cross-reference completed work with planned tasks
- Check acceptance criteria before marking complete

### 4. Documentation Coordination
Load: `references/documentation-triggers.md`

Trigger `./docs` updates when:
- Phase status changes, major features completed
- API contracts change, architecture decisions made
- Security patches, breaking changes

Delegate to `docs-manager` subagent for execution.

### 5. Status Reporting
Load: `references/reporting-patterns.md`

Generate reports: session summaries, plan completion, multi-plan overviews.
- Naming: `{reports-path}/pm-{date}-{time}-{slug}.md`
- Prefer tables over prose, keep concise
- List unresolved questions at the end

## Workflow

```
[Scan Plans] → [Hydrate Tasks] → [Track Progress] → [Update Status] → [Generate Report] → [Trigger Doc Updates]
```

1. `TaskList()` — check existing tasks
2. If empty: hydrate from plan files (unchecked items)
3. During work: `TaskUpdate` as tasks progress
4. On completion: sync-back all phase files (including backfill of previous phases), update YAML frontmatter
5. Generate status report to reports directory
6. Delegate doc updates if needed

## Mandatory Sync-Back Guard

When updating plan status, **NEVER** only mark the active phase.

1. Scan all `phase-XX-*.md` in the plan directory
2. Compare every `TaskUpdate(status: "completed")` with phase metadata (`phase` / `phaseFile`)
3. Backfill checkboxes in previous phases → then mark later phases
4. Update `plan.md` status/progress from actual checkbox counts
5. If any task cannot be mapped to a phase file → report as unresolved, do not claim full completion

## Plan YAML Frontmatter

All `plan.md` files MUST have:

```yaml
---
title: Feature name
status: in-progress  # pending | in-progress | completed
priority: P1
effort: medium
branch: feature-branch
tags: [auth, api]
created: 2026-02-05
---
```

Update `status` when plan state changes.

## Quality Standards

- All analysis must be data-driven, referencing specific plans and reports
- Focus on business value and actionable insights
- Highlight critical issues requiring immediate attention
- Ensure traceability between requirements and implementation

## Related Skills

- `plan` — Create implementation plans (planning phase)
- `cook` — Implement plans (execution phase)
