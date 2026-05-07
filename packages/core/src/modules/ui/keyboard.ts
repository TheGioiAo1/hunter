/**
 * Gbox Platform — Keyboard Shortcuts + Command Palette (Phase 2 Step 2.6)
 *
 * Shopify admin has three keyboard-first affordances every power user
 * eventually learns:
 *
 *   1. `Cmd+K` / `Ctrl+K` — open the command palette (like VS Code).
 *      Type a fragment → see matching pages/actions → Enter to jump.
 *   2. `?` — open the shortcuts cheatsheet modal.
 *   3. Go-to prefixes — press `g` then a letter (`g p` = products,
 *      `g o` = orders). Mirrors GitHub's navigation shortcuts.
 *
 * This module ships the shared building blocks:
 *
 *   - Types: `CommandItem`, `KeyboardShortcut`, `CommandPaletteOptions`
 *   - `filterCommands(items, query)` — fuzzy match (subsequence scoring)
 *   - `commandPaletteHtml(options)` — the modal shell + input + list
 *   - `keyboardShortcutsHtml(shortcuts)` — the cheatsheet list
 *   - `keyboardRuntimeScriptBody(items)` — the client JS that wires
 *      Cmd+K / Ctrl+K, `?`, and `g X` prefixes
 *   - `keyboardCss()` — styling
 *
 * Design invariants
 * -----------------
 * - The palette is a plain list + input, NOT a <dialog>. Why? Because
 *   <dialog> traps focus and that fights with Cmd+K re-press-to-close.
 *   Instead we use a fixed-position overlay with manual focus mgmt.
 * - Fuzzy matching is subsequence-based (like VS Code before its
 *   fuzzaldrin rewrite) — O(n*m) but n ≤ 200 commands so it's fine.
 * - The runtime is a single IIFE; nothing globals except the two
 *   helpers `window.gboxOpenPalette()` / `window.gboxClosePalette()`.
 * - Commands are defined server-side and serialized into the script
 *   body as a JSON literal. That means route handlers can filter out
 *   commands the current user can't access (e.g. god-admin routes
 *   when the viewer is a store owner).
 *
 * Security
 * --------
 * Command labels and hrefs flow through `esc()` and are rendered with
 * textContent at runtime, never innerHTML. The serialized JSON is
 * HTML-escaped inside the <script> via a closing-tag-safe transform.
 *
 * Triết lý: "clone giống hệt Shopify" (Cmd+K palette, g-prefix nav,
 * ? cheatsheet) + "power-ful hơn Shopify nhờ Claude" (one typed
 * registry drives both palette AND cheatsheet, filterable by role,
 * lives in the shared UI package so seller + god admin share it).
 */

export interface CommandItem {
  /** Stable id (used as React-like key + for a11y). */
  id: string
  /** Visible label. */
  label: string
  /**
   * Where to navigate on Enter. If not set, the command is action-only
   * and the UI must wire a handler via `onSelect` at runtime.
   */
  href?: string
  /** Group header (e.g. "Navigation", "Actions"). */
  group?: string
  /**
   * Secondary description ("Go to all products", "Create a new blog post").
   * Shown in a muted color to the right of the label.
   */
  description?: string
  /** Inline SVG icon (optional). */
  icon?: string
  /**
   * Optional keyboard shortcut hint shown on the right ("g p", "⌘N").
   * This is pure display — the real key handler is `shortcut`.
   */
  shortcut?: string
  /** Extra searchable keywords that aren't shown. */
  keywords?: string[]
}

export interface KeyboardShortcut {
  /** Display form: "⌘K", "?", "g p". */
  keys: string
  /** Human explanation: "Open command palette". */
  description: string
  /** Section header ("Navigation", "Editing", "General"). */
  group?: string
}

