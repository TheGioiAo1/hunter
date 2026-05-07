# External scouting — Gemini CLI

Offload the heavy scanning to Gemini. It has a 1M token context window and is nearly free — let it read hundreds of files while Claude keeps its context clean for the actual thinking.

## When to use
Pass `ext` argument to `/explore`. Best for large codebases (200+ files) where Claude scanning directly would eat too much context.

## Why this works
```
Claude context (200K, expensive)
  → "I need to scan 300 files"
  → spawns Gemini via Bash (1M context, nearly free)
  → Gemini reads 300 files, returns 50-line summary
  → Claude receives summary, not raw files
  → 95% token savings on the scan phase
```

## Prerequisites

Check if Gemini CLI is installed:
```bash
which gemini
```

If not installed → ask user once:
1. **Install** → `npm install -g @anthropic-ai/gemini-cli` (may need auth setup)
2. **Skip** → fall back to internal scouting (`internal-explore.md`)

## Configuration

Read model from `.claude/settings.json` or default:
```
Default model: gemini-2.5-flash
```

## Command

```bash
gemini -y -m <model> "<prompt>"
```

The `-y` flag auto-confirms, no interactive prompts.

## Prompt guidelines

Be specific about scope. Gemini doesn't know your project context — spell it out:

```bash
gemini -y -m gemini-2.5-flash "Search the directory src/ for files related to authentication. List every file path with a 1-line description of what it does. Also note any patterns like shared middleware, decorators, or guards."
```

Good prompts:
- Name exact directories
- Say what you're looking for
- Request file paths + descriptions
- Ask for patterns if relevant

Bad prompts:
- "Find auth stuff" (too vague, Gemini will hallucinate paths)
- No directory scope (scans everything, slow)

## Parallel execution

Spawn multiple Gemini calls in parallel via Bash subagents:

```
Task 1 (Bash): "Run: gemini -y -m gemini-2.5-flash 'Scan src/api/ and src/routes/ for API endpoint definitions. List paths + descriptions.'"
Task 2 (Bash): "Run: gemini -y -m gemini-2.5-flash 'Scan src/services/ and src/lib/ for business logic and utilities. List paths + descriptions.'"
Task 3 (Bash): "Run: gemini -y -m gemini-2.5-flash 'Scan prisma/ db/ migrations/ config/ for database schema and config. List paths + descriptions.'"
```

Spawn all in a single Task tool call — they run concurrently.

## Reading file content via Gemini

When you need Gemini to actually read and summarize file content (not just list paths):

**Small files (<500 lines each):**
```bash
gemini -y -m gemini-2.5-flash "Read these files and summarize what each does: src/auth/login.ts, src/auth/register.ts, src/middleware/auth.ts"
```

**Large files (>500 lines):**
Chunk with sed first, then feed to Gemini:
```bash
sed -n '1,500p' src/services/payment.ts | gemini -y -m gemini-2.5-flash "Summarize this code (part 1 of 3):"
```

## Timeout & fallback

- 3 minutes per Gemini call
- If Gemini hangs or errors → fall back to internal scouting for that slice
- Don't retry failed calls — move on, note the gap
