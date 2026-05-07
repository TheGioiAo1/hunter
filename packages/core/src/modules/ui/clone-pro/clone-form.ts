/**
 * CloneForm — the "start a new clone" form. Two variants:
 *   - `landing`: hero form on the accounts onboarding page
 *     (`/accounts/clone-new-store`). Wide layout, large CTA.
 *   - `modal`: compact form for the store-admin "New clone"
 *     dialog launched from the index page.
 *
 * Smart defaults (Q5 "inline B"): Alt-text + SEO toggles are on by
 * default; the CTA label shows the live CostEstimate ($0.65 default,
 * "Free" when both are off). The "More options" <details> hides
 * slug / max_pages / depth / concurrency / publish_mode so the
 * form stays on two visible rows for new users.
 *
 * Exports `cloneFormRuntimeScriptBody()` — hooks change listeners
 * on both toggles and rewrites the `data-cost-cents` hook (from
 * the CostEstimate render) without a round-trip.
 */

import { renderCostEstimate } from './cost-estimate.js'
import { esc } from './esc.js'

export type CloneFormVariant = 'landing' | 'modal'

export interface CloneFormDefaults {
  sourceUrl?: string
  altText?: boolean
  seo?: boolean
  slug?: string
  maxPages?: number
  depth?: number
  concurrency?: number
  publishMode?: 'draft' | 'publish'
}

export interface CloneFormProps {
  variant: CloneFormVariant
  action: string
  csrfToken: string
  defaults?: CloneFormDefaults
  /** When true, the submit button renders with disabled + aria-disabled="true". */
  disabled?: boolean
}

export function renderCloneForm(p: CloneFormProps): string {
  const d = p.defaults ?? {}
  const altText = d.altText ?? true
  const seo = d.seo ?? true
  const variantClass =
    p.variant === 'landing' ? 'gbx-clone-form-landing' : 'gbx-clone-form-modal'
  const cost = renderCostEstimate({ altText, seo })
  const btnDisabledAttr = p.disabled ? ' disabled aria-disabled="true"' : ''
  return `
<form method="post" action="${esc(p.action)}" class="gbx-clone-form ${variantClass}"
      data-base-action="${esc(p.action)}">
  <input type="hidden" name="_csrf" value="${esc(p.csrfToken)}">
  <div class="gbx-clone-row">
    <label class="gbx-clone-field">
      <span class="gbx-clone-lbl">Store URL to clone</span>
      <input type="url" name="source_url" placeholder="https://shop.example.com"
             value="${esc(d.sourceUrl ?? '')}" required autocomplete="off">
    </label>
  </div>
  <div class="gbx-clone-toggles">
    <label class="gbx-clone-toggle">
      <input type="checkbox" name="alt_text" value="1"${altText ? ' checked' : ''}>
      <span>Rewrite alt-text with AI <em>(+$0.40)</em></span>
    </label>
    <label class="gbx-clone-toggle">
      <input type="checkbox" name="seo" value="1"${seo ? ' checked' : ''}>
      <span>Rewrite SEO titles & meta <em>(+$0.25)</em></span>
    </label>
  </div>
  <details class="gbx-clone-advanced">
    <summary>More options</summary>
    <div class="gbx-clone-grid">
      <label class="gbx-clone-field">
        <span class="gbx-clone-lbl">Store slug</span>
        <input type="text" name="slug" value="${esc(d.slug ?? '')}" placeholder="auto from URL">
      </label>
      <label class="gbx-clone-field">
        <span class="gbx-clone-lbl">Max pages</span>
        <input type="number" name="max_pages" min="1" max="500" value="${d.maxPages ?? 50}">
      </label>
      <label class="gbx-clone-field">
        <span class="gbx-clone-lbl">Crawl depth</span>
        <input type="number" name="depth" min="1" max="10" value="${d.depth ?? 3}">
      </label>
      <label class="gbx-clone-field">
        <span class="gbx-clone-lbl">Concurrency</span>
        <input type="number" name="concurrency" min="1" max="20" value="${d.concurrency ?? 5}">
      </label>
      <label class="gbx-clone-field">
        <span class="gbx-clone-lbl">Publish mode</span>
        <select name="publish_mode">
          <option value="draft"${d.publishMode !== 'publish' ? ' selected' : ''}>Save as draft</option>
          <option value="publish"${d.publishMode === 'publish' ? ' selected' : ''}>Publish immediately</option>
        </select>
      </label>
    </div>
  </details>
  <div class="gbx-clone-cta">
    <button type="submit" class="gbx-btn-accent"${btnDisabledAttr}>
      Clone store · <span class="gbx-clone-cost">${cost}</span>
    </button>
  </div>
</form>
${renderDuplicateDomainModal()}`
}

