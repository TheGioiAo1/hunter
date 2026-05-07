/**
 * purchase-order-product-picker.ts
 * Component: inline autocomplete + modal picker cho Purchase Order form.
 * Self-contained CSS + JS, gắn vào trang qua productPickerAssets().
 *
 * Hooks (đặt sẵn trong page):
 *   - input.po-search-input        autocomplete trigger
 *   - .po-search-results           dropdown panel (rỗng, JS render)
 *   - button.po-browse-btn         mở modal
 *   - .po-selected-products        list các product đã chọn (JS render)
 *
 * Data: fetch JSON từ {searchUrl}?q=&limit=
 */

export interface PickerAssetsOptions {
  /** URL JSON endpoint trả {products:[]} — e.g. `${self}/products-search` */
  searchUrl: string
  /**
   * - 'product' (default): autocomplete click product → add tất cả variants;
   *   modal có product-level checkbox toggle-all.
   * - 'variant-only': autocomplete click product → expand variants trong dropdown
   *   để user pick từng variant; modal không có product-level checkbox.
   */
  mode?: 'product' | 'variant-only'
}

export function productPickerAssets(opts: PickerAssetsOptions): string {
  const styles = `<style>
    .po-search{position:relative}
    .po-search-results{position:absolute;left:0;right:0;top:calc(100% + 4px);background:var(--gx-card,#1a1d24);border:1px solid var(--gx-border,rgba(255,255,255,.12));border-radius:8px;max-height:320px;overflow-y:auto;z-index:50;display:none;box-shadow:0 8px 24px rgba(0,0,0,.4)}
    .po-search-results.open{display:block}
    .po-search-item{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--gx-border,rgba(255,255,255,.05));transition:.1s}
    .po-search-item:last-child{border-bottom:0}
    .po-search-item:hover{background:rgba(91,109,255,.08)}
    .po-search-item-img{width:34px;height:34px;border-radius:6px;object-fit:cover;background:rgba(255,255,255,.04);flex-shrink:0;border:1px solid var(--gx-border,rgba(255,255,255,.06))}
    .po-search-item-img-empty{width:34px;height:34px;border-radius:6px;display:grid;place-items:center;background:rgba(91,109,255,.06);color:rgba(91,109,255,.5);flex-shrink:0;font-size:14px}
    .po-search-item-name{font-size:13.5px;color:var(--gx-text,#e8eaf0);font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .po-search-item-meta{font-size:11.5px;color:var(--gx-muted,#7a8089)}
    .po-search-empty,.po-search-loading{padding:14px;text-align:center;font-size:12.5px;color:var(--gx-muted,#7a8089)}

    .po-selected-products{margin-top:14px;display:flex;flex-direction:column;gap:8px}
    .po-selected-products:empty + .po-empty-products{display:block}
    .po-selected-products:not(:empty) + .po-empty-products{display:none}
    .po-selected-row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--gx-bg,#13161c);border:1px solid var(--gx-border,rgba(255,255,255,.08));border-radius:8px}
    .po-selected-img{width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0;background:rgba(255,255,255,.04);border:1px solid var(--gx-border,rgba(255,255,255,.06))}
    .po-selected-img-empty{width:40px;height:40px;border-radius:6px;display:grid;place-items:center;background:rgba(91,109,255,.06);color:rgba(91,109,255,.5);flex-shrink:0;font-size:16px}
    .po-selected-info{flex:1;min-width:0}
    .po-selected-name{font-size:13.5px;font-weight:500;color:var(--gx-text,#e8eaf0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .po-selected-sub{font-size:11.5px;color:var(--gx-muted,#7a8089);margin-top:2px}
    .po-qty-input{width:80px;padding:6px 8px;border:1px solid var(--gx-border,rgba(255,255,255,.12));border-radius:6px;background:var(--gx-card,#1a1d24);color:var(--gx-text);font-size:13px;text-align:right;font-variant-numeric:tabular-nums}
    .po-remove-btn{padding:5px 9px;border:1px solid rgba(239,68,68,.25);background:transparent;color:#fca5a5;border-radius:6px;cursor:pointer;font-size:12px}
    .po-remove-btn:hover{background:rgba(239,68,68,.12);border-color:#ef4444}

    .po-pp-dialog{border:0;border-radius:14px;padding:0;background:var(--gx-card,#1a1d24);color:var(--gx-text,#e8eaf0);max-width:760px;width:92vw;max-height:80vh;overflow:hidden}
    .po-pp-dialog::backdrop{background:rgba(0,0,0,.55);backdrop-filter:blur(2px)}
    .po-pp-wrap{display:flex;flex-direction:column;height:80vh;max-height:80vh}
    .po-pp-header{padding:16px 22px;border-bottom:1px solid var(--gx-border,rgba(255,255,255,.08));display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
    .po-pp-title{margin:0;font-size:16px;font-weight:600}
    .po-pp-close{border:0;background:transparent;color:var(--gx-muted);font-size:22px;cursor:pointer;line-height:1;padding:4px 8px;border-radius:6px}
    .po-pp-close:hover{background:rgba(255,255,255,.06);color:var(--gx-text)}
    .po-pp-toolbar{padding:14px 22px;display:flex;gap:10px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid var(--gx-border,rgba(255,255,255,.08))}
    .po-pp-search{position:relative;flex:1;min-width:240px}
    .po-pp-search input{width:100%;padding:9px 12px 9px 36px;background:var(--gx-bg,#13161c);border:1px solid var(--gx-border,rgba(255,255,255,.1));border-radius:8px;color:var(--gx-text);font-size:13.5px;box-sizing:border-box;outline:none}
    .po-pp-search input:focus{border-color:#5b6dff;box-shadow:0 0 0 3px rgba(91,109,255,.15)}
    .po-pp-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--gx-muted,#7a8089)}
    .po-pp-filter{padding:9px 14px;background:var(--gx-bg,#13161c);border:1px solid var(--gx-border,rgba(255,255,255,.1));border-radius:8px;color:var(--gx-text);font-size:13.5px;cursor:pointer}
    .po-pp-table-wrap{flex:1;overflow-y:auto}
    .po-pp-table{width:100%;border-collapse:collapse;font-size:13.5px}
    .po-pp-table thead{position:sticky;top:0;background:var(--gx-card,#1a1d24);z-index:1}
    .po-pp-table thead th{text-align:left;padding:10px 16px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--gx-muted);font-weight:600;border-bottom:1px solid var(--gx-border,rgba(255,255,255,.08))}
    .po-pp-table tbody tr{border-bottom:1px solid var(--gx-border,rgba(255,255,255,.04));cursor:pointer;transition:.1s}
    .po-pp-table tbody tr:hover{background:rgba(91,109,255,.04)}
    .po-pp-table tbody tr.selected{background:rgba(91,109,255,.08)}
    .po-pp-table td{padding:10px 16px;vertical-align:middle}
    .po-pp-cb{width:16px;height:16px;cursor:pointer;accent-color:#5b6dff}
    .po-pp-thumb{width:36px;height:36px;border-radius:6px;object-fit:cover;background:rgba(255,255,255,.04);border:1px solid var(--gx-border,rgba(255,255,255,.06))}
    .po-pp-thumb-empty{width:36px;height:36px;border-radius:6px;display:grid;place-items:center;background:rgba(91,109,255,.06);color:rgba(91,109,255,.5);font-size:14px}
    .po-pp-product-name{font-weight:500;color:var(--gx-text)}
    .po-pp-num{text-align:right;font-variant-numeric:tabular-nums}
    .po-pp-empty,.po-pp-loading{padding:42px 20px;text-align:center;color:var(--gx-muted);font-size:13.5px}
    .po-pp-footer{padding:12px 22px;border-top:1px solid var(--gx-border,rgba(255,255,255,.08));display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
    .po-pp-count{font-size:12.5px;color:var(--gx-muted);background:rgba(255,255,255,.04);padding:5px 12px;border-radius:14px}
    .po-pp-actions{display:flex;gap:8px}
    .po-pp-btn-cancel{padding:8px 16px;border:1px solid var(--gx-border,rgba(255,255,255,.12));border-radius:7px;background:transparent;color:var(--gx-text);cursor:pointer;font-size:13px}
    .po-pp-btn-add{padding:8px 18px;border:0;border-radius:7px;background:linear-gradient(180deg,#5b6dff,#4854e0);color:#fff;cursor:pointer;font-size:13px;font-weight:600}
    .po-pp-btn-add:disabled{opacity:.4;cursor:not-allowed}
    .po-pp-chevron{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;color:var(--gx-muted);transition:.15s;flex-shrink:0;cursor:pointer}
    .po-pp-chevron:hover{background:rgba(255,255,255,.06);color:var(--gx-text)}
    .po-pp-chevron.expanded{transform:rotate(90deg);color:var(--gx-text)}
    .po-pp-variant-row{background:rgba(255,255,255,.015)}
    .po-pp-variant-row td{padding:8px 16px;font-size:12.5px}
    .po-pp-variant-row td.po-pp-variant-cell{padding-left:48px;color:var(--gx-muted)}
    .po-pp-variant-name{color:var(--gx-text)}
    .po-pp-variant-sku{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--gx-muted);margin-top:2px}
    .po-pp-cb-indeterminate::before{content:"−";display:inline-block;color:#5b6dff;font-weight:700}
  </style>`

  const dialogHtml = `
  <dialog class="po-pp-dialog" id="po-pp-dialog" aria-labelledby="po-pp-title">
    <div class="po-pp-wrap">
      <div class="po-pp-header">
        <h2 class="po-pp-title" id="po-pp-title">Add products</h2>
        <button type="button" class="po-pp-close" aria-label="Close" onclick="document.getElementById('po-pp-dialog').close()">×</button>
      </div>
      <div class="po-pp-toolbar">
        <div class="po-pp-search">
          <svg class="po-pp-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
          <input type="search" id="po-pp-search-input" placeholder="Search products" autocomplete="off">
        </div>
        <button type="button" class="po-pp-filter" aria-label="Search by All">Search by All ▾</button>
      </div>
      <div class="po-pp-table-wrap" id="po-pp-table-wrap">
        <div class="po-pp-loading">Loading…</div>
      </div>
      <div class="po-pp-footer">
        <span class="po-pp-count" id="po-pp-count">0 variants selected</span>
        <div class="po-pp-actions">
          <button type="button" class="po-pp-btn-cancel" onclick="document.getElementById('po-pp-dialog').close()">Cancel</button>
          <button type="button" class="po-pp-btn-add" id="po-pp-btn-add" disabled>Add</button>
        </div>
      </div>
    </div>
  </dialog>`

  // Single self-IIFE; state trong closure. Selection ở variant level — key
  // = "productId|variantSlug" để identify variant duy nhất.
  const mode = opts.mode === 'variant-only' ? 'variant-only' : 'product'
  const script = `<script>(function(){
    var SEARCH_URL = ${JSON.stringify(opts.searchUrl)};
    var MODE = ${JSON.stringify(mode)};
    var DEBOUNCE_MS = 300;
    // selected/modalSelected: Map<key, {key, productId, productName, productImage,
    //   variantId, variantSlug, variantName, sku, price, inventory, qty}>
    var selected = new Map();
    var modalSelected = new Map();
    var modalProducts = [];
    var expanded = new Set(); // productId in modal đang expand

    function esc(s){var d=document.createElement('div');d.textContent=String(s||'');return d.innerHTML}
    function fetchJson(url){
      return fetch(url, {credentials:'same-origin', headers:{'accept':'application/json'}})
        .then(function(r){return r.ok ? r.json() : Promise.reject(new Error('HTTP '+r.status))})
    }
    function variantKey(productId, variant){ return productId + '|' + (variant.slug || variant.id || variant.name) }
    function variantToItem(p, v){
      return {
        key: variantKey(p.id, v),
        productId: p.id, productName: p.name, productImage: p.image_url,
        variantId: v.id || '', variantSlug: v.slug || '',
        variantName: v.name || 'Default', sku: v.sku || '',
        price: Number(v.price || 0), inventory: Number(v.inventory || 0),
        image_url: v.image_url || p.image_url || '',
        qty: 1,
      }
    }

    // ---------- inline autocomplete (search by product name) ----------
    var inlineInput = document.querySelector('.po-search-input')
    var inlineResults = document.querySelector('.po-search-results')
    var inlineDebounce = null

    var inlineExpanded = null // productId đang expand trong dropdown (variant-only)

    function renderInlineResults(products){
      if (!products.length) {
        inlineResults.innerHTML = '<div class="po-search-empty">No products match.</div>'
        inlineResults.classList.add('open')
        return
      }
      var html = products.slice(0, 8).map(function(p){
        var img = p.image_url
          ? '<img class="po-search-item-img" src="'+esc(p.image_url)+'" alt="" loading="lazy">'
          : '<div class="po-search-item-img-empty">📦</div>'
        var vCount = (p.variants||[]).length
        var caret = MODE === 'variant-only' && vCount > 0 ? '<span style="color:var(--gx-muted);font-size:11px;margin-left:6px">'+(inlineExpanded===p.id?'▼':'▶')+'</span>' : ''
        var row = '<div class="po-search-item" data-id="'+esc(p.id)+'">'+img+
          '<div class="po-search-item-name">'+esc(p.name)+'</div>'+
          '<div class="po-search-item-meta">'+vCount+' variant'+(vCount!==1?'s':'')+'</div>'+caret+'</div>'
        // Variant-only: nếu product này đang expand → render variants nested
        if (MODE === 'variant-only' && inlineExpanded === p.id) {
          var vrows = (p.variants||[]).map(function(v){
            var k = variantKey(p.id, v)
            var alreadyAdded = selected.has(k)
            var vimg = v.image_url
              ? '<img class="po-search-item-img" src="'+esc(v.image_url)+'" alt="" loading="lazy" style="width:28px;height:28px">'
              : '<div class="po-search-item-img-empty" style="width:28px;height:28px;font-size:12px">📦</div>'
            var meta = (v.sku?'SKU '+esc(v.sku)+' · ':'') + (v.inventory!=null?'Stock '+v.inventory:'')
            return '<div class="po-search-item po-search-variant'+(alreadyAdded?' po-already-added':'')+'" data-pid="'+esc(p.id)+'" data-vkey="'+esc(k)+'" style="padding-left:34px;background:rgba(255,255,255,.02)">'+
              vimg+
              '<div class="po-search-item-name" style="font-size:12.5px">'+esc(v.name||'Default')+'</div>'+
              '<div class="po-search-item-meta">'+meta+(alreadyAdded?' · ✓':'')+'</div></div>'
          }).join('')
          row += vrows
        }
        return row
      }).join('')
      inlineResults.innerHTML = html
      inlineResults.classList.add('open')

      // Click product row
      Array.prototype.forEach.call(inlineResults.querySelectorAll('.po-search-item:not(.po-search-variant)'), function(el){
        el.addEventListener('click', function(){
          var id = el.getAttribute('data-id')
          var p = products.find(function(x){return x.id === id})
          if (!p) return
          if (MODE === 'variant-only') {
            // Toggle expand variants inline
            inlineExpanded = (inlineExpanded === id) ? null : id
            renderInlineResults(products)
          } else {
            // 'product' mode: add tất cả variants
            if (p.variants) p.variants.forEach(function(v){
              var item = variantToItem(p, v)
              if (!selected.has(item.key)) selected.set(item.key, item)
            })
            renderSelected()
            inlineResults.classList.remove('open')
            inlineInput.value = ''
          }
        })
      })

      // Click variant row (variant-only mode)
      if (MODE === 'variant-only') {
        Array.prototype.forEach.call(inlineResults.querySelectorAll('.po-search-variant'), function(el){
          el.addEventListener('click', function(e){
            e.stopPropagation()
            var pid = el.getAttribute('data-pid')
            var vkey = el.getAttribute('data-vkey')
            var p = products.find(function(x){return x.id === pid})
            if (!p) return
            var v = (p.variants||[]).find(function(x){return variantKey(p.id, x) === vkey})
            if (!v) return
            var item = variantToItem(p, v)
            if (!selected.has(item.key)) selected.set(item.key, item)
            renderSelected()
            // Re-render dropdown để update "✓ added" state
            renderInlineResults(products)
          })
        })
      }
    }

    if (inlineInput && inlineResults) {
      inlineInput.addEventListener('input', function(){
        var q = inlineInput.value.trim()
        clearTimeout(inlineDebounce)
        if (!q) { inlineResults.classList.remove('open'); return }
        inlineResults.innerHTML = '<div class="po-search-loading">Searching…</div>'
        inlineResults.classList.add('open')
        inlineDebounce = setTimeout(function(){
          fetchJson(SEARCH_URL + '?q=' + encodeURIComponent(q) + '&limit=10')
            .then(function(d){ renderInlineResults(d.products || []) })
            .catch(function(){ inlineResults.innerHTML = '<div class="po-search-empty">Search failed.</div>' })
        }, DEBOUNCE_MS)
      })
      document.addEventListener('click', function(e){
        if (!inlineResults.contains(e.target) && e.target !== inlineInput) {
          inlineResults.classList.remove('open')
        }
      })
    }

    // ---------- selected list (variant level) ----------
    var selectedWrap = document.querySelector('.po-selected-products')

    function renderSelected(){
      if (!selectedWrap) return
      var rows = []
      selected.forEach(function(it){
        var imgHtml = it.image_url
          ? '<img class="po-selected-img" src="'+esc(it.image_url)+'" alt="">'
          : '<div class="po-selected-img-empty">📦</div>'
        var sub = (it.sku ? 'SKU '+esc(it.sku)+' • ' : '') +
                  esc(it.variantName) +
                  (it.price>0 ? ' • $'+it.price.toFixed(2) : '')
        rows.push(
          '<div class="po-selected-row" data-key="'+esc(it.key)+'">'+
            imgHtml+
            '<div class="po-selected-info">'+
              '<div class="po-selected-name">'+esc(it.productName)+'</div>'+
              '<div class="po-selected-sub">'+sub+'</div>'+
            '</div>'+
            '<input type="number" class="po-qty-input" min="1" max="999999" value="'+(it.qty||1)+'" data-qty>'+
            '<button type="button" class="po-remove-btn" data-remove>Remove</button>'+
            '<input type="hidden" name="items['+esc(it.key)+'][product_id]" value="'+esc(it.productId)+'">'+
            '<input type="hidden" name="items['+esc(it.key)+'][variant_id]" value="'+esc(it.variantId)+'">'+
            '<input type="hidden" name="items['+esc(it.key)+'][variant_slug]" value="'+esc(it.variantSlug)+'">'+
            '<input type="hidden" name="items['+esc(it.key)+'][variant_name]" value="'+esc(it.variantName)+'">'+
            '<input type="hidden" name="items['+esc(it.key)+'][sku]" value="'+esc(it.sku)+'">'+
            '<input type="hidden" name="items['+esc(it.key)+'][price]" value="'+it.price+'">'+
            '<input type="hidden" name="items['+esc(it.key)+'][qty]" value="'+(it.qty||1)+'" data-hidden-qty>'+
          '</div>'
        )
      })
      selectedWrap.innerHTML = rows.join('')
      Array.prototype.forEach.call(selectedWrap.querySelectorAll('.po-selected-row'), function(row){
        var key = row.getAttribute('data-key')
        row.querySelector('[data-remove]').addEventListener('click', function(){
          selected.delete(key); renderSelected()
        })
        var qty = row.querySelector('[data-qty]')
        var hidden = row.querySelector('[data-hidden-qty]')
        qty.addEventListener('input', function(){
          var n = Math.max(1, parseInt(qty.value, 10) || 1)
          var item = selected.get(key); if (item) item.qty = n
          hidden.value = n
        })
      })
    }

    // ---------- modal picker (product → variants expand) ----------
    var dlg = document.getElementById('po-pp-dialog')
    var browseBtn = document.querySelector('.po-browse-btn')
    var modalSearch = document.getElementById('po-pp-search-input')
    var modalTableWrap = document.getElementById('po-pp-table-wrap')
    var modalCount = document.getElementById('po-pp-count')
    var modalAddBtn = document.getElementById('po-pp-btn-add')
    var modalDebounce = null

    function thumbHtml(src){
      return src
        ? '<img class="po-pp-thumb" src="'+esc(src)+'" alt="" loading="lazy">'
        : '<div class="po-pp-thumb-empty">📦</div>'
    }

    function productSelectionState(p){
      // 'all' | 'partial' | 'none'
      var keys = (p.variants||[]).map(function(v){return variantKey(p.id, v)})
      if (!keys.length) return 'none'
      var sel = keys.filter(function(k){return modalSelected.has(k)})
      if (sel.length === 0) return 'none'
      if (sel.length === keys.length) return 'all'
      return 'partial'
    }

    function renderModalRows(products){
      if (!products.length) {
        modalTableWrap.innerHTML = '<div class="po-pp-empty">No products found.</div>'
        return
      }
      var html = '<table class="po-pp-table"><thead><tr>'+
        '<th style="width:36px"></th>'+
        '<th style="width:24px"></th>'+
        '<th style="width:50px"></th>'+
        '<th>Product</th>'+
        '<th class="po-pp-num">Available at destination</th>'+
        '<th class="po-pp-num">Available</th>'+
        '</tr></thead><tbody>'

      products.forEach(function(p){
        var state = productSelectionState(p)
        var isExpanded = expanded.has(p.id) || (MODE === 'variant-only' && (p.variants||[]).length === 1)
        var hasVariants = (p.variants||[]).length > 0
        // variant-only: cell checkbox product hiển thị partial badge nếu có variant
        // được chọn — KHÔNG cho phép toggle-all qua checkbox này.
        var productCbCell = MODE === 'variant-only'
          ? '<td>'+(state!=='none'?'<span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:rgba(91,109,255,.25);text-align:center;line-height:14px;color:#a3aeff;font-size:10px">'+(state==='all'?'✓':'•')+'</span>':'')+'</td>'
          : '<td><input type="checkbox" class="po-pp-cb" data-pid="'+esc(p.id)+'" '+(state==='all'?'checked':'')+(state==='partial'?' data-indeterminate="1"':'')+'></td>'
        html += '<tr data-pid="'+esc(p.id)+'"'+(state==='all'?' class="selected"':'')+'>'+
          productCbCell+
          '<td>'+(hasVariants?'<span class="po-pp-chevron'+(isExpanded?' expanded':'')+'" data-chevron="'+esc(p.id)+'" aria-label="Expand variants">▶</span>':'')+'</td>'+
          '<td>'+thumbHtml(p.image_url)+'</td>'+
          '<td><span class="po-pp-product-name">'+esc(p.name)+'</span></td>'+
          '<td class="po-pp-num">'+(p.available_at_destination!=null?p.available_at_destination:'—')+'</td>'+
          '<td class="po-pp-num">'+(p.available!=null?p.available:'—')+'</td>'+
        '</tr>'
        if (isExpanded && (p.variants||[]).length > 0) {
          p.variants.forEach(function(v){
            var key = variantKey(p.id, v)
            var ck = modalSelected.has(key) ? 'checked' : ''
            html += '<tr class="po-pp-variant-row" data-key="'+esc(key)+'" data-pid="'+esc(p.id)+'">'+
              '<td><input type="checkbox" class="po-pp-cb po-pp-variant-cb" data-key="'+esc(key)+'" '+ck+'></td>'+
              '<td></td>'+
              '<td>'+thumbHtml(v.image_url || p.image_url)+'</td>'+
              '<td class="po-pp-variant-cell">'+
                '<div class="po-pp-variant-name">'+esc(v.name || 'Default')+'</div>'+
                (v.sku ? '<div class="po-pp-variant-sku">SKU '+esc(v.sku)+'</div>' : '')+
              '</td>'+
              '<td class="po-pp-num">'+(v.inventory!=null?v.inventory:'—')+'</td>'+
              '<td class="po-pp-num">'+(v.inventory!=null?v.inventory:'—')+'</td>'+
            '</tr>'
          })
        }
      })
      html += '</tbody></table>'
      modalTableWrap.innerHTML = html

      // indeterminate state cho product checkbox
      Array.prototype.forEach.call(modalTableWrap.querySelectorAll('.po-pp-cb[data-indeterminate]'), function(cb){
        cb.indeterminate = true
      })

      // Chevron expand/collapse
      Array.prototype.forEach.call(modalTableWrap.querySelectorAll('[data-chevron]'), function(el){
        el.addEventListener('click', function(e){
          e.stopPropagation()
          var pid = el.getAttribute('data-chevron')
          if (expanded.has(pid)) expanded.delete(pid); else expanded.add(pid)
          renderModalRows(modalProducts)
        })
      })

      // Product checkbox: toggle all variants of that product
      Array.prototype.forEach.call(modalTableWrap.querySelectorAll('.po-pp-cb[data-pid]'), function(cb){
        cb.addEventListener('click', function(e){
          e.stopPropagation()
          var pid = cb.getAttribute('data-pid')
          var p = modalProducts.find(function(x){return x.id === pid})
          if (!p) return
          var state = productSelectionState(p)
          if (state === 'all') {
            // Uncheck all
            ;(p.variants||[]).forEach(function(v){ modalSelected.delete(variantKey(p.id, v)) })
          } else {
            // Select all
            ;(p.variants||[]).forEach(function(v){
              var k = variantKey(p.id, v)
              if (!modalSelected.has(k)) modalSelected.set(k, variantToItem(p, v))
            })
          }
          renderModalRows(modalProducts); updateModalFooter()
        })
      })

      // Variant checkbox: toggle 1 variant
      Array.prototype.forEach.call(modalTableWrap.querySelectorAll('.po-pp-variant-cb'), function(cb){
        cb.addEventListener('click', function(e){
          e.stopPropagation()
          var key = cb.getAttribute('data-key')
          var pid = cb.closest('tr').getAttribute('data-pid')
          var p = modalProducts.find(function(x){return x.id === pid})
          if (!p) return
          var v = (p.variants||[]).find(function(x){return variantKey(p.id, x) === key})
          if (modalSelected.has(key)) modalSelected.delete(key)
          else if (v) modalSelected.set(key, variantToItem(p, v))
          renderModalRows(modalProducts); updateModalFooter()
        })
      })

      // Click row (không phải checkbox/chevron):
      // - mode 'product': toggle product selection (chỉ-tất-cả)
      // - mode 'variant-only': click row → expand/collapse variants
      Array.prototype.forEach.call(modalTableWrap.querySelectorAll('tbody tr:not(.po-pp-variant-row)'), function(tr){
        tr.addEventListener('click', function(e){
          if (e.target.closest('input,[data-chevron]')) return
          if (MODE === 'variant-only') {
            var pid = tr.getAttribute('data-pid')
            if (!pid) return
            if (expanded.has(pid)) expanded.delete(pid); else expanded.add(pid)
            renderModalRows(modalProducts)
          } else {
            var cb = tr.querySelector('.po-pp-cb[data-pid]')
            if (cb) cb.click()
          }
        })
      })
      Array.prototype.forEach.call(modalTableWrap.querySelectorAll('tr.po-pp-variant-row'), function(tr){
        tr.addEventListener('click', function(e){
          if (e.target.closest('input')) return
          var cb = tr.querySelector('.po-pp-variant-cb')
          if (cb) cb.click()
        })
      })
    }

    function updateModalFooter(){
      var n = modalSelected.size
      modalCount.textContent = n + ' variant' + (n!==1?'s':'') + ' selected'
      modalAddBtn.disabled = n === 0
    }

    function loadModal(query){
      modalTableWrap.innerHTML = '<div class="po-pp-loading">Loading…</div>'
      var url = SEARCH_URL + (query ? ('?q=' + encodeURIComponent(query) + '&limit=50') : '?limit=50')
      fetchJson(url)
        .then(function(d){ modalProducts = d.products || []; renderModalRows(modalProducts) })
        .catch(function(){ modalTableWrap.innerHTML = '<div class="po-pp-empty">Failed to load products.</div>' })
    }

    if (browseBtn && dlg) {
      browseBtn.addEventListener('click', function(){
        modalSelected = new Map(selected)
        expanded = new Set()
        updateModalFooter()
        if (modalSearch) modalSearch.value = ''
        loadModal('')
        dlg.showModal()
      })
    }

    if (modalSearch) {
      modalSearch.addEventListener('input', function(){
        clearTimeout(modalDebounce)
        var q = modalSearch.value.trim()
        modalDebounce = setTimeout(function(){ loadModal(q) }, DEBOUNCE_MS)
      })
    }

    if (modalAddBtn) {
      modalAddBtn.addEventListener('click', function(){
        modalSelected.forEach(function(it, key){
          if (!selected.has(key)) selected.set(key, Object.assign({}, it, {qty:1}))
        })
        Array.from(selected.keys()).forEach(function(k){
          if (!modalSelected.has(k)) selected.delete(k)
        })
        renderSelected()
        dlg.close()
      })
    }
  })();</script>`

  return styles + dialogHtml + script
}
