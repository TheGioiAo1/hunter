# Workflow Chaining

After completing any skill that is a **key** in `workflow.chains` (from `.claude/.claude-config.json`), you MUST present the user with next-step options **before ending the response** — provided the remaining chain (after filtering) is non-empty. If the skill is terminal (not a key) or the filtered chain is empty, end the response without an `AskUserQuestion`.

## How It Works

1. When a skill finishes, look up its name as a **key** in `workflow.chains`.
   - If the skill is not a key → it is terminal (e.g. `git`). End the response with just the skill's output summary. No `AskUserQuestion`, no invented options.
2. If found, the array value is the remaining chain (ordered).
3. **Apply conditional filters** (see "Conditional Skills" below) — remove any skills whose prerequisite flags are not satisfied.
4. If the filtered chain is non-empty → you MUST invoke the `AskUserQuestion` tool to present next-step options.
5. If the filtered chain is empty → end the response without a prompt.
6. NEVER print options as markdown text (e.g. `[1] Proceed... [2] Stop...`). Text-based options cannot be clicked in the UI — that is a bug.

## Conditional Skills

Some skills in a chain are **gated by capability flags** in `.claude/.claude-config.json` → `workflow`. If the flag is not set (or is `false`), the skill is **silently removed** from the remaining chain before options are built.

### Current gates

| Skill | Flag | Meaning |
|-------|------|---------|
| `test` | `workflow.hasTests` | Only suggested when the project actually has test files / a test strategy committed. Default: `false` → `test` is filtered out of every chain. |
| `git`  | `.git` exists at project root (auto-detected) | Only suggested when the project is actually a Git repo. If `<projectRoot>/.git` does **not** exist → `git` is silently filtered out. **No config flag** — filesystem check only, using `resolveProjectRoot()` to anchor at the real root (not a sub-project `cwd`). Skips the "Proceed to /git" nag for vibe-coders / quick scripts that haven't `git init`'d yet. |

### How to flip a gate

- `hasTests` gets set to `true` **only inside `brainstorm` or `plan`** — after the user explicitly commits to writing tests (via `AskUserQuestion`). Those skills are responsible for:
  1. Asking the user whether automated tests are part of the work
  2. If yes → edit `.claude/.claude-config.json` and set `workflow.hasTests = true`
  3. Ensuring the plan/report includes test file ownership + success criteria
- Once `hasTests` is `true`, every subsequent chain will include `test` as normal.
- The user may also flip the flag manually (e.g. "dự án này có test rồi") — treat that as explicit consent and update the config.

### Filtering algorithm (pseudo)

```
remaining = chains[current_skill]

# Gate 1: tests — user-committed flag
if workflow.hasTests !== true:
    remaining = [s for s in remaining if s != "test"]

# Gate 2: git — filesystem auto-detect at the real project root
projectRoot = resolveProjectRoot(cwd)   # walks up for .git / .claude marker
if not fs.exists(projectRoot + "/.git"):
    remaining = [s for s in remaining if s != "git"]

next = remaining[0]
rest = remaining[1:]
options = [Proceed to /{next}]

# Near-skip: jump one step
if len(rest) >= 1 and next not in workflow.skipBlockers:
    options.append(Skip to /{rest[0]})

# Commit shortcut: jump multiple steps straight to /git
# Only when code already exists (no producer skill blocking the path)
if "git" in remaining and next not in workflow.skipBlockers:
    git_idx = remaining.index("git")
    if git_idx >= 2:
        intermediate = remaining[1:git_idx]
        if not any(s in workflow.skipBlockers for s in intermediate):
            options.append(Skip to /git)

options.append(Stop here)
# then build AskUserQuestion from `options`
```

- If filtering empties the chain → do NOT call `AskUserQuestion`. Just report completion and stop.
- If the only survivor is `git` AND `.git` exists → present the single "Proceed to /git" + "Stop here" pair.
- If the only survivor is `git` AND `.git` is **missing** → chain is empty → no prompt, just stop.
- NEVER show `test` as an option when its gate flag is off, even if it appears in the raw chain.
- NEVER show `git` as an option when the project has no `.git` folder, even if it appears in the raw chain.

## Option Format (AskUserQuestion params)

After skill `{current}` completes, with chain `[next, ...rest]`, call `AskUserQuestion` with:

