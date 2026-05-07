# Guard Pattern & Noise-Aware Verification

## Guard Pattern

The verify command answers "did the target metric improve?" The guard command answers "did anything else break?" Two different questions. Don't merge them.

### How it works

1. Baseline run: guard must exit 0 before the loop starts. If it can't, fix it first — never relax the guard.
2. After each `keep` decision: run guard.
3. Guard fails: recovery flow kicks in.

### Recovery flow

```
Guard fails →
  revert to previous commit →
  rework attempt 1 (different approach) →
    still fails →
  rework attempt 2 (minimal change) →
    still fails →
  discard (log: guard-failed)
```

**Three rules, non-negotiable:**
- Guard files are **READ-ONLY.** Never modify test files, spec files, or guard scripts during a loop.
- Guard failure means the optimization is wrong. Not the guard.
- If guard can't pass at baseline, fix it before starting. Never start a loop with a broken safety net.

### Common guard commands

| Stack | Command | Notes |
|-------|---------|-------|
| Node.js | `npm test` | Jest/Vitest suite |
| Python | `pytest` | Full test suite |
| Go | `go test ./...` | All packages |
| Rust | `cargo test` | Unit + integration |
| TypeScript | `tsc --noEmit && npm test` | Type check then tests |

---

## Noise-Aware Verification

A "5% improvement" that's really measurement variance leads to keeping bad changes and discarding good ones. Know your metric's noise level.

### Noise levels

| Level | Description | Strategy |
|-------|-------------|----------|
| Low | Deterministic output (LOC, type errors, lint count) | Single run, trust the result |
| Medium | Slight variance (build time ±5%, test timing) | 2 runs, use the worse result |
| High | High variance (API latency, benchmarks, ML accuracy) | 3-5 runs, use median |

### Multi-run median (high noise)

```
runs = []
repeat 3-5 times:
  result = run verify command
  runs.append(result)
metric = median(runs)
```

Median, not mean — one outlier spike won't contaminate the result.

### Min-Delta threshold

Only keep if improvement exceeds the threshold:

```
if improvement < min_delta:
  status = no-op   # not a failure, just insufficient
```

**Defaults by noise:**
- Low: 0 (any improvement counts)
- Medium: 1-2% of baseline
- High: 3-5% of baseline

### Confirmation run

For high-stakes measurements (final 3 iterations, or improvement > 20%):

```
looks good →
  run verify again →
  compare to initial measurement →
  within 2% → confirm keep
  outside 2% → average the two, treat as medium noise
```

### Environment (user's responsibility)

The loop can't control the lab conditions. User must ensure:
- Fixed random seeds for ML workloads
- Consistent cache state (warmed or cold, pick one)
- No competing background processes
- Same input data across all runs