/**
 * Hidden-by-default modal that surfaces when the server returns a
 * Phase-6 `duplicate_domain` 409 from the start endpoint. The modal
 * lists every active clone job for the seller's shop on that domain
 * and exposes two actions:
 *
 *   - View existing — a plain link to the newest conflicting job's
 *     detail page.
 *   - Clone again (Replace) — resubmits the SAME form but with the
 *     server's provided `replace_url` (which sets ?replace=1). The
 *     server then soft-deletes the conflicting jobs and proceeds.
 *
 * Rendered once per form instance, populated from the 409 payload by
 * the runtime script (`cloneFormRuntimeScriptBody`). Keeping the
 * modal markup adjacent to the form (instead of a page-level portal)
 * means the landing + modal variants both get the same behaviour
 * without any plumbing in the pages that render the form.
 */
function renderDuplicateDomainModal(): string {
  return `
<div class="gbx-dupe-modal" data-dupe-modal hidden role="dialog"
     aria-labelledby="gbxDupeTitle" aria-modal="true">
  <div class="gbx-dupe-card">
    <h2 class="gbx-dupe-title" id="gbxDupeTitle">
      You already have a clone for this store
    </h2>
    <p class="gbx-dupe-sub" data-dupe-sub>
      Your shop already has an active clone for this domain. Pick one:
    </p>
    <ul class="gbx-dupe-list" data-dupe-list></ul>
    <div class="gbx-dupe-actions">
      <button type="button" class="gbx-btn-outline" data-dupe-cancel>Cancel</button>
      <a class="gbx-btn-secondary" data-dupe-view href="#">View existing</a>
      <button type="button" class="gbx-btn-danger" data-dupe-replace>
        Clone again (replace)
      </button>
    </div>
  </div>
</div>`
}

