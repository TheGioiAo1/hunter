/**
 * Gbox Platform — Shared Bulk Actions (Phase 2 Step 2.4)
 *
 * Shopify-style multi-row selection + bulk operations:
 *
 *   [ ☐ ] Name              Email               Status
 *   [ ☑ ] Thái Bùi           thai@gbox.co        Active
 *   [ ☑ ] Admin Two          admin2@gbox.co      Active
 *   ──────────────────────────────────────────────────────
 *   [ 2 selected ]   [ Activate ]  [ Suspend ]  [ Delete ]
 *
 * Before Stage 2.4 Gbox had zero multi-row selection. Every operation
 * was a single row click → page navigation → one action → back. That's
 * fine for 5 users but murder for 500 users or 5000 orders.
 *
 * IMPORTANT — ROLE SCOPING
 * ------------------------
 * Per Iron Rule #2 and the owner's Phase 2 decision (Q4):
 *   "tất cả những tính năng bulk, chỉ có duy nhất 1 tài khoản god
 *    admin default có thôi em nhé"
 *
 * Translation: **BULK ACTIONS ARE GOD-ADMIN-ONLY IN GOD-ADMIN ROUTES.**
 * Store owners CAN use bulk actions INSIDE their own store (products,
 * orders, customers) because that's their own data. They CANNOT use
 * bulk actions from any god-admin page.
 *
 * This module is a pure UI helper — it does NOT enforce the rule.
 * Route handlers MUST gate bulk endpoints behind the appropriate
 * middleware (`requireLevel(0)` for god-admin bulks, `requireStoreRole`
 * for per-store bulks).
 *
 * What this module ships
 * ----------------------
 *   - `bulkCheckbox(rowId)` — the row-level checkbox HTML.
 *   - `bulkHeaderCheckbox()` — the select-all checkbox in the table header.
 *   - `bulkActionBar(actions, formId)` — the floating/sticky footer that
 *     appears when rows are selected, listing the available actions.
 *   - `bulkRuntimeScriptBody()` — client JS that wires everything:
 *     header-click toggles all rows, row-click updates the counter,
 *     submitting an action pushes the selected IDs as the form body.
 *   - `bulkActionsCss()` — styles.
 *
 * Security model
 * --------------
 * - Selected IDs are serialized into a hidden `<input name="ids[]">`
 *   array via JS when the action is triggered. The form already
 *   includes the CSRF token (layouts inject it via `csrfField`).
 * - Dangerous actions (delete, suspend) should open a
 *   `dangerousConfirmModal()` where the user types "DELETE N items"
 *   to confirm — the runtime script wires the count into the modal's
 *   description automatically.
 *
 * Triết lý: "clone giống hệt Shopify" (sticky bulk action bar,
 * select-all header checkbox) + "power-ful hơn Shopify nhờ Claude"
 * (typed action config + inline CSRF + auto-wired confirm modal).
 */

export interface BulkAction {
  /** Unique action id — POSTed as the form's `action` field. */
  id: string
  /** Visible label — "Activate", "Suspend", "Delete". */
  label: string
  /**
   * Visual tone. `default` (neutral), `primary` (accent), `danger`
   * (red — use for destructive ops). Default: 'default'.
   */
  kind?: 'default' | 'primary' | 'danger'
  /**
   * If set, submitting this action opens a confirmation modal with
   * this id BEFORE the form submits. Use `dangerousConfirmModal` for
   * type-to-confirm destructive ops.
   */
  confirmModalId?: string
  /** Optional small SVG icon prepended to the label. */
  icon?: string
  /** Disabled at render time (e.g. feature-flagged). */
  disabled?: boolean
}

export interface BulkCheckboxOptions {
  /** The row's primary key (stringified). */
  rowId: string
  /** Extra className on the <input>. */
  className?: string
  /** ARIA label (defaults to "Select row"). */
  ariaLabel?: string
}

