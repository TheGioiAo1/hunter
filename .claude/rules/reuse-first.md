# Reuse First

Before writing new code, the skills `/plan`, `/cook`, and `/fix` **must** check what already exists. Copy-paste across surfaces (public / admin / user, web / mobile, etc.) is the #1 source of divergence in this repo. This rule stops that at the door.

## The one-line rule

**Never write a new function, service, handler, middleware, hook, or component without first spawning `reuse-scout` to check for prior art — unless the change is < 20 LOC in a single file AND doesn't define a new public export.**

## What the rule applies to

| Situation | Trigger reuse-scout? |
|---|---|
| New service / repository / handler / controller | YES |
| New middleware / guard / interceptor | YES |
| New util / helper / lib module | YES |
| New hook / composable / context | YES |
| New component (non-trivial — has props, has state, or is used ≥2 places) | YES |
| New DTO / schema / validator | YES (check for existing shape) |
| Phase that touches ≥2 API surfaces with the same domain keyword | YES (mandatory, even if verdict would otherwise skip) |
| Typo / rename / 1-line fix | NO |
| Test-only file | NO |
| Config / env change | NO |
| CSS-only tweak | NO |

## When to spawn `reuse-scout`

| Skill | Spawn point | Why |
|---|---|---|
| `/plan` | After Scope Challenge (step 3), before writing phase files — **always, no exceptions** | Plan needs to decide whether phases propose shared layer first. Verdict shapes the phase list. This is the one place reuse-scout is never optional. |
| `/cook` | **Conditional** — reuse plan's verdict when available; re-scout only when stale or missing (see "Cook's conditional scout" below) | If the phase came from `/plan`, the audit is already inline. Re-scouting every phase in the same session is duplicate work. Cook verifies the audit exists + is fresh, then proceeds. |
| `/fix` | During Scout step (step 1), when diagnosis reveals a new function is needed | Patches often duplicate logic — scout catches it before the patch lands. `/fix` is typically standalone (no prior `/plan`), so it scouts fresh every time. |

## Cook's conditional scout

The typical flow `brainstorm → plan → cook` runs scout once at plan time. The verdict + candidate table land inside each phase file's `## Existing code audit` and `## Reuse strategy` sections. Cook **reads that** instead of re-scouting.

### Decision tree

For each phase, before Implement:

```
1. Does the phase file contain BOTH `## Existing code audit` AND `## Reuse strategy` sections?
   NO  → re-scout (legacy plan, hand-edited phase, or user wrote the phase manually)
   YES → continue

2. Is there a scout report referenced in the audit section (plans/reports/reuse-scout-*.md)?
   NO  → re-scout (audit text exists but provenance missing)
   YES → continue

3. Is the phase file's mtime newer than the scout report's mtime?
   YES → re-scout (phase was edited after original scout — scope may have changed)
   NO  → continue

4. Was `/cook` invoked standalone (no prior `/plan` in the chain)?
   YES → re-scout (scoped to the change being cooked)
   NO  → use the plan's audit inline, skip re-scout
```

Record the decision in the cook report under `## Existing utilities considered`:
- **"Reused plan's audit"** + scout report path (audit was fresh + valid)
- **"Re-scouted"** + reason from the tree above + new report path

### HARD-GATE still applies

Even on the reuse path, cook MUST NOT start Implement unless:
- The audit section exists and names a verdict (REUSE-AS-IS / REUSE-EXTEND / EXTRACT-SHARED / FORK-NEW)
- If verdict is EXTRACT-SHARED, the shared-layer phase has already run (or is the current phase)
- If verdict is REUSE-AS-IS or REUSE-EXTEND, the phase's Todo list includes the import/edit to the existing module (not a new file)

Missing any of the above → treat as "audit missing" and re-scout. Never skip-to-Implement because the file "looks done."

## Spawn template

```
Task: Scout reusable code for "<keyword>"
Agent: reuse-scout
Context:
  - Keyword(s): <primary noun + 2-3 verb/variant forms>
  - Target layer(s): <handler | service | repository | middleware | util | hook | component | dto>
  - Entry points / surfaces: <api/public | api/admin | api/user | web | mobile | cron | worker>
  - Work context: <project root>
  - Phase file (optional): plans/<plan-dir>/phase-NN-<name>.md
Acceptance: report at plans/reports/reuse-scout-<YYMMDD>-<HHmm>-<slug>.md, inline summary returned
```

