# Workspace State Sync (MANDATORY FIRST STEP)

Skills that rely on workspace metadata (`brainstorm`, `plan`, `cook`, `fix`) **MUST** run this sync as the very first action — before reading any phase file, before scouting, before any other tool call.

## Why

The ambient sync hooks can be swallowed by the Claude Code runtime in certain contexts (Skill-triggered tool calls). To guarantee the sync fires, each affected skill runs the check itself via Bash and reacts to the result.

## How

**Step 1.** Run the check via Bash (cross-shell — works on bash, zsh, PowerShell):

```bash
node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-sync.cjs" --check --skill=<SKILL_NAME>
```

Replace `<SKILL_NAME>` with the literal skill name: `brainstorm`, `plan`, `cook`, or `fix`.

**Step 2.** React to the exit code:

| Exit | Stdout | Action |
|------|--------|--------|
| `0`  | empty  | Workspace state OK — proceed with the skill as normal |
| `1`  | plain-text notice | Workspace state out of sync — follow the steps below |

**When exit = 1:**

1. Print the stdout contents **verbatim** to the user (inside a fenced code block to preserve formatting).
2. Do **NOT** run any further tool calls.
3. Do **NOT** invoke `AskUserQuestion` or continue the workflow chain.
4. End the response.

**Example response skeleton when exit = 1:**

```
<stdout from the Bash check, verbatim inside a code block>
```

(No preamble, no analysis, no "Let me help you fix this" — just the message, then stop.)

## Rules

- Run this sync on EVERY invocation of an affected skill — do not cache across turns.
- If the Bash command itself fails to execute (node missing, file missing) → treat as `exit 0` (fail-open) and proceed.
- Do not modify, paraphrase, or translate the stdout notice.
- This check costs one Bash call (~50ms) — negligible overhead.