- **question**: `"{current} done. Chain: {next} → {rest...}. Next step?"`
- **header**: `"Next step"`
- **multiSelect**: `false`
- **options** (2–4 items; the UI auto-appends "Other"):
  - `"Proceed to /{next}"` — invoke the next skill with context from current
  - `"Skip to /{rest[0]}"` — near-skip (one step). Only include if **all** of these hold:
    1. `rest` has 1+ items
    2. `next` is NOT in `workflow.skipBlockers` (see "Skip Safety" below)
  - `"Skip to /git"` — commit shortcut (multi-step jump). Only include if **all** of these hold:
    1. `git` is in remaining chain (post-filter)
    2. `git` is at index ≥ 2 in remaining (i.e. not `next` and not `rest[0]` — those are covered above)
    3. `next` is NOT in `workflow.skipBlockers`
    4. No producer skill (`cook` / `fix` / any entry in `skipBlockers`) sits between `next` and `git` in remaining — code must already exist to commit
  - `"Stop here"` — end the workflow, no further skills

## Skip Safety — blockers

Some skills **produce the artifact** that every downstream skill consumes. Skipping them orphans the rest of the chain. The list lives in `.claude/.claude-config.json` → `workflow.skipBlockers` (default `["cook", "fix"]`).

Rule: if `next` ∈ `skipBlockers` → **do NOT show the Skip option**. Only `Proceed` + `Stop` (+ auto `Other`).

### Why
- `cook` writes the code. Skipping `cook` → `test`/`simplify`/`review`/`git` have nothing to work on.
- `fix` applies the bug fix. Skipping `fix` → `simplify`/`review`/`git` have nothing to ship.
- Every other skill in a chain (`test`, `simplify`, `review`, `git`, `plan`, `brainstorm`) is **non-blocking** — skipping it leaves downstream skills a valid (if less-polished) artifact to work with.

### Examples

After `/plan` (chain `[cook, test, simplify, review, git]`, with `hasTests=false` filtering `test`):
- Raw remaining: `[cook, simplify, review, git]`
- `next = cook` ∈ skipBlockers → **no Skip option**
- Options shown: `Cook luôn` + `Stop here` (+ Other)
- ❌ Old behavior was: `Cook luôn` + `Skip to /simplify` + `Stop` — nonsense, no code exists yet.

After `/debug` (chain `[fix, simplify, review, git]`):
- `next = fix` ∈ skipBlockers → **no Skip option**
- Options: `Proceed to /fix` + `Stop here`.

After `/cook` (chain `[test, simplify, review, git]`, with `hasTests=false` filtering `test`):
- Remaining: `[simplify, review, git]`
- `next = simplify` ∉ skipBlockers → near-skip allowed → Skip to /review
- `git` at index 2, intermediate `[review]` has no blockers → commit shortcut allowed → Skip to /git
- Options: `Proceed to /simplify` + `Skip to /review` + `Skip to /git` + `Stop`.

After `/cook` (chain `[test, simplify, review, git]`, with `hasTests=true` keeping `test`):
- Remaining: `[test, simplify, review, git]`
- `next = test` ∉ skipBlockers → near-skip → Skip to /simplify
- `git` at index 3, intermediate `[simplify, review]` has no blockers → commit shortcut → Skip to /git
- Options: `Proceed to /test` + `Skip to /simplify` + `Skip to /git` + `Stop`.

After `/simplify` (chain `[review, git]`):
- `next = review` ∉ skipBlockers → Skip allowed
- `git` at index 1 → fails index ≥ 2 check → no additional commit shortcut (existing Skip to /git already covers it)
- Options: `Proceed to /review` + `Skip to /git` + `Stop`.

After `/brainstorm` (chain `[plan, cook, test, simplify, review, git]`, with `hasTests=false`):
- Remaining: `[plan, cook, simplify, review, git]`
- `next = plan` ∉ skipBlockers → near-skip → Skip to /cook
- `git` at index 4, intermediate `[cook, simplify, review]` contains `cook` (blocker) → **no commit shortcut** (can't ship code that doesn't exist)
- Options: `Proceed to /plan` + `Skip to /cook` + `Stop`.

After `/review` (chain `[git]`) in a project with **no `.git`** (e.g. fresh scratch dir, vibe-coder hasn't init'd):
- Gate 2 filters `git` out → remaining is empty.
- Result: no `AskUserQuestion`, just report completion and stop. No "Proceed to /git" nag.

After `/simplify` (chain `[review, git]`) in a project with **no `.git`**:
- Gate 2 filters `git` out → remaining = `[review]`.
- `next = review` ∉ skipBlockers, but `rest` is empty → Skip option not shown.
- Options: `Proceed to /review` + `Stop here`.

### Maintenance

When adding a new producer skill (e.g. `migrate`, `scaffold`, `generate`) that writes artifacts downstream skills depend on → add it to `skipBlockers`. No code change needed, just config.

### Examples

❌ WRONG (text print):

```
simplify done. Chain: review → git
[1] Proceed to /review
[2] Skip to /git
[3] Stop here
Which option?
```

✅ RIGHT: call `AskUserQuestion` tool with structured options above.

## Rules

