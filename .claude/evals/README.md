# Evals

Regression harness for claudex-kit skills. Each eval is a JSON spec that pins down one piece of behavior a skill must maintain. When you tweak a skill's SKILL.md, run the relevant evals before shipping to catch drift.

## Layout

```
.claude/evals/
├── README.md                 — this file
├── run.cjs                   — CLI runner (list / validate / show)
└── smoke/                    — "must pass" baseline evals
    ├── cook/
    │   ├── 01-surgical-discipline.json
    │   └── 02-reuse-first-check.json
    └── plan/
        └── 01-scope-challenge.json
```

Filename convention: `NN-kebab-name.json`. The `name` field inside the JSON must match the filename without the numeric prefix. The `skill` field must match the parent directory name. `run.cjs validate` enforces both.

## CLI

```bash
# List all evals
node .claude/evals/run.cjs list

# Validate every eval's schema
node .claude/evals/run.cjs validate

# Show one eval's full spec
node .claude/evals/run.cjs show surgical-discipline
node .claude/evals/run.cjs show cook/surgical-discipline   # disambiguate
```

Exit codes: `0` OK, `1` validation failure / not found, `2` usage error.

## Eval schema

```json
{
  "name": "surgical-discipline",
  "skill": "cook",
  "description": "One-line summary of what this eval protects against",
  "fixture": "fixtures/<name>",
  "prompt": "The exact user prompt that triggers the scenario",
  "context": { "...": "any setup state the runner/human needs" },
  "assert": {
    "files_changed": { "must_include": [...], "must_not_include": [...] },
    "diff": { "max_lines_changed": 20, "must_not_contain_patterns": [...] },
    "behavioral": { "reuse_scout_spawned": true },
    "metrics": { "max_tokens": 40000, "max_duration_ms": 90000 }
  },
  "rationale": "Why this eval exists — what regression it catches"
}
```

Only `name`, `skill`, `description`, `prompt`, `assert` are required. `assert` must be non-empty.

### Assert blocks — what each means

| Block | Purpose |
|---|---|
| `files_changed` | Whitelist / blacklist of paths that should / shouldn't appear in the diff |
| `diff` | Regex patterns that must not appear; hard line-count caps |
| `behavioral` | Flags the runner observes during the run (e.g. "did reuse-scout spawn?") |
| `cook_report_sections` | Sections the cook report is required to contain |
| `plan_artifacts` | Structural checks on the generated plan directory |
| `metrics` | Hard ceilings on cost — tokens, duration |

Skills evolve, so assert blocks evolve too. Add new keys when new behaviors need pinning. The runner ignores unknown keys (forward-compatible).

## How to run an eval today (MVP)

`run.cjs` only validates and shows — it does not execute evals yet. To actually run one:

1. `node .claude/evals/run.cjs show <name>` — read the full spec
2. Set up `fixture` directory manually (copy into a scratch repo)
3. Paste the `prompt` into a fresh Claude Code session pointed at the fixture
4. Compare the run against the `assert` checks by eye
5. Record pass/fail in a local scratchpad or issue tracker

A future `local-runner.cjs` will automate steps 2-4 via the Claude Agent SDK. For now, manual is fine — the value is in having the spec pinned down, not the automation.

## When to add an eval

Add a new eval when:
- A user-visible skill behavior was wrong → fix the skill, add an eval that would have caught it
- You change a rule in a SKILL.md and want a backstop that the change stuck
- You notice drift between two skills that should behave the same (e.g. both `/cook` and `/fix` must respect reuse-first)

Don't add an eval when:
- The behavior is covered by an existing eval → tighten the existing one instead
- The check is purely syntactic (schema linting) — that belongs in a hook, not an eval

## When to remove an eval

- The skill it tests was removed
- The behavior it tests was intentionally changed (then: either rewrite the eval or delete it and write the replacement)
- Two evals cover the same thing → keep the stricter one

Don't keep evals alive past their purpose — stale evals that false-fail erode trust in the suite.

## Why smoke only (for now)

`smoke/` holds the minimum set every change to claudex-kit should pass. As the suite grows, we can add siblings:
- `golden/` — richer fixtures, longer runs, run nightly not per-change
- `adversarial/` — prompts designed to trick skills into misbehaving
- `perf/` — cost / duration regression tracking

Start narrow, grow deliberately. An eval suite with 3 high-value evals beats 30 low-value ones.