export function cloneFormRuntimeScriptBody(): string {
  return `
(function(){
  var form = document.querySelector('.gbx-clone-form');
  if (!form) return;
  var altEl = form.querySelector('input[name="alt_text"]');
  var seoEl = form.querySelector('input[name="seo"]');
  var costEl = form.querySelector('.gbx-cost');
  if (altEl && seoEl && costEl) {
    function recompute(){
      var alt = altEl.checked ? 40 : 0;
      var seo = seoEl.checked ? 25 : 0;
      var total = alt + seo;
      costEl.setAttribute('data-cost-cents', String(total));
      costEl.textContent = total === 0 ? 'Free' : '$' + (total/100).toFixed(2);
    }
    altEl.addEventListener('change', recompute);
    seoEl.addEventListener('change', recompute);
  }

  /* ---------------------------------------------------------------
   * Phase 6 — duplicate_domain 409 handler.
   *
   * Intercept the form submit so we can surface the "Replace vs
   * View" modal when the server refuses the new clone. Native form
   * submits would render the JSON body as text; that's the old UX
   * we're replacing. We always send a classic form-encoded POST
   * (so CSRF + existing server code Just Works), then parse the
   * response and branch on the status.
   *
   * Any non-409 response (including the happy path 302 to the
   * detail page) is handled by doing a real page navigation so the
   * server's redirect / validation errors surface normally.
   * ------------------------------------------------------------- */
  var modal = form.parentElement && form.parentElement.querySelector('[data-dupe-modal]');
  if (!modal) return;
  var modalList = modal.querySelector('[data-dupe-list]');
  var modalSub = modal.querySelector('[data-dupe-sub]');
  var modalView = modal.querySelector('[data-dupe-view]');
  var modalReplace = modal.querySelector('[data-dupe-replace]');
  var modalCancel = modal.querySelector('[data-dupe-cancel]');
  var baseAction = form.getAttribute('data-base-action') || form.action;
  var pendingReplaceUrl = '';

  function escHtml(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function fmtStatus(s){
    if (s === 'queued' || s === 'running' || s === 'paused') return 'In progress';
    if (s === 'succeeded') return 'Succeeded';
    if (s === 'failed') return 'Failed';
    if (s === 'cancelled') return 'Cancelled';
    return String(s || 'Unknown');
  }
  function openModal(payload){
    modalList.innerHTML = '';
    var jobs = (payload && payload.existing_jobs) || [];
    if (modalSub) {
      modalSub.textContent =
        'Your shop already has ' + jobs.length + ' active clone' +
        (jobs.length === 1 ? '' : 's') + ' for ' +
        (payload.domain || 'this domain') + '. Pick one:';
    }
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      var li = document.createElement('li');
      li.className = 'gbx-dupe-row';
      li.innerHTML =
        '<span class="gbx-dupe-row-status">' + escHtml(fmtStatus(j.status)) + '</span>' +
        '<a class="gbx-dupe-row-link" href="' + escHtml(j.detail_url || '#') + '">' +
          escHtml(j.source_url || j.id || '') + '</a>' +
        '<span class="gbx-dupe-row-meta">' + escHtml(j.created_at || '') + '</span>';
      modalList.appendChild(li);
    }
    if (modalView) {
      modalView.setAttribute('href',
        (jobs[0] && jobs[0].detail_url) || payload.detail_url || '#');
    }
    pendingReplaceUrl = String(payload.replace_url || '');
    modal.hidden = false;
    modal.classList.add('open');
    document.body.classList.add('gbx-dupe-lock');
  }
  function closeModal(){
    modal.hidden = true;
    modal.classList.remove('open');
    document.body.classList.remove('gbx-dupe-lock');
    pendingReplaceUrl = '';
  }
  modalCancel && modalCancel.addEventListener('click', closeModal);
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });
  modalReplace && modalReplace.addEventListener('click', function(){
    if (!pendingReplaceUrl) return;
    /* Point the form at the server-provided replace endpoint and
       let the browser submit it normally. This preserves the user's
       form values (URL + toggles + advanced options) because we
       never rebuilt them client-side. */
    form.setAttribute('action', pendingReplaceUrl);
    closeModal();
    form.submit();
  });

  form.addEventListener('submit', function(e){
    /* Only AJAX-handle the happy path to catch 409s. We still want
       classic submit behaviour after the user clicks Replace (the
       click handler above re-sets action + calls form.submit() which
       does NOT refire this listener). */
    if (form.getAttribute('action') !== baseAction) return;
    e.preventDefault();
    var fd = new FormData(form);
    fetch(baseAction, {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' },
    }).then(function(r){
      if (r.status === 409) {
        return r.json().then(function(body){
          if (body && body.error === 'duplicate_domain') {
            openModal(body);
          } else {
            /* Unknown 409 shape — fall back to native submit so the
               server can render its preferred error view. */
            form.submit();
          }
        });
      }
      if (r.redirected) { window.location.href = r.url; return; }
      if (r.ok) { window.location.reload(); return; }
      /* Non-409, non-OK (e.g. 400 validation) — surface the server
         body in-place. Native submit replays the same POST so the
         server can render its validation UI. */
      form.submit();
    }).catch(function(){
      /* Network error — fall back to native submit. */
      form.submit();
    });
  });
})();`
}