- **Option 1 (Proceed)**: invoke the next skill via `/` command with relevant context from the current skill.
- **Option 2 (Skip)**: remove the skipped skill, invoke the one after it. Only show if the chain has 2+ remaining items AND `next` is not a skip blocker (see "Skip Safety" above).
- **Option 3 (Stop)**: end the workflow. Do NOT invoke any further skills.
- **Option 4 (Other)**: ask the user what they want to do instead.
- Always pass context from the completed skill to the next (report path, plan path, summary, changed files list, etc.).
- This rule REPLACES any hardcoded "Finalize Phase" transitions inside individual skills. Skills should NOT independently ask "want to create a plan?" or "want to commit?" — this rule handles all transitions.

## Chain Lookup

Read chains from `.claude/.claude-config.json` → `workflow.chains`:

```json
{
  "workflow": {
    "hasTests": false,
    "skipBlockers": ["cook", "fix"],
    "chains": {
      "brainstorm": ["plan", "cook", "test", "simplify", "review", "git"],
      "plan":       ["cook", "test", "simplify", "review", "git"],
      "cook":       ["test", "simplify", "review", "git"],
      "debug":      ["fix", "simplify", "review", "git"],
      "fix":        ["simplify", "review", "git"],
      "test":       ["simplify", "review", "git"],
      "simplify":   ["review", "git"],
      "review":     ["git"]
    }
  }
}
```

The raw chains keep `test` in place; **filtering happens at lookup time** based on `workflow.hasTests` (see "Conditional Skills" above). This way flipping one flag enables `test` everywhere instead of editing 4 arrays.

## Mid-Chain Entry

When the user starts at a mid-chain skill (e.g. running `/plan` directly), use **that skill's own chain** — not any parent's remaining chain. Each key in `chains` is an independent entry point.

Example: user runs `/cook` directly → chain is `["test", "simplify", "review", "git"]`, not `["plan", "cook", ...]`.

## Context Passing

When transitioning between skills, always pass the relevant context:

| Transition | Context to pass |
|------------|-----------------|
| `brainstorm` → `plan` | Report file path, key decisions, chosen approach |
| `plan` → `cook` | Plan directory path, phase files |
| `cook` → `test` | Modified files list, phases completed |
| `test` → `simplify` | Test results summary, files covered |
| `simplify` → `review` | Changed files summary, refactor notes |
| `review` → `git` | Review findings addressed, final changed files list |
| `debug` → `fix` | Report path, root cause summary, files involved |
| `fix` → `simplify` | Fix summary, affected files, root cause |

## Enforcement

Before ending the response after a chained skill completes:

1. Check if the current skill appears in `workflow.chains` **as a KEY** (i.e. `chains[currentSkill]` exists).
   - Appearing only as a *value* inside another skill's array does NOT count. Values-in-arrays describe what comes next for some *other* skill, not what comes after the current one.
2. If the current skill is a key → compute the remaining chain via the filtering algorithm above.
   - If remaining is non-empty → **the LAST tool call before ending the response MUST be `AskUserQuestion`**.
   - If remaining is empty (all filtered out) → no prompt, just report completion and stop.
3. If the current skill is NOT a key → it is a **terminal skill**. No prompt, just report completion and stop. Do NOT invent options.

### Terminal skills

A skill is terminal when `chains[currentSkill]` is undefined. Right now that's `git` — nothing runs after commit/push. Terminal skills are the natural end of a workflow.

**Never fabricate next-step options for a terminal skill.** If the chain is out, the workflow is done. Examples of wrong behavior:

- ❌ After `/git`: offering "Draft release notes" / "Write CHANGELOG" / "Tag release" as AskUserQuestion options. The chain stopped at git — there is no "next step" to offer.
- ❌ Picking any skill the user hasn't asked for and dressing it up as "want to do X next?"
- ✅ After `/git`: write the output summary (what was committed / pushed / PR URL), end the response.

If the user wants release notes, tags, changelog, etc. — they'll ask. Don't prompt.

### Violation examples

- ❌ `"simplify done. Chain: review → git\n[1] Proceed to /review\n[2] Stop"` (markdown text)
- ❌ `"Workflow chain: ...\nWhich option?"` (asking via plain text)
- ❌ Ending the response with a text question after a skill completes
- ❌ Calling `AskUserQuestion` after a terminal skill (e.g. `/git`) with invented options
- ✅ Calling `AskUserQuestion` tool with structured options as the last action — when the current skill IS a key and the remaining chain is non-empty
- ✅ Ending with just the skill's output summary when the current skill is terminal OR the filtered chain is empty

### Why this matters