export interface BulkActionBarOptions {
  /** The form id that wraps the list + hidden ids input. Required. */
  formId: string
  /** Available actions. */
  actions: BulkAction[]
  /** Extra className on the root container. */
  className?: string
  /** Shown when 0 rows selected. Default: hidden. */
  showWhenEmpty?: boolean
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render a per-row checkbox. The row id is stored in `data-row-id`
 * so the runtime script can serialize the selected set on submit.
 */
export function bulkCheckbox(opts: BulkCheckboxOptions): string {
  const className = opts.className ?? ''
  const ariaLabel = opts.ariaLabel ?? 'Select row'
  return (
    `<input type="checkbox" class="gbox-bulk-row ${className}" ` +
    `data-row-id="${esc(opts.rowId)}" ` +
    `aria-label="${esc(ariaLabel)}">`
  )
}

/**
 * Render the header-row "select all" checkbox. Clicking it toggles
 * every row checkbox on the page.
 */
export function bulkHeaderCheckbox(ariaLabel: string = 'Select all rows'): string {
  return (
    `<input type="checkbox" class="gbox-bulk-all" ` +
    `aria-label="${esc(ariaLabel)}">`
  )
}

/**
 * Render the floating bulk action bar. Hidden by default; the
 * runtime script shows it when ≥1 row is checked and updates the
 * counter.
 *
 * The bar contains:
 *   - "N selected" counter
 *   - "Clear selection" link
 *   - Action buttons
 */
export function bulkActionBar(opts: BulkActionBarOptions): string {
  const className = opts.className ?? ''
  const hiddenClass = opts.showWhenEmpty ? '' : ' gbox-bulk-bar-hidden'

  const actionsHtml = opts.actions
    .map((action) => {
      const kind = action.kind ?? 'default'
      const cls = `gbox-bulk-btn gbox-bulk-btn-${kind}`
      const disabled = action.disabled ? ' disabled' : ''
      const modalAttr = action.confirmModalId
        ? ` data-confirm-modal="${esc(action.confirmModalId)}"`
        : ''
      const icon = action.icon ? `<span class="gbox-bulk-btn-icon">${action.icon}</span>` : ''
      return (
        `<button type="submit" form="${esc(opts.formId)}" name="action" ` +
        `value="${esc(action.id)}" class="${cls}"${disabled}${modalAttr}>` +
        icon +
        `<span>${esc(action.label)}</span>` +
        `</button>`
      )
    })
    .join('')

  return (
    `<div class="gbox-bulk-bar${hiddenClass} ${className}" ` +
    `role="toolbar" aria-label="Bulk actions" ` +
    `data-form-id="${esc(opts.formId)}">` +
    `<div class="gbox-bulk-count"><span class="gbox-bulk-count-number">0</span> selected</div>` +
    `<button type="button" class="gbox-bulk-clear" onclick="gboxBulkClear()">Clear selection</button>` +
    `<div class="gbox-bulk-actions">${actionsHtml}</div>` +
    `</div>`
  )
}

/**
 * Runtime script body. Defines:
 *   - window.gboxBulkClear() — uncheck every row, hide the bar.
 *   - Automatic wiring of the header checkbox → toggle all rows.
 *   - Automatic wiring of row checkboxes → update count + show/hide bar.
 *   - Before submit, serialize all checked ids into a hidden
 *     `<input type="hidden" name="ids">` (comma-separated), so the
 *     server handler sees a single string it can split.
 *   - If the button has `data-confirm-modal`, intercept the submit,
 *     inject the count into the modal's description, and open the
 *     modal instead of submitting directly. The modal's own confirm
 *     button (inside the same form) will re-submit.
 */
export function bulkRuntimeScriptBody(): string {
  return `
    (function(){
      function rows() {
        return Array.prototype.slice.call(
          document.querySelectorAll('.gbox-bulk-row')
        );
      }
      function checked() {
        return rows().filter(function(r){ return r.checked; });
      }
      function bar() {
        return document.querySelector('.gbox-bulk-bar');
      }
      function updateBar() {
        var b = bar();
        if (!b) return;
        var n = checked().length;
        var countEl = b.querySelector('.gbox-bulk-count-number');
        if (countEl) countEl.textContent = String(n);
        if (n > 0) {
          b.classList.remove('gbox-bulk-bar-hidden');
        } else {
          b.classList.add('gbox-bulk-bar-hidden');
        }
        // Sync the header checkbox (checked iff all rows checked).
        var all = document.querySelector('.gbox-bulk-all');
        if (all) {
          var total = rows().length;
          if (total === 0) {
            all.checked = false;
            all.indeterminate = false;
          } else if (n === 0) {
            all.checked = false;
            all.indeterminate = false;
          } else if (n === total) {
            all.checked = true;
            all.indeterminate = false;
          } else {
            all.checked = false;
            all.indeterminate = true;
          }
        }
      }

      function toggleAll(on) {
        rows().forEach(function(r){ r.checked = on; });
        updateBar();
      }

      window.gboxBulkClear = function() {
        toggleAll(false);
      };

      // Wire the header checkbox.
      document.addEventListener('change', function(e){
        var t = e.target;
        if (!t || !t.classList) return;
        if (t.classList.contains('gbox-bulk-all')) {
          toggleAll(t.checked);
        } else if (t.classList.contains('gbox-bulk-row')) {
          updateBar();
        }
      });

      // Before submit, write the selected ids into a hidden input on the form.
      document.addEventListener('click', function(e){
        var t = e.target;
        while (t && t.tagName !== 'BUTTON') t = t.parentNode;
        if (!t || !t.classList || !t.classList.contains('gbox-bulk-btn')) return;

        var formId = t.getAttribute('form');
        var form = formId ? document.getElementById(formId) : null;
        if (!form) return;

        // Write hidden input with checked ids.
        var ids = checked().map(function(r){ return r.getAttribute('data-row-id'); });
        var existing = form.querySelector('input[type="hidden"][name="ids"]');
        if (!existing) {
          existing = document.createElement('input');
          existing.type = 'hidden';
          existing.name = 'ids';
          form.appendChild(existing);
        }
        existing.value = ids.join(',');

        // If the action requires confirmation, open the modal instead.
        var modalId = t.getAttribute('data-confirm-modal');
        if (modalId && window.gboxOpenModal) {
          e.preventDefault();
          // Inject the count into any element inside the modal that has
          // a data-bulk-count attribute so the prompt reads "Delete 3 items".
          var modal = document.getElementById(modalId);
          if (modal) {
            var countNodes = modal.querySelectorAll('[data-bulk-count]');
            for (var i = 0; i < countNodes.length; i++) {
              countNodes[i].textContent = String(ids.length);
            }
          }
          window.gboxOpenModal(modalId);
        }
        // Otherwise the native submit happens.
      });

      // Keep the bar in sync on page load.
      document.addEventListener('DOMContentLoaded', updateBar);
    })();
  `
}

export function bulkActionsCss(): string {
  return `
    .gbox-bulk-row,
    .gbox-bulk-all {
      width: 14px;
      height: 14px;
      cursor: pointer;
      accent-color: var(--god-accent, #3b82f6);
    }
    .gbox-bulk-row:focus-visible,
    .gbox-bulk-all:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }

    .gbox-bulk-bar {
      position: sticky;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 16px;
      background: var(--god-surface, #1f2937);
      border-top: 1px solid var(--god-border, rgba(255,255,255,0.1));
      box-shadow: 0 -10px 20px rgba(0,0,0,0.15);
      z-index: 50;
      transform: translateY(0);
      transition: transform 0.2s ease, opacity 0.2s ease;
    }
    .gbox-bulk-bar-hidden {
      transform: translateY(100%);
      opacity: 0;
      pointer-events: none;
    }
    .gbox-bulk-count {
      font-size: 13px;
      font-weight: 600;
      color: var(--god-text, #f3f4f6);
    }
    .gbox-bulk-count-number {
      color: var(--god-accent, #3b82f6);
    }
    .gbox-bulk-clear {
      background: transparent;
      border: none;
      color: var(--god-text-secondary, #9ca3af);
      font-size: 12px;
      cursor: pointer;
      text-decoration: underline;
      padding: 0;
      font-family: inherit;
    }
    .gbox-bulk-clear:hover {
      color: var(--god-text, #f3f4f6);
    }
    .gbox-bulk-clear:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }
    .gbox-bulk-actions {
      display: inline-flex;
      gap: 8px;
      margin-left: auto;
    }
    .gbox-bulk-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 6px;
      border: 1px solid var(--god-border, rgba(255,255,255,0.1));
      background: var(--god-bg, #0f172a);
      color: var(--god-text, #f3f4f6);
      cursor: pointer;
      font-family: inherit;
      transition: transform 0.1s ease, background 0.1s ease;
    }
    .gbox-bulk-btn:hover:not(:disabled) {
      background: var(--god-border-light, rgba(255,255,255,0.06));
      transform: translateY(-1px);
    }
    .gbox-bulk-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .gbox-bulk-btn-primary {
      background: var(--god-accent, #3b82f6);
      color: #ffffff;
      border-color: transparent;
    }
    .gbox-bulk-btn-primary:hover:not(:disabled) {
      background: var(--god-accent, #3b82f6);
      filter: brightness(1.1);
    }
    .gbox-bulk-btn-danger {
      background: var(--god-danger, #ef4444);
      color: #ffffff;
      border-color: transparent;
    }
    .gbox-bulk-btn-danger:hover:not(:disabled) {
      background: var(--god-danger, #ef4444);
      filter: brightness(1.1);
    }
    .gbox-bulk-btn:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }
    .gbox-bulk-btn-icon {
      display: inline-flex;
      width: 14px;
      height: 14px;
    }
  `
}
