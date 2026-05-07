/**
 * Manage Products modal — popup chọn products áp dụng cho 1 shipping profile.
 *
 * Data: fetch JSON từ endpoint sẵn có
 *   GET /admin/store/{slug}/products/collections/products-search?q={query}
 * (đã trả normalized {id, name, slug, image_url, ...}).
 *
 * Output 3 mảnh: <style>, modal HTML, <script>. Theme dùng token `--s-*`.
 *
 * Caller render 1 hidden input do modal ghi vào:
 *   - #manage-products-ids  (comma-joined product ids)
 *
 * Sau Done dispatch CustomEvent 'manage-products:applied' với detail
 * { ids, summary } để caller update label nút "X products".
 */

export function renderManageProductsModalStyles(): string {
  return `<style>
    .mpm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px}
    .mpm-overlay[hidden]{display:none !important}
    [data-theme="dark"] .mpm-overlay{background:rgba(0,0,0,.6)}
    .mpm-dialog{width:100%;max-width:660px;max-height:calc(100vh - 48px);background:var(--s-card);border:1px solid var(--s-border);border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;color:var(--s-text)}
    .mpm-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:var(--s-bg);border-bottom:1px solid var(--s-border)}
    .mpm-head h2{margin:0;font-size:14px;font-weight:600;color:var(--s-text)}
    .mpm-close{background:transparent;border:none;cursor:pointer;font-size:20px;line-height:1;color:var(--s-text-muted);padding:2px 8px;border-radius:6px}
    .mpm-close:hover{background:var(--s-card-hover);color:var(--s-text)}
    .mpm-body{padding:16px 18px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:10px}
    .mpm-toolbar{display:grid;grid-template-columns:1fr 200px;gap:10px}
    .mpm-search{position:relative}
    .mpm-search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--s-text-muted);pointer-events:none}
    .mpm-input{width:100%;padding:9px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none;box-sizing:border-box}
    .mpm-input:focus{border-color:var(--s-accent);box-shadow:0 0 0 2px color-mix(in srgb, var(--s-accent) 25%, transparent)}
    .mpm-search .mpm-input{padding-left:34px}
    .mpm-select-wrap{position:relative}
    .mpm-select-wrap svg{position:absolute;right:10px;top:50%;transform:translateY(-50%);color:var(--s-text-muted);pointer-events:none}
    .mpm-select{appearance:none;-webkit-appearance:none;width:100%;padding:9px 28px 9px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none;cursor:pointer}
    .mpm-add-filter{align-self:flex-start;font-size:12px;color:var(--s-text-muted);background:transparent;border:1px dashed var(--s-border);border-radius:999px;padding:4px 12px;cursor:pointer}
    .mpm-add-filter:hover{border-color:var(--s-accent);color:var(--s-text)}
    .mpm-table{border:1px solid var(--s-border);border-radius:8px;overflow:hidden;background:var(--s-card)}
    .mpm-table-head,.mpm-row{display:grid;grid-template-columns:36px 1fr 140px;align-items:center;gap:8px;padding:10px 12px}
    .mpm-table-head{background:var(--s-bg);border-bottom:1px solid var(--s-border);font-size:12px;font-weight:600;color:var(--s-text-muted);text-transform:none}
    .mpm-row{border-bottom:1px solid var(--s-border);font-size:13px;color:var(--s-text)}
    .mpm-row:last-child{border-bottom:none}
    .mpm-row:hover{background:var(--s-card-hover)}
    .mpm-cb{margin:0;cursor:pointer;accent-color:var(--s-accent)}
    .mpm-prod{display:flex;align-items:center;gap:10px;min-width:0}
    .mpm-thumb{width:28px;height:28px;border-radius:6px;background:var(--s-input-bg);border:1px solid var(--s-border);display:inline-flex;align-items:center;justify-content:center;color:var(--s-text-muted);overflow:hidden;flex-shrink:0}
    .mpm-thumb img{width:100%;height:100%;object-fit:cover;display:block}
    .mpm-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mpm-profile{font-size:12px;color:var(--s-text-muted);text-align:right}
    .mpm-empty{padding:32px 16px;text-align:center;font-size:13px;color:var(--s-text-muted)}
    .mpm-loading{padding:32px 16px;text-align:center;font-size:13px;color:var(--s-text-muted)}
    .mpm-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 18px;border-top:1px solid var(--s-border);background:var(--s-card)}
    .mpm-foot .btn[disabled]{opacity:.5;cursor:not-allowed}
  </style>`
}

export function renderManageProductsModalHtml(): string {
  return `<div id="manage-products-modal" class="mpm-overlay" hidden role="presentation">
    <div class="mpm-dialog" role="dialog" aria-modal="true" aria-labelledby="mpm-title">
      <header class="mpm-head">
        <h2 id="mpm-title">Manage products</h2>
        <button type="button" class="mpm-close" data-mpm-close aria-label="Close">×</button>
      </header>
      <div class="mpm-body">
        <div class="mpm-toolbar">
          <div class="mpm-search">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><path d="M11 11l3 3"/></svg>
            <input id="mpm-q" type="search" class="mpm-input" placeholder="Search products" autocomplete="off">
          </div>
          <div class="mpm-select-wrap">
            <select id="mpm-scope" class="mpm-select">
              <option value="all">Search by All</option>
              <option value="title">Title</option>
              <option value="sku">SKU</option>
              <option value="vendor">Vendor</option>
            </select>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>
          </div>
        </div>
        <button type="button" class="mpm-add-filter" id="mpm-add-filter">Add filter +</button>
        <div class="mpm-table">
          <div class="mpm-table-head">
            <div><input type="checkbox" class="mpm-cb" id="mpm-cb-all"></div>
            <div>Product</div>
            <div style="text-align:right">Profile</div>
          </div>
          <div id="mpm-list">
            <div class="mpm-loading">Loading…</div>
          </div>
        </div>
      </div>
      <footer class="mpm-foot">
        <button type="button" class="btn btn-outline" data-mpm-close>Cancel</button>
        <button type="button" class="btn btn-primary" id="mpm-done-btn" disabled>Done</button>
      </footer>
    </div>
  </div>`
}