The `AskUserQuestion` tool renders an interactive UI prompt with clickable options. Markdown text forces the user to type their choice manually — that defeats the purpose. At the same time, prompting when there's nothing meaningful to ask is worse than not prompting at all: it wastes the user's attention and pushes them toward options they didn't want. This rule applies to **every** skill that is a KEY in `workflow.chains`, with no exceptions. Skills that are only values (terminal skills) get no prompt.

## Authorized overrides

Some skills have bespoke fork logic at their Hand off step. These deviate from the generic "Proceed / Skip / Stop" triad on purpose and are **authorized** — the skill's SKILL.md owns the fork UI and this rule yields to it.

| Skill | Fork point | Why |
|-------|-----------|-----|
| `plan` | Hand off | After a plan is written, the options depend on **TDD eligibility** of the plan. If eligible, surface `Cook luôn` (default) + `Viết test trước, cook sau` (TDD fork) + `Stop`. If not eligible, fall back to the generic chain. The skill runs `detect-tests.cjs` + `test-eligibility.cjs` and builds its own `AskUserQuestion`. |

When an authorized override is in play, the Enforcement rule still holds — the last tool call must be `AskUserQuestion`. Only the **options** differ.

## Which skills are currently available

`claudex-kit` currently ships with these skills: `bootstrap`, `brainstorm`, `chrome`, `coding-level`, `cook`, `db-analyze`, `db-design`, `debug`, `deploy`, `devops`, `docs`, `docs-seeker`, `docx`, `explore`, `fix`, `frontend-design`, `frontend-development`, `git`, `go-backend`, `loop`, `mermaidjs`, `mobile-development`, `node-backend`, `payment-integration`, `pdf`, `php-backend`, `plan`, `project-management`, `python-backend`, `react-best-practices`, `review`, `security`, `setup`, `simplify`, `skill-creator`, `test`, `theme-implement`, `ui-ux-pro-max`, `wails`, `xlsx`.

All skills referenced in `workflow.chains` (`cook`, `test`, `simplify`, `git`, `fix`, `review`) now exist. If a future chain references a skill that is not yet implemented, present the `AskUserQuestion` option anyway; if the user picks it and the skill is missing, respond: *"Skill `{name}` is not available in this version — what would you like to do instead?"* and let the user decide.

## Skills NOT in any chain

These skills are standalone utilities and do NOT trigger `AskUserQuestion` on completion:

- `bootstrap` — project scaffolding
- `chrome` — Chrome CDP automation
- `coding-level` — tone calibration (0-3) for the session
- `db-analyze` — DB inspection tool
- `db-design` — DB schema design + migration safety rules
- `deploy` — ship to AWS / Cloudflare / Vercel / VPS, direct or via CI
- `devops` — provision cloud infra + CI/CD pipelines + Docker / K8s reference
- `docs` — init / update / summarize `./docs/` via `docs-manager` agent
- `docs-seeker` — lookup library docs via llms.txt (context7.com), fallback repomix
- `docx` — read/edit/create Word (.docx) — pandoc, docx-js, OOXML
- `explore` — codebase exploration
- `frontend-design` — create UI from screenshot/video/description, anti-slop, design thinking
- `frontend-development` — React/TS patterns, Suspense, perf rules, file organization
- `go-backend` — Go backend patterns: Echo + GORM + Redis, handlers, middleware, repository pattern
- `loop` — repeat a task until a condition holds
- `mermaidjs` — Mermaid.js v11 syntax reference for flowchart, sequence, ER, Gantt, architecture diagrams
- `mobile-development` — React Native / Flutter / iOS / Android patterns
- `node-backend` — Node.js backend patterns: NestJS + Prisma + Mongoose + Redis, modules, services, DTOs
- `payment-integration` — Stripe / payment flow patterns
- `php-backend` — PHP backend patterns: Laravel 11 + Eloquent + Sanctum + Redis + Horizon, FormRequest, Resources, Services
- `python-backend` — Python backend patterns: FastAPI + Flask + Pydantic + SQLAlchemy + Beanie + Redis
- `project-management` — track plan progress, hydrate tasks, sync checkboxes, generate reports
- `pdf` — read/create/merge/split/fill form .pdf — pypdf, reportlab
- `react-best-practices` — React patterns reference
- `xlsx` — read/create/edit spreadsheet (.xlsx/.csv/.tsv) — openpyxl, pandas
- `skill-creator` — create, test, optimize Claude skills with eval-driven iteration
- `security` — standalone audit
- `theme-implement` — implement external UI code (artifacts, templates, Figma exports) into project
- `ui-ux-pro-max` — design intelligence database: 161 palettes, 99 UX rules, 57 fonts, 50+ styles
- `wails` — Wails desktop app patterns: Go↔React bindings, events, window management, native dialogs, packaging
- `setup` — one-shot environment setup

They can be invoked mid-workflow as helpers without breaking the active chain.
