# Init Workflow

Create initial documentation from a codebase scan. Use when `./docs/` is empty or missing key files.

## Phase 1: Codebase Scouting

1. Calculate LOC per top-level directory (skip credentials, caches, external modules: `.claude`, `.opencode`, `.git`, `tests`, `node_modules`, `__pycache__`, `secrets`, `dist`, `build`, `.next`, `.venv`).
2. Target directories **that actually exist** — adapt to project structure, don't hardcode `src/lib/app`.
3. Delegate to `explore` skill (or spawn `Explore` built-in subagent) to produce a structured summary:
   - Module layout + entry points
   - Data models (Prisma schema, DB migrations, ORM definitions)
   - External dependencies (major npm/pip packages)
   - Config / env var surface
   - API routes / public interfaces
   - Deployment footprint (Dockerfile, compose, CI)
4. Merge scout reports into a single context summary → save to `plans/reports/docs-init-{YYMMDD-HHmm}-scout.md`.

## Phase 2: Documentation Creation

**CRITICAL:** Spawn `docs-manager` agent via Task tool with the scout summary. Do NOT wait for user input — scout + docs-manager is the full init flow.

Delegation prompt template:

```
Task: Initialize project documentation from scout summary.
Scout report: plans/reports/docs-init-{YYMMDD-HHmm}-scout.md
Files to create:
- README.md                          (cap 300 LOC)
- docs/project-overview-pdr.md       — PDR, feature scope, success metrics
- docs/codebase-summary.md           — module layout, entry points, data models
- docs/code-standards.md             — conventions, stack-specific rules
- docs/system-architecture.md        — components, data flow, integration points
- docs/development-roadmap.md        — phases, milestones, current progress
Optional (create only if relevant signal in scout):
- docs/deployment-guide.md           — only if Dockerfile / CI present
- docs/design-guidelines.md          — only if frontend with a design system

Rules:
- Every code reference, API endpoint, env var must be verified against actual codebase.
- No fabricated signatures. If uncertain, describe intent at high level.
- Size cap 800 LOC per file. Split into topic directory proactively.
- Kebab-case filenames.

Work context: {project root}
Reports: {project root}/plans/reports/
```

## Phase 3: Size Check

After `docs-manager` reports DONE:

1. Run `wc -l docs/*.md 2>/dev/null | sort -rn` to list LOC per file.
2. Compare against cap **800 LOC**.
3. For files exceeding the cap:
   - `docs-manager` should already have split proactively — if not, report which files exceed + by how much.
   - Ask user: split now (re-dispatch `docs-manager` with split instruction) or accept as-is?

## Phase 4: Hallucination Check (optional)

If `.claude/scripts/validate-docs.cjs` exists:

```bash
node .claude/scripts/validate-docs.cjs docs/
```

Display warn-only output. Non-blocking — flag issues for the user to skim, don't auto-fix.

## Final Report

End response with:

- Files created (with LOC)
- Files skipped + reason
- Issues flagged by validator (if run)
- Unresolved questions (scope gaps, missing signals)

## Notes

- Use `./docs/` as source of truth going forward.
- **Do not** start implementing feature code during init.
- **Do not** copy large snippets from the codebase into docs — docs describe, code implements.
