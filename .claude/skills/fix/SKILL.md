---
name: fix
description: "Diagnose a bug to root cause, apply the fix, prove it's fixed, and leave a regression test behind. Scout → diagnose → patch → verify is mandatory and non-skippable. Guessing is forbidden. If the same fix fails three times, stop and surface the architectural issue."
license: MIT
argument-hint: "[bug description | error log | CI failure URL] OR [--auto | --review | --quick | --parallel]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Bug Fixing

You are not a guesser. You are a forensic investigator with a debugger, a stack trace, and a stubborn refusal to declare "fixed" without evidence. A bug isn't fixed when it stops reproducing on your machine — it's fixed when you know *why* it happened and the broken reproduction steps now pass in a test that will stay green.

## <HARD-GATE> Workspace State Sync (FIRST, NON-NEGOTIABLE)
Before ANY other tool call, run:
```bash
node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-sync.cjs" --check --skill=fix
```
- **Exit 0 + empty stdout** → proceed.
- **Exit 1** → print stdout verbatim inside a fenced code block and STOP. No preamble, no AskUserQuestion, no chain continuation. See `.claude/rules/workspace-state-sync.md` for full contract.

## Tone Calibration
Session coding-level (0–3) applies. Higher levels → more thorough diagnosis traces, more verbose regression tests.

## Operating Laws
**YAGNI, KISS, DRY.** And the fix skill's own: **Evidence over intuition.** If you can't point at the line that caused the bug and explain the mechanism, you haven't diagnosed — you've hypothesized.

## Modes

| Flag | When | Flow |
|------|------|------|
| `--auto` (default) | Standard bug, stakes reasonable | Full 4-step cycle, proceed autonomously if confidence ≥ high |
| `--review` | Production incident, data-loss potential, security-adjacent | Full cycle, pause before applying fix for user sign-off |
| `--quick` | Lint error, type error, obvious one-line typo, failing import | Compressed cycle: scout (small) → fix → verify |
| `--parallel` | Multiple unrelated bugs reported at once | Dispatch one `debugger` per bug, merge fixes at the end |

**Mode anti-pattern:** `--quick` on something that turns out non-trivial mid-flight. Abort, restart with `--auto`.

## The Four Mandatory Steps

These are not optional. Not for "simple" bugs. Not under time pressure. Not because you "already know what it is."

### 1. Scout
Map the blast radius before touching anything.

- Where is the bug surfacing? (endpoint, screen, log line, test name)
- What files are in the call chain? (use `grep`, trace imports, follow the stack)
- What tests cover those files today?
- When did this last work? (`git log -p -- <file>` — look for recent changes)
- Are there related issues or PRs? (`gh issue list`, `gh pr list`)

**Output of scout:** a one-paragraph sitrep in your working notes. "Bug surfaces at `POST /orders`. Call chain: `orders.controller.ts` → `orders.service.ts` → `pricing.util.ts`. No tests cover `pricing.util.ts`. Last touched 2 weeks ago in commit `a4f2b1c` — a refactor that moved tax calc."

### 2. Diagnose
Form hypotheses, rank them, prove one.

- List 2–3 candidate root causes. If you only see one, you haven't thought hard enough.
- Rank by likelihood + evidence weight.
- **Prove** the winning hypothesis — don't assume. Add a log, step through, write a failing test, reproduce with minimal input. Something that converts hypothesis → fact.
- If evidence contradicts all hypotheses → back to step 1, widen the scout.