export interface CommandPaletteOptions {
  /** DOM id for the palette overlay (default 'gboxPalette'). */
  id?: string
  /** Placeholder text for the search input. */
  placeholder?: string
  /** Shown when the search yields no matches. */
  emptyLabel?: string
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
 * Make a JSON string safe to inline in a <script> tag. The only
 * sequence that can escape a script body is `</` — so we transform
 * it into `<\/` which remains valid JSON but no longer terminates
 * the tag.
 */
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

// ---------------------------------------------------------------------------
// Fuzzy matching (subsequence scoring)
// ---------------------------------------------------------------------------

/**
 * Return `items` filtered + scored by how well they match `query`.
 * Uses case-insensitive subsequence matching: every letter of the
 * query must appear in order in the label (or in a keyword). Score
 * prefers consecutive matches and early matches.
 *
 * Empty query returns all items in original order (score 0).
 */
export function filterCommands(
  items: CommandItem[],
  query: string,
): CommandItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items.slice()

  interface Scored {
    item: CommandItem
    score: number
  }
  const scored: Scored[] = []

  for (const item of items) {
    // We try matching against the label first (weighted higher) and
    // fall back to each keyword. Best score across all haystacks wins.
    const haystacks: { text: string; weight: number }[] = [
      { text: item.label, weight: 3 },
      { text: item.description ?? '', weight: 1 },
      ...(item.keywords ?? []).map((k) => ({ text: k, weight: 2 })),
    ]

    let best = -1
    for (const { text, weight } of haystacks) {
      if (!text) continue
      const score = scoreFuzzy(text.toLowerCase(), q)
      if (score < 0) continue
      const weighted = score * weight
      if (weighted > best) best = weighted
    }

    if (best >= 0) scored.push({ item, score: best })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.item)
}

/**
 * Returns a match score, or -1 if `query` is not a subsequence of
 * `text`. Higher is better. Rewards:
 *  - Early matches (first letter starts at index 0 = bonus).
 *  - Consecutive matches (no gap between query letters = bonus).
 *  - Short haystacks (fewer letters between matches = bonus).
 */
