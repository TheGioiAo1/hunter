# Context Hygiene

The `.claude/hooks/context-awareness.cjs` hook injects a `<context-awareness>` tag at the top of every user prompt. This is **required reading** — the agent must adjust its behavior based on the `Status` in the tag.

The tag contains 2 distinct metrics:

- **Conversation: X% (tokens/200K)** — fill level of the current conversation's context window. **This is the primary signal** for deciding to compact. LLM quality degrades with context length (U-shaped attention: middle content goes "fuzzy", recall drops). Compacting at 90% keeps the agent in its sharp zone. Ignoring this = bugs slip through because the agent "forgets" things it read 30 tool calls ago.
- **Usage limits: 5h=X%, 7d=Y%** — Anthropic quota consumed over 5h / 7d. **Secondary signal** — warns of impending quota exhaustion so you can conserve calls; unrelated to degradation within this session.

`Status` = MAX of all three (Conversation, 5h, 7d) → always react to the most severe signal.

## Thresholds and behavior

### OK (<90%)
Normal operation. No special handling.

### WARNING (≥90%) — proactive compaction
1. **No large inline output.** Diff dumps, file content, stack traces, logs → save to `plans/reports/` and reference by path. Response should only contain a 3-5 line summary + link.
2. **Targeted file reads.** Use `Grep` + `Read` with `offset`/`limit` instead of reading whole files. Read only the lines you need.
3. **Cut preamble/postamble.** Answer directly. Drop "Let me...", "After reviewing...", "Hope this helps...".
4. **Delegate context-heavy work to subagents.** Keep the main session light — subagent reads 10 files, returns a 1-paragraph summary.
5. **Flush intermediate results to disk.** Don't hold analysis results in the turn — write to a file, reference the path.

### CRITICAL (≥98%) — stop the chain, snapshot
1. **Stop any in-flight skill chain.** Don't start new skills.
2. **Write a snapshot:** `plans/reports/context-snapshot-YYMMDD-HHmm.md` containing:
   - Current task + goal
   - Files touched
   - Next steps if continuing
3. **Notify the user:** *"Context {N}% — snapshot saved to {path}. Run `/compact` or open a new session to continue."*
4. **Don't try to cram in more work.** Keep the final response short, pointing back to the snapshot.

## When the tag is absent

If a prompt lacks `<context-awareness>` (hook disabled / fetch failed / credentials missing):
- Treat as `Status: OK` and operate normally.
- DO NOT try to estimate usage by counting tokens manually — that wastes more context than it saves.

## Core principles

- **Context quality > quantity.** High-signal tokens beat exhaustive ones.
- **Write > Keep.** Save to a file and hold the path, don't hold content in the turn.
- **Isolate > Share.** Subagents have their own context, keeping the main session lean.
- **Measure > Guess.** The hook gives real numbers. Don't estimate.

## Applying to subagents

When the main agent delegates via the `Task` tool, always pass context hygiene rules in the prompt:
```
Context constraint: current usage {N}%. Avoid inline dumps > 50 lines,
save heavy outputs to {work_context}/plans/reports/, report back a summary.
```
Subagents must also respect the WARNING/CRITICAL thresholds within their own session.
