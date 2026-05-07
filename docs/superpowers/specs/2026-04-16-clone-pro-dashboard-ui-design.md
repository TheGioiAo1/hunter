# Clone Pro — Dashboard UI Design

**Date:** 2026-04-16
**Author:** Claude + Thai Bui
**Status:** Approved — ready for implementation plan
**Related specs:**
- `2026-04-13-clone-pro-v4-spec.md` — backend spec
- `2026-04-07-seller-dashboard-spec.md` — seller-layout design system

## 1. Goal

Build a professional, cohesive dashboard UI for `clone-pro` v4 that:

- Replaces the minimal `storefront-clone.ts` (443 LOC, URL + SSE console only) with a full-fledged experience that exposes every Phase 1/2/3 capability the backend already implements.
- Presents in both `accounts` portal (merchant onboarding) and `store-admin` (per-store management) — one shared component library, two entry points.
- Matches the existing seller dashboard visual system (dark-first, indigo `#6366f1`, inline CSS tokens from `seller-layout.ts`) without introducing a new framework or palette.
- Ships with end-to-end tests, dark/light parity, WCAG-safe a11y, and zero regressions on the existing 228-test clone-pro suite.

## 2. Scope

**In scope:**

- Accounts portal landing page (`/accounts/clone-new-store`) that creates a store and kicks off a clone in one flow.
- Store-admin index page (`/admin/store/:slug/clone-pro`) with stats strip, active job cards, "ready to publish" banner, and history table.
- Store-admin job detail page (`/admin/store/:slug/clone-pro/:jobId`) — 3-column layout: timeline sidebar, phase-aware main content, AI panel.
- Live SSE updates for active jobs (list + detail).
- Action endpoints: start, resume, cancel, publish, discard.
- Shared component library (`packages/core/src/modules/ui/clone-pro/`) — 11 components, each with a unit test.
- Rollout gated by Phases 6.1 → 6.3 (MVP); 6.4/6.5 deprioritized.

**Out of scope (later phases):**

- Section-preview iframe (6.4) — live render of detected sections before publish.
- Source-vs-clone side-by-side diff view (6.5).
- Multi-tenant admin analytics across stores (own spec).
- Real-time collaboration on in-flight clones (own spec).

## 3. Decisions (locked from brainstorming)

| # | Topic | Decision |
|---|---|---|
| Q1 | Scope | **C** — both accounts portal onboarding + per-store admin |
| Q2 | Layout | **B** — single-page + vertical timeline sidebar + phase-aware main + AI panel |
| Q3 | Verification display | **B** — breakdown grid (overall grade hero + 5-check scores + findings list + recommendations) |
| Q4 | Job history | **C** — hybrid (active jobs as cards, history as compact table) |
| Q5 | New-clone form | **B** — inline with smart defaults (URL + AI toggles with cost estimate), advanced options collapsed |

Supporting rationale and per-option mockups live in `.superpowers/brainstorm/3496-1776356505/content/` (preserved for reference).

## 4. Architecture

### 4.1 Stack (locked by existing codebase)

- Express SSR + vanilla JS + inline CSS tokens.
- No new framework (React, Vue, htmx) — matches `store-admin`, `accounts`, `god-admin`.
- Reuse `seller-layout.ts` chrome, tokens, command palette, keyboard shortcuts, toast/modal/flash helpers.

### 4.2 Routes

**Accounts portal** (`apps/accounts/src/pages/clone-pro/`):

- `GET  /accounts/clone-new-store` — landing page with inline form (Q5 variant B).
- `POST /accounts/clone-new-store/start` — validates URL, creates store (owner role, slug auto-generated from hostname with override), creates clone job, redirects to `/admin/store/:slug/clone-pro/:jobId`.

**Store-admin** (`apps/store-admin/src/pages/clone-pro/`):

- `GET  /admin/store/:slug/clone-pro` — index view.
- `POST /admin/store/:slug/clone-pro/start` — start new clone in this store.
- `GET  /admin/store/:slug/clone-pro/:jobId` — detail view.
- `GET  /admin/store/:slug/clone-pro/:jobId/events` — per-job SSE stream.
- `GET  /admin/store/:slug/clone-pro/active/events` — aggregate SSE stream for index page (1 connection covers all active jobs in store).
- `POST /admin/store/:slug/clone-pro/:jobId/resume` — resume failed/paused job from last checkpoint.
- `POST /admin/store/:slug/clone-pro/:jobId/cancel` — cancel running job (progress lost, AI cost not refunded).
- `POST /admin/store/:slug/clone-pro/:jobId/publish` — publish verified job to live storefront.
- `POST /admin/store/:slug/clone-pro/:jobId/discard` — soft-delete job (revertible for N days).
- `GET  /admin/store/:slug/clone-pro/:jobId/report.txt` — download plain-text verification report.