function scoreFuzzy(text: string, query: string): number {
  let ti = 0
  let qi = 0
  let score = 0
  let prevMatchIdx = -2
  while (ti < text.length && qi < query.length) {
    if (text[ti] === query[qi]) {
      // Consecutive bonus
      if (prevMatchIdx === ti - 1) score += 5
      else score += 1
      // Early-match bonus
      if (ti === 0) score += 3
      prevMatchIdx = ti
      qi++
    }
    ti++
  }
  if (qi < query.length) return -1
  // Penalize long tails
  score -= (text.length - query.length) * 0.05
  return score
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/**
 * Render the command palette overlay. Hidden by default; the runtime
 * script shows it via `window.gboxOpenPalette()`.
 */
export function commandPaletteHtml(opts: CommandPaletteOptions = {}): string {
  const id = opts.id ?? 'gboxPalette'
  const placeholder = opts.placeholder ?? 'Type a command or search...'
  const emptyLabel = opts.emptyLabel ?? 'No matches found.'
  return (
    `<div id="${esc(id)}" class="gbox-cp gbox-cp-hidden" role="dialog" aria-modal="true" aria-label="Command palette">` +
    `<div class="gbox-cp-backdrop" data-cp-close="1" aria-hidden="true"></div>` +
    `<div class="gbox-cp-panel" role="document">` +
    `<div class="gbox-cp-search">` +
    `<svg class="gbox-cp-search-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="9" r="6"/><path d="M13.5 13.5L18 18"/></svg>` +
    `<input type="text" class="gbox-cp-input" placeholder="${esc(placeholder)}" aria-label="Command search" autocomplete="off" spellcheck="false">` +
    `<kbd class="gbox-cp-esc">Esc</kbd>` +
    `</div>` +
    `<div class="gbox-cp-list" role="listbox"></div>` +
    `<div class="gbox-cp-empty" hidden>${esc(emptyLabel)}</div>` +
    `<div class="gbox-cp-footer">` +
    `<kbd>↑</kbd> <kbd>↓</kbd> to navigate &nbsp; <kbd>Enter</kbd> to select &nbsp; <kbd>Esc</kbd> to close` +
    `</div>` +
    `</div>` +
    `</div>`
  )
}

/**
 * Render a cheatsheet list of shortcuts, grouped by section. Meant
 * to be injected into the body of a `modal()` or a plain page.
 */
export function keyboardShortcutsHtml(shortcuts: KeyboardShortcut[]): string {
  // Group by section
  const grouped: Record<string, KeyboardShortcut[]> = {}
  for (const s of shortcuts) {
    const key = s.group ?? 'General'
    const list = grouped[key] ?? []
    list.push(s)
    grouped[key] = list
  }

  const sections = Object.entries(grouped)
    .map(([groupName, items]) => {
      const rows = items
        .map(
          (s) =>
            `<div class="gbox-ks-row">` +
            `<div class="gbox-ks-desc">${esc(s.description)}</div>` +
            `<div class="gbox-ks-keys">${renderKeys(s.keys)}</div>` +
            `</div>`,
        )
        .join('')
      return (
        `<div class="gbox-ks-group">` +
        `<h3 class="gbox-ks-group-title">${esc(groupName)}</h3>` +
        rows +
        `</div>`
      )
    })
    .join('')

  return `<div class="gbox-ks">${sections}</div>`
}

function renderKeys(keys: string): string {
  // Split on whitespace so "g p" becomes two kbd pills.
  return keys
    .split(/\s+/)
    .map((k) => `<kbd>${esc(k)}</kbd>`)
    .join(' ')
}

// ---------------------------------------------------------------------------
// Runtime script
// ---------------------------------------------------------------------------

export interface KeyboardRuntimeOptions {
  /** Command list — serialized into the script body as JSON. */
  commands: CommandItem[]
  /** DOM id for the palette (matches commandPaletteHtml). */
  paletteId?: string
  /**
   * DOM id for the shortcuts modal (opened with `?`). If absent, the
   * `?` key is not wired. The modal itself must be rendered elsewhere
   * using `modal()` from the shared UI module.
   */
  shortcutsModalId?: string
  /**
   * Go-to prefix bindings: press `g` then the given letter to navigate.
   * Example: `{ p: '/products', o: '/orders', c: '/customers' }`.
   */
  goToBindings?: Record<string, string>
  /**
   * Phase G4 (2026-04-17): generic two-key chords (e.g. `c p`, `c d`).
   * Unlike `goToBindings` — which is always prefixed with `g` — chords
   * carry their own prefix so pages can register arbitrary combos.
   *
   * Each chord is optionally scoped to a page: the runtime reads the
   * current scope from `document.body[data-kbd-scope]` and only fires
   * the chord when scopes match (or when the chord has no scope).
   *
   * If `href` is set the runtime navigates there; otherwise it fires a
   * `gbox:command` CustomEvent with the chord as `detail` — pages wire
   * their own handlers for those.
   */
  chords?: ChordBinding[]
  /**
   * Phase G4: single-key shortcuts that fire without any prefix
   * (e.g. `n` to open "new clone" on the clone-pro index). Scoped the
   * same way as `chords` so global single-letter presses don't hijack
   * every page.
   */
  singleKeys?: SingleKeyBinding[]
}

/**
 * A two-key chord like `c p` or `g l`. `keys` is the whitespace-split
 * representation shown in the cheatsheet — e.g. `'c p'`. Set either
 * `href` (navigation) or `action` (dispatch a `gbox:command` event with
 * this string as `detail.action`).
 */
export interface ChordBinding {
  keys: string
  scope?: string
  href?: string
  action?: string
}

/**
 * A single-key shortcut. Same shape as ChordBinding but `key` is a
 * single character (case-insensitive). `n` on the clone-pro index is
 * the canonical example.
 */
export interface SingleKeyBinding {
  key: string
  scope?: string
  href?: string
  action?: string
}

/**
 * Client-side runtime. Wires:
 *   - Cmd+K / Ctrl+K → open palette (if already open, close it).
 *   - Esc → close palette.
 *   - Arrow Up/Down → move selection inside palette.
 *   - Enter → navigate to selected command's href.
 *   - `?` (when no input is focused) → open shortcutsModalId if set.
 *   - `g` prefix (when no input is focused) → next letter maps to
 *     goToBindings for up to 2 seconds.
 *
 * Exposes `window.gboxOpenPalette()` and `window.gboxClosePalette()`
 * for programmatic control.
 */
export function keyboardRuntimeScriptBody(
  opts: KeyboardRuntimeOptions,
): string {
  const paletteId = opts.paletteId ?? 'gboxPalette'
  const commandsJson = safeJsonForScript(opts.commands)
  const bindingsJson = safeJsonForScript(opts.goToBindings ?? {})
  const chordsJson = safeJsonForScript(opts.chords ?? [])
  const singleKeysJson = safeJsonForScript(opts.singleKeys ?? [])
  const shortcutsModalId = opts.shortcutsModalId ?? ''

  return `
    (function(){
      var COMMANDS = ${commandsJson};
      var BINDINGS = ${bindingsJson};
      var CHORDS = ${chordsJson};
      var SINGLE_KEYS = ${singleKeysJson};
      var PALETTE_ID = ${JSON.stringify(paletteId)};
      var SHORTCUTS_MODAL_ID = ${JSON.stringify(shortcutsModalId)};

      var selectedIndex = 0;
      var currentResults = COMMANDS.slice();
      var goPrefixActive = false;
      var goPrefixTimer = null;

      // Phase G4: generic chord prefix state. Any non-'g' first letter
      // that matches a registered chord scope primes the chord; a second
      // key within 2s resolves it. Scoped by document.body's
      // data-kbd-scope so 'c p' on the clone-pro detail page does not
      // also fire on /products.
      var chordFirst = '';
      var chordTimer = null;
      function currentScope() {
        var b = document.body;
        if (!b) return '';
        return b.getAttribute('data-kbd-scope') || '';
      }
      function scopeMatches(scope) {
        if (!scope) return true;
        return scope === currentScope();
      }
      function fireAction(action, src) {
        var detail = { action: action, source: src };
        var ev;
        try { ev = new CustomEvent('gbox:command', { detail: detail }); }
        catch(e) {
          ev = document.createEvent('CustomEvent');
          ev.initCustomEvent('gbox:command', true, true, detail);
        }
        window.dispatchEvent(ev);
      }
      function resolveChord(second) {
        var combo = chordFirst + ' ' + second;
        for (var i = 0; i < CHORDS.length; i++) {
          var c = CHORDS[i];
          if (c.keys !== combo) continue;
          if (!scopeMatches(c.scope)) continue;
          if (c.href) { window.location.href = c.href; return true; }
          if (c.action) { fireAction(c.action, 'chord'); return true; }
        }
        return false;
      }
      function primeChord(first) {
        chordFirst = first;
        if (chordTimer) clearTimeout(chordTimer);
        chordTimer = setTimeout(function(){ chordFirst = ''; }, 2000);
      }
      function clearChord() {
        chordFirst = '';
        if (chordTimer) clearTimeout(chordTimer);
      }
      function anyChordStartsWith(letter) {
        var scope = currentScope();
        for (var i = 0; i < CHORDS.length; i++) {
          var c = CHORDS[i];
          var head = (c.keys || '').split(/\\s+/)[0];
          if (head !== letter) continue;
          if (!c.scope || c.scope === scope) return true;
        }
        return false;
      }
      function matchSingleKey(key) {
        var scope = currentScope();
        for (var i = 0; i < SINGLE_KEYS.length; i++) {
          var sk = SINGLE_KEYS[i];
          if ((sk.key || '').toLowerCase() !== key) continue;
          if (sk.scope && sk.scope !== scope) continue;
          return sk;
        }
        return null;
      }

      function $(sel, root) { return (root || document).querySelector(sel); }
      function palette() { return document.getElementById(PALETTE_ID); }
      function isInputFocused() {
        var el = document.activeElement;
        if (!el) return false;
        var tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable) return true;
        return false;
      }

      // ---------- fuzzy match (mirrors filterCommands on the server) ----------
      function scoreFuzzy(text, query) {
        var ti = 0, qi = 0, score = 0, prev = -2;
        while (ti < text.length && qi < query.length) {
          if (text.charAt(ti) === query.charAt(qi)) {
            if (prev === ti - 1) score += 5; else score += 1;
            if (ti === 0) score += 3;
            prev = ti;
            qi++;
          }
          ti++;
        }
        if (qi < query.length) return -1;
        score -= (text.length - query.length) * 0.05;
        return score;
      }
      function filterCmds(q) {
        var query = (q || '').trim().toLowerCase();
        if (!query) return COMMANDS.slice();
        var scored = [];
        for (var i = 0; i < COMMANDS.length; i++) {
          var item = COMMANDS[i];
          var hays = [
            { t: (item.label || '').toLowerCase(), w: 3 },
            { t: (item.description || '').toLowerCase(), w: 1 }
          ];
          if (item.keywords) {
            for (var k = 0; k < item.keywords.length; k++) {
              hays.push({ t: item.keywords[k].toLowerCase(), w: 2 });
            }
          }
          var best = -1;
          for (var h = 0; h < hays.length; h++) {
            if (!hays[h].t) continue;
            var s = scoreFuzzy(hays[h].t, query) * hays[h].w;
            if (s > best) best = s;
          }
          if (best >= 0) scored.push({ item: item, score: best });
        }
        scored.sort(function(a,b){ return b.score - a.score; });
        return scored.map(function(s){ return s.item; });
      }

      // ---------- rendering ----------
      function renderList() {
        var p = palette();
        if (!p) return;
        var list = p.querySelector('.gbox-cp-list');
        var empty = p.querySelector('.gbox-cp-empty');
        if (!list) return;

        // Clear
        while (list.firstChild) list.removeChild(list.firstChild);

        if (currentResults.length === 0) {
          if (empty) empty.hidden = false;
          return;
        }
        if (empty) empty.hidden = true;

        var lastGroup = null;
        for (var i = 0; i < currentResults.length; i++) {
          var cmd = currentResults[i];
          if (cmd.group && cmd.group !== lastGroup) {
            var gh = document.createElement('div');
            gh.className = 'gbox-cp-group';
            gh.textContent = cmd.group;
            list.appendChild(gh);
            lastGroup = cmd.group;
          }
          var row = document.createElement('div');
          row.className = 'gbox-cp-item' + (i === selectedIndex ? ' gbox-cp-item-active' : '');
          row.setAttribute('role', 'option');
          row.setAttribute('data-cp-index', String(i));

          var label = document.createElement('div');
          label.className = 'gbox-cp-label';
          label.textContent = cmd.label;
          row.appendChild(label);

          if (cmd.description) {
            var desc = document.createElement('div');
            desc.className = 'gbox-cp-desc';
            desc.textContent = cmd.description;
            row.appendChild(desc);
          }
          if (cmd.shortcut) {
            var sc = document.createElement('div');
            sc.className = 'gbox-cp-shortcut';
            var parts = cmd.shortcut.split(/\\s+/);
            for (var j = 0; j < parts.length; j++) {
              var kbd = document.createElement('kbd');
              kbd.textContent = parts[j];
              sc.appendChild(kbd);
            }
            row.appendChild(sc);
          }
          list.appendChild(row);
        }

        // Scroll the active row into view.
        var active = list.querySelector('.gbox-cp-item-active');
        if (active && active.scrollIntoView) {
          active.scrollIntoView({ block: 'nearest' });
        }
      }

      // ---------- open/close ----------
      function openPalette() {
        var p = palette();
        if (!p) return;
        p.classList.remove('gbox-cp-hidden');
        selectedIndex = 0;
        currentResults = COMMANDS.slice();
        renderList();
        var input = p.querySelector('.gbox-cp-input');
        if (input) {
          input.value = '';
          input.focus();
        }
      }
      function closePalette() {
        var p = palette();
        if (!p) return;
        p.classList.add('gbox-cp-hidden');
      }
      window.gboxOpenPalette = openPalette;
      window.gboxClosePalette = closePalette;

      function selectCurrent() {
        var cmd = currentResults[selectedIndex];
        if (!cmd) return;
        closePalette();
        if (cmd.href) {
          window.location.href = cmd.href;
        } else {
          // Fire a custom event so pages can wire arbitrary actions.
          var ev;
          try {
            ev = new CustomEvent('gbox:command', { detail: cmd });
          } catch(e) {
            ev = document.createEvent('CustomEvent');
            ev.initCustomEvent('gbox:command', true, true, cmd);
          }
          window.dispatchEvent(ev);
        }
      }

      // ---------- event wiring ----------
      document.addEventListener('keydown', function(e){
        var p = palette();
        var isOpen = p && !p.classList.contains('gbox-cp-hidden');

        // Cmd+K / Ctrl+K toggles the palette.
        var key = (e.key || '').toLowerCase();
        if ((e.metaKey || e.ctrlKey) && key === 'k') {
          e.preventDefault();
          if (isOpen) closePalette(); else openPalette();
          return;
        }

        // Esc closes the palette.
        if (isOpen && e.key === 'Escape') {
          e.preventDefault();
          closePalette();
          return;
        }

        // Arrow navigation inside the palette.
        if (isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          if (currentResults.length === 0) return;
          if (e.key === 'ArrowDown') {
            selectedIndex = (selectedIndex + 1) % currentResults.length;
          } else {
            selectedIndex = (selectedIndex - 1 + currentResults.length) % currentResults.length;
          }
          renderList();
          return;
        }

        // Enter selects.
        if (isOpen && e.key === 'Enter') {
          e.preventDefault();
          selectCurrent();
          return;
        }

        // "?" opens the cheatsheet modal (only when no input is focused).
        if (!isOpen && !isInputFocused() && e.key === '?' && SHORTCUTS_MODAL_ID) {
          if (window.gboxOpenModal) {
            e.preventDefault();
            window.gboxOpenModal(SHORTCUTS_MODAL_ID);
          }
          return;
        }

        // "g" primes a go-to prefix.
        if (!isOpen && !isInputFocused() && key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          goPrefixActive = true;
          if (goPrefixTimer) clearTimeout(goPrefixTimer);
          goPrefixTimer = setTimeout(function(){ goPrefixActive = false; }, 2000);
          return;
        }

        // Second letter after "g" → navigate.
        if (goPrefixActive && !isOpen && !isInputFocused()) {
          var dest = BINDINGS[key];
          if (dest) {
            e.preventDefault();
            goPrefixActive = false;
            if (goPrefixTimer) clearTimeout(goPrefixTimer);
            window.location.href = dest;
            return;
          } else {
            // Any other key cancels.
            goPrefixActive = false;
            if (goPrefixTimer) clearTimeout(goPrefixTimer);
          }
        }

        // Phase G4: generic chord resolution. When a chord is armed
        // (chordFirst is set), any next printable key either resolves
        // the chord or clears it.
        if (!isOpen && !isInputFocused() && chordFirst) {
          if (key.length === 1) {
            var handled = resolveChord(key);
            clearChord();
            if (handled) { e.preventDefault(); return; }
            // Fall through — unmatched combos should not hijack the key.
          }
        }

        // Arm a chord when the first letter matches a registered chord
        // and the modifier-free single key belongs to the current scope.
        // We do this AFTER the "g" branch so the existing go-to shortcut
        // (which has its own prefix state) keeps priority.
        if (!isOpen && !isInputFocused() && !e.metaKey && !e.ctrlKey && !e.altKey
            && key.length === 1 && anyChordStartsWith(key)) {
          // Never shadow a single-key shortcut for the same letter —
          // single keys win because they don't need a second press.
          if (!matchSingleKey(key)) {
            primeChord(key);
            return;
          }
        }

        // Phase G4: single-key scoped shortcut (e.g. 'n' on the
        // clone-pro index opens the New clone modal or focuses the
        // "+ New clone" link).
        if (!isOpen && !isInputFocused() && !e.metaKey && !e.ctrlKey && !e.altKey
            && key.length === 1) {
          var sk = matchSingleKey(key);
          if (sk) {
            e.preventDefault();
            if (sk.href) window.location.href = sk.href;
            else if (sk.action) fireAction(sk.action, 'single');
            return;
          }
        }
      });

      // Palette input → live filter.
      document.addEventListener('input', function(e){
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains('gbox-cp-input')) return;
        currentResults = filterCmds(t.value);
        selectedIndex = 0;
        renderList();
      });

      // Click on a row or on the backdrop.
      document.addEventListener('click', function(e){
        var t = e.target;
        if (!t) return;
        if (t.getAttribute && t.getAttribute('data-cp-close') === '1') {
          closePalette();
          return;
        }
        // Walk up to .gbox-cp-item
        while (t && (!t.classList || !t.classList.contains('gbox-cp-item'))) {
          t = t.parentNode;
        }
        if (t && t.getAttribute) {
          var idx = parseInt(t.getAttribute('data-cp-index') || '-1', 10);
          if (idx >= 0) {
            selectedIndex = idx;
            selectCurrent();
          }
        }
      });
    })();
  `
}

export function keyboardCss(): string {
  return `
    /* Command palette overlay */
    .gbox-cp {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 15vh;
    }
    .gbox-cp-hidden { display: none; }
    .gbox-cp-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(2px);
    }
    .gbox-cp-panel {
      position: relative;
      width: 560px;
      max-width: calc(100vw - 32px);
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      background: var(--god-surface, #1f2937);
      border: 1px solid var(--god-border, rgba(255,255,255,0.1));
      border-radius: 10px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.35);
      overflow: hidden;
    }
    .gbox-cp-search {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--god-border, rgba(255,255,255,0.08));
    }
    .gbox-cp-search-icon {
      width: 16px;
      height: 16px;
      color: var(--god-text-secondary, #9ca3af);
      flex-shrink: 0;
    }
    .gbox-cp-input {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--god-text, #f3f4f6);
      font-size: 15px;
      font-family: inherit;
      outline: none;
    }
    .gbox-cp-input::placeholder {
      color: var(--god-text-secondary, #9ca3af);
    }
    .gbox-cp-esc {
      font-size: 11px;
      padding: 2px 6px;
      border: 1px solid var(--god-border, rgba(255,255,255,0.1));
      border-radius: 4px;
      color: var(--god-text-secondary, #9ca3af);
      background: var(--god-bg, #0f172a);
    }
    .gbox-cp-list {
      flex: 1;
      overflow-y: auto;
      padding: 6px;
    }
    .gbox-cp-group {
      padding: 10px 10px 4px;
      font-size: 10px;
      font-weight: 700;
      color: var(--god-text-secondary, #9ca3af);
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }
    .gbox-cp-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 12px;
      border-radius: 6px;
      cursor: pointer;
      color: var(--god-text, #f3f4f6);
    }
    .gbox-cp-item-active {
      background: var(--god-border-light, rgba(255,255,255,0.06));
    }
    .gbox-cp-label {
      font-size: 13px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .gbox-cp-desc {
      font-size: 12px;
      color: var(--god-text-secondary, #9ca3af);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .gbox-cp-shortcut {
      display: inline-flex;
      gap: 4px;
      margin-left: auto;
    }
    .gbox-cp-shortcut kbd {
      font-size: 10px;
      padding: 2px 5px;
      border: 1px solid var(--god-border, rgba(255,255,255,0.1));
      border-radius: 4px;
      color: var(--god-text-secondary, #9ca3af);
      background: var(--god-bg, #0f172a);
      font-family: inherit;
    }
    .gbox-cp-empty {
      padding: 24px;
      text-align: center;
      font-size: 13px;
      color: var(--god-text-secondary, #9ca3af);
    }
    .gbox-cp-footer {
      padding: 10px 14px;
      border-top: 1px solid var(--god-border, rgba(255,255,255,0.08));
      font-size: 11px;
      color: var(--god-text-secondary, #9ca3af);
      display: flex;
      gap: 4px;
    }
    .gbox-cp-footer kbd {
      font-size: 10px;
      padding: 2px 5px;
      border: 1px solid var(--god-border, rgba(255,255,255,0.1));
      border-radius: 4px;
      background: var(--god-bg, #0f172a);
      font-family: inherit;
    }

    /* Shortcuts cheatsheet */
    .gbox-ks { display: flex; flex-direction: column; gap: 16px; }
    .gbox-ks-group { display: flex; flex-direction: column; gap: 6px; }
    .gbox-ks-group-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--god-text-secondary, #9ca3af);
      margin: 0 0 4px;
    }
    .gbox-ks-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
      border-bottom: 1px solid var(--god-border, rgba(255,255,255,0.05));
    }
    .gbox-ks-desc {
      font-size: 13px;
      color: var(--god-text, #f3f4f6);
    }
    .gbox-ks-keys {
      display: inline-flex;
      gap: 4px;
    }
    .gbox-ks-keys kbd {
      font-size: 11px;
      padding: 2px 6px;
      border: 1px solid var(--god-border, rgba(255,255,255,0.1));
      border-radius: 4px;
      background: var(--god-bg, #0f172a);
      color: var(--god-text, #f3f4f6);
      font-family: inherit;
    }
  `
}
