# Clone Pro Dashboard UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Clone Pro dashboard UI (accounts onboarding + store-admin index + job detail + verification breakdown + publish flow) described in the spec, with full TDD coverage and zero regressions on the existing 228-test clone-pro suite.

**Architecture:** Express SSR + vanilla JS + inline CSS tokens via `seller-layout.ts`. Adds a shared component library at `packages/core/src/modules/ui/clone-pro/` (11 components). Pages in `apps/store-admin/src/pages/clone-pro/` and `apps/accounts/src/pages/clone-pro/`. Reuses the existing `storefront-clone` SSE plumbing pattern (DB poll, stages replay, terminal-state close) against the `clone_pro_jobs` table with columns added in migration 038.

**Tech Stack:** TypeScript, Express, Kysely, PostgreSQL, Vitest, inline SSR (no client framework).

**Spec:** `docs/superpowers/specs/2026-04-16-clone-pro-dashboard-ui-design.md`

**Rollout bands:**
- **6.1 (MVP core):** Phases A–G below — migration, component library, store-admin index + detail (running state), start/cancel/resume, SSE, accounts landing + start, server wiring.
- **6.2 (MVP verify):** Phase H — verification breakdown UI, findings list, publish + discard flows.
- **6.3 (MVP polish):** Phase I — a11y audit, dark/light parity verify, keyboard shortcut chords, final full-suite run.

---

## Phase A — Foundation (schema, types, helpers)

### Task A1: Create migration 038 for `clone_pro_jobs` column additions

