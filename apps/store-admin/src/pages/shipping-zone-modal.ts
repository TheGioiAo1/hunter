/**
 * Shipping Zone modal — popup chọn region từ Markets có sẵn.
 *
 * Data flow:
 *   handler `getShippingSettingsPage` → listShippings() → shippingsToZoneMarkets()
 *   → render modal với 1 row mỗi market. Bao nhiêu market trong shop thì
 *   modal có bấy nhiêu shipping zone để chọn.
 *
 * Output 3 mảnh: <style>, modal HTML, <script>. Theme dùng các token Gbox
 * (`--s-*`) để đồng nhất light/dark.
 *
 * 2 hidden input do caller render (modal sẽ ghi vào):
 *   - #shipping-zone-country-codes  (comma-joined ISO alpha-2)
 *   - #shipping-zone-name           (zone name nhập trong modal)
 *
 * Sau Done dispatch CustomEvent 'shipping-zone:applied' với detail
 * { codes, name }.
 */

import type { ApiShipping } from '../lib/shipping-api-types.js'
import { COUNTRY_FLAG, COUNTRY_NAME, EU_COUNTRY_CODES, flagOf, nameOf } from '../lib/country-data.js'
import { esc } from '../layouts/seller-layout.js'

export interface ZoneMarket {
  id: string
  name: string
  flagEmoji: string
  countries: { code: string; name: string }[]
}

export function shippingsToZoneMarkets(shippings: ApiShipping[]): ZoneMarket[] {
  return shippings.map(s => {
    const codes = (s.country_codes ?? []).map(c => c.toUpperCase()).filter(Boolean)
    const isEu = codes.length > 5 && codes.every(c => EU_COUNTRY_CODES.has(c))
    const flag = isEu ? '🇪🇺' : (codes[0] ? COUNTRY_FLAG[codes[0]] ?? '🌐' : '🌐')
    let name = s.name?.trim() || ''
    if (!name) {
      if (isEu) name = 'European Union'
      else if (codes.length === 1) name = COUNTRY_NAME[codes[0]] ?? codes[0]
      else if (codes.length === 0) name = 'All countries'
      else name = `${COUNTRY_NAME[codes[0]] ?? codes[0]} +${codes.length - 1}`
    }
    return {
      id: s.id ?? name,
      name,
      flagEmoji: flag,
      countries: codes.map(c => ({ code: c, name: nameOf(c) })),
    }
  })
}

export function renderShippingZoneModalStyles(): string {
  return `<style>
    .czm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px}
    .czm-overlay[hidden]{display:none !important}
    [data-theme="dark"] .czm-overlay{background:rgba(0,0,0,.6)}
    .czm-dialog{width:100%;max-width:560px;max-height:calc(100vh - 48px);background:var(--s-card);border:1px solid var(--s-border);border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;color:var(--s-text)}
    .czm-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:var(--s-bg);border-bottom:1px solid var(--s-border)}
    .czm-head h2{margin:0;font-size:14px;font-weight:600;color:var(--s-text)}
    .czm-close{background:transparent;border:none;cursor:pointer;font-size:20px;line-height:1;color:var(--s-text-muted);padding:2px 8px;border-radius:6px}
    .czm-close:hover{background:var(--s-card-hover);color:var(--s-text)}
    .czm-body{padding:18px;overflow-y:auto;flex:1}
    .czm-field{margin-bottom:18px}
    .czm-label{display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:var(--s-text)}
    .czm-input{width:100%;padding:9px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none;box-sizing:border-box}
    .czm-input:focus{border-color:var(--s-accent);box-shadow:0 0 0 2px color-mix(in srgb, var(--s-accent) 25%, transparent)}
    .czm-help{margin:4px 0 0;font-size:12px;color:var(--s-text-muted)}
    .czm-section-label{font-size:13px;font-weight:600;margin:0 0 8px;color:var(--s-text)}
    .czm-search{position:relative;margin-bottom:8px}
    .czm-search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--s-text-muted);pointer-events:none}
    .czm-search .czm-input{padding-left:34px}
    .czm-tree{list-style:none;margin:0;padding:0;border:1px solid var(--s-border);border-radius:8px;overflow:hidden;max-height:320px;overflow-y:auto;background:var(--s-card)}
    .czm-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--s-border);cursor:pointer;user-select:none}
    .czm-row:last-child{border-bottom:none}
    .czm-row-group{background:var(--s-bg);font-weight:500}
    .czm-row:hover{background:var(--s-card-hover)}
    .czm-cb{margin:0;cursor:pointer;flex-shrink:0;accent-color:var(--s-accent)}
    .czm-flag-emoji{font-size:18px;line-height:1;flex-shrink:0;width:26px;text-align:center}
    .czm-name{flex:1;font-size:13px;color:var(--s-text)}
    .czm-count{font-size:12px;color:var(--s-text-muted);flex-shrink:0}
    .czm-chevron{flex-shrink:0;color:var(--s-text-muted);transition:transform .15s}
    .czm-row[data-collapsed="true"] .czm-chevron{transform:rotate(-90deg)}
    .czm-children{list-style:none;margin:0;padding:0}
    .czm-children .czm-row{padding-left:38px;background:var(--s-card)}
    .czm-children[hidden]{display:none}
    .czm-empty{padding:32px 16px;text-align:center;font-size:13px;color:var(--s-text-muted)}
    .czm-empty a{color:var(--s-accent);text-decoration:none;font-weight:500}
    .czm-empty a:hover{text-decoration:underline}
    .czm-markets-link{display:inline-block;margin-top:12px;font-size:13px;color:var(--s-accent);text-decoration:none}
    .czm-markets-link:hover{text-decoration:underline}
    .czm-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 18px;border-top:1px solid var(--s-border);background:var(--s-card)}
  </style>`
}