### 4.3 File structure

```
apps/accounts/src/pages/clone-pro/
  landing.ts                    (~150 LOC, 1 test file)
  start.ts                      (~80 LOC, 1 test file)

apps/store-admin/src/pages/clone-pro/
  index.ts                      (~200 LOC, 1 test file)
  detail.ts                     (~350 LOC, 1 test file)
  start.ts                      (~100 LOC, 1 test file)
  actions.ts                    (~150 LOC, 1 test file)
  events.ts                     (~120 LOC, 1 test file)

packages/core/src/modules/ui/clone-pro/
  grade-badge.ts
  check-score.ts
  phase-timeline.ts
  job-card.ts
  job-table-row.ts
  clone-form.ts
  cost-estimate.ts
  section-chip.ts
  live-log.ts
  finding-row.ts
  ready-banner.ts
  (11 components × ~60-100 LOC each + co-located .test.ts files)
```

LOC totals: pages ~1,150, components ~800, tests ~1,240. Everything routed through existing `seller-layout.ts` and `accounts` layout.

## 5. Page designs

### 5.1 Accounts portal landing (`/accounts/clone-new-store`)

**Structure (top to bottom):**

1. Accounts portal top chrome (existing).
2. Hero section (max-width 720px, centered): pill "✨ Clone Pro · Powered by Gbox AI" → H1 "Start your store from any URL" → description.
3. Inline form card (dark surface, elevated shadow):
   - URL input with left-aligned `🔗` affordance.
   - Two smart-default tiles: Pages (default "All — auto-detect") + Theme (default "Gbox Dawn").
   - AI enhancement block: two iOS-style toggle rows (Alt-text $0.40, SEO metadata $0.25), both on by default.
   - Primary CTA button "Start clone · Estimated $0.65" (gradient indigo→violet).
   - Link row: "More options" (expands advanced) + "Free if no AI features selected".
4. Trust strip under form: "⚡ Usually 2–4 min · 🛡️ 95%+ fidelity · 🎨 20 Dawn sections mapped".

**Behaviors:**

- On URL blur/paste: async HEAD fetch validates reachability (green ✓ / red ✗ next to input).
- Cost estimate updates after a successful HEAD returns a rough page count.
- Duplicate guard: if the user already has a running job for the same URL, show a toast with a link to that job and block submission.
- "More options" expands to reveal: custom slug, max pages, crawl depth, concurrency, publish mode (staged/direct).
- On submit: server creates store (owner role, slug from hostname, overridable) and clone job, then responds 302 to `/admin/store/:slug/clone-pro/:jobId`.

### 5.2 Store-admin index (`/admin/store/:slug/clone-pro`)

**Structure:**

1. Breadcrumb: `Online Store › Clone Pro`.
2. Page header: title + subtitle + buttons `📊 Analytics` (secondary) and `+ New clone` (primary indigo).
3. Stats strip (4 cards): Total jobs / Published / Avg grade / AI cost 30d.
4. "Active (N)" section: grid of `JobCard` components (blue for running with progress bar, red for failed with inline error, amber for paused). Auto-refresh via aggregate SSE.
5. "Ready to publish" banner (separate from Active) — green gradient card per job that finished verification, with `Preview` + `Publish now` buttons.
6. "History" section: search + status filter → table with columns `Job | Source | Status | Grade | Pages | AI cost | Age | View →`. Pagination 10/page.
7. Sidebar nav badge: running-job count displayed next to "Clone Pro" nav entry.
8. Empty state: illustration + "Start your first clone" CTA + three example URLs.

**Keyboard:**

- `g l` → jump to clone-pro list.
- `n` while on this page → open New clone modal.

### 5.3 Store-admin job detail (`/admin/store/:slug/clone-pro/:jobId`)

**Layout:** 3 columns — timeline sidebar (220px), main content (flex), AI panel (320px).

**Header:** back link + source URL + status badge (running/failed/paused/ready/published) + metadata line (job id, age, duration, cost, grade if verified). Right side: secondary buttons + primary CTA (Publish/Resume/Re-run depending on state).

**Timeline sidebar:**

