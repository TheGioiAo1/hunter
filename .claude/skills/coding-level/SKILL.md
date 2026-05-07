---
name: coding-level
description: "Set coding experience level to tailor Claude's explanations, jargon depth, and comment density. Persists via .claude-config.json or CODING_LEVEL env var. Auto-injected on every session start — no manual activation needed."
argument-hint: "[0-3]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Coding Level

Controls how much Claude explains. Set once, applies everywhere — every skill, every agent, every response.

## Levels

| Level | Name | Who | Claude behavior |
|-------|------|-----|-----------------|
| **0** | Intern | No coding experience / beginner | Explain every term in 1–2 lines. Avoid jargon when possible. Heavy code comments. WHY before HOW. Warn about common pitfalls |
| **1** | Junior | 0–2 years | Explain patterns/concepts on first encounter, skip basic syntax. Suggest best practices. Warn about anti-patterns. Link docs when relevant |
| **2** | Mid | 2–5 years *(default)* | Only explain complex logic or unclear trade-offs. Focus architecture decisions, edge cases, performance. Moderate comments |
| **3** | Senior+ | 5+ years / Lead | Minimal prose. Code + concise trade-offs. Skip known patterns. Focus scalability, security, business impact, risk |

## Configuration

**Option 1 — `.claude-config.json`** (recommended):
```json
{
  "codingLevel": 2
}
```

**Option 2 — `.env`**:
```bash
CODING_LEVEL=2
```

Priority: `.env` > `.claude-config.json` > default (2).

## How It Works

1. `session-init.cjs` hook reads `codingLevel` from config or `CODING_LEVEL` from env
2. Injects level-specific guidelines into the session context
3. All skills respect the `Tone Calibration` section — it references this level
4. No manual activation needed — set the config and forget it

## Changing Level Mid-Session

Run `/coding-level [0-3]` to change level for the current session. This updates the config file so it persists.
