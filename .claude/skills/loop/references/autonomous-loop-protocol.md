# Autonomous Loop Protocol

8 phases per iteration. Complete them in order — no skipping, no shortcuts, no "I already know what to do." The protocol exists because you don't.

---

## Phase 0: Precondition Checks (first iteration only)

Run once. Abort with a clear error if any check fails.

1. Git repo exists (`git rev-parse --git-dir`)
2. Working tree clean (`git status --porcelain` → empty)
3. HEAD on a named branch (not detached)
4. No stale lock files (`loop-results.tsv.lock`)
5. Scope glob resolves to ≥1 file
6. Verify command dry-run: exits 0, prints a number
7. Guard command dry-run (if set): exits 0
8. Record **baseline metric** as iteration 0 in `loop-results.tsv`

---

## Phase 1: Review

Read context before every iteration. Do not skip even if "nothing changed" — the history changed.

```bash
git log --oneline -20              # what was tried and in what order
git diff HEAD~1                    # last change in detail
cat loop-results.tsv               # metric trend + keep/discard record
```

Extract patterns:
- Which file types / functions yielded improvements?
- Which changes were consistently discarded?
- Is the metric trending, plateauing, or oscillating?

**The review phase is where you stop being a code monkey and start being a scientist.** If you skip it, you're running experiments blind.

---

## Phase 2: Ideate

Pick **ONE** focused change. Rules:

- **Exploit** patterns from successful iterations — what worked before probably works again in adjacent code
- **Avoid** repeating failed patterns — same file + same approach that was discarded = definition of insanity
- **Atomicity test:** describe the change in one sentence. If it contains "and," split into two iterations
- Prefer high-leverage targets: files with low coverage, large bundle contributors, most lint errors
- 3+ consecutive discards on the same area → pivot. Different file, different technique

---

## Phase 3: Modify

- Edit files within `Scope` only. The fence is the fence.
- **Never** modify files referenced by the `Guard` command. That's tampering with the instrument.
- Ensure syntax is valid after edit (`tsc --noEmit` or equivalent for the language)
- Keep changes minimal — one logical unit. If the diff makes you scroll, it's too big.

---

## Phase 4: Commit

Commit **before** running verification. Git is the undo mechanism, not a post-hoc backup.

```bash
git add <changed files>
git commit -m "loop(iter-N): <one-line description>"
```

The `loop(iter-N):` prefix is not a suggestion — it enables `git log --grep="loop(iter-"` filtering.

---

## Phase 5: Verify

Run the verify command. Extract the number.

```bash
RESULT=$(eval "$VERIFY_CMD")
DELTA=$(echo "$RESULT - $PREV_METRIC" | bc)
```

### When things go wrong

| Outcome | Meaning | Action |
|---------|---------|--------|
| Exit 0, number printed | Success | Proceed to Phase 5.5 / 6 |
| Exit 0, no number | Bad command | Log `error:no-number`, revert, fix verify cmd |
| Exit non-zero | Verify crash | Log `error:verify-crash`, revert, treat as discard |
| Timeout (>30s) | Too slow | Log `error:timeout`, abort loop, surface to user |

---

## Phase 5.5: Guard (skip if no Guard configured)

Run the guard after verify.

```bash
eval "$GUARD_CMD"
```

| Guard exit | Action |
|------------|--------|
| 0 (pass) | Proceed to Phase 6 |
| Non-zero (fail) | Revert commit → rework (max 2 attempts) → discard if still failing |

Guard failure means the optimization is wrong, not that the guard is wrong. Never weaken the guard to pass.

---

## Phase 6: Decide

### Decision Matrix

| Metric direction | Delta vs Min-Delta | Guard | Decision |
|------------------|--------------------|-------|----------|
| higher is better | delta ≥ Min-Delta | pass | **KEEP** |
| higher is better | delta < Min-Delta | pass | **DISCARD** |
| lower is better  | delta ≤ -Min-Delta | pass | **KEEP** |
| lower is better  | delta > -Min-Delta | pass | **DISCARD** |
| any | any | fail | **DISCARD** |
| any | verify crash | n/a | **DISCARD** |

### Keep
Update `PREV_METRIC`. Reset consecutive-discard counter to 0.

### Discard
```bash
git revert HEAD --no-edit    # preferred: preserves history
# fallback only if revert conflicts:
# git reset --hard HEAD~1
```
Increment consecutive-discard counter.

---

## Phase 7: Log

Append one TSV line to `loop-results.tsv`:

```
{iter}\t{ISO8601_timestamp}\t{metric}\t{delta:+.2f}\t{kept:yes/no}\t{description}
```

---

## Phase 8: Repeat or Stop

Continue if ALL conditions met:
- Iteration count < configured max
- Consecutive discards < 10
- No `loop-stop` file or interrupt signal

### Stuck detection

| Consecutive discards | Action |
|----------------------|--------|
| 5 | Analyze `loop-results.tsv` → shift strategy (different scope area, different technique) |
| 10 | **STOP.** Surface findings. Recommend manual intervention. Don't grind. |

### Final report

```
Loop complete: N iterations, K kept, best metric: X (baseline: Y, delta: +Z)
Kept changes: [commit hashes + descriptions]
Discarded: [count]
Recommendation: [continue / diminishing returns / target met]
```

---

## Anti-Patterns

| Anti-pattern | Why it fails | Correct approach |
|--------------|--------------|------------------|
| Multiple changes per iteration | Can't attribute metric change to a specific edit | One atomic change only |
| Verify before commit | No rollback point if verify crashes | Always commit first |
| Editing guard-scope files | Guard becomes meaningless | Guard files are read-only |
| `git reset` instead of `git revert` | Destroys history, breaks pattern analysis | Use `git revert` |
| Skipping Phase 1 review | Repeats failed patterns, wastes iterations | Always read log + diff |
| Ignoring `Min-Delta` | Micro-improvements are noise, not progress | Set a meaningful threshold |
