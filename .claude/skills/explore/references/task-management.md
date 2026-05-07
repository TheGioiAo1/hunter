# Task management for parallel scouting

Track parallel agent execution when spawning ≥3 agents. Adds visibility, not functionality — explore works fine without it.

## When to create tasks

| Agents spawned | Create tasks? | Why |
|---------------|--------------|-----|
| 1-2 | No | Finishes fast, overhead isn't worth it |
| 3+ | Yes | Helps track which agents finished, which timed out |

**If Task tools unavailable** (e.g. VSCode extension not loaded) → skip entirely, use `TodoWrite` as lightweight alternative or just proceed without tracking.

## Flow

```
TaskList()                        → check for existing explore tasks
  → found?  → reuse them
  → empty?  → TaskCreate one per agent
```

## Task schema

```
TaskCreate(
  subject: "Explore {directory} for {target}",
  activeForm: "Scanning {directory}",
  description: "Search {directories} for {patterns}",
  metadata: {
    agentType: "Explore" or "Bash",
    scope: "src/auth/,src/middleware/",
    agentIndex: 1,
    totalAgents: 4,
    mode: "internal" or "external"
  }
)
```

Keep metadata minimal — just enough to know what each agent is doing.

## Lifecycle

```
Created          → pending
Agent spawned    → TaskUpdate → in_progress
Agent returned   → TaskUpdate → completed
Agent timed out  → keep in_progress, add error note
```

## Timeout handling

Don't mark timed-out agents as completed — they didn't finish. Just note it:

```
TaskUpdate(taskId, {
  metadata: { ...existing, error: "timeout_3m" }
})
```

Log in the final report under "Gaps".

## Cleanup

Explore tasks are independent from other workflows (brainstorm, planning, implementation). Don't mix them. When explore finishes, its tasks stay as a record — no need to delete.
