# Update Workflow

Update existing `./docs/` against the current codebase. Use after a major feature, phase completion, architecture shift, or API change.

## Phase 1: Codebase Scouting

1. Calculate LOC per top-level dir (skip `.claude`, `.opencode`, `.git`, `tests`, `node_modules`, `__pycache__`, `secrets`, `dist`, `build`, `.next`, `.venv`).
2. Target directories that actually exist.
3. Delegate to `explore` skill to produce a fresh structural summary (same surface as init: layout, entry points, data models, deps, config, routes, deploy footprint).
4. Merge scout output → save to `plans/reports/docs-update-{YYMMDD-HHmm}-scout.md`.

## Phase 1.5: Parallel Documentation Reading

**Main agent must spawn readers** — subagents cannot spawn subagents.

1. Count docs: `ls docs/*.md 2>/dev/null | wc -l`
2. Get LOC distribution: `wc -l docs/*.md 2>/dev/null | sort -rn`
3. Strategy by count:

   | Doc count | Action |
   |-----------|--------|
   | 1-3 files | Skip parallel reading; let `docs-manager` read directly |
   | 4-6 files | Spawn 2 `Explore` subagents; split files by LOC |
   | 7+ files  | Spawn 3 `Explore` subagents (max 3 to keep context tight); largest file gets its own agent |

4. Distribute files so each agent gets roughly equal total LOC (big file alone; small files grouped).
5. Each agent prompt:

   ```
   Task: Read these docs and extract (1) purpose, (2) key sections, (3) areas that look stale vs the scout summary.
   Files: {list}
   Scout summary: {path}
   Report format: bullet points per file, under 40 lines total.
   Work context: {project root}
   ```

6. Merge agent outputs → save to `plans/reports/docs-update-{YYMMDD-HHmm}-reading.md`.

## Phase 2: Documentation Update

**CRITICAL:** Spawn `docs-manager` agent via Task tool with both reports (scout + reading).

Delegation prompt template:

```
Task: Update project documentation to reflect current codebase.
Scout report:   plans/reports/docs-update-{YYMMDD-HHmm}-scout.md
Reading report: plans/reports/docs-update-{YYMMDD-HHmm}-reading.md

Files to update (if exists; skip if not present):
- README.md                          (cap 300 LOC)
- docs/project-overview-pdr.md
- docs/codebase-summary.md
- docs/code-standards.md
- docs/system-architecture.md
- docs/development-roadmap.md
- docs/project-changelog.md          (append-only — add new dated entry, never rewrite old entries)
- docs/deployment-guide.md           (only if it already exists or deployment changed)
- docs/design-guidelines.md          (only if it already exists or design tokens changed)

Rules:
- Verify every code reference, API endpoint, env var before writing.
- Remove stale refs. Mark uncertain sections with <!-- stale: verify --> rather than deleting blindly.
- Size cap 800 LOC — split if approaching.
- No fabricated signatures.

Additional requests from user: {$ARGUMENTS if present}

Work context: {project root}
Reports: {project root}/plans/reports/
```

## Phase 3: Size Check

After `docs-manager` DONE:

1. `wc -l docs/*.md 2>/dev/null | sort -rn`
2. Cap = **800 LOC**.
3. Files over cap: ask user to split now or accept as-is.

## Phase 4: Hallucination Check

If `.claude/scripts/validate-docs.cjs` exists:

```bash
node .claude/scripts/validate-docs.cjs docs/
```

Display warn-only output. Flag for user skim, do not auto-fix.

## Additional requests

<additional_requests>
$ARGUMENTS
</additional_requests>

If user provided arguments (e.g., `/docs update --focus api`), pass them to `docs-manager` in the delegation prompt as "Additional requests".

## Final Report

End response with:

- Files modified (with LOC delta)
- Files created (if any — usually none on update)
- Files flagged stale by `docs-manager` (with `<!-- stale: verify -->` markers)
- Issues flagged by validator
- Unresolved questions

## Notes

- Use `./docs/` as source of truth — do not revisit planning assumptions during update.
- `project-changelog.md` is append-only. Never overwrite old entries.
- **Do not** start implementing feature code.
