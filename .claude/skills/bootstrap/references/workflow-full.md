# Full Interactive Workflow (`--full`)

**Thinking level:** Ultrathink
**User gates:** Every major phase. You don't move a wall without the client signing off.

## Step 1: Clarify Requirements

Use `AskUserQuestion` to probe the user's actual needs — not the words they used, but the problem behind the words.

- One question at a time. Wait for the answer before asking the next.
- Challenge assumptions. "Dashboard" could mean 50 things. Find out which one.
- Keep going until you could explain the project to a stranger and they'd build the right thing.

## Step 2: Research

Spawn multiple `researcher` subagents in parallel:
- Explore request validity, challenges, best available solutions
- Reports ≤150 lines each — if it's longer, it's not focused enough

**Gate:** Present findings to user. Proceed only with approval.

## Step 3: Tech Stack

1. Ask user for preferred stack. If they know what they want, respect it — skip to step 4.
2. Otherwise: `planner` + `researcher` agents find the best fit.
3. Present 2-3 options with pros/cons via `AskUserQuestion`.
4. Write approved stack to `./docs`.

**Gate:** User approves tech stack.

## Step 4: Wireframe & Design

1. Ask user if they want wireframes. No → skip to Step 5.
2. `ui-ux-pro-max` skill + `researcher` agents in parallel:
   - Style, trends, fonts (real Google Fonts names — not just Inter/Poppins), colors, spacing
   - Use Claude's native vision for any reference screenshots the user provides
3. Outputs: design guidelines at `./docs/design-guidelines.md`, wireframes in HTML at `./docs/wireframe/`
4. Screenshot wireframes with `chrome` skill → `./docs/wireframes/`

**Gate:** User approves design. Rejected? Redo. Don't negotiate.

## Step 5: Planning

Activate `/plan --hard <requirements>`.
- Plan directory with `plan.md` (<80 lines) + `phase-XX-*.md` files
- Present pros/cons of the plan

**Gate:** User approves plan. No code until this gate passes.

## Step 6: Implementation → Final Report

Load `references/shared-phases.md`. Activate `/cook <plan-path>` — interactive mode with review gates at each step.
