# Git as Long-Term Memory

Git history is the loop's lab notebook. It's the only thing that persists across iterations, and it never lies. Read it every time.

---

## Required Reads — Every Iteration

Phase 1 (Review). No exceptions, even if you "remember" what happened:

```bash
git log --oneline -20              # what was tried and in what order
git diff HEAD~1                    # last change detail
cat loop-results.tsv               # metric trend + keep/discard record
```

Three questions these answer:
1. **What worked?** (kept=yes rows with positive delta)
2. **What failed?** (kept=no rows, repeated file paths)
3. **Where is the trend going?** (last 5 deltas — accelerating, flat, or reversing?)

---

## Pattern Recognition

### Exploit what worked
- Same file category improved before → try adjacent files in that category
- Same technique (adding edge-case tests) worked → apply to untouched functions
- Larger deltas correlate with a specific module → prioritize that module

### Avoid what didn't
- File + technique combo that was discarded → don't retry the same pair
- Zero-delta changes (refactors that don't move the metric) → skip unless required by guard
- Oscillating metric on a file → leave it alone, move elsewhere

### Detect diminishing returns
If the last 5 kept iterations all have `delta < Min-Delta * 2`, the low-hanging fruit is gone:
- Broaden scope to adjacent files
- Switch technique entirely
- Report the plateau honestly rather than grinding

---

## Revert vs Reset

Always `git revert`. Only fall back to `git reset` when revert produces a merge conflict.

| Command | Preserves history | Safe for analysis | Use when |
|---------|------------------|-------------------|----------|
| `git revert HEAD --no-edit` | Yes | Yes | Default discard path |
| `git reset --hard HEAD~1` | No | No | Revert conflict — last resort |

Why: `git log --grep="loop(iter-"` relies on intact history. A reset erases what was tried and silently breaks future pattern analysis.

---

## Commit Convention

```
loop(iter-N): <one-line description>
```

Examples:
```
loop(iter-3): add null guard to parseToken in lexer.ts
loop(iter-7): split large test fixture into focused unit cases
loop(iter-12): remove unused lodash import reducing bundle 1.2kB
```

Enables targeted queries:
```bash
git log --oneline --grep="loop(iter-"
```

Reverted commits stay in history with the standard message:
```
Revert "loop(iter-4): ..."
```

Intentional — discards are part of the experiment record, not mistakes to hide.