export function renderShippingZoneModalHtml(opts: { marketsUrl: string; markets: ZoneMarket[] }): string {
  const treeHtml = opts.markets.length === 0
    ? `<li><div class="czm-empty">
        Chưa có market nào. <a href="${opts.marketsUrl}">Thêm market</a> trước, sau đó quay lại tạo shipping zone.
      </div></li>`
    : opts.markets.map(m => {
      const total = Math.max(m.countries.length, 1)
      const children = m.countries.length === 0
        ? ''
        : m.countries.map(c => `<li class="czm-row czm-row-leaf" data-czm-name="${esc(c.name.toLowerCase())}">
            <input type="checkbox" class="czm-cb czm-cb-country" data-country="${esc(c.code)}" data-group="${esc(m.id)}">
            <span class="czm-flag-emoji">${flagOf(c.code)}</span>
            <span class="czm-name">${esc(c.name)}</span>
          </li>`).join('')
      const expandable = m.countries.length > 0
      return `<li class="czm-group" data-group="${esc(m.id)}">
        <div class="czm-row czm-row-group" ${expandable ? `data-czm-toggle="${esc(m.id)}"` : ''} data-collapsed="false">
          <input type="checkbox" class="czm-cb czm-cb-group" data-group-cb="${esc(m.id)}" onclick="event.stopPropagation()">
          <span class="czm-flag-emoji">${m.flagEmoji}</span>
          <span class="czm-name">${esc(m.name)}</span>
          <span class="czm-count" data-group-count="${esc(m.id)}">0 of ${total} ${m.countries.length === 1 ? 'country' : 'countries'}</span>
          ${expandable ? `<svg class="czm-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>` : ''}
        </div>
        ${children ? `<ul class="czm-children" data-children-of="${esc(m.id)}">${children}</ul>` : ''}
      </li>`
    }).join('')

  return `<div id="shipping-zone-modal" class="czm-overlay" hidden role="presentation">
    <div class="czm-dialog" role="dialog" aria-modal="true" aria-labelledby="czm-title">
      <header class="czm-head">
        <h2 id="czm-title">Create new shipping zone</h2>
        <button type="button" class="czm-close" data-czm-close aria-label="Close">×</button>
      </header>
      <div class="czm-body">
        <div class="czm-field">
          <label class="czm-label" for="czm-zone-name-input">Zone name</label>
          <input id="czm-zone-name-input" type="text" class="czm-input" autocomplete="off">
          <p class="czm-help">Customers won't see this</p>
        </div>
        <div class="czm-section-label">Shipping zones</div>
        <div class="czm-search">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><path d="M11 11l3 3"/></svg>
          <input id="czm-search-input" type="search" class="czm-input" placeholder="Search countries and regions to ship to" autocomplete="off">
        </div>
        <ul class="czm-tree">${treeHtml}</ul>
        <a href="${opts.marketsUrl}" class="czm-markets-link">Add more countries/regions in Markets</a>
      </div>
      <footer class="czm-foot">
        <button type="button" class="btn btn-outline" data-czm-close>Cancel</button>
        <button type="button" class="btn btn-primary" id="czm-done-btn">Done</button>
      </footer>
    </div>
  </div>`
}

export function renderShippingZoneModalScript(): string {
  return `<script>
  (function(){
    var modal = document.getElementById('shipping-zone-modal');
    if (!modal) return;
    var nameInput = document.getElementById('czm-zone-name-input');
    var searchInput = document.getElementById('czm-search-input');
    var doneBtn = document.getElementById('czm-done-btn');

    function close(){ modal.hidden = true; }
    function open(){ modal.hidden = false; setTimeout(function(){ nameInput && nameInput.focus(); }, 0); }
    window.openShippingZoneModal = open;

    modal.addEventListener('click', function(e){
      var t = e.target;
      if (t === modal) { close(); return; }
      if (t.closest && t.closest('[data-czm-close]')) { close(); return; }

      var groupRow = t.closest && t.closest('[data-czm-toggle]');
      if (groupRow && !t.matches('input[type=checkbox]')) {
        var grp = groupRow.getAttribute('data-czm-toggle');
        var children = modal.querySelector('[data-children-of="' + CSS.escape(grp) + '"]');
        var collapsed = groupRow.getAttribute('data-collapsed') === 'true';
        groupRow.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
        if (children) children.hidden = !collapsed ? true : false;
      }
    });

    modal.querySelectorAll('.czm-cb-group').forEach(function(cb){
      cb.addEventListener('change', function(){
        var grp = cb.getAttribute('data-group-cb');
        modal.querySelectorAll('.czm-cb-country[data-group="' + CSS.escape(grp) + '"]').forEach(function(child){
          child.checked = cb.checked;
        });
        updateGroupCount(grp);
      });
    });

    modal.querySelectorAll('.czm-cb-country').forEach(function(cb){
      cb.addEventListener('change', function(){
        var grp = cb.getAttribute('data-group');
        var siblings = modal.querySelectorAll('.czm-cb-country[data-group="' + CSS.escape(grp) + '"]');
        var checkedCount = 0;
        siblings.forEach(function(s){ if (s.checked) checkedCount++; });
        var groupCb = modal.querySelector('.czm-cb-group[data-group-cb="' + CSS.escape(grp) + '"]');
        if (groupCb) {
          groupCb.checked = checkedCount === siblings.length && siblings.length > 0;
          groupCb.indeterminate = checkedCount > 0 && checkedCount < siblings.length;
        }
        updateGroupCount(grp);
      });
    });

    function updateGroupCount(grp){
      var countEl = modal.querySelector('[data-group-count="' + CSS.escape(grp) + '"]');
      if (!countEl) return;
      var siblings = modal.querySelectorAll('.czm-cb-country[data-group="' + CSS.escape(grp) + '"]');
      var total = Math.max(siblings.length, 1);
      var picked = 0;
      siblings.forEach(function(s){ if (s.checked) picked++; });
      countEl.textContent = picked + ' of ' + total + ' ' + (siblings.length === 1 ? 'country' : 'countries');
    }

    if (searchInput) {
      searchInput.addEventListener('input', function(){
        var q = searchInput.value.trim().toLowerCase();
        modal.querySelectorAll('.czm-row-leaf').forEach(function(row){
          var name = row.getAttribute('data-czm-name') || '';
          row.style.display = (!q || name.indexOf(q) !== -1) ? '' : 'none';
        });
      });
    }

    doneBtn && doneBtn.addEventListener('click', function(){
      var codes = [];
      modal.querySelectorAll('.czm-cb-country:checked').forEach(function(cb){
        codes.push(cb.getAttribute('data-country'));
      });
      var hiddenCodes = document.getElementById('shipping-zone-country-codes');
      var hiddenName = document.getElementById('shipping-zone-name');
      if (hiddenCodes) hiddenCodes.value = codes.join(',');
      if (hiddenName) hiddenName.value = (nameInput && nameInput.value.trim()) || '';
      document.dispatchEvent(new CustomEvent('shipping-zone:applied', {
        detail: { codes: codes, name: (nameInput && nameInput.value.trim()) || '' }
      }));
      close();
    });
  })();
  </script>`
}
