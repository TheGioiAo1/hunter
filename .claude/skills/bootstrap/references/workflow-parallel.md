# Parallel Workflow (`--parallel`)

**Thinking level:** Ultrathink
**User gates:** Design approval only. Implementation uses multi-agent parallel execution.

This is for projects with clearly separable subsystems. If you can't draw a line between "auth module" and "billing module" with zero file overlap, you don't have a parallel project — you have a sequential one. Use `--auto` instead.

## Step 1: Research

Spawn max 2 `researcher` agents in parallel. Requirements, validation, challenges, solutions. Reports ≤150 lines.

No gate.

## Step 2: Tech Stack

`planner` + `researcher` agents in parallel. Write to `./docs` (≤150 lines).

No gate.

## Step 3: Wireframe & Design

1. `ui-ux-pro-max` skill + `researcher` agents in parallel:
   - Style, trends, fonts, colors, spacing
   - Claude's native vision for reference images
2. Outputs: `./docs/design-guidelines.md` + HTML wireframes
3. `chrome` skill screenshots → `./docs/wireframes/`

**Gate:** User approves design.

## Step 4: Parallel Planning

Activate `/plan --parallel <requirements>`.
- Phases with **exclusive file ownership** — no two agents touching the same file
- **Dependency matrix**: which phases run concurrently vs sequentially
- `plan.md` includes dependency graph, execution strategy, file ownership matrix

No gate.

## Step 5: Parallel Implementation → Final Report

Load `references/shared-phases.md`. Activate `/cook --parallel <plan-path>`.
- Multiple `fullstack-developer` agents launched in PARALLEL for concurrent phases
- `ui-ux-pro-max` skill for frontend design decisions
- File ownership boundaries are hard walls, not suggestions
- Type checking runs after implementation

Cook handles testing, review, docs, onboarding, final report per `shared-phases.md`.
