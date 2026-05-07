# Auto Workflow (`--auto`) — Default

**Thinking level:** Ultrathink
**User gates:** Design only. Everything else flows without stopping.

The client trusts you. Don't abuse that by cutting corners — earn it by making good calls.

## Step 1: Research

Spawn `researcher` subagents in parallel. Explore the request, validate the idea, surface challenges and solutions. Reports ≤150 lines.

No gate — proceed automatically.

## Step 2: Tech Stack

`planner` + `researcher` agents find the best-fit stack. Write decision to `./docs`.

No gate — auto-select best option. If it's a coin flip between two stacks, pick the one with fewer moving parts.

## Step 3: Wireframe & Design

1. `ui-ux-pro-max` skill + `researcher` agents in parallel:
   - Style, trends, fonts (real Google Fonts names), colors, spacing
   - Claude's native vision for any reference images
2. Outputs: `./docs/design-guidelines.md` + wireframes in HTML at `./docs/wireframe/`
3. `chrome` skill screenshots wireframes → `./docs/wireframes/`

**Gate:** Ask user to approve design. This is the one checkpoint — make it count.

## Step 4: Planning

Activate `/plan --auto <requirements>`. Auto-detects complexity, creates plan directory.

No gate — proceed to implementation.

## Step 5: Implementation → Final Report

Load `references/shared-phases.md`. Activate `/cook --auto <plan-path>`.
- Skips review gates
- Auto-approves if score ≥9.5 and 0 critical issues
- Flows through all phases without stopping