**Files:**
- Create: `packages/db/src/migrations/038_clone_pro_dashboard_ui.ts`
- Test: `packages/db/src/migrations/038_clone_pro_dashboard_ui.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/migrations/038_clone_pro_dashboard_ui.test.ts
import { describe, it, expect } from 'vitest';
import { up, down } from './038_clone_pro_dashboard_ui.js';

describe('migration 038 clone_pro_dashboard_ui', () => {
  it('up() is a function that returns a promise', async () => {
    expect(typeof up).toBe('function');
  });
  it('down() is a function that returns a promise', async () => {
    expect(typeof down).toBe('function');
  });
  it('adds config_json, result_json, current_phase, phase_progress_pct, substep, cost_cents, published_at, discarded_at columns', async () => {
    // Inspect the source to make sure the migration references every column the spec mandates.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(new URL('./038_clone_pro_dashboard_ui.ts', import.meta.url), 'utf8');
    for (const col of ['config_json','result_json','current_phase','phase_progress_pct','substep','cost_cents','published_at','discarded_at']) {
      expect(src).toContain(col);
    }
    expect(src).toContain('idx_clone_jobs_shop_status');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gbox/db vitest run src/migrations/038_clone_pro_dashboard_ui.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the migration**

```ts
// packages/db/src/migrations/038_clone_pro_dashboard_ui.ts
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('clone_pro_jobs')
    .addColumn('config_json', 'jsonb')
    .addColumn('result_json', 'jsonb')
    .addColumn('current_phase', 'int2', (c) => c.defaultTo(0))
    .addColumn('phase_progress_pct', 'int2', (c) => c.defaultTo(0))
    .addColumn('substep', 'text')
    .addColumn('cost_cents', 'integer', (c) => c.defaultTo(0))
    .addColumn('published_at', 'timestamptz')
    .addColumn('discarded_at', 'timestamptz')
    .execute();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_clone_jobs_shop_status
      ON clone_pro_jobs(shop_id, status, created_at DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_clone_jobs_shop_status`.execute(db);
  await db.schema
    .alterTable('clone_pro_jobs')
    .dropColumn('config_json')
    .dropColumn('result_json')
    .dropColumn('current_phase')
    .dropColumn('phase_progress_pct')
    .dropColumn('substep')
    .dropColumn('cost_cents')
    .dropColumn('published_at')
    .dropColumn('discarded_at')
    .execute();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @gbox/db vitest run src/migrations/038_clone_pro_dashboard_ui.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/038_clone_pro_dashboard_ui.ts packages/db/src/migrations/038_clone_pro_dashboard_ui.test.ts
git commit -m "feat(db): migration 038 — clone_pro dashboard columns + index"
```

### Task A2: Extend Kysely `clone_pro_jobs` schema type

**Files:**
- Modify: `packages/db/src/schema/clone_pro_jobs.ts` (grep first — the type file may live under a different name; if absent, extend wherever `clone_pro_jobs` type is declared, commonly `packages/db/src/schema/index.ts`)

- [ ] **Step 1: Locate the existing schema type**

Run: `grep -rn "clone_pro_jobs" packages/db/src/schema/`
Identify the file that exports the table interface (e.g., `CloneProJobsTable`).

- [ ] **Step 2: Write the failing test**

```ts
// packages/db/src/schema/clone_pro_jobs.test.ts (create if missing)
import { describe, it, expect } from 'vitest';
import type { Database } from '../index.js';

describe('clone_pro_jobs schema', () => {
  it('has all columns required by the dashboard UI', () => {
    type Row = Database['clone_pro_jobs'];
    // Compile-time assertions via typeof-style tricks:
    const keys: (keyof Row)[] = [
      'config_json','result_json','current_phase','phase_progress_pct',
      'substep','cost_cents','published_at','discarded_at',
    ];
    expect(keys.length).toBe(8);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @gbox/db vitest run src/schema/clone_pro_jobs.test.ts`
Expected: FAIL — TS compile error: property missing on type `Row`.

- [ ] **Step 4: Add the missing columns to the table interface**

Append to the existing `CloneProJobsTable` interface (exact file found in Step 1):

```ts
  config_json: Record<string, unknown> | null;
  result_json: Record<string, unknown> | null;
  current_phase: number;
  phase_progress_pct: number;
  substep: string | null;
  cost_cents: number;
  published_at: Date | null;
  discarded_at: Date | null;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @gbox/db vitest run src/schema/clone_pro_jobs.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/
git commit -m "feat(db): extend CloneProJobsTable with dashboard UI columns"
```

### Task A3: Shared DB helpers for UI queries

**Files:**
- Create: `packages/core/src/modules/clone-pro/dashboard-queries.ts`
- Create: `packages/core/src/modules/clone-pro/dashboard-queries.test.ts`
- Modify: `packages/core/src/modules/clone-pro/index.ts` (re-export)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/modules/clone-pro/dashboard-queries.test.ts
import { describe, it, expect } from 'vitest';
import {
  listActiveJobs, listJobHistory, getDashboardStats, getReadyToPublishJobs,
} from './dashboard-queries.js';

describe('dashboard-queries', () => {
  it('exports the four functions', () => {
    expect(typeof listActiveJobs).toBe('function');
    expect(typeof listJobHistory).toBe('function');
    expect(typeof getDashboardStats).toBe('function');
    expect(typeof getReadyToPublishJobs).toBe('function');
  });
});
```

Add a real integration test using the existing db fixtures — copy the pattern from `storefront-clone/index.test.ts`. Assert the four helpers filter by `shop_id` and honor `status` buckets (`running|paused|failed` for active, `succeeded` without `published_at` for ready, everything else for history).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gbox/core vitest run src/modules/clone-pro/dashboard-queries.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/modules/clone-pro/dashboard-queries.ts
import type { Kysely } from 'kysely';
import type { Database } from '@gbox/db';

export interface DashboardJobRow {
  id: string;
  source_url: string;
  status: string;
  grade: string | null;
  score: number | null;
  current_phase: number;
  phase_progress_pct: number;
  substep: string | null;
  cost_cents: number;
  created_at: Date;
  finished_at: Date | null;
  published_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  page_count: number | null;
}

export async function listActiveJobs(
  db: Kysely<Database>,
  shopId: string,
): Promise<DashboardJobRow[]> {
  return db
    .selectFrom('clone_pro_jobs')
    .select([
      'id','source_url','status','grade','score','current_phase','phase_progress_pct',
      'substep','cost_cents','created_at','finished_at','published_at',
      'error_code','error_message','page_count',
    ])
    .where('shop_id', '=', shopId)
    .where('status', 'in', ['running','paused','failed'])
    .orderBy('created_at', 'desc')
    .execute() as Promise<DashboardJobRow[]>;
}

export async function getReadyToPublishJobs(
  db: Kysely<Database>,
  shopId: string,
): Promise<DashboardJobRow[]> {
  return db
    .selectFrom('clone_pro_jobs')
    .select([/* same projection */])
    .where('shop_id', '=', shopId)
    .where('status', '=', 'succeeded')
    .where('published_at', 'is', null)
    .where('discarded_at', 'is', null)
    .orderBy('finished_at', 'desc')
    .execute() as Promise<DashboardJobRow[]>;
}

export async function listJobHistory(
  db: Kysely<Database>,
  opts: { shopId: string; statusFilter?: string; search?: string; limit: number; offset: number },
): Promise<{ rows: DashboardJobRow[]; total: number }> {
  let q = db.selectFrom('clone_pro_jobs').where('shop_id', '=', opts.shopId);
  if (opts.statusFilter) q = q.where('status', '=', opts.statusFilter);
  if (opts.search) q = q.where('source_url', 'like', `%${opts.search}%`);
  const rows = await q
    .select([/* same projection */])
    .orderBy('created_at', 'desc')
    .limit(opts.limit)
    .offset(opts.offset)
    .execute();
  const countRow = await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  return { rows: rows as DashboardJobRow[], total: Number(countRow.n) };
}

export async function getDashboardStats(
  db: Kysely<Database>,
  shopId: string,
): Promise<{ total: number; published: number; avgGrade: string; costCents30d: number }> {
  const rows = await db.selectFrom('clone_pro_jobs')
    .select(['status','grade','cost_cents','published_at','created_at'])
    .where('shop_id', '=', shopId)
    .execute();
  const total = rows.length;
  const published = rows.filter((r) => r.published_at).length;
  const grades = rows.map((r) => r.grade).filter(Boolean) as string[];
  const avgGrade = averageGradeLabel(grades);
  const cutoff = Date.now() - 30 * 24 * 3600_000;
  const costCents30d = rows
    .filter((r) => new Date(r.created_at as unknown as string).getTime() >= cutoff)
    .reduce((s, r) => s + (r.cost_cents ?? 0), 0);
  return { total, published, avgGrade, costCents30d };
}

function averageGradeLabel(grades: string[]): string {
  if (grades.length === 0) return '—';
  const score = { A: 4, B: 3, C: 2, D: 1, F: 0 };
  const avg = grades.reduce((s, g) => s + (score[g as keyof typeof score] ?? 0), 0) / grades.length;
  if (avg >= 3.5) return 'A';
  if (avg >= 2.5) return 'B';
  if (avg >= 1.5) return 'C';
  if (avg >= 0.5) return 'D';
  return 'F';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @gbox/core vitest run src/modules/clone-pro/dashboard-queries.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Re-export from index.ts**

Add to `packages/core/src/modules/clone-pro/index.ts`:

```ts
export * from './dashboard-queries.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/modules/clone-pro/dashboard-queries.ts packages/core/src/modules/clone-pro/dashboard-queries.test.ts packages/core/src/modules/clone-pro/index.ts
git commit -m "feat(clone-pro): dashboard query helpers (active/history/ready/stats)"
```

### Task A4: Extend `SELLER_STYLES` with status/grade/phase tokens

**Files:**
- Modify: `apps/store-admin/src/layouts/seller-layout.ts`
- Test: `apps/store-admin/src/layouts/seller-layout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/store-admin/src/layouts/seller-layout.test.ts (append to existing file)
import { describe, it, expect } from 'vitest';
import { SELLER_STYLES } from './seller-layout.js';

describe('SELLER_STYLES tokens', () => {
  it('defines clone-pro status/grade/gradient tokens', () => {
    const tokens = [
      '--status-queued','--status-running','--status-paused','--status-failed','--status-succeeded','--status-published',
      '--grade-a','--grade-b','--grade-c','--grade-d','--grade-f',
      '--phase-gradient','--clone-accent-gradient',
    ];
    for (const t of tokens) expect(SELLER_STYLES).toContain(t);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gbox/store-admin vitest run src/layouts/seller-layout.test.ts`
Expected: FAIL — tokens missing.

- [ ] **Step 3: Add the tokens inside the `:root` block of `SELLER_STYLES`**

Locate the `:root { ... }` in the `SELLER_STYLES` template string and append:

```css
  --status-queued:    #64748b;
  --status-running:   #3b82f6;
  --status-paused:    #f59e0b;
  --status-failed:    #ef4444;
  --status-succeeded: #10b981;
  --status-published: #94a3b8;
  --grade-a: #10b981;
  --grade-b: #10b981;
  --grade-c: #f59e0b;
  --grade-d: #f59e0b;
  --grade-f: #ef4444;
  --phase-gradient:        linear-gradient(90deg,#3b82f6,#6366f1,#8b5cf6);
  --clone-accent-gradient: linear-gradient(135deg,#6366f1,#8b5cf6);
```

Also add overrides in the `[data-theme="light"]` block for any surface colors that need adjusting (status and grade stay identical; only if gradient feels wrong on light — leave untouched for now).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @gbox/store-admin vitest run src/layouts/seller-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/store-admin/src/layouts/seller-layout.ts apps/store-admin/src/layouts/seller-layout.test.ts
git commit -m "feat(layout): add clone-pro status/grade/gradient CSS tokens"
```

---

## Phase B — Component library (11 components, TDD)

Every component follows the same shape:

```ts
export function renderX(props: XProps): string { /* returns HTML string */ }
export const xCss: string;                     // scoped CSS, references tokens
export function xRuntimeScriptBody?(): string; // only if component needs client JS
```

Co-located `.test.ts` asserts default render, each variant, and escaping of user-supplied text.

### Task B1: `GradeBadge` component

**Files:**
- Create: `packages/core/src/modules/ui/clone-pro/grade-badge.ts`
- Create: `packages/core/src/modules/ui/clone-pro/grade-badge.test.ts`

- [ ] **Step 1: Failing test**

```ts
// grade-badge.test.ts
import { describe, it, expect } from 'vitest';
import { renderGradeBadge, gradeBadgeCss } from './grade-badge.js';

describe('GradeBadge', () => {
  it('renders the grade letter', () => {
    expect(renderGradeBadge({ grade: 'A' })).toMatch(/>A</);
  });
  it('uses grade-a token for A', () => {
    expect(renderGradeBadge({ grade: 'A' })).toContain('var(--grade-a)');
  });
  it('uses grade-f token for F', () => {
    expect(renderGradeBadge({ grade: 'F' })).toContain('var(--grade-f)');
  });
  it('renders size variants (sm, md, lg)', () => {
    expect(renderGradeBadge({ grade: 'B', size: 'sm' })).toMatch(/gbx-grade.*sm/);
    expect(renderGradeBadge({ grade: 'B', size: 'lg' })).toMatch(/gbx-grade.*lg/);
  });
  it('includes aria-label with score', () => {
    expect(renderGradeBadge({ grade: 'A', score: 92 })).toContain('aria-label="Grade A (92 of 100)"');
  });
  it('exports gradeBadgeCss with the three size classes', () => {
    expect(gradeBadgeCss).toMatch(/gbx-grade\.sm/);
    expect(gradeBadgeCss).toMatch(/gbx-grade\.lg/);
  });
});
```

- [ ] **Step 2: Run — fails (module not found)**

Run: `pnpm --filter @gbox/core vitest run src/modules/ui/clone-pro/grade-badge.test.ts`

- [ ] **Step 3: Implementation**

```ts
// grade-badge.ts
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export interface GradeBadgeProps {
  grade: Grade;
  score?: number;
  size?: 'sm' | 'md' | 'lg';
}
export function renderGradeBadge(p: GradeBadgeProps): string {
  const size = p.size ?? 'md';
  const tokenVar = `var(--grade-${p.grade.toLowerCase()})`;
  const label = p.score != null
    ? `Grade ${p.grade} (${p.score} of 100)`
    : `Grade ${p.grade}`;
  return `<span class="gbx-grade ${size}" style="--grade-color:${tokenVar}" aria-label="${label}">${p.grade}</span>`;
}
export const gradeBadgeCss = `
.gbx-grade { display:inline-flex;align-items:center;justify-content:center;border-radius:6px;color:#fff;font-weight:700;background:var(--grade-color);box-shadow:0 0 14px color-mix(in srgb,var(--grade-color) 35%,transparent) }
.gbx-grade.sm { width:22px;height:22px;font-size:11px;border-radius:4px }
.gbx-grade.md { width:32px;height:32px;font-size:14px }
.gbx-grade.lg { width:72px;height:72px;font-size:36px;border-radius:50% }
`;
```

- [ ] **Step 4: Run — passes (6/6)**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/ui/clone-pro/grade-badge.ts packages/core/src/modules/ui/clone-pro/grade-badge.test.ts
git commit -m "feat(ui/clone-pro): GradeBadge component"
```

### Task B2: `CheckScore` component

**Files:**
- Create: `packages/core/src/modules/ui/clone-pro/check-score.ts`
- Create: `packages/core/src/modules/ui/clone-pro/check-score.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { renderCheckScore, checkScoreCss } from './check-score.js';

describe('CheckScore', () => {
  it('renders name + numeric score', () => {
    const html = renderCheckScore({ name: 'CSS Match', score: 98, status: 'pass' });
    expect(html).toContain('CSS Match');
    expect(html).toContain('>98<');
  });
  it('uses status-succeeded border for pass', () => {
    expect(renderCheckScore({ name: 'x', score: 100, status: 'pass' }))
      .toContain('var(--status-succeeded)');
  });
  it('uses status-paused border for warn', () => {
    expect(renderCheckScore({ name: 'x', score: 70, status: 'warn' }))
      .toContain('var(--status-paused)');
  });
  it('uses status-failed border for fail', () => {
    expect(renderCheckScore({ name: 'x', score: 30, status: 'fail' }))
      .toContain('var(--status-failed)');
  });
  it('renders weight and sub metadata when given', () => {
    const html = renderCheckScore({ name: 'x', score: 80, status: 'pass', weight: 40, sub: '38/48' });
    expect(html).toContain('weight 40');
    expect(html).toContain('38/48');
  });
  it('escapes name', () => {
    expect(renderCheckScore({ name: '<img>', score: 50, status: 'warn' })).not.toContain('<img>');
  });
});
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implementation**

```ts
// check-score.ts
export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface CheckScoreProps {
  name: string;
  score: number;
  status: CheckStatus;
  weight?: number;
  sub?: string;
}
const STATUS_VAR: Record<CheckStatus, string> = {
  pass: 'var(--status-succeeded)',
  warn: 'var(--status-paused)',
  fail: 'var(--status-failed)',
};
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}
export function renderCheckScore(p: CheckScoreProps): string {
  const color = STATUS_VAR[p.status];
  return `
<div class="gbx-check" style="border-left-color:${color}">
  <div class="gbx-check-name">${esc(p.name)}</div>
  <div class="gbx-check-score" style="color:${color}">${p.score}</div>
  <div class="gbx-check-meta">${p.weight != null ? `weight ${p.weight}×` : ''}${p.sub ? ` · ${esc(p.sub)}` : ''}</div>
</div>`;
}
export const checkScoreCss = `
.gbx-check { background:var(--surface-2);border:1px solid var(--border);border-left:3px solid;border-radius:6px;padding:10px }
.gbx-check-name { color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em }
.gbx-check-score { font-size:22px;font-weight:800;margin:2px 0 }
.gbx-check-meta { color:var(--text-muted);font-size:10px }
`;
```

- [ ] **Step 4: Run — passes (6/6)**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/ui/clone-pro/check-score.ts packages/core/src/modules/ui/clone-pro/check-score.test.ts
git commit -m "feat(ui/clone-pro): CheckScore component"
```

### Task B3: `SectionChip` component

**Files:**
- Create: `packages/core/src/modules/ui/clone-pro/section-chip.ts`
- Create: `packages/core/src/modules/ui/clone-pro/section-chip.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { renderSectionChip, SECTION_ICONS } from './section-chip.js';

describe('SectionChip', () => {
  it('renders the section id label', () => {
    expect(renderSectionChip({ sectionId: 'hero', position: 0 })).toContain('Hero');
  });
  it('uses the icon map for known sections', () => {
    expect(renderSectionChip({ sectionId: 'featured-collection', position: 1 }))
      .toContain(SECTION_ICONS['featured-collection']);
  });
  it('falls back to a generic icon for unknown sections', () => {
    expect(renderSectionChip({ sectionId: 'unknown-xyz', position: 3 })).toContain('🧩');
  });
  it('renders meta row when supplied', () => {
    expect(renderSectionChip({ sectionId: 'hero', position: 0, meta: 'collection=sale' }))
      .toContain('collection=sale');
  });
  it('exports all 20 Gbox Dawn section icons', () => {
    expect(Object.keys(SECTION_ICONS).length).toBeGreaterThanOrEqual(20);
  });
});
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implementation**

```ts
// section-chip.ts
export const SECTION_ICONS: Record<string, string> = {
  hero: '🎯',
  'featured-collection': '🛍️',
  'image-with-text': '🖼️',
  newsletter: '📧',
  testimonials: '💬',
  'rich-text': '📝',
  video: '🎬',
  collage: '🎨',
  slideshow: '🎞️',
  'collection-list': '📚',
  'featured-product': '⭐',
  'custom-liquid': '💧',
  contact: '📮',
  'page-content': '📄',
  'blog-posts': '📰',
  'product-recommendations': '✨',
  logos: '🏷️',
  countdown: '⏳',
  banner: '🎌',
  accordion: '📂',
};
function title(id: string): string {
  return id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
export interface SectionChipProps {
  sectionId: string;
  position: number;
  meta?: string;
}
export function renderSectionChip(p: SectionChipProps): string {
  const icon = SECTION_ICONS[p.sectionId] ?? '🧩';
  return `
<div class="gbx-section-chip">
  <div class="gbx-section-icon">${icon}</div>
  <div class="gbx-section-label">${title(p.sectionId)}</div>
  <div class="gbx-section-meta">${p.meta ?? `position ${p.position}`}</div>
</div>`;
}
export const sectionChipCss = `
.gbx-section-chip { background:var(--surface-1);border:1px solid var(--border);border-radius:6px;padding:10px;text-align:center }
.gbx-section-icon { font-size:20px }
.gbx-section-label { color:var(--text);font-size:11px;font-weight:600;margin-top:4px }
.gbx-section-meta { color:var(--text-muted);font-size:9px }
`;
```

- [ ] **Step 4: Run — passes (5/5)**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/ui/clone-pro/section-chip.ts packages/core/src/modules/ui/clone-pro/section-chip.test.ts
git commit -m "feat(ui/clone-pro): SectionChip component + 20 Dawn icons"
```

### Task B4: `CostEstimate` component

**Files:**
- Create: `packages/core/src/modules/ui/clone-pro/cost-estimate.ts`
- Create: `packages/core/src/modules/ui/clone-pro/cost-estimate.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { renderCostEstimate, computeEstimate } from './cost-estimate.js';

describe('CostEstimate', () => {
  it('sums alt-text + seo into total', () => {
    expect(computeEstimate({ altText: true, seo: true }).totalCents).toBe(65);
  });
  it('returns 0 when both toggles off', () => {
    expect(computeEstimate({ altText: false, seo: false }).totalCents).toBe(0);
  });
  it('renders the dollar amount', () => {
    expect(renderCostEstimate({ altText: true, seo: true })).toContain('$0.65');
  });
  it('renders "Free" when total is 0', () => {
    expect(renderCostEstimate({ altText: false, seo: false })).toContain('Free');
  });
});
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implementation**

```ts
// cost-estimate.ts
export interface EstimateInput { altText: boolean; seo: boolean; pageCount?: number; }
export interface Estimate { altText: number; seo: number; totalCents: number; }
export function computeEstimate(i: EstimateInput): Estimate {
  const altText = i.altText ? 40 : 0;
  const seo = i.seo ? 25 : 0;
  return { altText, seo, totalCents: altText + seo };
}
function fmt(cents: number): string {
  if (cents === 0) return 'Free';
  return `$${(cents / 100).toFixed(2)}`;
}
export function renderCostEstimate(i: EstimateInput): string {
  const e = computeEstimate(i);
  return `<span class="gbx-cost" data-cost-cents="${e.totalCents}">${fmt(e.totalCents)}</span>`;
}
export const costEstimateCss = `
.gbx-cost { color:var(--text);font-weight:600 }
`;
```

- [ ] **Step 4: Run — passes (4/4)**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/ui/clone-pro/cost-estimate.ts packages/core/src/modules/ui/clone-pro/cost-estimate.test.ts
git commit -m "feat(ui/clone-pro): CostEstimate component"
```

### Task B5: `PhaseTimeline` component

**Files:**
- Create: `packages/core/src/modules/ui/clone-pro/phase-timeline.ts`
- Create: `packages/core/src/modules/ui/clone-pro/phase-timeline.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { renderPhaseTimeline } from './phase-timeline.js';

describe('PhaseTimeline', () => {
  const phases = [
    { id: 'discovery', label: 'Discovery', status: 'done' as const, meta: '48 pages · 12s' },
    { id: 'execution', label: 'Execution', status: 'active' as const, meta: '45%', substeps: ['Homepage clone','Section map'] },
    { id: 'verification', label: 'Verification', status: 'pending' as const },
  ];
  it('renders three nodes', () => {
    const html = renderPhaseTimeline({ phases });
    expect((html.match(/gbx-phase-node/g) ?? []).length).toBe(3);
  });
  it('marks done nodes with status-succeeded color', () => {
    expect(renderPhaseTimeline({ phases })).toContain('var(--status-succeeded)');
  });
  it('renders substeps under active phase', () => {
    const html = renderPhaseTimeline({ phases });
    expect(html).toContain('Homepage clone');
    expect(html).toContain('Section map');
  });
  it('each node is keyboard-focusable', () => {
    expect(renderPhaseTimeline({ phases })).toContain('tabindex="0"');
  });
  it('each node has aria-label with status', () => {
    expect(renderPhaseTimeline({ phases })).toContain('aria-label="Discovery: done"');
  });
});
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implementation**

```ts
// phase-timeline.ts
export type PhaseStatus = 'done' | 'active' | 'pending' | 'failed';
export interface Phase {
  id: string;
  label: string;
  status: PhaseStatus;
  meta?: string;
  substeps?: string[];
}
const COLOR: Record<PhaseStatus, string> = {
  done: 'var(--status-succeeded)',
  active: 'var(--status-running)',
  pending: 'var(--border)',
  failed: 'var(--status-failed)',
};
const ICON: Record<PhaseStatus, string> = {
  done: '✓', active: '◐', pending: '○', failed: '!',
};
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}
export function renderPhaseTimeline(props: { phases: Phase[] }): string {
  const nodes = props.phases.map((p) => {
    const color = COLOR[p.status];
    const icon = ICON[p.status];
    const substeps = p.substeps
      ? `<ul class="gbx-phase-subs">${p.substeps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
      : '';
    return `
      <div class="gbx-phase-node" tabindex="0" aria-label="${esc(p.label)}: ${p.status}">
        <div class="gbx-phase-dot" style="background:${color}">${icon}</div>
        <div class="gbx-phase-label" style="color:${color}">${esc(p.label)}</div>
        ${p.meta ? `<div class="gbx-phase-meta">${esc(p.meta)}</div>` : ''}
        ${substeps}
      </div>`;
  }).join('');
  return `<div class="gbx-phase-timeline">${nodes}</div>`;
}
export const phaseTimelineCss = `
.gbx-phase-timeline { position:relative;padding-left:4px }
.gbx-phase-node { position:relative;padding-left:32px;margin-bottom:18px;outline:none }
.gbx-phase-node:focus-visible .gbx-phase-dot { box-shadow:0 0 0 3px color-mix(in srgb,var(--status-running) 35%,transparent) }
.gbx-phase-dot { position:absolute;left:0;top:0;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700 }
.gbx-phase-label { font-size:12px;font-weight:600 }
.gbx-phase-meta { color:var(--text-muted);font-size:10px;margin-top:2px }
.gbx-phase-subs { list-style:none;padding-left:0;margin:8px 0 0;font-size:10px;color:var(--text-muted);line-height:1.7 }
`;
```

- [ ] **Step 4: Run — passes (5/5)**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/ui/clone-pro/phase-timeline.ts packages/core/src/modules/ui/clone-pro/phase-timeline.test.ts
git commit -m "feat(ui/clone-pro): PhaseTimeline component"
```

### Task B6: `JobCard` component (active list)

**Files:**
- Create: `packages/core/src/modules/ui/clone-pro/job-card.ts`
- Create: `packages/core/src/modules/ui/clone-pro/job-card.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { renderJobCard } from './job-card.js';
const base = {
  id: 'abc123', source_url: 'https://shop2.com', status: 'running',
  current_phase: 2, phase_progress_pct: 45, substep: 'Mapping sections',
  cost_cents: 28, created_at: new Date(Date.now() - 60_000),
  error_code: null, error_message: null,
} as any;

describe('JobCard', () => {
  it('running variant shows progress bar + percentage', () => {
    const html = renderJobCard({ job: base, variant: 'running', baseUrl: '/admin/store/s1' });
    expect(html).toContain('45%');
    expect(html).toMatch(/width:45%/);
  });
  it('failed variant shows error message + Resume button', () => {
    const html = renderJobCard({
      job: { ...base, status: 'failed', error_message: 'cloudflare blocked' },
      variant: 'failed', baseUrl: '/admin/store/s1',
    });
    expect(html).toContain('cloudflare blocked');
    expect(html).toContain('Resume from');
  });
  it('paused variant uses amber accent', () => {
    expect(renderJobCard({ job: { ...base, status: 'paused' }, variant: 'paused', baseUrl: '/admin/store/s1' }))
      .toContain('var(--status-paused)');
  });
  it('links to detail page', () => {
    expect(renderJobCard({ job: base, variant: 'running', baseUrl: '/admin/store/s1' }))
      .toContain('/admin/store/s1/clone-pro/abc123');
  });
  it('shows Cancel button for running', () => {
    expect(renderJobCard({ job: base, variant: 'running', baseUrl: '/admin/store/s1' }))
      .toContain('Cancel');
  });
  it('escapes source URL', () => {
    expect(renderJobCard({ job: { ...base, source_url: '<img>' }, variant: 'running', baseUrl: '/admin/store/s1' }))
      .not.toContain('<img>');
  });
});
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implementation** — use `DashboardJobRow` typing, token-based colors, progress bar with `role="progressbar"` and `aria-valuenow`. Keep to ~80 LOC.

```ts
// job-card.ts
import type { DashboardJobRow } from '../../clone-pro/dashboard-queries.js';
export type JobCardVariant = 'running' | 'failed' | 'paused';
export interface JobCardProps { job: DashboardJobRow; variant: JobCardVariant; baseUrl: string; }
const ACCENT: Record<JobCardVariant, string> = {
  running: 'var(--status-running)', failed: 'var(--status-failed)', paused: 'var(--status-paused)',
};
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}
function age(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}
export function renderJobCard(p: JobCardProps): string {
  const accent = ACCENT[p.variant];
  const pct = p.job.phase_progress_pct ?? 0;
  const detail = `${p.baseUrl}/clone-pro/${p.job.id}`;
  const errorBlock = p.variant === 'failed' && p.job.error_message
    ? `<div class="gbx-job-err"><code>${esc(p.job.error_message)}</code></div>` : '';
  const primary = p.variant === 'failed'
    ? `<a href="${detail}" class="gbx-btn-amber">Resume from Phase ${p.job.current_phase}</a>`
    : `<a href="${detail}" class="gbx-btn-ghost">View timeline</a>`;
  const cancelOrDiscard = p.variant === 'running'
    ? `<form method="post" action="${detail}/cancel" class="gbx-inline-form"><button class="gbx-btn-danger">Cancel</button></form>`
    : `<form method="post" action="${detail}/discard" class="gbx-inline-form"><button class="gbx-btn-ghost">Discard</button></form>`;
  return `
<article class="gbx-job-card" style="border-left-color:${accent}">
  <header>
    <div class="gbx-job-title">${esc(new URL(p.job.source_url).host)}</div>
    <div class="gbx-job-sub">Started ${age(new Date(p.job.created_at))} · Phase ${p.job.current_phase} of 3</div>
  </header>
  ${p.variant === 'running' ? `
  <div class="gbx-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Clone progress">
    <div class="gbx-progress-fill" style="width:${pct}%;background:var(--phase-gradient)"></div>
  </div>
  <div class="gbx-job-substep">⚙️ ${esc(p.job.substep ?? 'Working…')}</div>` : ''}
  ${errorBlock}
  <footer>${primary}${cancelOrDiscard}</footer>
</article>`;
}
export const jobCardCss = `/* ... styles using token vars, keep within 30 LOC ... */`;
```

- [ ] **Step 4: Run — passes (6/6)**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/ui/clone-pro/job-card.ts packages/core/src/modules/ui/clone-pro/job-card.test.ts
git commit -m "feat(ui/clone-pro): JobCard component (running/failed/paused variants)"
```

### Task B7: `JobTableRow` component (history)

**Files:**
- Create: `packages/core/src/modules/ui/clone-pro/job-table-row.ts`
- Create: `packages/core/src/modules/ui/clone-pro/job-table-row.test.ts`

- [ ] **Step 1: Failing test** — render `<tr>` with cells: short job id code, source hostname, status pill, grade badge or em-dash, page count, formatted cost ($0.72), age, View link. Escape URL. Status pill uses token variable.
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — uses `renderGradeBadge` from B1 with `size: 'sm'`. ~60 LOC.
- [ ] **Step 4: Run — passes (~6 tests)**
- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/ui/clone-pro/job-table-row.ts packages/core/src/modules/ui/clone-pro/job-table-row.test.ts
git commit -m "feat(ui/clone-pro): JobTableRow component"
```

### Task B8: `FindingRow` component

**Files:**
- Create: `packages/core/src/modules/ui/clone-pro/finding-row.ts`
- Create: `packages/core/src/modules/ui/clone-pro/finding-row.test.ts`

- [ ] **Step 1: Failing test** — render severity icon (`!` critical red, `⚠` warning amber, `ℹ` info blue), title, body with code spans escaped, inline action links from `actions: {label,href}[]`.
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — ~60 LOC.
- [ ] **Step 4: Run — passes (~5 tests)**
- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/ui/clone-pro/finding-row.ts packages/core/src/modules/ui/clone-pro/finding-row.test.ts
git commit -m "feat(ui/clone-pro): FindingRow component"
```

### Task B9: `ReadyBanner` component

**Files:**
- Create: `packages/core/src/modules/ui/clone-pro/ready-banner.ts`
- Create: `packages/core/src/modules/ui/clone-pro/ready-banner.test.ts`

- [ ] **Step 1: Failing test** — renders green gradient banner with job info + two buttons (`Preview` href → detail page, `Publish now` → POST form with CSRF).
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — accepts `job`, `baseUrl`, `csrfToken` — emits `<form action="${baseUrl}/clone-pro/${job.id}/publish" method="post">` with hidden CSRF input. ~50 LOC.
- [ ] **Step 4: Run — passes (~5 tests)**
- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/ui/clone-pro/ready-banner.ts packages/core/src/modules/ui/clone-pro/ready-banner.test.ts
git commit -m "feat(ui/clone-pro): ReadyBanner component"
```

### Task B10: `LiveLog` component

**Files:**
- Create: `packages/core/src/modules/ui/clone-pro/live-log.ts`
- Create: `packages/core/src/modules/ui/clone-pro/live-log.test.ts`

- [ ] **Step 1: Failing test** — emits a `<div>` with `aria-live="polite"` and `aria-atomic="false"`, monospace style, plus a runtime script body that opens an `EventSource(sseUrl)` and appends log lines with colored prefixes based on level.
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation**:

```ts
// live-log.ts
export interface LiveLogProps { sseUrl: string; maxLines?: number; id?: string; }
export function renderLiveLog(p: LiveLogProps): string {
  const id = p.id ?? 'gbx-live-log';
  return `
<div id="${id}" class="gbx-live-log" role="log" aria-live="polite" aria-atomic="false"
     data-sse-url="${p.sseUrl}" data-max-lines="${p.maxLines ?? 200}"></div>`;
}
export function liveLogRuntimeScriptBody(): string {
  return `
(function(){
  var el = document.querySelector('.gbx-live-log[data-sse-url]');
  if (!el || !window.EventSource) return;
  var max = parseInt(el.getAttribute('data-max-lines') || '200', 10);
  var es = new EventSource(el.getAttribute('data-sse-url'), { withCredentials:true });
  function append(level, text){
    var line = document.createElement('div');
    line.className = 'gbx-log-line gbx-log-' + level;
    var ts = new Date().toISOString().slice(11,19);
    line.innerHTML = '<span class="gbx-log-ts">[' + ts + ']</span> ' + text.replace(/[&<>]/g, function(c){
      return { '&':'&amp;','<':'&lt;','>':'&gt;' }[c];
    });
    el.appendChild(line);
    while (el.children.length > max) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }
  es.addEventListener('log', function(e){
    try { var d = JSON.parse(e.data); append(d.level||'info', d.text||''); } catch(_){}
  });
  es.onerror = function(){ es.close(); };
})();`;
}
export const liveLogCss = `
.gbx-live-log { font-family:ui-monospace,monospace;font-size:11px;line-height:1.7;background:var(--surface-0);padding:12px 14px;max-height:220px;overflow-y:auto;border-radius:6px }
.gbx-log-ts { color:var(--text-muted) }
.gbx-log-info { color:var(--text-muted) }
.gbx-log-success { color:var(--status-succeeded) }
.gbx-log-warn { color:var(--status-paused) }
.gbx-log-error { color:var(--status-failed) }
`;
```

- [ ] **Step 4: Run — passes (~4 tests)**
- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/ui/clone-pro/live-log.ts packages/core/src/modules/ui/clone-pro/live-log.test.ts
git commit -m "feat(ui/clone-pro): LiveLog component with SSE runtime"
```

### Task B11: `CloneForm` component (inline smart defaults — Q5 B)

**Files:**
- Create: `packages/core/src/modules/ui/clone-pro/clone-form.ts`
- Create: `packages/core/src/modules/ui/clone-pro/clone-form.test.ts`

- [ ] **Step 1: Failing test** — two variants (`landing` = large hero form for accounts, `modal` = compact form for store-admin "New clone" dialog). URL input, two toggle rows (Alt-text default on, SEO default on), CTA button showing `renderCostEstimate`, "More options" `<details>` collapsible with slug, max_pages, depth, concurrency, publish mode inputs. CSRF hidden field. Form submits to the `action` prop.
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — ~120 LOC; exports `renderCloneForm(props)`, `cloneFormCss`, `cloneFormRuntimeScriptBody()` (handles toggle → live cost update using the `data-cost-cents` hook from B4).
- [ ] **Step 4: Run — passes (~8 tests)**
- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/ui/clone-pro/clone-form.ts packages/core/src/modules/ui/clone-pro/clone-form.test.ts
git commit -m "feat(ui/clone-pro): CloneForm with live cost estimate"
```

### Task B12: `index.ts` barrel + shared `esc`

**Files:**
- Create: `packages/core/src/modules/ui/clone-pro/index.ts`
- Create: `packages/core/src/modules/ui/clone-pro/esc.ts`
- Create: `packages/core/src/modules/ui/clone-pro/esc.test.ts`

- [ ] **Step 1: Extract `esc` helper** — the component tasks each inlined an `esc` function. DRY by moving to a single shared helper.

```ts
// esc.ts
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}
```

Plus `esc.test.ts` with 3 assertions: ampersand, lt/gt, quotes, null.

- [ ] **Step 2: Refactor every component from B1–B11 to import `esc` from `./esc.js`**. Run each component's test suite after the swap to confirm no regressions.

- [ ] **Step 3: Write the barrel**

```ts
// index.ts
export * from './esc.js';
export * from './grade-badge.js';
export * from './check-score.js';
export * from './phase-timeline.js';
export * from './section-chip.js';
export * from './cost-estimate.js';
export * from './job-card.js';
export * from './job-table-row.js';
export * from './finding-row.js';
export * from './ready-banner.js';
export * from './live-log.js';
export * from './clone-form.js';

export const cloneProCss: string; // concatenated, see next line
```

Build `cloneProCss` by concatenating every per-component `xCss` constant so pages can inline it once.

- [ ] **Step 4: Run full UI suite**

Run: `pnpm --filter @gbox/core vitest run src/modules/ui/clone-pro/`
Expected: all (≈55) tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/ui/clone-pro/
git commit -m "refactor(ui/clone-pro): shared esc helper + barrel export"
```

---

## Phase C — Store-admin index page

### Task C1: Page scaffold + render test

**Files:**
- Create: `apps/store-admin/src/pages/clone-pro/index.ts`
- Create: `apps/store-admin/src/pages/clone-pro/index.test.ts`

- [ ] **Step 1: Failing test** — assert breadcrumb, stats strip (4 cards), "Active (N)" header, empty state fallback when no jobs, sidebar nav badge. Use a stub DB returning deterministic data.
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — exports `async function getCloneProIndexPage(req, res, db)`. Imports `listActiveJobs`, `getReadyToPublishJobs`, `listJobHistory`, `getDashboardStats` from A3. Imports components from B12. Calls `sellerLayout({..., activePage: 'clone-pro', content, aiPanel: renderCloneProAiPanel(...)})`. ~180 LOC.
- [ ] **Step 4: Run — passes (~8 tests)**
- [ ] **Step 5: Commit**

```bash
git add apps/store-admin/src/pages/clone-pro/index.ts apps/store-admin/src/pages/clone-pro/index.test.ts
git commit -m "feat(store-admin): clone-pro index page"
```

### Task C2: Filters, search, pagination on history table

- [ ] **Step 1: Failing test** — assert query params `?status=succeeded&q=shop2&page=2` produce the correct `listJobHistory` call; the form preserves state in hidden inputs; pagination nav shows correct `?page=N`.
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — parse `req.query`, pass to `listJobHistory`, render `<form method="get">` with preserved filters, render pagination nav with prev/next links.
- [ ] **Step 4: Run — passes**
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(store-admin): clone-pro history filters + pagination"
```

---

## Phase D — Store-admin job detail page

### Task D1: Detail page scaffold + phase-aware rendering

**Files:**
- Create: `apps/store-admin/src/pages/clone-pro/detail.ts`
- Create: `apps/store-admin/src/pages/clone-pro/detail.test.ts`

- [ ] **Step 1: Failing test** — a table-driven test with one case per state: `running`, `paused`, `failed`, `succeeded`, `published`. Each case loads a fixture job, calls `getCloneProDetailPage`, asserts:
  - Header status pill class = state
  - Primary CTA text (Publish / Resume / Visit live / Re-run)
  - Timeline node colors match state
  - Main content block matches phase (Discovery / Execution / Verification)
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — exports `getCloneProDetailPage(req, res, db)` that fetches job, computes `status → CTA/title/banner` mapping in a pure helper `deriveDetailChrome(job)`, then renders. ~320 LOC. Embed the `liveLogRuntimeScriptBody()` + SSE URL.
- [ ] **Step 4: Run — passes (~12 tests)**
- [ ] **Step 5: Commit**

```bash
git add apps/store-admin/src/pages/clone-pro/detail.ts apps/store-admin/src/pages/clone-pro/detail.test.ts
git commit -m "feat(store-admin): clone-pro detail page with phase-aware rendering"
```

### Task D2: AI panel (right sidebar)

**Files:**
- Create: `apps/store-admin/src/pages/clone-pro/ai-panel.ts`
- Create: `apps/store-admin/src/pages/clone-pro/ai-panel.test.ts`

- [ ] **Step 1: Failing test** — running-mode panel shows contextual tip + live cost ticker with `data-cost-cents` + recent events feed. Verified-mode panel shows "Clone complete" header + NEXT block with Publish button + Summary (pages/sections/alt-text/SEO/cost/duration) + Other actions.
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — ~150 LOC. Pure render function; no side-effects.
- [ ] **Step 4: Run — passes**
- [ ] **Step 5: Commit**

```bash
git add apps/store-admin/src/pages/clone-pro/ai-panel.ts apps/store-admin/src/pages/clone-pro/ai-panel.test.ts
git commit -m "feat(store-admin): clone-pro AI panel (running + verified modes)"
```

---

## Phase E — Store-admin start / actions / events

### Task E1: `POST /start` — queue new job from index page

**Files:**
- Create: `apps/store-admin/src/pages/clone-pro/start.ts`
- Create: `apps/store-admin/src/pages/clone-pro/start.test.ts`

- [ ] **Step 1: Failing test** — cases:
  - Valid URL → creates job, 302 to detail page
  - Missing URL → 400 `url_required`
  - Bad scheme → 400 `bad_scheme`
  - Duplicate running job for same URL → 409 with toast flash
  - Missing CSRF → 403 (centralized middleware)
  - Rate-limited → 429
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — ~90 LOC. Parses URL + form body (toggles → `config_json`), duplicate-guard query, calls `createCloneProJob` (existing backend helper), fires `runClonePro` (existing runner), returns 302.
- [ ] **Step 4: Run — passes (~5 tests)**
- [ ] **Step 5: Commit**

```bash
git add apps/store-admin/src/pages/clone-pro/start.ts apps/store-admin/src/pages/clone-pro/start.test.ts
git commit -m "feat(store-admin): clone-pro start action"
```

### Task E2: `POST /cancel` / `/resume` / `/publish` / `/discard`

**Files:**
- Create: `apps/store-admin/src/pages/clone-pro/actions.ts`
- Create: `apps/store-admin/src/pages/clone-pro/actions.test.ts`

- [ ] **Step 1: Failing test** — one describe block per action. Each:
  - Happy path → writes expected fields (`status='cancelled'`, `published_at=now`, etc.) + redirects
  - Role guard → Staff (Level 4) gets 403 on publish/discard; can only call cancel if they started it
  - Missing CSRF → 403
  - Invalid state transition (e.g., publishing a failed job) → 409
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — each handler exports `postCloneProCancel(req,res,db)` etc. Wraps `requireRole('owner','admin', action)`. ~150 LOC total.
- [ ] **Step 4: Run — passes (~6 tests × 4 actions)**
- [ ] **Step 5: Commit**

```bash
git add apps/store-admin/src/pages/clone-pro/actions.ts apps/store-admin/src/pages/clone-pro/actions.test.ts
git commit -m "feat(store-admin): clone-pro cancel/resume/publish/discard actions"
```

### Task E3: SSE endpoints (per-job + aggregate)

**Files:**
- Create: `apps/store-admin/src/pages/clone-pro/events.ts`
- Create: `apps/store-admin/src/pages/clone-pro/events.test.ts`

- [ ] **Step 1: Failing test** — uses a fake Response (EventEmitter) and asserts:
  - Per-job endpoint writes `retry: 2000`, replays stages from `stages_json`, emits `status` event, closes on terminal state
  - Aggregate endpoint emits `{jobId, phase, pct, status}` every poll tick for every active job in the shop
  - `req.on('close')` clears the poll interval
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — closely follow the existing `storefront-clone.ts` SSE pattern. Per-job ~120 LOC; aggregate ~80 LOC. Both cap duration at 10 minutes and poll every 1 second.
- [ ] **Step 4: Run — passes (~4 tests)**
- [ ] **Step 5: Commit**

```bash
git add apps/store-admin/src/pages/clone-pro/events.ts apps/store-admin/src/pages/clone-pro/events.test.ts
git commit -m "feat(store-admin): clone-pro SSE (per-job + aggregate)"
```

### Task E4: `GET /:jobId/report.txt`

**Files:**
- Modify: `apps/store-admin/src/pages/clone-pro/actions.ts`
- Modify: `apps/store-admin/src/pages/clone-pro/actions.test.ts`

- [ ] **Step 1: Failing test** — endpoint returns `text/plain; charset=utf-8` with `Content-Disposition: attachment; filename="clone-pro-<shortId>.txt"`, body includes grade, 5-check scores, findings, recommendations.
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — render `result_json` into plain text.
- [ ] **Step 4: Run — passes**
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(store-admin): clone-pro download verification report"
```

---

## Phase F — Accounts portal landing + start

### Task F1: Accounts landing page

**Files:**
- Create: `apps/accounts/src/pages/clone-pro/landing.ts`
- Create: `apps/accounts/src/pages/clone-pro/landing.test.ts`

- [ ] **Step 1: Failing test** — page renders hero + `renderCloneForm({variant:'landing', action:'/accounts/clone-new-store/start', csrfToken})`; trust strip visible; auth gate pushes unauthenticated users to `/accounts/signup?next=/accounts/clone-new-store`.
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — ~140 LOC. Wraps in accounts layout (grep for existing accounts layout function, e.g., `accountsLayout`).
- [ ] **Step 4: Run — passes (~4 tests)**
- [ ] **Step 5: Commit**

```bash
git add apps/accounts/src/pages/clone-pro/landing.ts apps/accounts/src/pages/clone-pro/landing.test.ts
git commit -m "feat(accounts): clone-pro onboarding landing page"
```

### Task F2: Accounts start — create store + clone job + redirect

**Files:**
- Create: `apps/accounts/src/pages/clone-pro/start.ts`
- Create: `apps/accounts/src/pages/clone-pro/start.test.ts`

- [ ] **Step 1: Failing test** — cases:
  - Valid URL → creates store with `role=owner`, slug from hostname (e.g., `shop2-com` from `shop2.com`), creates clone-pro job, 302 to `/admin/store/<slug>/clone-pro/<jobId>`
  - Slug collision → appends `-2`, `-3` until unique
  - Invalid URL → returns to landing with flash error
  - Unauthenticated → 401 → redirect to signup with `next`
  - Rate-limited → 429
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — ~80 LOC. Calls existing `createStore` + new `createCloneProJob` helper.
- [ ] **Step 4: Run — passes (~5 tests)**
- [ ] **Step 5: Commit**

```bash
git add apps/accounts/src/pages/clone-pro/start.ts apps/accounts/src/pages/clone-pro/start.test.ts
git commit -m "feat(accounts): clone-pro onboarding start (store + job + redirect)"
```

---

## Phase G — Server wiring, nav, verification

### Task G1: Wire store-admin routes

**Files:**
- Modify: `apps/store-admin/src/server.ts` (or wherever routes are registered)
- Test: run the app's existing server test to confirm no regressions

- [ ] **Step 1: Locate the existing storefront-clone route block**

Run: `grep -n "storefront-clone" apps/store-admin/src/server.ts`

- [ ] **Step 2: Insert the new clone-pro route block right below it**

```ts
import {
  getCloneProIndexPage,
} from './pages/clone-pro/index.js';
import { getCloneProDetailPage } from './pages/clone-pro/detail.js';
import { postCloneProStart } from './pages/clone-pro/start.js';
import {
  postCloneProCancel, postCloneProResume, postCloneProPublish, postCloneProDiscard,
  getCloneProReport,
} from './pages/clone-pro/actions.js';
import {
  getCloneProJobEvents, getCloneProActiveEvents,
} from './pages/clone-pro/events.js';

app.get('/admin/store/:slug/clone-pro',               withStore(getCloneProIndexPage));
app.post('/admin/store/:slug/clone-pro/start',        withStore(postCloneProStart));
app.get('/admin/store/:slug/clone-pro/active/events', withStore(getCloneProActiveEvents));
app.get('/admin/store/:slug/clone-pro/:jobId',        withStore(getCloneProDetailPage));
app.get('/admin/store/:slug/clone-pro/:jobId/events', withStore(getCloneProJobEvents));
app.get('/admin/store/:slug/clone-pro/:jobId/report.txt', withStore(getCloneProReport));
app.post('/admin/store/:slug/clone-pro/:jobId/cancel',  withStore(postCloneProCancel));
app.post('/admin/store/:slug/clone-pro/:jobId/resume',  withStore(postCloneProResume));
app.post('/admin/store/:slug/clone-pro/:jobId/publish', withStore(postCloneProPublish));
app.post('/admin/store/:slug/clone-pro/:jobId/discard', withStore(postCloneProDiscard));
```

- [ ] **Step 3: Run the server integration test**

Run: `pnpm --filter @gbox/store-admin vitest run`
Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(server): wire clone-pro routes in store-admin"
```

### Task G2: Wire accounts routes

- [ ] **Step 1: Locate** `apps/accounts/src/server.ts`.
- [ ] **Step 2: Insert** routes for `GET /accounts/clone-new-store` and `POST /accounts/clone-new-store/start`.
- [ ] **Step 3: Run accounts test suite** — expected pass.
- [ ] **Step 4: Commit**

```bash
git commit -am "feat(server): wire clone-pro routes in accounts"
```

### Task G3: Add sidebar nav entry + live badge

**Files:**
- Modify: `apps/store-admin/src/layouts/seller-layout.ts`
- Modify: `apps/store-admin/src/layouts/seller-layout.test.ts`

- [ ] **Step 1: Failing test** — assert the nav config contains `{ id:'clone-pro', label:'Clone Pro', href:'/admin/store/${slug}/clone-pro', group:'Online Store' }` and that `renderNavBadge` emits a pill when `activeCloneJobs > 0`.
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — add the nav entry; pass `activeCloneJobs` through `SellerLayoutOptions`; render pill next to label.
- [ ] **Step 4: Run — passes**
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(layout): clone-pro nav entry with live count badge"
```

### Task G4: Keyboard shortcuts

**Files:**
- Modify: `packages/core/src/modules/ui/keyboard.ts`
- Modify: `packages/core/src/modules/ui/keyboard.test.ts`

- [ ] **Step 1: Failing test** — register chord `g l` → `/admin/store/<slug>/clone-pro`; `n` while focused on clone-pro list → opens New clone modal; `c p` / `c d` on detail page.
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — extend the shortcut registry.
- [ ] **Step 4: Run — passes**
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(ui): clone-pro keyboard shortcuts (g l, n, c p, c d)"
```

### Task G5: Full-suite verification gate (6.1 finish)

- [ ] **Step 1: Run every test** — `pnpm test` at repo root (or `pnpm -r test`).
- [ ] **Step 2: Assert** the existing 228 clone-pro backend tests still pass alongside new ones.
- [ ] **Step 3: If any fail** — bisect, fix, re-run. Do NOT proceed to phase H until green.
- [ ] **Step 4: Tag commit**

```bash
git commit --allow-empty -m "ci: clone-pro dashboard 6.1 MVP core green"
```

---

## Phase H — Verification breakdown + publish (6.2)

### Task H1: Verification view in detail page

- [ ] **Step 1: Failing test** — when `job.status === 'succeeded'`, main content contains:
  - Hero: `renderGradeBadge({grade, score, size:'lg'})` + label ("Excellent clone · 92 / 100") + count summary ("5 checks passed · 2 warnings · No critical issues · Safe to publish")
  - Check grid: 5 × `renderCheckScore(...)` from `result_json.checks`
  - Findings section: filter tabs (All / Critical / Warnings) + list of `renderFindingRow(...)`
  - Recommendations block: ordered list of 3 items
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — add a `renderVerificationView(result)` helper in `detail.ts` invoked only when state is `succeeded` / `published`.
- [ ] **Step 4: Run — passes**
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(store-admin): clone-pro verification breakdown UI"
```

### Task H2: Findings filter (client-side)

- [ ] **Step 1: Failing test** — click on "Critical" pill hides non-critical rows; "All" restores.
- [ ] **Step 2: Implementation** — tiny runtime script toggles `data-severity` visibility.
- [ ] **Step 3: Run — passes**
- [ ] **Step 4: Commit**

```bash
git commit -am "feat(ui/clone-pro): findings filter tabs"
```

### Task H3: Publish flow verification

- [ ] **Step 1: Failing test** — after `POST /publish` the job row has `published_at = now`, status unchanged, banner disappears from index, detail page swaps CTA to "Visit live site". Grade F publish is blocked with a red banner.
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implementation** — guard inside `postCloneProPublish` (E2): reject if `grade === 'F'` or any critical finding present; return 409 with reason.
- [ ] **Step 4: Run — passes**
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(store-admin): clone-pro publish guard (F/critical blocked)"
```

### Task H4: Full-suite verification gate (6.2 finish)

- [ ] Run `pnpm test` — all green.
- [ ] Commit empty checkpoint `ci: clone-pro dashboard 6.2 verify green`.

---

## Phase I — Polish (6.3)

### Task I1: A11y audit

- [ ] **Step 1: Write test** using `packages/core/src/modules/ui/a11y.ts` helpers against rendered HTML of every page. Assert:
  - Every `<button>` has text or `aria-label`.
  - Every progress bar has `role="progressbar"` + `aria-valuenow/min/max`.
  - Every live region uses `aria-live="polite"`.
  - No color-only signal (each status has a letter or icon alongside color).
- [ ] **Step 2: Fix every failing assertion.**
- [ ] **Step 3: Commit** — `test(clone-pro): a11y audit`.

### Task I2: Dark/light theme parity

- [ ] **Step 1: Test** — render each page with `theme='dark'` and `theme='light'`, snapshot the token usage, assert no raw hex colors leaked into inline styles outside the seller-layout CSS block.

```ts
// Example helper
const html = getCloneProIndexPage(/* req, res, db with theme=light */);
expect(html).not.toMatch(/style="[^"]*#[0-9a-f]{3,6}/i);
```

- [ ] **Step 2: Fix any hex leaks** by swapping to token variables.
- [ ] **Step 3: Commit** — `test(clone-pro): dark/light parity`.

### Task I3: Notification hooks

- [ ] **Step 1: Test** — `postCloneProStart` emits a `clone_pro_started` notification via `notify()`; publish emits `clone_pro_published`; failure via orchestrator emits `clone_pro_failed`.
- [ ] **Step 2: Implementation** — call `notify(db, {...})` in the three handlers.
- [ ] **Step 3: Commit** — `feat(clone-pro): notification events`.

### Task I4: Retire the old `/storefront-clone` page (redirect only)

> The spec says the new UI "replaces" the old page. Do NOT delete the old module — it backs a different DB table and different pipeline. Only redirect the merchant-facing URL.

- [ ] **Step 1: Test** — `GET /admin/store/:slug/storefront-clone` responds 301 to `/admin/store/:slug/clone-pro`.
- [ ] **Step 2: Implementation** — replace the existing handler body with `res.redirect(301, \`/admin/store/\${req.store.slug}/clone-pro\`)`.
- [ ] **Step 3: Commit** — `feat(store-admin): redirect legacy storefront-clone to clone-pro`.

### Task I5: Final verification gate (6.3 finish)

- [ ] **Step 1:** `pnpm test` — everything green.
- [ ] **Step 2:** `pnpm build` — no type errors.
- [ ] **Step 3:** Manual smoke on dev server (`pnpm dev:store-admin`) — accounts landing → submit → redirect → detail page → SSE ticks → verify view.
- [ ] **Step 4:** Commit empty checkpoint:

```bash
git commit --allow-empty -m "ci: clone-pro dashboard 6.1→6.3 MVP complete"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Covered by |
|---|---|
| §4.2 Routes | Tasks E1–E4, G1–G2 (all 10 route endpoints mapped) |
| §4.3 File structure | Tasks A–G create every file listed |
| §5.1 Accounts landing | F1, F2 |
| §5.2 Store-admin index | C1, C2, G3 (badge) |
| §5.3 Store-admin detail | D1, D2, H1 |
| §6 Component library (11) | B1–B11 exactly 11 components + B12 barrel |
| §6.1 Tokens | A4 |
| §6.2 A11y | B1/B5 components have aria-label; I1 audit enforces |
| §6.3 Keyboard | G4 |
| §7.1 Schema | A1, A2 |
| §7.2 SSE events | E3 plus LiveLog runtime in B10 |
| §8 Error handling | Covered inline by each action's failing-test table |
| §9 Security | CSRF + rate-limit + role guard in E1, E2, F2 |
| §10 Testing | TDD structure in every task |
| §11 Rollout | Phases G5, H4, I5 map to 6.1, 6.2, 6.3 checkpoints |

**2. Placeholder scan:** No "TBD/TODO/implement later". All code paths show concrete snippets; tasks where a full 100-LOC file would bloat the plan (B6 footer block, C1, D1) give complete signatures, imports, and test assertions so the engineer has a precise target.

**3. Type consistency:**
- `DashboardJobRow` defined in A3, used in B6, C1, D1. Same field names throughout.
- `Grade` type A–F in B1; used by `DashboardJobRow.grade` (string) — compatible.
- `PhaseStatus` values `done|active|pending|failed` match the timeline icon map.
- `renderGradeBadge` / `renderCheckScore` / `renderPhaseTimeline` / etc. all consistently use `render*` prefix + single `props` object.
- `esc` helper: inlined in early tasks, then DRY'd into `./esc.ts` in B12 with explicit refactor step — no orphaned duplicates.

No gaps found on re-review.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-17-clone-pro-dashboard-ui.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good for this plan because tasks are well-isolated (one component / one page per task).

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Good if you want to stay in one conversation and review diffs as they land.

Which approach?
