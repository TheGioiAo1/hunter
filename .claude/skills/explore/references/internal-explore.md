# Internal scouting — Explore subagents

Use Claude's built-in Explore subagents to scan the codebase in parallel. Each agent gets its own context window and read-only tools (Glob, Grep, Read).

## When to use
Default mode. Always available, no external tools needed. Best when project has <500 files or Gemini CLI isn't installed.

## How it works

Spawn multiple Explore subagents via the `Task` tool. Each agent scans a specific slice of the codebase and returns a summary.

```
Task tool config:
  subagent_type: "Explore"
```

## Prompt template

Give each agent a clear, bounded task:

```
Scan {DIRECTORIES} for files related to: {SEARCH_TARGET}

Do:
- Glob/Grep to find relevant files
- Read key files if needed (skim, don't read everything)
- List file paths with 1-line descriptions
- Note any patterns or conventions you spot

Don't:
- Read files over 500 lines in full
- Spend more than 3 minutes
- Modify anything

Return:
## Found
- `path/file.ext` — description

## Patterns
- Key observations
```

## Splitting strategy

Divide by directory or domain — no overlap between agents:

| Agent | Scope example |
|-------|--------------|
| 1 | `src/auth/`, `src/middleware/` |
| 2 | `src/api/`, `src/routes/` |
| 3 | `src/services/`, `src/lib/` |
| 4 | `tests/`, `__tests__/` |
| 5 | `config/`, `prisma/`, `db/` |
| 6 | `types/`, `interfaces/`, `utils/` |

Adjust based on actual project structure. Fewer agents for smaller projects.

## Reading large files

When an agent needs to read a big file, chunk it instead of loading everything:

```
< 500 lines   → Read entire file
500-1500 lines → Split into 2-3 chunks via sed
> 1500 lines   → Split into ceil(lines/500) chunks
```

Chunking via sed:
```bash
sed -n '1,500p' large-file.ts       # chunk 1
sed -n '501,1000p' large-file.ts    # chunk 2
sed -n '1001,1500p' large-file.ts   # chunk 3
```

Get line count first: `wc -l path/to/file.ts`

## Parallel execution

Spawn ALL agents in a single Task tool call — they run concurrently. Don't spawn one, wait, spawn next.

## Timeout

3 minutes per agent. If an agent doesn't respond:
- Skip it
- Don't retry
- Note the gap in the final report under "Gaps"
