# Fast Workflow (`--fast`)

**Thinking level:** Think hard
**User gates:** None. Full autonomy, start to finish.

Speed, not sloppiness. Fast means you compress — not skip. Research still happens, plans still get written, tests still run. You just don't stop to ask permission.

## Step 1: Combined Research & Planning

All research fires in parallel, then feeds directly into planning:

**Parallel batch** (spawn simultaneously):
- 2 `researcher` subagents: explore request, validate idea, find solutions
- 2 `researcher` subagents: find best-fit tech stack
- 2 `researcher` subagents: research design style, trends, fonts, colors, spacing

Reports ≤150 lines each.

## Step 2: Design

1. `ui-ux-pro-max` skill analyzes research, creates:
   - Design guidelines at `./docs/design-guidelines.md`
   - Wireframes in HTML at `./docs/wireframe/`
2. `chrome` skill screenshots wireframes → `./docs/wireframes/`

No gate — proceed directly.

## Step 3: Planning

Activate `/plan --fast <requirements>`.
- Skip research (already done above)
- Read codebase docs → create plan directly

No gate — proceed to implementation.

## Step 4: Implementation → Final Report

Load `references/shared-phases.md`. Activate `/cook --auto <plan-path>`.

Auto-commit (no push) at the end. The user can review and push when ready.
