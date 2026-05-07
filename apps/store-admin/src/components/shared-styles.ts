/**
 * shared-styles.ts
 * CSS for gx-* components (badge, empty-state, pagination, filter-toolbar,
 * data-table, bulk-action-bar, stat-card).
 * Inject once into <head> via injectAdminStyles().
 */

const GX_STYLE_ID = 'gx-admin-styles'

/** Returns the full CSS string for all gx-* components. */
export function injectAdminStyles(): string {
  return `<style id="${GX_STYLE_ID}">
/* ── GX TOKENS ──────────────────────────────────────────────── */
:root {
  --gx-radius-sm:   4px;
  --gx-radius-md:   8px;
  --gx-radius-lg:   12px;
  --gx-shadow-sm:   0 1px 4px rgba(0,0,0,.2);
  --gx-shadow-md:   0 4px 16px rgba(0,0,0,.3);
  --gx-color-success: var(--s-success, #22c55e);
  --gx-color-warning: var(--s-warning, #f59e0b);
  --gx-color-danger:  var(--s-danger,  #ef4444);
  --gx-color-info:    var(--s-info,    #3b82f6);
  --gx-color-neutral: var(--s-text-muted, #94a3b8);
  --gx-bg:    var(--s-bg,   #0f172a);
  --gx-card:  var(--s-card, #1e293b);
  --gx-border:var(--s-border,#1e293b);
  --gx-text:  var(--s-text, #e2e8f0);
  --gx-muted: var(--s-text-muted, #94a3b8);
  --gx-accent:var(--s-accent,#6366f1);
}

/* ── BADGE ──────────────────────────────────────────────────── */
.gx-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: .75rem;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
}
.gx-badge--success { background: rgba(34,197,94,.15);  color: var(--gx-color-success); }
.gx-badge--warning { background: rgba(245,158,11,.15); color: var(--gx-color-warning); }
.gx-badge--danger  { background: rgba(239,68,68,.15);  color: var(--gx-color-danger); }
.gx-badge--info    { background: rgba(59,130,246,.15); color: var(--gx-color-info); }
.gx-badge--neutral { background: rgba(148,163,184,.12);color: var(--gx-color-neutral); }

/* ── EMPTY STATE ────────────────────────────────────────────── */
.gx-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 24px;
  text-align: center;
  color: var(--gx-muted);
}
.gx-empty__icon { font-size: 2.5rem; line-height:1; }
.gx-empty__title { font-size: 1.1rem; font-weight: 600; color: var(--gx-text); margin:0; }
.gx-empty__desc  { font-size: .875rem; margin:0; max-width: 320px; }
.gx-empty__cta {
  margin-top: 4px;
  display: inline-block;
  padding: 8px 20px;
  border-radius: var(--gx-radius-md);
  background: var(--gx-accent);
  color: #fff;
  font-size: .875rem;
  font-weight: 600;
  text-decoration: none;
  transition: opacity .15s;
}
.gx-empty__cta:hover { opacity:.85; }
.gx-empty__cta:focus-visible { outline: 2px solid var(--gx-accent); outline-offset: 2px; }

/* ── PAGINATION ─────────────────────────────────────────────── */
.gx-pagination {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
  padding: 16px 0;
}
.gx-pagination a, .gx-pagination span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  height: 36px;
  padding: 0 8px;
  border-radius: var(--gx-radius-sm);
  font-size: .875rem;
  text-decoration: none;
  color: var(--gx-text);
  background: var(--gx-card);
  border: 1px solid var(--gx-border);
  transition: background .15s;
}
.gx-pagination a:hover { background: var(--s-card-hover, #263348); }
.gx-pagination a:focus-visible { outline: 2px solid var(--gx-accent); outline-offset: 2px; }
.gx-pagination__current { background: var(--gx-accent) !important; color:#fff !important; border-color: var(--gx-accent) !important; }
.gx-pagination__disabled { opacity:.4; pointer-events:none; }

/* ── FILTER TOOLBAR ─────────────────────────────────────────── */
.gx-filter-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 12px 0;
}
.gx-filter-toolbar__search {
  position: relative;
  flex: 1 1 200px;
  min-width: 0;
}
.gx-filter-toolbar__search-input {
  width: 100%;
  padding: 8px 12px 8px 36px;
  border-radius: var(--gx-radius-md);
  border: 1px solid var(--gx-border);
  background: var(--s-input-bg, var(--gx-bg));
  color: var(--gx-text);
  font-size: .875rem;
  box-sizing: border-box;
}
.gx-filter-toolbar__search-input:focus { outline: 2px solid var(--gx-accent); outline-offset: -1px; }
.gx-filter-toolbar__search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--gx-muted);
  pointer-events: none;
}
.gx-filter-toolbar__select {
  padding: 8px 32px 8px 12px;
  border-radius: var(--gx-radius-md);
  border: 1px solid var(--gx-border);
  background: var(--s-input-bg, var(--gx-bg));
  color: var(--gx-text);
  font-size: .875rem;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  cursor: pointer;
}
.gx-filter-toolbar__select:focus { outline: 2px solid var(--gx-accent); outline-offset: -1px; }
.gx-filter-toolbar__clear {
  font-size: .8rem;
  color: var(--gx-muted);
  text-decoration: none;
  padding: 4px 8px;
  border-radius: var(--gx-radius-sm);
}
.gx-filter-toolbar__clear:hover { color: var(--gx-text); }
.gx-filter-toolbar__clear:focus-visible { outline: 2px solid var(--gx-accent); outline-offset: 2px; }

/* ── DATA TABLE ─────────────────────────────────────────────── */
.gx-table-wrap {
  overflow-x: auto;
  border-radius: var(--gx-radius-md);
  border: 1px solid var(--gx-border);
}
.gx-table {
  width: 100%;
  border-collapse: collapse;
  font-size: .875rem;
  color: var(--gx-text);
}
.gx-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--s-sidebar, #0c1222);
  padding: 10px 14px;
  text-align: left;
  font-weight: 600;
  font-size: .8rem;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--gx-muted);
  white-space: nowrap;
  border-bottom: 1px solid var(--gx-border);
}
.gx-table tbody tr {
  border-bottom: 1px solid var(--gx-border);
  transition: background .1s;
}
.gx-table tbody tr:last-child { border-bottom: none; }
.gx-table tbody tr:hover { background: var(--s-card-hover, #263348); }
.gx-table tbody td { padding: 10px 14px; vertical-align: middle; }
.gx-table--compact thead th,
.gx-table--compact tbody td { padding: 6px 12px; }
.gx-table__sort-link {
  color: inherit;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.gx-table__sort-link:focus-visible { outline: 2px solid var(--gx-accent); outline-offset: 2px; border-radius: 2px; }
.gx-table__sort-icon { font-size: .75rem; opacity: .6; }
.gx-table__sort-icon--active { opacity: 1; color: var(--gx-accent); }
.gx-table__cb { width: 40px; text-align: center; }
.gx-table input[type=checkbox] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--gx-accent); }

/* ── BULK ACTION BAR ────────────────────────────────────────── */
.gx-bulk-bar {
  position: sticky;
  bottom: 0;
  z-index: 20;
  display: none;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 20px;
  background: var(--s-card, #1e293b);
  border-top: 1px solid var(--gx-border);
  box-shadow: 0 -4px 16px rgba(0,0,0,.3);
}
.gx-bulk-bar.gx-bulk-bar--visible { display: flex; }
.gx-bulk-bar__count { font-size: .875rem; font-weight: 600; color: var(--gx-muted); }
.gx-bulk-bar__btn {
  padding: 7px 16px;
  border-radius: var(--gx-radius-sm);
  border: 1px solid var(--gx-border);
  background: var(--gx-card);
  color: var(--gx-text);
  font-size: .875rem;
  cursor: pointer;
  transition: background .15s;
}
.gx-bulk-bar__btn:hover { background: var(--s-card-hover, #263348); }
.gx-bulk-bar__btn:focus-visible { outline: 2px solid var(--gx-accent); outline-offset: 2px; }
.gx-bulk-bar__btn--destructive { color: var(--gx-color-danger); border-color: var(--gx-color-danger); }
.gx-bulk-bar__btn--destructive:hover { background: rgba(239,68,68,.1); }

/* ── STAT CARD ──────────────────────────────────────────────── */
.gx-stat {
  background: var(--gx-card);
  border-radius: var(--gx-radius-lg);
  border: 1px solid var(--gx-border);
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-shadow: var(--gx-shadow-sm);
}
.gx-stat__label { font-size: .8rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--gx-muted); }
.gx-stat__value { font-size: 1.75rem; font-weight: 700; color: var(--gx-text); line-height: 1.2; }
.gx-stat__hint  { font-size: .8rem; color: var(--gx-muted); }
.gx-stat__trend { font-size: .8rem; font-weight: 600; margin-top: 2px; }
.gx-stat__trend--up   { color: var(--gx-color-success); }
.gx-stat__trend--down { color: var(--gx-color-danger); }
.gx-stat__trend--flat { color: var(--gx-color-neutral); }
</style>`
}
