---
name: explore
description: "Scan and summarize a codebase fast. Splits the project across parallel agents — Explore subagents by default, Gemini CLI when you pass `ext` — to find files, map structure, and report back what's relevant. Use before brainstorming, planning, debugging, or any task that needs codebase context first."
argument-hint: "[search-target] [ext]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Explore

Token-efficient codebase scanning. Divide the project across parallel agents, each scans its slice, results merge into one report.

## Arguments
- Default: spawn Explore subagents internally (`./references/internal-explore.md`)
- `ext`: use Gemini CLI for scanning — cheaper, 1M context window (`./references/external-explore.md`)

## When to trigger

- Before brainstorming or planning a feature that touches multiple areas
- User says "find", "locate", "where is", "how does X work"
- Starting a debug session where file relationships matter
- Before changes that could ripple across the codebase

## Process

### 1 — Read the prompt
Parse what the user needs: search targets, file types, directories. Run a quick Glob + Grep to gauge project size and identify top-level structure.

### 2 — Divide the work
Split the codebase into logical slices — by directory, by domain, by layer. Each agent gets a non-overlapping scope. Rule of thumb:
- Small project (<50 files) → 1-2 agents, or just Glob/Grep directly
- Medium project (50-200 files) → 2-4 agents
- Large project (200+ files) → 4-6 agents

### 3 — Track progress (optional)
If spawning ≥3 agents AND Task tools are available → register one task per agent via `TaskCreate` for progress visibility. See `references/task-management.md` for patterns. If ≤2 agents or Task tools unavailable → skip, overhead isn't worth it.

### 4 — Spawn agents
Pick the right reference and spawn:
- **Default** → `references/internal-explore.md` (Explore subagents)
- **`ext` argument** → `references/external-explore.md` (Gemini CLI via Bash)

Every agent gets:
- Exact directories to scan
- What to look for (from user prompt)
- Instruction to return file paths + brief descriptions
- 3-minute timeout

Spawn all agents in a single tool call for parallel execution.

### 5 — Merge results
- Collect reports from all agents
- Deduplicate file paths
- Note any agents that timed out
- Compile into one report

## Report format

```markdown
# Explore report

## Stack
- [detected framework, language, DB if visible]

## Relevant files
- `path/to/file.ts` — what it does
- `path/to/other.ts` — what it does

## Structure overview
- [high-level directory map if useful]

## Gaps
- [anything not found, timed-out agents, open questions]
```

**NEVER ask the user where to save.** Write the report to `plans/reports/explore-<YYMMDD>-<HHmm>-<slug>.md` using relative path from current working directory. `mkdir -p plans/reports/` if needed.

## References
- `references/internal-explore.md` — Explore subagent patterns
- `references/external-explore.md` — Gemini CLI patterns
- `references/task-management.md` — task tracking for parallel agents
