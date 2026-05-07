# Archive — 2026-04-24 v1 Shopify Parity Docs

**Archived:** 2026-04-24 (same day)
**Reason:** Superseded by v2 consolidation landed the same afternoon.
**Superseded by:**

- `docs/superpowers/specs/2026-04-24-gbox-vs-shopify-consolidated-v2.md`
- `docs/superpowers/specs/2026-04-25-gbox-flow-v2-design-spec.md`

Do not delete. Preserved for historical reference and diff-checking what
was known at the original write vs what the v2 consolidation corrects /
extends.

---

## Files in this archive

### 1. `2026-04-24-gbox-vs-shopify-comprehensive-analysis.md` (~50 KB, 862 lines)

First-pass comprehensive analysis written earlier 2026-04-24. Contains:

- Hierarchical ASCII mindmap (12 top-level branches) — replaced in v2 by
  Mermaid mindmaps that render natively on GitHub.
- Gap analysis table (~80 rows) — refreshed in v2 with Phase 14 PR1
  (email) and Phase 15 PR1 (tx isolation) + PR2 (webhook idempotency)
  status.
- Prioritized roadmap P0-P3 — replaced in v2 with "Phase 16+" explicit
  sprint plan.
- Where Gbox exceeds/equals/lags Shopify — carried forward largely
  unchanged.

**Why replaced:** ASCII mindmap hard to scan on GitHub; analysis lacks
Phase 14-15 progress; roadmap mixed feature gaps with security gaps
without separating the critical path.

### 2. `2026-04-24-gbox-vs-shopify-deployment-readiness.md` (~116 KB)

Deep drill-down on production-readiness gates (migration ledger, test
matrix, smoke baselines, runbooks, PM2 configs). Length made it
standalone-readable but duplicated material from:

- `docs/ops/release-checklist.md`
- `docs/ops/test-matrix.md`
- `CLAUDE-EXTENDED.md` Phase 11 section

**Why replaced:** Content duplicated across ops runbooks + CLAUDE-EXTENDED;
the v2 consolidation references those directly instead of re-stating
them. The bits that were genuinely novel (e.g., the "production launch
checklist" enumeration) are folded into v2 PART 5 Phase 16+ roadmap.

### 3. `2026-04-12-shopify-parity-roadmap.md` (~31 KB, 675 lines)

Earliest Shopify-parity roadmap (Phase A-H decomposition from 2026-04-12,
~12 sessions planned). Already ~95 % completed by the time v1 above was
written, but never formally marked done.

**Why replaced:** Phases A-H are all shipped (Phases 4-14 in current
nomenclature). The plan document is now historical — its work is
captured in CLAUDE.md "Current Phase" section and CLAUDE-EXTENDED.md
phase-by-phase log.

---

## If you are reading this to find something

- **"What's Gbox status vs Shopify today?"** → read v2 consolidated.
- **"What does Gbox Flow v2 look like?"** → read the companion spec
  `2026-04-25-gbox-flow-v2-design-spec.md`.
- **"What was the first-pass gap analysis?"** → read file #1 above.
- **"What production gates exist?"** → read `docs/ops/release-checklist.md`
  and `docs/ops/test-matrix.md` (not file #2 above — those runbooks are
  the canonical source).
- **"What was the original sprint breakdown?"** → read file #3 above,
  understanding Phases A-H map roughly to current Phases 4-11.

---

*Archive prepared 2026-04-24. Do not modify archived files.*
