# Summarize Workflow

Quick refresh of `docs/codebase-summary.md` only. Use when you want "what's in this repo?" answered cheaply without rewriting the whole doc set.

## Arguments

- `$1` — Focused topics (default: all modules)
- `$2` — Should scan codebase (`true` | `false`, default: `false`)

## Focused Topics

<focused_topics>$1</focused_topics>

## Should Scan Codebase

<should_scan_codebase>$2</should_scan_codebase>

## Workflow

### Default ($2 = false) — doc-only refresh

1. Read current `docs/codebase-summary.md` (if exists).
2. Read surrounding docs for cross-reference: `project-overview-pdr.md`, `system-architecture.md`.
3. Delegate to `docs-manager` agent:

   ```
   Task: Refresh docs/codebase-summary.md against latest project state.
   Focused topics: {$1 or "all"}
   Rules:
   - Do NOT scan full codebase — work from existing docs + README.
   - Under 500 LOC.
   - Module layout, entry points, data models, external deps.
   - Verify any code reference you include.
   ```

4. Return summary path + 3-5 line diff summary to the user.

### Scan mode ($2 = true) — fresh scan

1. Delegate to `explore` skill to scout the codebase (same surface as init phase 1).
2. Merge scout output.
3. Delegate to `docs-manager` with scout summary + instruction to rewrite `docs/codebase-summary.md`.
4. Run `.claude/scripts/validate-docs.cjs docs/codebase-summary.md` if present.

## Size Check

Final `codebase-summary.md` should stay under **500 LOC** (tighter than the 800 global cap — this file is meant to be a quick index). If over, split module details into `docs/modules/<name>.md` and keep the summary as a table of links.

## Notes

- Use `./docs/` as source of truth — summarize mode trusts existing docs by default.
- **Do not** scan the entire codebase unless `$2 = true`.
- **Do not** start implementing feature code.
- **Do not** touch any doc file other than `codebase-summary.md` (and optionally `docs/modules/` if splitting).
