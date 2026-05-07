/**
 * Store Admin — Theme Editor
 *
 * Visual code editor for theme templates and settings.
 * Shopify-style: file tree on the left, code editor on the right.
 *
 * Routes:
 *   GET  /online-store/themes/:themeId/editor         — Editor UI
 *   GET  /online-store/themes/:themeId/editor/file     — Get file content (AJAX)
 *   POST /online-store/themes/:themeId/editor/file     — Save file content
 *   POST /online-store/themes/:themeId/editor/new-file — Create new file
 *   POST /online-store/themes/:themeId/editor/delete   — Delete file
 *   POST /online-store/themes/:themeId/settings        — Save theme settings
 *   POST /online-store/themes/:themeId/activate        — Activate theme
 *   POST /online-store/themes/:themeId/duplicate        — Duplicate theme
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import {
  getTheme,
  listThemeAssets,
  getThemeAsset,
  updateThemeAsset,
  deleteThemeAsset,
  setActiveTheme,
  duplicateTheme,
  searchThemeAssets,
} from '@gbox/core/modules/themes/service.js'
import { notify, byActor } from '../lib/notify.js'

// ---------------------------------------------------------------------------
// GET /online-store/themes/:themeId/editor — Main editor UI
// ---------------------------------------------------------------------------

export async function getThemeEditor(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}`
  const themeId = req.params.themeId

  try {
    const themeRecord = await getTheme(db, themeId)
    // Scope check: the theme must belong to this shop. `getTheme` only
    // returns (id, shop_id, name, role, …) — it's up to the caller to
    // verify tenancy. Without this line any authenticated seller could
    // poke another shop's theme id and render its file tree.
    if (!themeRecord || (themeRecord as any).shop_id !== store.id) {
      res.redirect(`${base}/online-store/themes`)
      return
    }

    // Get all assets for the file tree
    const assets = await listThemeAssets(db, themeId)
    const assetList = assets || []

    // Group assets by directory
    const dirs: Record<string, Array<{ key: string; name: string }>> = {}
    for (const asset of assetList) {
      const key = asset.key || ''
      const parts = key.split('/')
      const dir = parts.length > 1 ? parts[0] : 'root'
      const name = parts.length > 1 ? parts.slice(1).join('/') : key
      if (!dirs[dir]) dirs[dir] = []
      dirs[dir].push({ key, name })
    }

    // Sort dirs
    const dirOrder = ['layout', 'templates', 'sections', 'snippets', 'assets', 'config', 'locales', 'root']
    const sortedDirs = Object.keys(dirs).sort((a, b) => {
      const ai = dirOrder.indexOf(a)
      const bi = dirOrder.indexOf(b)
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    })

    // Build file tree HTML
    const fileTreeHtml = sortedDirs.map(dir => {
      const files = dirs[dir].sort((a, b) => a.name.localeCompare(b.name))
      return `
        <div class="tree-dir">
          <div class="tree-dir-name" onclick="this.parentElement.classList.toggle('collapsed')">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4"/></svg>
            ${esc(dir)}
          </div>
          <div class="tree-files">
            ${files.map(f => `
              <div class="tree-file" data-key="${esc(f.key)}" onclick="loadFile('${esc(f.key)}')" title="${esc(f.key)}">
                ${esc(f.name)}
              </div>
            `).join('')}
          </div>
        </div>
      `
    }).join('')

    // Initial file content — load first template if exists
    const firstFile = assetList.find(a => a.key?.startsWith('layout/')) || assetList[0]
    let initialContent = ''
    let initialKey = ''
    if (firstFile) {
      try {
        const assetData = await getThemeAsset(db, themeId, firstFile.key)
        initialContent = assetData?.value || ''
        initialKey = firstFile.key
      } catch { /* graceful */ }
    }

    const content = `
      <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:12px">
          <a href="${base}/online-store/themes" style="color:var(--s-text-secondary);text-decoration:none;font-size:20px">&larr;</a>
          <div>
            <h1 style="margin:0;font-size:20px;font-weight:700">${esc(themeRecord.name || 'Theme')} — Code Editor</h1>
            <p style="margin:2px 0 0;color:var(--s-text-secondary);font-size:12px">${assetList.length} files${themeRecord.role === 'main' ? ' &middot; Active theme' : ''}</p>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          ${themeRecord.role !== 'main' ? `
            <form method="POST" action="${base}/online-store/themes/${esc(themeId)}/activate" style="margin:0">
              <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
              <button type="submit" class="btn btn-outline" style="font-size:12px;padding:6px 14px">Activate</button>
            </form>
          ` : ''}
          <form method="POST" action="${base}/online-store/themes/${esc(themeId)}/duplicate" style="margin:0">
            <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
            <button type="submit" class="btn btn-outline" style="font-size:12px;padding:6px 14px">Duplicate</button>
          </form>
          <a href="${base}/online-store/themes/${esc(themeId)}/export"
             class="btn btn-outline"
             style="font-size:12px;padding:6px 14px;text-decoration:none"
             title="Download this theme as a Shopify-format .zip">
            Download .zip
          </a>
        </div>
      </div>

      <!-- CodeMirror 5 from CDN. Pinned patch version — unpinning would
           give drive-by updates a free pass into the admin UI. -->
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css" />
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/material-darker.min.css" />
      <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js"></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/xml/xml.min.js"></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/javascript/javascript.min.js"></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/css/css.min.js"></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/htmlmixed/htmlmixed.min.js"></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/closebrackets.min.js"></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/matchbrackets.min.js"></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/selection/active-line.min.js"></script>

      <div id="editorWrap" style="display:grid;grid-template-columns:240px 1fr;gap:0;border:1px solid var(--s-border);border-radius:10px;overflow:hidden;height:calc(100vh - 160px);background:var(--s-surface)">
        <!-- FILE TREE -->
        <div style="border-right:1px solid var(--s-border);overflow-y:auto;background:var(--s-bg);padding:8px 0">
          <div style="padding:8px 12px;display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--s-text-secondary);letter-spacing:.5px">Files</span>
            <div style="display:flex;gap:2px">
              <button onclick="showSearchModal()" style="background:none;border:none;color:var(--s-text-secondary);cursor:pointer;font-size:14px;padding:0 4px" title="Search files (Ctrl+Shift+F)">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="5"/><path d="M11 11l3 3" stroke-linecap="round"/></svg>
              </button>
              <button onclick="showNewFileModal()" style="background:none;border:none;color:var(--s-accent);cursor:pointer;font-size:16px;padding:0 4px" title="New file">+</button>
            </div>
          </div>
          ${fileTreeHtml}
        </div>

        <!-- CODE EDITOR -->
        <div style="display:flex;flex-direction:column;min-width:0">
          <div id="editorToolbar" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--s-border);background:var(--s-surface)">
            <div style="display:flex;align-items:center;gap:8px;min-width:0">
              <span id="currentFile" style="font-size:13px;font-weight:600;color:var(--s-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(initialKey || 'Select a file')}</span>
              <span id="modifiedBadge" style="display:none;font-size:10px;color:var(--s-warning);font-weight:600">Modified</span>
            </div>
            <div style="display:flex;gap:6px">
              <button onclick="showSearchModal()" class="btn" style="font-size:12px;padding:5px 10px;background:transparent;color:var(--s-text-secondary);border:1px solid var(--s-border)" title="Search files (Ctrl+Shift+F)">Find</button>
              <button onclick="saveFile()" id="saveBtn" class="btn btn-primary" style="font-size:12px;padding:5px 14px" disabled>Save</button>
              <button onclick="deleteCurrentFile()" id="deleteBtn" class="btn" style="font-size:12px;padding:5px 14px;background:rgba(239,68,68,.12);color:var(--s-danger);border:1px solid rgba(239,68,68,.35)" disabled>Delete</button>
            </div>
          </div>
          <div style="flex:1;position:relative;min-height:0">
            <textarea
              id="codeEditor"
              spellcheck="false"
              style="width:100%;height:100%;padding:16px;font-family:'JetBrains Mono',Consolas,'Courier New',monospace;font-size:13px;line-height:1.6;background:var(--s-bg);color:var(--s-text-primary);border:none;resize:none;outline:none;tab-size:2;white-space:pre"
            >${esc(initialContent)}</textarea>
          </div>
        </div>
      </div>

      <!-- Search Modal (Ctrl+Shift+F) -->
      <div id="searchModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:999;align-items:flex-start;justify-content:center;padding-top:80px">
        <div style="background:var(--s-surface);border-radius:12px;width:640px;max-width:90vw;max-height:70vh;display:flex;flex-direction:column;overflow:hidden">
          <div style="padding:14px 16px;border-bottom:1px solid var(--s-border);display:flex;align-items:center;gap:10px">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" style="color:var(--s-text-secondary);flex:0 0 auto"><circle cx="7" cy="7" r="5"/><path d="M11 11l3 3" stroke-linecap="round"/></svg>
            <input id="searchInput" type="text" placeholder="Search files by name or content…" autocomplete="off" style="flex:1;padding:6px 8px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
            <select id="searchMode" style="padding:6px 8px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:12px">
              <option value="both">Name &amp; content</option>
              <option value="filename">Name only</option>
              <option value="content">Content only</option>
            </select>
            <button type="button" onclick="hideSearchModal()" style="background:none;border:none;color:var(--s-text-secondary);cursor:pointer;font-size:18px;padding:0 6px" title="Close (Esc)">&times;</button>
          </div>
          <div id="searchResults" style="flex:1;overflow-y:auto;padding:4px 0;min-height:40px">
            <div style="padding:24px;text-align:center;color:var(--s-text-secondary);font-size:13px">Start typing to search…</div>
          </div>
          <div style="padding:8px 14px;border-top:1px solid var(--s-border);font-size:11px;color:var(--s-text-secondary);display:flex;justify-content:space-between">
            <span><kbd style="background:var(--s-bg);padding:2px 6px;border-radius:3px;border:1px solid var(--s-border)">Esc</kbd> to close</span>
            <span id="searchStatus"></span>
          </div>
        </div>
      </div>

      <!-- New File Modal -->
      <div id="newFileModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:999;align-items:center;justify-content:center">
        <div style="background:var(--s-surface);border-radius:12px;padding:24px;width:400px;max-width:90vw">
          <h3 style="margin:0 0 16px;font-size:16px;font-weight:700">New File</h3>
          <form method="POST" action="${base}/online-store/themes/${esc(themeId)}/editor/new-file">
            <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
            <div style="margin-bottom:12px">
              <label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px">File path</label>
              <input type="text" name="key" placeholder="templates/page.custom.liquid" required style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
              <div style="font-size:11px;color:var(--s-text-secondary);margin-top:4px">e.g. templates/custom.liquid, snippets/header.liquid</div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <button type="button" onclick="hideNewFileModal()" class="btn btn-outline" style="font-size:13px;padding:6px 16px">Cancel</button>
              <button type="submit" class="btn btn-primary" style="font-size:13px;padding:6px 16px">Create</button>
            </div>
          </form>
        </div>
      </div>

      <style>
        .tree-dir { margin-bottom:2px; }
        .tree-dir-name {
          display:flex;align-items:center;gap:6px;padding:4px 12px;font-size:12px;font-weight:600;
          color:var(--s-text-secondary);cursor:pointer;user-select:none;
        }
        .tree-dir-name:hover { color:var(--s-text-primary); }
        .tree-dir-name svg { transition:transform .15s; }
        .tree-dir.collapsed .tree-dir-name svg { transform:rotate(-90deg); }
        .tree-dir.collapsed .tree-files { display:none; }
        .tree-file {
          padding:3px 12px 3px 28px;font-size:12px;color:var(--s-text-primary);cursor:pointer;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        }
        .tree-file:hover { background:var(--s-surface); }
        .tree-file.active { background:var(--s-accent);color:#fff;border-radius:4px; }
        /* CodeMirror fills the editor panel; without !important the default
           300px height wins and the editor collapses to one line. */
        .CodeMirror { height:100% !important; font-size:13px; font-family:'JetBrains Mono',Consolas,'Courier New',monospace; }
        .CodeMirror-scroll { min-height:200px; }
        /* Search result rows */
        .search-row {
          padding:8px 14px;cursor:pointer;border-bottom:1px solid var(--s-border);
          display:flex;flex-direction:column;gap:2px;
        }
        .search-row:hover, .search-row.focused { background:var(--s-bg); }
        .search-row-key { font-size:13px;font-weight:600;color:var(--s-text-primary);display:flex;align-items:center;gap:6px }
        .search-row-meta { font-size:10px;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px }
        .search-row-snippet {
          font-family:'JetBrains Mono',Consolas,monospace;font-size:11px;color:var(--s-text-secondary);
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        }
        .search-row-snippet mark { background:rgba(245,158,11,.3);color:inherit;padding:0 2px;border-radius:2px }
        kbd { font-family:'JetBrains Mono',Consolas,monospace;font-size:11px }
      </style>

      <script>
        let currentKey = ${JSON.stringify(initialKey)};
        let originalContent = ${JSON.stringify(initialContent)};
        const csrf = ${JSON.stringify((req as any).csrfToken || '')};
        const base = ${JSON.stringify(`${base}/online-store/themes/${themeId}/editor`)};

        // --------- CodeMirror setup ---------
        // Pick a CM mode from the file extension. Liquid templates are mostly
        // HTML with {{ }} sprinkled in, so htmlmixed is a better-than-nothing
        // default — we don't ship a full Liquid grammar here.
        function modeFor(key) {
          if (!key) return null;
          const ext = (key.split('.').pop() || '').toLowerCase();
          if (ext === 'liquid' || ext === 'html' || ext === 'htm') return 'htmlmixed';
          if (ext === 'json') return { name: 'javascript', json: true };
          if (ext === 'js' || ext === 'mjs') return 'javascript';
          if (ext === 'css' || ext === 'scss') return 'css';
          if (ext === 'xml' || ext === 'svg') return 'xml';
          return null;
        }

        const editor = CodeMirror.fromTextArea(document.getElementById('codeEditor'), {
          lineNumbers: true,
          lineWrapping: false,
          indentUnit: 2,
          tabSize: 2,
          indentWithTabs: false,
          autoCloseBrackets: true,
          matchBrackets: true,
          styleActiveLine: true,
          theme: 'material-darker',
          mode: modeFor(currentKey),
          extraKeys: {
            'Ctrl-S': function () { saveFile(); return false; },
            'Cmd-S': function () { saveFile(); return false; },
            'Ctrl-Shift-F': function () { showSearchModal(); return false; },
            'Cmd-Shift-F': function () { showSearchModal(); return false; },
            Tab: function (cm) { cm.replaceSelection('  '); },
          },
        });
        editor.on('change', markModified);

        // Highlight active file
        if (currentKey) {
          document.querySelectorAll('.tree-file').forEach(el => {
            if (el.dataset.key === currentKey) el.classList.add('active');
          });
        }

        async function loadFile(key) {
          if (document.getElementById('modifiedBadge').style.display !== 'none') {
            if (!confirm('Unsaved changes will be lost. Continue?')) return;
          }
          try {
            const resp = await fetch(base + '/file?key=' + encodeURIComponent(key));
            const data = await resp.json();
            const body = data.content || '';
            editor.setValue(body);
            editor.setOption('mode', modeFor(key));
            document.getElementById('currentFile').textContent = key;
            document.getElementById('saveBtn').disabled = false;
            document.getElementById('deleteBtn').disabled = false;
            document.getElementById('modifiedBadge').style.display = 'none';
            currentKey = key;
            originalContent = body;
            document.querySelectorAll('.tree-file').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tree-file[data-key="' + key + '"]').forEach(el => el.classList.add('active'));
          } catch (e) { alert('Failed to load file: ' + e.message); }
        }

        function markModified() {
          const current = editor.getValue();
          document.getElementById('modifiedBadge').style.display = current !== originalContent ? 'inline' : 'none';
        }

        async function saveFile() {
          if (!currentKey) return;
          const content = editor.getValue();
          try {
            const resp = await fetch(base + '/file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: currentKey, content, _csrf: csrf }),
            });
            if (!resp.ok) throw new Error('Save failed');
            originalContent = content;
            document.getElementById('modifiedBadge').style.display = 'none';
          } catch (e) { alert('Save failed: ' + e.message); }
        }

        async function deleteCurrentFile() {
          if (!currentKey) return;
          if (!confirm('Delete ' + currentKey + '? This cannot be undone.')) return;
          try {
            const resp = await fetch(base + '/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: currentKey, _csrf: csrf }),
            });
            if (resp.ok) location.reload();
          } catch (e) { alert('Delete failed: ' + e.message); }
        }

        function showNewFileModal() {
          document.getElementById('newFileModal').style.display = 'flex';
        }
        function hideNewFileModal() {
          document.getElementById('newFileModal').style.display = 'none';
        }

        // --------- File search (Ctrl+Shift+F) ---------
        let searchDebounce = null;
        let searchFocusedIdx = -1;
        let searchHits = [];

        function showSearchModal() {
          const modal = document.getElementById('searchModal');
          modal.style.display = 'flex';
          const input = document.getElementById('searchInput');
          input.focus();
          input.select();
          // Fire a search right away in case there's a previous query
          if (input.value.trim()) runSearch();
        }
        function hideSearchModal() {
          document.getElementById('searchModal').style.display = 'none';
        }

        function escapeHtml(s) {
          return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
          }[c]));
        }
        function highlight(snippet, needle) {
          if (!snippet || !needle) return escapeHtml(snippet || '');
          const escSnippet = escapeHtml(snippet);
          const escNeedle = escapeHtml(needle).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
          return escSnippet.replace(new RegExp(escNeedle, 'ig'), m => '<mark>' + m + '</mark>');
        }

        function renderSearchResults(hits, q) {
          const box = document.getElementById('searchResults');
          const status = document.getElementById('searchStatus');
          searchHits = hits;
          searchFocusedIdx = hits.length ? 0 : -1;
          if (!q) {
            box.innerHTML = '<div style="padding:24px;text-align:center;color:var(--s-text-secondary);font-size:13px">Start typing to search…</div>';
            status.textContent = '';
            return;
          }
          if (!hits.length) {
            box.innerHTML = '<div style="padding:24px;text-align:center;color:var(--s-text-secondary);font-size:13px">No matches.</div>';
            status.textContent = '0 results';
            return;
          }
          box.innerHTML = hits.map((h, i) => {
            const lineBadge = h.lineNumber ? ' <span class="search-row-meta">Line ' + h.lineNumber + '</span>' : '';
            const typeBadge = '<span class="search-row-meta">' + escapeHtml(h.matchType) + '</span>';
            const snippet = h.snippet ? '<div class="search-row-snippet">' + highlight(h.snippet, q) + '</div>' : '';
            return '<div class="search-row' + (i === 0 ? ' focused' : '') +
              '" data-key="' + escapeHtml(h.key) + '" data-idx="' + i +
              '" onclick="pickSearchResult(' + i + ')">' +
              '<div class="search-row-key">' + escapeHtml(h.key) + ' ' + typeBadge + lineBadge + '</div>' +
              snippet +
              '</div>';
          }).join('');
          status.textContent = hits.length + (hits.length === 1 ? ' result' : ' results');
        }

        async function runSearch() {
          const input = document.getElementById('searchInput');
          const q = input.value.trim();
          const mode = document.getElementById('searchMode').value;
          if (!q) { renderSearchResults([], ''); return; }
          try {
            const u = base + '/search?q=' + encodeURIComponent(q) + '&mode=' + encodeURIComponent(mode) + '&limit=50';
            const resp = await fetch(u);
            if (!resp.ok) {
              renderSearchResults([], q);
              document.getElementById('searchStatus').textContent = 'Search failed';
              return;
            }
            const data = await resp.json();
            renderSearchResults(Array.isArray(data.hits) ? data.hits : [], q);
          } catch (e) {
            document.getElementById('searchStatus').textContent = 'Search failed';
          }
        }

        function pickSearchResult(i) {
          const hit = searchHits[i];
          if (!hit) return;
          hideSearchModal();
          loadFile(hit.key);
        }

        function moveSearchFocus(delta) {
          if (!searchHits.length) return;
          searchFocusedIdx = (searchFocusedIdx + delta + searchHits.length) % searchHits.length;
          const rows = document.querySelectorAll('.search-row');
          rows.forEach(r => r.classList.remove('focused'));
          const row = rows[searchFocusedIdx];
          if (row) {
            row.classList.add('focused');
            row.scrollIntoView({ block: 'nearest' });
          }
        }

        document.getElementById('searchInput').addEventListener('input', () => {
          if (searchDebounce) clearTimeout(searchDebounce);
          searchDebounce = setTimeout(runSearch, 150);
        });
        document.getElementById('searchMode').addEventListener('change', runSearch);
        document.getElementById('searchInput').addEventListener('keydown', e => {
          if (e.key === 'Escape') { hideSearchModal(); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); moveSearchFocus(1); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); moveSearchFocus(-1); }
          else if (e.key === 'Enter') { e.preventDefault(); if (searchFocusedIdx >= 0) pickSearchResult(searchFocusedIdx); }
        });

        // Global: Ctrl+S saves, Ctrl+Shift+F opens search (outside the editor, CM
        // handles the in-editor variants via extraKeys above).
        document.addEventListener('keydown', e => {
          if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            showSearchModal();
          } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            saveFile();
          } else if (e.key === 'Escape' && document.getElementById('searchModal').style.display === 'flex') {
            hideSearchModal();
          }
        });
      </script>
    `

    res.send(
      sellerLayout({
        title: 'Theme Editor',
        storeName: store.name,
        storeSlug: store.slug,
        userName: user.name,
        userEmail: user.email,
        userRole: user.role,
        storeRole: user.storeRole,
        activePage: 'online-store',
        content,
        theme: theme as 'dark' | 'light',
      }),
    )
  } catch (err: any) {
    res.redirect(`${base}/online-store/themes`)
  }
}