export const cloneFormCss = `
.gbx-clone-form { background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:20px;color:var(--text) }
.gbx-clone-form-landing { padding:28px 32px }
.gbx-clone-form-modal { padding:16px }
.gbx-clone-row { margin-bottom:12px }
.gbx-clone-field { display:flex;flex-direction:column;gap:4px }
.gbx-clone-lbl { color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em }
.gbx-clone-form input[type="url"],.gbx-clone-form input[type="text"],.gbx-clone-form input[type="number"],.gbx-clone-form select { background:var(--surface-0);border:1px solid var(--border);border-radius:6px;padding:10px 12px;color:var(--text);font-size:13px }
.gbx-clone-toggles { display:flex;flex-direction:column;gap:8px;margin:12px 0 }
.gbx-clone-toggle { display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text) }
.gbx-clone-toggle em { color:var(--text-muted);font-style:normal;font-size:11px }
.gbx-clone-advanced { margin:8px 0 16px;color:var(--text-muted);font-size:12px }
.gbx-clone-advanced summary { cursor:pointer;padding:6px 0 }
.gbx-clone-grid { display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:8px }
.gbx-clone-cta { display:flex;justify-content:flex-end;margin-top:8px }
.gbx-btn-accent { background:var(--clone-accent-gradient);color:#fff;border:none;border-radius:8px;padding:12px 18px;font-weight:700;cursor:pointer;font-size:14px }
.gbx-btn-accent:hover { transform:translateY(-1px) }
.gbx-clone-cost { font-weight:700 }

/* ------------------------------------------------------------------
 * Phase 6 -- duplicate_domain modal.
 *
 * Shown via the runtime script when the server returns a 409 for
 * "you already cloned this domain". Hidden by default via the
 * [hidden] HTML attribute; the .open class adds the overlay styling.
 * Uses the same surface/border tokens as the rest of clone-pro so it
 * themes cleanly under the seller layout.
 * ---------------------------------------------------------------- */
.gbx-dupe-modal[hidden] { display:none }
.gbx-dupe-modal { position:fixed; inset:0; z-index:110; display:flex; align-items:center; justify-content:center; background:rgba(10,12,16,.55); animation:gbxDupeIn .14s ease-out }
.gbx-dupe-modal.open { }
@keyframes gbxDupeIn { from { opacity:0 } to { opacity:1 } }
.gbx-dupe-card { width:min(520px, calc(100vw - 32px)); background:var(--surface-1, #fff); color:var(--text, #111); border:1px solid var(--border, #e5e7eb); border-radius:12px; padding:20px 20px 16px; box-shadow:0 18px 48px rgba(0,0,0,.28) }
.gbx-dupe-title { margin:0 0 8px; font-size:17px; font-weight:700; letter-spacing:-.01em }
.gbx-dupe-sub { margin:0 0 14px; font-size:13px; color:var(--text-muted, #6b7280); line-height:1.5 }
.gbx-dupe-list { list-style:none; margin:0 0 16px; padding:0; max-height:180px; overflow-y:auto; border:1px solid var(--border, #e5e7eb); border-radius:8px; background:var(--surface-0, #fafafa) }
.gbx-dupe-row { display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:10px; padding:8px 12px; border-bottom:1px solid var(--border, #eee); font-size:12px }
.gbx-dupe-row:last-child { border-bottom:none }
.gbx-dupe-row-status { padding:2px 8px; border-radius:999px; font-weight:600; font-size:11px; color:var(--s-accent, #4f46e5); background:color-mix(in srgb, var(--s-accent, #6366f1) 12%, transparent) }
.gbx-dupe-row-link { color:var(--text, #111); text-decoration:none; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.gbx-dupe-row-link:hover { text-decoration:underline }
.gbx-dupe-row-meta { color:var(--text-muted, #6b7280); font-size:11px; white-space:nowrap }
.gbx-dupe-actions { display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap }
.gbx-btn-outline, .gbx-btn-secondary, .gbx-btn-danger { display:inline-flex; align-items:center; justify-content:center; padding:8px 14px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; text-decoration:none; border:1px solid transparent; line-height:1 }
.gbx-btn-outline { background:transparent; color:var(--text, #111); border-color:var(--border, #e5e7eb) }
.gbx-btn-outline:hover { background:var(--surface-0, #f3f4f6) }
.gbx-btn-secondary { background:var(--surface-0, #f3f4f6); color:var(--text, #111); border-color:var(--border, #e5e7eb) }
.gbx-btn-secondary:hover { background:var(--surface-1, #e5e7eb) }
.gbx-btn-danger { background:#dc2626; color:#fff; border-color:#dc2626 }
.gbx-btn-danger:hover { filter:brightness(.95) }
body.gbx-dupe-lock { overflow:hidden }
`
