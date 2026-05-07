---
name: docs-seeker
description: Look up library/framework docs via llms.txt (context7.com). Use when you need API docs, GitHub repo analysis, or feature/component lookup for the latest libraries.
argument-hint: "[library-name] [topic]"
metadata:
  author: claudex-kit
  version: "3.1.0"
---

# Documentation Discovery via Scripts

## Overview

**Script-first** — run Node scripts to build URLs, handle fallbacks, distribute agents. Zero-token execution for mechanics, saving context for reading docs.

Based on `llms.txt` standard via `context7.com` (+ fallback to official site).

## Primary Workflow

**Run sequentially:**

```bash
# 1. DETECT query type
node .claude/skills/docs-seeker/scripts/detect-topic.js "<user query>"

# 2. FETCH docs
node .claude/skills/docs-seeker/scripts/fetch-docs.js "<user query>"

# 3. ANALYZE (if multiple URLs)
cat llms.txt | node .claude/skills/docs-seeker/scripts/analyze-llms-txt.js -
```

Scripts handle URL construction, fallback chain, error handling automatically.

## Scripts

**`detect-topic.js`** — Classify query
- Topic-specific vs general
- Extract library name + topic keyword
- Output JSON: `{topic, library, isTopicSpecific}`

**`fetch-docs.js`** — Fetch llms.txt
- Build URL `context7.com/{path}/llms.txt?topic=...`
- Fallback: topic URL → general URL → error
- Auth via `CONTEXT7_API_KEY` if available

**`analyze-llms-txt.js`** — Classify URLs
- Group: critical / important / supplementary
- Suggest agent distribution (1 / 3 / 7 / phased)
- Output JSON: `{totalUrls, grouped, distribution}`

## Workflows

- [topic-search.md](./workflows/topic-search.md) — fastest (10-15s), query with specific feature
- [library-search.md](./workflows/library-search.md) — comprehensive (30-60s), query about entire library
- [repo-analysis.md](./workflows/repo-analysis.md) — fallback when no llms.txt available, uses Repomix

## References

- [context7-patterns.md](./references/context7-patterns.md) — URL patterns, known repo mappings
- [errors.md](./references/errors.md) — Error handling, fallback chain
- [advanced.md](./references/advanced.md) — Versioning, multi-language, edge cases

## Execution Principles

1. **Scripts first** — build URLs via scripts, never construct URLs manually
2. **Zero-token overhead** — scripts run outside context
3. **Automatic fallback** — topic → general → official site → repo analysis
4. **Progressive disclosure** — only load workflow/reference when needed
5. **Agent distribution** — script recommends number of parallel Explore agents

## Quick Start

**Topic query:** "How do I use date picker in shadcn?"
```bash
node .claude/skills/docs-seeker/scripts/detect-topic.js "<query>"  # → {topic, library, isTopicSpecific}
node .claude/skills/docs-seeker/scripts/fetch-docs.js "<query>"    # → 2-3 URLs
# Read URLs via WebFetch
```

**General query:** "Documentation for Next.js"
```bash
node .claude/skills/docs-seeker/scripts/detect-topic.js "<query>"         # → {isTopicSpecific: false}
node .claude/skills/docs-seeker/scripts/fetch-docs.js "<query>"           # → 8+ URLs
cat llms.txt | node .claude/skills/docs-seeker/scripts/analyze-llms-txt.js -  # → distribution strategy
# Deploy Explore agents per recommendation
```

## Environment

Scripts load `.env` by priority (low → high):
1. `.claude/.env` ← **main file, copy from `.claude/.env.sample`**
2. `.claude/skills/.env`
3. `.claude/skills/docs-seeker/.env`
4. `process.env` (highest)

See [.env.sample](../../../.env.sample) for variables: `CONTEXT7_API_KEY`, `DEBUG`, etc.

## Chain

This skill is **not in any workflow chain** — standalone utility, invoke mid-workflow when docs lookup is needed.