// ---------------------------------------------------------------------------
// GET /editor/file — Get file content (AJAX)
// ---------------------------------------------------------------------------

export async function getThemeFile(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const themeId = req.params.themeId
  const key = req.query.key as string

  if (!key) {
    res.status(400).json({ error: 'key is required' })
    return
  }

  try {
    const asset = await getThemeAsset(db, themeId, key)
    res.json({ content: asset?.value || '', key })
  } catch {
    res.status(404).json({ error: 'File not found' })
  }
}

// ---------------------------------------------------------------------------
// POST /editor/file — Save file content (AJAX)
// ---------------------------------------------------------------------------

export async function postThemeFile(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = req.params.themeId
  const { key, content } = req.body

  if (!key) {
    res.status(400).json({ error: 'key is required' })
    return
  }

  try {
    await updateThemeAsset(db, store.id, themeId, key, content || '')
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'theme_file_saved',
      title: `Theme file saved: ${key}`,
      message: byActor((req as any).storeUser),
      resourceType: 'theme',
      resourceId: themeId,
    })
    res.json({ success: true, key })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
}

// ---------------------------------------------------------------------------
// POST /editor/new-file — Create new file
// ---------------------------------------------------------------------------

export async function postNewThemeFile(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = req.params.themeId
  const base = `/admin/store/${store.slug}`
  const { key } = req.body

  if (!key) {
    res.redirect(`${base}/online-store/themes/${themeId}/editor`)
    return
  }

  try {
    await updateThemeAsset(db, store.id, themeId, key, '')
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'theme_file_created',
      title: `Theme file created: ${key}`,
      message: byActor((req as any).storeUser),
      resourceType: 'theme',
      resourceId: themeId,
    })
    res.redirect(`${base}/online-store/themes/${themeId}/editor`)
  } catch (err: any) {
    res.redirect(`${base}/online-store/themes/${themeId}/editor?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /editor/delete — Delete file (AJAX)
// ---------------------------------------------------------------------------

export async function postDeleteThemeFile(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = req.params.themeId
  const { key } = req.body

  if (!key) {
    res.status(400).json({ error: 'key is required' })
    return
  }

  try {
    await deleteThemeAsset(db, store.id, themeId, key)
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'theme_file_deleted',
      title: `Theme file deleted: ${key}`,
      message: byActor((req as any).storeUser),
      resourceType: 'theme',
      resourceId: themeId,
    })
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
}

// ---------------------------------------------------------------------------
// POST /themes/:themeId/activate — Activate theme
// ---------------------------------------------------------------------------

export async function postActivateTheme(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = req.params.themeId
  const base = `/admin/store/${store.slug}`

  try {
    await setActiveTheme(db, store.id, themeId)
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'theme_activated',
      title: 'Theme activated',
      message: byActor((req as any).storeUser),
      resourceType: 'theme',
      resourceId: themeId,
    })
    res.redirect(`${base}/online-store/themes`)
  } catch (err: any) {
    res.redirect(`${base}/online-store/themes?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /themes/:themeId/duplicate — Duplicate theme
// ---------------------------------------------------------------------------

export async function postDuplicateTheme(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = req.params.themeId
  const base = `/admin/store/${store.slug}`

  try {
    await duplicateTheme(db, store.id, themeId)
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'theme_duplicated',
      title: 'Theme duplicated',
      message: byActor((req as any).storeUser),
      resourceType: 'theme',
      resourceId: themeId,
    })
    res.redirect(`${base}/online-store/themes`)
  } catch (err: any) {
    res.redirect(`${base}/online-store/themes?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// GET /online-store/themes/:themeId/editor/search — File finder (Ctrl+Shift+F)
// ---------------------------------------------------------------------------

/**
 * Theme-scoped file search. Powers the editor's Ctrl+Shift+F panel.
 * Validates the theme belongs to the seller's shop before delegating
 * to the service-layer `searchThemeAssets` — keeps one file search
 * from leaking another shop's theme keys in cross-tenant setups.
 */
export async function getThemeEditorSearch(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = req.params.themeId
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const modeRaw = typeof req.query.mode === 'string' ? req.query.mode : 'both'
  const mode =
    modeRaw === 'filename' || modeRaw === 'content' || modeRaw === 'both'
      ? modeRaw
      : 'both'
  const ext = typeof req.query.ext === 'string' ? req.query.ext : null
  const limit = Number.parseInt(String(req.query.limit ?? '50'), 10) || 50

  try {
    // Verify the theme belongs to this shop. `getTheme` doesn't take a
    // shopId param but returns the shop_id column — compare here so a
    // seller can't poke another shop's theme id and get search results.
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.status(404).json({ error: 'theme_not_found' })
      return
    }

    const hits = await searchThemeAssets(db, themeId, q, { mode, ext, limit })
    res.json({ hits })
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'search_failed' })
  }
}