export function renderManageProductsModalScript(opts: { searchUrl: string; profileLabel: string }): string {
  const search = JSON.stringify(opts.searchUrl)
  const profile = JSON.stringify(opts.profileLabel)
  return `<script>
  (function(){
    var modal = document.getElementById('manage-products-modal');
    if (!modal) return;
    var qInput = document.getElementById('mpm-q');
    var scopeSel = document.getElementById('mpm-scope');
    var listEl = document.getElementById('mpm-list');
    var doneBtn = document.getElementById('mpm-done-btn');
    var cbAll = document.getElementById('mpm-cb-all');
    var addFilterBtn = document.getElementById('mpm-add-filter');
    var SEARCH_URL = ${search};
    var PROFILE_LABEL = ${profile};

    var products = [];           // {id, name, image_url}
    var picked = new Set();      // ids
    var debounceTimer = null;
    var seenIds = {};            // id -> product object (preserve picked across searches)

    function close(){ modal.hidden = true; }
    function open(){
      modal.hidden = false;
      if (products.length === 0) fetchAndRender('');
      setTimeout(function(){ qInput && qInput.focus(); }, 0);
    }
    window.openManageProductsModal = open;

    modal.addEventListener('click', function(e){
      var t = e.target;
      if (t === modal) { close(); return; }
      if (t.closest && t.closest('[data-mpm-close]')) { close(); return; }
    });

    function escHtml(s){ return String(s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    }); }

    function render(){
      if (!Array.isArray(products) || products.length === 0) {
        listEl.innerHTML = '<div class="mpm-empty">Không tìm thấy sản phẩm</div>';
        cbAll.checked = false;
        cbAll.indeterminate = false;
        return;
      }
      listEl.innerHTML = products.map(function(p){
        var checked = picked.has(p.id) ? 'checked' : '';
        var thumb = p.image_url
          ? '<img src="' + escHtml(p.image_url) + '" alt="">'
          : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="7" r="1"/><path d="M2 12l4-4 4 3 4-3"/></svg>';
        return '<label class="mpm-row">' +
          '<input type="checkbox" class="mpm-cb" data-id="' + escHtml(p.id) + '" ' + checked + '>' +
          '<div class="mpm-prod"><span class="mpm-thumb">' + thumb + '</span><span class="mpm-name">' + escHtml(p.name) + '</span></div>' +
          '<div class="mpm-profile">' + escHtml(PROFILE_LABEL) + '</div>' +
        '</label>';
      }).join('');
      var visIds = products.map(function(p){ return p.id; });
      var visPicked = visIds.filter(function(id){ return picked.has(id); }).length;
      cbAll.checked = visPicked === visIds.length && visIds.length > 0;
      cbAll.indeterminate = visPicked > 0 && visPicked < visIds.length;
      updateDoneState();
    }

    function updateDoneState(){
      doneBtn.disabled = picked.size === 0 && (window.__mpmInitialPicked || 0) === 0;
    }

    listEl.addEventListener('change', function(e){
      var t = e.target;
      if (!t.matches('input.mpm-cb[data-id]')) return;
      var id = t.getAttribute('data-id');
      if (t.checked) picked.add(id); else picked.delete(id);
      var visIds = products.map(function(p){ return p.id; });
      var visPicked = visIds.filter(function(x){ return picked.has(x); }).length;
      cbAll.checked = visPicked === visIds.length && visIds.length > 0;
      cbAll.indeterminate = visPicked > 0 && visPicked < visIds.length;
      doneBtn.disabled = false;
    });

    cbAll.addEventListener('change', function(){
      products.forEach(function(p){
        if (cbAll.checked) picked.add(p.id); else picked.delete(p.id);
      });
      render();
      doneBtn.disabled = false;
    });

    function fetchAndRender(q){
      listEl.innerHTML = '<div class="mpm-loading">Loading…</div>';
      var url = SEARCH_URL + (q ? ('?q=' + encodeURIComponent(q)) : '');
      fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function(data){
          var raw = Array.isArray(data) ? data : (data && data.products) || [];
          products = raw.map(function(p){
            seenIds[p.id] = { id: p.id, name: p.name, image_url: p.image_url || '' };
            return seenIds[p.id];
          });
          render();
        })
        .catch(function(err){
          listEl.innerHTML = '<div class="mpm-empty">Lỗi tải danh sách: ' + escHtml(err.message || 'unknown') + '</div>';
        });
    }

    if (qInput) {
      qInput.addEventListener('input', function(){
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function(){ fetchAndRender(qInput.value.trim()); }, 250);
      });
    }
    if (addFilterBtn) addFilterBtn.addEventListener('click', function(){ qInput && qInput.focus(); });

    doneBtn.addEventListener('click', function(){
      var ids = Array.from(picked);
      var hidden = document.getElementById('manage-products-ids');
      if (hidden) hidden.value = ids.join(',');
      var summary = ids.length === 0 ? '0 products' : ids.length + ' product' + (ids.length === 1 ? '' : 's');
      document.dispatchEvent(new CustomEvent('manage-products:applied', { detail: { ids: ids, summary: summary } }));
      close();
    });
  })();
  </script>`
}