- Vertical rail with 3 nodes (Discovery / Execution / Verification).
- Done: green check circle. Active: blue animated circle. Pending: gray outline circle.
- Each node shows phase meta (e.g., "48 pages · 12s" when done).
- Active phase reveals substeps (e.g., "Homepage clone · Section map (4/4) · AI alt-text (12/38) · AI SEO · Persist").
- Below timeline: Config snapshot block (theme, AI toggles, publish mode). Artifacts block (links to index.json, liquid files, assets, report.txt) once done.

**Main content — phase-aware:**

- **Discovery view:** URL summary, detected page types, per-type counts, crawl progress bar, live per-page log.
- **Execution view:** overall progress bar (gradient indigo→violet), section-mapper cards (Hero 🎯 / Featured 🛍️ / Image+Text 🖼️ / Newsletter 📧 with detected metadata), live log stream in monospace with colored levels.
- **Verification view (Option B):**
  - Hero: large A-F circle (radial gradient of status color) + "Excellent/Good/…/Critical" label + "N checks passed · N warnings · N critical issues · Safe/Unsafe to publish" subtitle.
  - 5-check breakdown grid: one tile per check (CSS Match, Assets, Content, Routes, Deps) showing score and meta.
  - Findings list with filter tabs (All / Critical / Warnings) — each row has severity icon, title, body, and inline actions ("Open in theme editor", "Ignore finding", "Re-run with depth=4").
  - Recommendations block: ordered list of 3 next steps.

**AI panel (right):**

- Running mode: contextual tip card (matches current phase) + live cost ticker with progress against estimate + recent events feed.
- Verified mode: "✓ Clone complete · Safe to publish" header + NEXT box with `Publish to live` (primary green) and `Open theme editor` (secondary) + Summary block (Pages / Sections / Alt-text / SEO / Cost / Duration) + Other actions (Re-run, Copy config, Discard).

**State variants:**

- Failed: hero turns red, primary CTA becomes "Resume from last successful step", inline error banner with technical details collapsible.
- Paused: hero turns amber, primary CTA "Resume".
- Published: hero gets a green check ring, primary CTA replaced by "Visit live site".
- Grade F / critical finding: Publish disabled with red "Critical issues must be resolved before publishing" banner; only Re-run enabled.

## 6. Shared component library

`packages/core/src/modules/ui/clone-pro/*.ts` — 11 components, each exporting:

```ts
export function renderX(props: XProps): string
export const xCss: string
export function xRuntimeScriptBody?(): string
```

Pattern matches existing `toast.ts`, `modal.ts`, `keyboard.ts`.

| Component | Props | Notes |
|---|---|---|
| `GradeBadge` | `grade: 'A'…'F', size: 'sm'∣'md'∣'lg'` | Circle or chip form depending on size |
| `CheckScore` | `name, score, weight?, status: 'pass'∣'warn'∣'fail', sub?` | Left border color reflects status |
| `PhaseTimeline` | `phases: [{id,label,status,meta?,substeps?}]` | Vertical rail + nodes |
| `JobCard` | `job: JobRow, variant: 'running'∣'failed'∣'paused'` | Used in Active list |
| `JobTableRow` | `job: JobRow` | Used in History table |
| `CloneForm` | `variant: 'landing'∣'modal', action, csrfToken, defaults?` | Inline form (Q5 B) |
| `CostEstimate` | `{altText?, seo?, total}` | Shown in form + AI panel |
| `SectionChip` | `sectionId, position, meta?` | 20 Gbox Dawn icon map |
| `LiveLog` | `sseUrl, maxLines?` | Monospace, colored levels, `aria-live="polite"` |
| `FindingRow` | `finding, onActionHref?` | Severity icon + body + inline actions |
| `ReadyBanner` | `job` | Green gradient, Publish CTA |

### 6.1 Design tokens

Extend `SELLER_STYLES` in `seller-layout.ts` with semantic variables (do not introduce a new palette — Thai confirmed existing indigo is enough):

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