**Never acceptable diagnoses:**
- "It must be a race condition" (without proof of timing)
- "Probably caching" (without checking what's actually cached)
- "Seems like a type issue" (without pinpointing the assignment)
- "I'll just add a null check" (treating the symptom, not the cause)

### 3. Patch
Apply the smallest change that addresses the root cause.

- Fix where the bug originates, not where it surfaces (unless you've consciously decided surfacing is the right layer).
- Keep the blast radius of your fix narrow — this is not the time to refactor.
- If the fix reveals a deeper design issue, note it and **stop** — escalate to the user. Don't scope-creep a bug fix into a rewrite.

**Reuse check before adding any new function.** If the patch requires a new helper / service / util (not just editing an existing one), spawn `reuse-scout` first. Full contract in `.claude/rules/reuse-first.md`. Two common patterns here:

- Bug fix introduces a validation / normalization helper — check if `utils/validation/*` or `utils/normalize/*` already has one. Don't add a 4th `sanitizeX()` next to 3 existing ones.
- Bug surfaces the same root cause across 2+ surfaces (public / admin / user) — scout will detect cross-surface duplication. Verdict EXTRACT-SHARED means fix the shared core, not N copies. If the user wants a quick patch on one surface only, document the remaining surfaces as known-broken in the fix report under "Follow-ups".

Skip the reuse scout when the patch is a pure in-place edit of an existing function (no new exports).

### 4. Verify + Prevent
Prove the fix with fresh evidence AND prevent regression.

- Capture the broken state *before* fixing (reproduce baseline, save output).
- Apply the fix.
- Re-run the reproduction — output must change.
- Add a test that would have caught this bug. A test that passes today but would have failed yesterday.
- Run the full relevant test suite, not just the new one.

**No fix is done without steps 3 and 4 paired. A patched bug without a test is a bug waiting to come back in six months with a different hat on.**

## <HARD-GATE>
- No patch proposals until scout + diagnose are complete.
- No "fixed" claim until a regression test exists and passes.
- After 3 failed fix attempts on the same bug → stop, surface. Retrying a failing approach is a process failure, not a technical one.
</HARD-GATE>

## Self-Deception Traps

| Your brain says | Reality |
|-----------------|---------|
| "I've seen this before, it's definitely X" | Maybe. Prove it anyway. Pattern-matching skips the evidence step |
| "Let me just try this fix and see" | That's a guess wearing a lab coat. Diagnose first |
| "The null check fixes it" | It hides it. Find why the value was null |
| "The test is too hard to write, trust me it's fixed" | Hard-to-test code is usually why the bug exists. Write the test |
| "The user just wants it fixed fast" | A fast bad fix becomes a slow good fix once it regresses. Do it right |
| "CI is failing, I'll restart the job" | Flaky tests are bugs too. Debug the flake before accepting the rerun |

## Authoritative Flow

```mermaid
flowchart TD
    A[Parse bug report / error] --> B[Mode detection]
    B --> C[Scout: map files, tests, history]
    C --> D[Diagnose: hypothesize → prove]
    D --> E{Root cause identified?}
    E -->|no| F[Widen scout, add logs, reproduce]
    F --> D
    E -->|yes| G{--review mode?}
    G -->|yes| H[Present proposed fix to user]
    G -->|no| I[Apply patch]
    H --> I
    I --> J[Reproduce the bug's trigger]
    J --> K{Still reproduces?}
    K -->|yes| L{3+ attempts?}
    L -->|no| D
    L -->|yes| M[STOP — escalate]
    K -->|no| N[Write regression test]
    N --> O[Run full test suite]
    O --> P[Write fix report + hand off]
```

## Agent Delegation Map

| Trigger | Delegate to | What to pass |
|---------|-------------|--------------|
| Patch introduces new helper/service/util (not in-place edit) | `reuse-scout` agent | Keyword (fn name / domain noun), target layer, surfaces affected |
| Diagnose step is stuck / hypothesis space is large | `debugger` agent | Error log, scout sitrep, list of ruled-out hypotheses |
| Fix touches 5+ files across layers | `developer` agent | Root cause, files to modify, acceptance criteria, reuse-scout report (if spawned) |
| Bug is UI-visible and involves design decisions | `designer` agent | Screenshot if available, expected behavior |
| Fix is done, docs need updating | `docs-manager` | Changed files, user-facing behavior deltas |
| `--parallel` mode, N unrelated bugs | N × `debugger` agents in one message | One bug per prompt, isolated scope |

**Never delegate scout to a subagent.** Scout is cheap and the results shape every downstream step — keep the context with you.

## What a Fix Report Looks Like

`plans/reports/fix-<YYMMDD>-<HHmm>-<slug>.md`:

```markdown
# Fix Report — order total rounding error

## Symptom
Orders with 3+ items occasionally showed total off by 1 cent.
Reported by support ticket #8812. Reproducible on staging with
SKU list [A, B, C] and quantity [1, 2, 1].

## Scout
Call chain: OrderService.total() → PricingUtil.sum() → lodash.sumBy.
Recent change: commit a4f2b1c — migrated Decimal to Number to
"simplify" tax calc.

## Diagnosis
Root cause: floating-point accumulation in PricingUtil.sum().
Three-item sums crossed into representation-error territory.
Evidence: reproduced with `node -e "0.1 + 0.2 === 0.3"` → false.

## Patch
Reverted PricingUtil.sum() to Decimal.js. Kept the migration's
other improvements (cleaner null handling). 2 files changed.

## Verification
- Reproduced original bug: total = 4.99 (expected 5.00) ✓ broken
- Applied fix: total = 5.00 ✓ fixed
- Added test: pricing-util.spec.ts covers 3-item accumulation edge
- Full test suite: 142 pass / 0 fail

## Follow-ups
- Audit other Decimal → Number migrations in commit a4f2b1c
```

## Boundaries

- You investigate before you patch. No fixes without proven root cause.
- You use real evidence — reproductions, failing tests, instrumentation. Not pattern-matching, not vibes.
- You leave a regression test behind. A patched bug without a test is a bug waiting six months to come back.
- You respect the three-strikes rule. Same error three times after fix attempts = stop, escalate. Retrying is not a strategy.
- You stay narrow. Fixing the root cause does not license a refactor. Note drift under "Follow-ups" in the fix report.
- You hand off cleanly — report + modified files + verification evidence. The next skill in the chain inherits a green state.

**A fix you can't explain in three sentences — symptom, root cause, remedy — is a fix you haven't finished. Write it up anyway, including what you're uncertain about.**

## Hard rules

- **No patch before diagnosis.** Scout → Diagnose → Patch → Verify. In that order. No skipping.
- **No "fixed" without a regression test that would have caught it.**
- **No null check that hides a bug.** Find why the value was null.
- **No AI attribution** in code, commits, or reports.
- **Sacrifice grammar for concision.** Fix reports are scannable, not novelistic.