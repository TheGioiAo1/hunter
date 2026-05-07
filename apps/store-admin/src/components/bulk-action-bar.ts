/**
 * bulk-action-bar.ts
 * Sticky bottom bar for bulk operations — JS-light, no framework.
 * Visibility driven by inline vanilla script reacting to checkbox changes.
 * Destructive actions show a confirm() dialog before submit.
 */

import { esc } from '../layouts/seller-layout.js'

export interface BulkAction {
  /** Form value — caller phải esc */
  value: string
  /** Button label — caller phải esc */
  label: string
  destructive?: boolean
}

export interface BulkActionBarOptions {
  /** Form POST action URL — caller phải esc */
  formAction: string
  /** CSRF token value — caller phải esc */
  csrfToken: string
  actions: BulkAction[]
}

/**
 * Returns HTML for a sticky bulk-action bar + an inline script that:
 *  - Counts checked `.gx-row-cb` checkboxes and updates the count label.
 *  - Shows/hides the bar based on selection count.
 *  - Wires the #gx-select-all checkbox to toggle all rows.
 *  - Asks for confirmation before submitting destructive actions.
 *
 * @param opts.formAction — caller phải esc
 * @param opts.csrfToken  — caller phải esc
 */
export function bulkActionBar(opts: BulkActionBarOptions): string {
  const { formAction, csrfToken, actions } = opts

  const buttonsHtml = actions
    .map((a) => {
      const destructiveAttr = a.destructive ? ' data-destructive="true"' : ''
      const cls = `gx-bulk-bar__btn${a.destructive ? ' gx-bulk-bar__btn--destructive' : ''}`
      return `<button
        type="submit"
        class="${cls}"
        name="_action"
        value="${esc(a.value)}"${destructiveAttr}
        aria-label="${esc(a.label)}"
      >${esc(a.label)}</button>`
    })
    .join('\n      ')

  return `<form
  id="gx-bulk-form"
  method="post"
  action="${esc(formAction)}"
>
  <input type="hidden" name="_csrf" value="${esc(csrfToken)}">

  <!-- Hidden inputs for selected IDs are injected by the script below -->
  <div id="gx-bulk-bar" class="gx-bulk-bar" role="toolbar" aria-label="Bulk actions" aria-live="polite">
    <span class="gx-bulk-bar__count">
      <span id="gx-bulk-count">0</span> selected
    </span>
    ${buttonsHtml}
    <button
      type="button"
      class="gx-bulk-bar__btn"
      id="gx-bulk-clear"
      aria-label="Clear selection"
    >Clear</button>
  </div>
</form>

<script>(function(){
  var bar = document.getElementById('gx-bulk-bar');
  var countEl = document.getElementById('gx-bulk-count');
  var form = document.getElementById('gx-bulk-form');
  var selectAll = document.getElementById('gx-select-all');

  function getBoxes() {
    return Array.prototype.slice.call(document.querySelectorAll('.gx-row-cb'));
  }

  function updateBar() {
    var checked = getBoxes().filter(function(cb){ return cb.checked; });
    var n = checked.length;
    if (countEl) countEl.textContent = String(n);
    if (bar) {
      if (n > 0) bar.classList.add('gx-bulk-bar--visible');
      else bar.classList.remove('gx-bulk-bar--visible');
    }
    // Sync select-all indeterminate state
    if (selectAll) {
      var all = getBoxes();
      selectAll.checked = all.length > 0 && checked.length === all.length;
      selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
    }
  }

  document.addEventListener('change', function(e) {
    var t = e.target;
    if (!t) return;
    if (t.id === 'gx-select-all') {
      getBoxes().forEach(function(cb){ cb.checked = t.checked; });
    }
    updateBar();
  });

  document.getElementById('gx-bulk-clear') && document.getElementById('gx-bulk-clear').addEventListener('click', function(){
    getBoxes().forEach(function(cb){ cb.checked = false; });
    if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
    updateBar();
  });

  if (form) {
    form.addEventListener('submit', function(e) {
      var btn = document.activeElement;
      if (btn && btn.getAttribute('data-destructive') === 'true') {
        var n = getBoxes().filter(function(cb){ return cb.checked; }).length;
        if (!confirm('This will affect ' + n + ' item(s). Are you sure?')) {
          e.preventDefault();
          return;
        }
      }
      // Inject hidden inputs for checked IDs
      var existing = form.querySelectorAll('input[data-bulk-id]');
      Array.prototype.slice.call(existing).forEach(function(el){ el.remove(); });
      getBoxes().filter(function(cb){ return cb.checked; }).forEach(function(cb){
        var inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = 'ids[]';
        inp.value = cb.value;
        inp.setAttribute('data-bulk-id', '1');
        form.appendChild(inp);
      });
    });
  }

  updateBar();
})();</script>`
}