--phase-gradient:      linear-gradient(90deg, #3b82f6, #6366f1, #8b5cf6);
--clone-accent-gradient: linear-gradient(135deg, #6366f1, #8b5cf6);
```

All components reference variables — no hard-coded hex values; the light-theme override scope (`[data-theme="light"]`) adjusts surfaces and borders.

### 6.2 Accessibility

- Every action button has a specific `aria-label` (e.g., "Cancel job a3f9 running since 12:04").
- Progress bars: `role="progressbar"` with `aria-valuenow/min/max`.
- `LiveLog`: `aria-live="polite"`, NOT atomic (so screen readers announce only new lines).
- Grade badges: `title` tooltip "Grade A (92 of 100)"; color never the sole signal (letter + icon accompany).
- Timeline nodes expose status via both icon and text, keyboard-focusable (`tabindex=0`) with `Enter` to scroll main-content to that phase's anchor.

### 6.3 Keyboard shortcuts (additions to command palette)

| Chord | Effect | Scope |
|---|---|---|
| `g l` | Jump to Clone Pro list | Store-admin |
| `n` | Open New clone modal | Clone Pro list |
| `c p` | Copy job config to clipboard | Detail page |
| `c d` | Download verification report | Detail page (verified state) |

## 7. Data & SSE

### 7.1 Schema additions (extend `storefront_clone_jobs`)

> **Note (2026-04-17):** Per pragmatic decision, the clone-pro v4 runner currently writes to the existing `storefront_clone_jobs` table (the runner anticipates a future `clone_pro_jobs` table via Online Store Rewrite Phase 2B, but that migration does not exist yet). To ship 6.1→6.3 without blocking on backend work, the dashboard UI targets `storefront_clone_jobs`. The eventual rename to `clone_pro_jobs` is a mechanical swap in one runner file; UI queries read the same columns either way.

```sql
ALTER TABLE storefront_clone_jobs
  ADD COLUMN config_json        JSONB,
  ADD COLUMN result_json        JSONB,  -- already exists on this table; skip if duplicate
  ADD COLUMN current_phase      SMALLINT DEFAULT 0,
  ADD COLUMN phase_progress_pct SMALLINT DEFAULT 0,
  ADD COLUMN substep            TEXT,
  ADD COLUMN cost_cents         INTEGER DEFAULT 0,
  ADD COLUMN published_at       TIMESTAMPTZ,
  ADD COLUMN discarded_at       TIMESTAMPTZ,
  ADD COLUMN grade              TEXT,
  ADD COLUMN score              SMALLINT,
  ADD COLUMN page_count         INTEGER;

CREATE INDEX idx_clone_jobs_shop_status
  ON storefront_clone_jobs(shop_id, status, created_at DESC);
```

The migration must first introspect the existing table to skip any column that already exists (e.g., `result_json`).

`stages_json` and its helpers (`readStages`, `appendStage`) carry over from storefront-clone v1.

### 7.2 Event taxonomy

Single per-job SSE endpoint emits newline-delimited JSON:

```ts
type CloneProEvent =
  | { type: 'phase.start';    phase: 1|2|3;  at: string }
  | { type: 'phase.progress'; phase: 1|2|3;  pct: number; substep?: string }
  | { type: 'phase.done';     phase: 1|2|3;  meta: Record<string, unknown> }
  | { type: 'discovery.page'; url: string; pageType: string; status: string }
  | { type: 'section.detected'; id: SectionId; position: number; settings: Record<string, unknown> }
  | { type: 'ai.cost';        feature: 'alt_text'|'seo'; delta_cents: number; total_cents: number }
  | { type: 'log';            level: 'info'|'success'|'warn'|'error'; text: string; ts: string }
  | { type: 'job.finished';   status: 'succeeded'|'failed'; grade?: string; score?: number }
  | { type: 'error';          phase: 1|2|3; code: string; message: string; recoverable: boolean }
```

Connection pattern: replay stored stages from `stages_json`, attach appender, close on terminal status — reuses storefront-clone v1 plumbing.

Aggregate endpoint `/admin/store/:slug/clone-pro/active/events` pushes compact updates `{jobId, phase, pct, status}` for the index view — one browser connection updates every active card.

## 8. Error handling

| Phase | Error | Surface | Recovery |
|---|---|---|---|
| Discovery | Source unreachable / 4xx / 5xx | Red banner + Retry button | New job with same config |
| Discovery | Bot detection / Cloudflare block | Error card + technical details collapsible | Resume with `respect_robots=false` (advanced option) |
| Discovery | Exceeds `max_pages` | Amber warning + partial-success banner | Publish partial, or re-run with higher depth |
| Execution | AI rate-limit (429) | Auto-pause + toast "Paused, waiting for quota" | Auto-retry with backoff; user may "Skip AI and resume" |
| Execution | AI provider outage (5xx) | Pause + email alert to owner | Resume once upstream status recovers |
| Execution | Section mapper throws | Log warning + fallback to Gbox Dawn defaults | Continue — non-blocking |
| Execution | DB write failure | Critical fail | Resume from last committed substep |
| Verification | Critical finding (e.g., tracking pixel) | Grade F + Publish disabled | Fix manually or re-run with `strict_dep_check=false` |
| Any | Worker killed mid-phase | Poller marks job `paused` | Resume reads `substep` and continues |

Resume semantics: every substep boundary writes `clone_pro_jobs.substep`; resume skips completed substeps. AI cost is not refunded — merchant sees it explicitly in the cost tracker.

## 9. Security

- CSRF tokens on all POST forms (start, resume, cancel, publish, discard) via `csrfHiddenField`.
- Rate limits: 5 start/resume operations per user per minute (existing rate-limit middleware).
- Authorization (per CLAUDE.md Rule 2):
  - Level 2 Store Owner: full access.
  - Level 3 Store Admin: view + start; cannot publish or discard.
  - Level 4 Store Staff: view only.
  - Middleware `requireRole('owner'|'admin', action)` wraps each route.
- Audit log entries for every write action (start/cancel/resume/publish/discard) via the `audit-log` plugin.
- Response sanitization: strip internal fields (`config_json.internal_api_key` if present, stage-level secrets) before JSON serialization.

## 10. Testing strategy

Follow `superpowers:test-driven-development` — write tests before implementation.

**Page tests** (`apps/*/src/pages/clone-pro/*.test.ts`):

- Accounts landing: render, URL validation, estimate math. (~4 tests, 60 LOC)
- Accounts start: store creation, job creation, redirect, CSRF, rate-limit. (~5 tests, 80 LOC)
- Store-admin index: list rendering, empty state, filters, pagination, sidebar badge, SSE attach. (~8 tests, 120 LOC)
- Store-admin detail: render per phase, each state variant, action wiring, SSE replay. (~12 tests, 180 LOC)
- Store-admin start: validation, duplicate guard, CSRF, rate-limit. (~5 tests, 80 LOC)
- Store-admin actions: guards for resume/cancel/publish/discard plus role checks. (~6 tests, 100 LOC)
- Store-admin events: replay + live append + terminal close. (~4 tests, 70 LOC)

**Component tests** (`packages/core/src/modules/ui/clone-pro/*.test.ts`):

- One file per component, ~50 LOC each, covering default render + variants + edge cases. (11 files, ~550 LOC)

**Totals:** ~1,240 LOC test / ~1,750 LOC implementation (~0.7 ratio — matches house standard).

**Smoke E2E (optional, Playwright, post-MVP):** full flow from accounts landing → redirect → SSE connect → succeeded → Publish → live storefront assertion.

**Non-regression guard:** existing 228 clone-pro tests must remain green throughout.

## 11. Rollout phases

- **6.1 (MVP core):** Store-admin index + detail (running state) + start/cancel/resume. Accounts portal landing + start.
- **6.2 (MVP verify):** Verification breakdown, findings UI, publish flow, discard.
- **6.3 (MVP polish):** Component library tests, a11y audit, dark/light parity verification, keyboard shortcuts.
- **6.4 (nice-to-have):** Section preview iframe inside execution phase.
- **6.5 (nice-to-have):** Source-vs-clone side-by-side diff view for findings.

6.1 → 6.3 is the "professional + đồng bộ" MVP Thai requested. 6.4/6.5 ship after.

## 12. Success metrics

- Merchant reaches "Start clone" within 30 seconds from accounts landing.
- Job detail page SSR < 400 ms; SSE attach < 200 ms.
- Verification report renders within 1 s after Phase 3 finishes.
- Zero regressions on the 228-test clone-pro suite.
- New test suite passes 100% before merge.

## 13. Open questions / future work

None blocking 6.1 → 6.3. Candidates for a follow-up spec:

- Cross-store analytics dashboard (god-admin view of all clones).
- Clone templates ("re-clone with adjustments" one-click presets).
- Scheduled re-clones (watch source URL for structural changes).
- Partner/agency multi-tenant management.

## 14. References

- `CLAUDE.md` — iron rules (workflow-first, hierarchy, security).
- `apps/store-admin/src/layouts/seller-layout.ts` — design system foundation.
- `apps/store-admin/src/pages/storefront-clone.ts` — v1 page being replaced.
- `packages/core/src/modules/clone-pro/` — backend module (228 tests).
- `packages/core/src/modules/ui/` — existing shared UI primitives.
- `.superpowers/brainstorm/3496-1776356505/` — brainstorming mockups (preserved).