## Cross-surface detection (the core problem)

Most repos grow with one surface at a time (first `api/public`, then `api/admin`, then `api/user`). The domain logic — validate, create, log, notify — gets **copy-pasted** each time because the existing code is coupled to a specific surface (reads `req.user.role`, hardcodes an audit tag, etc.).

### When the phase touches ≥2 surfaces

The caller **MUST** pass all relevant surfaces in the spawn template. If `reuse-scout` detects duplication across them:

1. Verdict is locked to **EXTRACT-SHARED** — no overrides.
2. The plan/cook/fix must add a **shared-layer phase** BEFORE the new code phase.
3. The shared phase refactors existing callers to use the new shared module — NOT left as "follow-up".

### Why "left as follow-up" is banned

"Refactor in a follow-up PR" → never ships. Next time someone adds a 4th surface, they copy-paste from the 3 existing ones and the problem doubles. Shared-layer extraction is part of the current phase or it doesn't happen.

## Reuse-vs-fork decision table (mirrors reuse-scout agent)

| Verdict | Caller action |
|---|---|
| REUSE-AS-IS | Import existing. Do not create new file. |
| REUSE-EXTEND | Add optional param / generic / enum to existing. One source of truth. |
| EXTRACT-SHARED | Hoist shared module, refactor existing callers, THEN implement new. |
| FORK-NEW | Write new. Document in report why reuse wasn't viable. |

**Tie-breaker**: REUSE-EXTEND > FORK-NEW when the existing candidate is ≥70% match.

## What gets recorded where

| Artifact | What to include |
|---|---|
| Phase file `## Existing code audit` | Summary of reuse-scout verdict + the candidate table |
| Phase file `## Reuse strategy` | One paragraph: REUSE-AS-IS / REUSE-EXTEND / EXTRACT-SHARED / FORK-NEW and why |
| Cook report `## Existing utilities considered` | File:line list of candidates that were evaluated, which verdict was applied |
| Cook report `## Shared modules created/updated` | If EXTRACT-SHARED, list the shared files created and the callers refactored |

If a cook/fix phase is implemented without these sections populated, the phase is **non-compliant** — `/review` must flag it.

## Override / bypass

The ONLY way to bypass reuse-scout:

1. User passes `--no-reuse-scout` flag explicitly to the skill. Or says "skip reuse check" in plain language.
2. Current phase is trivial (< 20 LOC, single file, no new exports) — auto-bypass.

Any other bypass attempt is a rule violation. Scouts are cheap (haiku, ~1-3s). Skipping them is never a real optimization — it's just hiding debt.

## Interaction with other rules

- **workspace-state-sync.md** — runs FIRST. Reuse scan only spawns after state sync passes.
- **workflow-chaining.md** — reuse-scout is a sub-agent, not a skill. It does NOT enter `workflow.chains`. It runs inside `/plan`, `/cook`, `/fix`.
- **context-hygiene.md** — reuse-scout reports are capped at 80 lines. Main session reads the inline summary. Full report sits on disk.

## FAQ

**Q: Our codebase is small / early-stage. Is this overkill?**
A: No. The whole point is to start the habit early — before you have 3 copies of the same thing. In a small repo, scout returns "nothing to reuse, FORK-NEW" in 1-2 seconds. Cheap insurance.

**Q: Scout said REUSE-EXTEND but the existing function is ugly. Can I rewrite it?**
A: Rewrite is out of scope for the current phase. Note it under "follow-ups" in the cook report. The rule is: don't create a NEW divergent copy while fixing the existing one. Either reuse ugly-as-is, or put the clean-up in its own plan.

**Q: What if scout and the planner disagree?**
A: Scout wins on reuse verdict. Planner wins on phase decomposition. If planner says "fork is fine here because the surfaces will diverge for real business reasons", that's a valid override — document it in the phase's `## Reuse strategy` section with the business reason.
