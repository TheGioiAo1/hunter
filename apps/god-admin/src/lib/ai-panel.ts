/**
 * Gbox God Admin — AI Advisor Panel (reusable component)
 *
 * Renders the embedded AI chat panel that sits on every god-admin
 * detail page (order detail, store detail, customer detail, revenue
 * breakdown). The panel has three jobs:
 *
 *   1. Show a pre-computed "executive brief" the server generated
 *      on page load (via `analyzeContext()` from @gbox/core).
 *   2. Let the operator type follow-up questions.
 *   3. Keep a rolling chat history client-side and POST it + the
 *      board snapshot to `/god-admin/ai/chat` each turn.
 *
 * Why render this as a string builder instead of a framework
 * component?
 *   The god-admin surface is server-rendered HTML with small
 *   islands of vanilla JS — no React, no Vue, no Astro islands. A
 *   string builder matches the existing style in `god-layout.ts`
 *   and `dashboard.ts` and avoids dragging in a client bundler.
 *
 * The CSS is scoped behind `.god-ai-panel`. The JS is an IIFE that
 * attaches to a single root by id so multiple panels on the same
 * page (theoretical — we don't do that today) won't fight each
 * other.
 *
 * Copyright / injection posture:
 *   - The `initialInsight` is AI-generated text from the server —
 *     it's inserted via `textContent` inside the client-side
 *     bootstrap so there's no HTML injection surface even if the
 *     model returns HTML-ish content.
 *   - The `context` snapshot is JSON.stringify'd into a
 *     `<script type="application/json">` block which is the safest
 *     way to ship structured data to an inline script.
 */

import type { AdvisorContext } from '../../../../packages/core/src/modules/ai/advisor.js'

export interface AiPanelOptions {
  /**
   * The same snapshot the server passed to `analyzeContext()`. The
   * client echoes this back on every follow-up question so the
   * endpoint doesn't have to re-query the DB — a tradeoff for a
   * simpler server handler. Keep it small (<8kB JSON).
   */
  context: AdvisorContext
  /**
   * Optional pre-computed initial brief from `analyzeContext()`.
   * Rendered immediately in the conversation area so the operator
   * gets value on first paint without having to type anything.
   */
  initialInsight?: string
  /**
   * CSRF token issued by the surrounding page handler via
   * `aiPanelCsrf.issue(res, isProduction)`. The hydration JS puts
   * this in the POST body as `_csrf`.
   */
  csrfToken: string
  /**
   * POST endpoint that handles follow-up chat turns. Default is
   * the canonical `/god-admin/ai/chat`.
   */
  endpoint?: string
  /**
   * DOM id for the panel root — must be unique on the page. Default
   * `god-ai-panel`.
   */
  id?: string
}

/**
 * Returned when `isAiConfigured()` is false — the host page calls
 * this instead of `renderAiPanel()` so the rest of the board still
 * loads. Intentionally styled to look like a disabled version of
 * the real panel so the layout doesn't jump.
 */
export function renderAiPanelUnconfigured(opts: { reason?: string } = {}): string {
  const reason =
    opts.reason ??
    'Set ANTHROPIC_API_KEY (and AI_ENABLED=true) in the god-admin .env to enable the AI advisor.'
  return `
    ${AI_PANEL_CSS}
    <div class="god-ai-panel god-ai-panel--disabled" role="complementary" aria-label="AI Advisor (disabled)">
      <div class="god-ai-panel__header">
        <div class="god-ai-panel__title">
          <span class="god-ai-panel__dot god-ai-panel__dot--off"></span>
          AI Advisor
        </div>
        <span class="god-ai-panel__badge">Not configured</span>
      </div>
      <div class="god-ai-panel__body">
        <p class="god-ai-panel__empty">${escHtml(reason)}</p>
      </div>
    </div>
  `
}

/**
 * Main panel. Returns a string that can be dropped into a detail
 * page's `content` template literal.
 */
export function renderAiPanel(opts: AiPanelOptions): string {
  const panelId = opts.id ?? 'god-ai-panel'
  const endpoint = opts.endpoint ?? '/god-admin/ai/chat'
  const initialInsight = opts.initialInsight ?? ''
  // Serialise the context for an inline JSON script tag. JSON.stringify
  // escapes quotes but NOT `</script>`, so we do the closing-tag
  // escape ourselves — standard technique for embedding JSON in HTML.
  const contextJson = JSON.stringify(opts.context).replace(/</g, '\\u003c')

  return `
    ${AI_PANEL_CSS}
    <div id="${escAttr(panelId)}" class="god-ai-panel" role="complementary" aria-label="AI Advisor">
      <div class="god-ai-panel__header">
        <div class="god-ai-panel__title">
          <span class="god-ai-panel__dot"></span>
          AI Advisor
        </div>
        <span class="god-ai-panel__badge god-ai-panel__badge--live">Live</span>
      </div>

      <div class="god-ai-panel__body" data-role="conversation">
        ${
          initialInsight
            ? `
          <div class="god-ai-msg god-ai-msg--assistant" data-role="initial-brief">
            <div class="god-ai-msg__label">Executive brief</div>
            <div class="god-ai-msg__content"></div>
          </div>
        `
            : `
          <div class="god-ai-msg god-ai-msg--assistant">
            <div class="god-ai-msg__label">AI Advisor</div>
            <div class="god-ai-msg__content">Ask me anything about this board — orders, customers, fulfillment, revenue trends.</div>
          </div>
        `
        }
      </div>

      <form class="god-ai-panel__form" data-role="form" autocomplete="off">
        <textarea
          name="question"
          rows="2"
          placeholder="Ask about this board… (Enter to send, Shift+Enter for newline)"
          maxlength="2000"
          required
        ></textarea>
        <div class="god-ai-panel__form-row">
          <span class="god-ai-panel__hint" data-role="hint">Powered by Claude · responses may be imperfect</span>
          <button type="submit" class="god-ai-panel__send">Send</button>
        </div>
      </form>

      <script type="application/json" data-role="context">${contextJson}</script>
      <script type="application/json" data-role="csrf">${JSON.stringify(opts.csrfToken).replace(/</g, '\\u003c')}</script>
      ${initialInsight ? `<script type="application/json" data-role="initial-brief-text">${JSON.stringify(initialInsight).replace(/</g, '\\u003c')}</script>` : ''}
    </div>
    <script>${renderPanelScript(panelId, endpoint)}</script>
  `
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/**
 * Panel styles. Deliberately uses the god-layout CSS variables
 * (`--surface`, `--border`, `--text-primary`, etc.) so it
 * automatically adapts to the theme toggle without a re-render.
 */
const AI_PANEL_CSS = `<style>
  .god-ai-panel {
    background: var(--surface, #ffffff);
    border: 1px solid var(--border, #e2e8f0);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: inherit;
    min-height: 320px;
    max-height: 640px;
  }
  .god-ai-panel--disabled { opacity: 0.75; }

  .god-ai-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border, #e2e8f0);
    background: var(--surface-hover, #f8fafc);
  }
  .god-ai-panel__title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--text-primary, #0f172a);
    text-transform: uppercase;
  }
  .god-ai-panel__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #10b981;
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18);
    animation: godAiPulse 2.2s ease-in-out infinite;
  }
  .god-ai-panel__dot--off {
    background: #94a3b8;
    box-shadow: none;
    animation: none;
  }
  @keyframes godAiPulse {
    0%, 100% { box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18); }
    50%      { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0.0); }
  }
  .god-ai-panel__badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--surface, #ffffff);
    border: 1px solid var(--border, #e2e8f0);
    color: var(--text-secondary, #64748b);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .god-ai-panel__badge--live {
    background: rgba(16, 185, 129, 0.12);
    border-color: rgba(16, 185, 129, 0.3);
    color: #059669;
  }

  .god-ai-panel__body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    scroll-behavior: smooth;
  }
  .god-ai-panel__empty {
    margin: 0;
    color: var(--text-secondary, #64748b);
    font-size: 13px;
    line-height: 1.5;
  }

  .god-ai-msg {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.55;
    max-width: 100%;
  }
  .god-ai-msg--assistant {
    background: var(--surface-hover, #f1f5f9);
    border: 1px solid var(--border, #e2e8f0);
    color: var(--text-primary, #0f172a);
  }
  .god-ai-msg--user {
    align-self: flex-end;
    background: var(--primary, #3b82f6);
    color: #ffffff;
    border: 1px solid var(--primary, #3b82f6);
    max-width: 85%;
  }
  .god-ai-msg--error {
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #b91c1c;
  }
  .god-ai-msg__label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.7;
  }
  .god-ai-msg__content {
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .god-ai-msg__content p { margin: 0 0 6px 0; }
  .god-ai-msg__content p:last-child { margin-bottom: 0; }
  .god-ai-msg__content ul, .god-ai-msg__content ol {
    margin: 4px 0 4px 18px;
    padding: 0;
  }
  .god-ai-msg--thinking .god-ai-msg__content::after {
    content: '…';
    animation: godAiDots 1.2s steps(4, end) infinite;
  }
  @keyframes godAiDots {
    0%,20% { content: ''; }
    40%    { content: '.'; }
    60%    { content: '..'; }
    80%,100% { content: '...'; }
  }

  .god-ai-panel__form {
    border-top: 1px solid var(--border, #e2e8f0);
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--surface, #ffffff);
  }
  .god-ai-panel__form textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border, #e2e8f0);
    background: var(--surface, #ffffff);
    color: var(--text-primary, #0f172a);
    font-family: inherit;
    font-size: 13px;
    line-height: 1.45;
  }
  .god-ai-panel__form textarea:focus {
    outline: none;
    border-color: var(--primary, #3b82f6);
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.12);
  }
  .god-ai-panel__form-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .god-ai-panel__hint {
    font-size: 11px;
    color: var(--text-secondary, #94a3b8);
  }
  .god-ai-panel__send {
    appearance: none;
    border: none;
    padding: 7px 16px;
    border-radius: 8px;
    background: var(--primary, #3b82f6);
    color: #ffffff;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s;
  }
  .god-ai-panel__send:hover:not(:disabled) { background: #2563eb; }
  .god-ai-panel__send:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>`

// ---------------------------------------------------------------------------
// Client-side hydration script
// ---------------------------------------------------------------------------

/**
 * The IIFE that hydrates the panel. Reads the embedded JSON context
 * + csrf token, binds the form submit handler, posts to the chat
 * endpoint, appends messages. No framework, no bundler, ~50 lines.
 */
function renderPanelScript(panelId: string, endpoint: string): string {
  return `(function(){
  var root = document.getElementById(${JSON.stringify(panelId)});
  if (!root) return;

  var conv = root.querySelector('[data-role="conversation"]');
  var form = root.querySelector('[data-role="form"]');
  var textarea = form.querySelector('textarea');
  var sendBtn = form.querySelector('button[type="submit"]');
  var hint = root.querySelector('[data-role="hint"]');
  var contextEl = root.querySelector('[data-role="context"]');
  var csrfEl = root.querySelector('[data-role="csrf"]');
  var initialEl = root.querySelector('[data-role="initial-brief-text"]');
  var initialHolder = conv.querySelector('[data-role="initial-brief"] .god-ai-msg__content');

  var ctx, csrf;
  try { ctx = JSON.parse(contextEl.textContent || '{}'); } catch(e) { ctx = null; }
  try { csrf = JSON.parse(csrfEl.textContent || '""'); } catch(e) { csrf = ''; }

  // Paint initial brief via textContent so markdown/html can't inject.
  if (initialHolder && initialEl) {
    try {
      var text = JSON.parse(initialEl.textContent || '""');
      renderText(initialHolder, text);
    } catch(e) {}
  }

  // History = what we actually sent (user) + what we got back
  // (assistant). We DO NOT include the initial brief here — it was
  // rendered from a synthetic "give me the brief" call on the
  // server, and including it in follow-up context would bloat every
  // subsequent request.
  var history = [];

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    submit();
  });
  textarea.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  function submit() {
    var q = (textarea.value || '').trim();
    if (!q) return;
    textarea.value = '';
    sendBtn.disabled = true;
    if (hint) hint.textContent = 'Thinking…';

    appendMsg('user', q, 'You');
    var thinkingNode = appendMsg('assistant', '', 'AI Advisor', true);

    fetch(${JSON.stringify(endpoint)}, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _csrf: csrf,
        context: ctx,
        history: history.slice(-10), // keep last 10 turns to cap tokens
        question: q,
      }),
    }).then(function(r) {
      if (!r.ok) {
        return r.text().then(function(t) { throw new Error('HTTP ' + r.status + ': ' + (t || r.statusText)); });
      }
      return r.json();
    }).then(function(data) {
      thinkingNode.classList.remove('god-ai-msg--thinking');
      var contentEl = thinkingNode.querySelector('.god-ai-msg__content');
      renderText(contentEl, data.text || '(no response)');
      history.push({ role: 'user', content: q });
      history.push({ role: 'assistant', content: data.text || '' });
      if (hint) hint.textContent = 'Powered by Claude · responses may be imperfect';
    }).catch(function(err) {
      thinkingNode.classList.remove('god-ai-msg--thinking');
      thinkingNode.classList.remove('god-ai-msg--assistant');
      thinkingNode.classList.add('god-ai-msg--error');
      var contentEl = thinkingNode.querySelector('.god-ai-msg__content');
      var labelEl = thinkingNode.querySelector('.god-ai-msg__label');
      if (labelEl) labelEl.textContent = 'Error';
      if (contentEl) contentEl.textContent = String(err && err.message || err);
      if (hint) hint.textContent = 'Request failed — try again';
    }).then(function() {
      sendBtn.disabled = false;
      conv.scrollTop = conv.scrollHeight;
      textarea.focus();
    });
  }

  function appendMsg(kind, text, label, thinking) {
    var div = document.createElement('div');
    div.className = 'god-ai-msg god-ai-msg--' + kind + (thinking ? ' god-ai-msg--thinking' : '');
    var lbl = document.createElement('div');
    lbl.className = 'god-ai-msg__label';
    lbl.textContent = label;
    var body = document.createElement('div');
    body.className = 'god-ai-msg__content';
    if (text) renderText(body, text);
    div.appendChild(lbl);
    div.appendChild(body);
    conv.appendChild(div);
    conv.scrollTop = conv.scrollHeight;
    return div;
  }

  // Lightweight markdown-ish renderer: splits into paragraphs on
  // double-newline and auto-bullets lines starting with '- ' or '* '.
  // No HTML allowed — everything goes through textContent. Not a
  // full markdown parser, but enough for model output tuned to
  // short bullet lists.
  function renderText(el, text) {
    el.innerHTML = '';
    var paragraphs = String(text).split(/\\n{2,}/);
    paragraphs.forEach(function(p) {
      var lines = p.split(/\\n/).filter(function(l) { return l.trim().length > 0; });
      if (lines.length === 0) return;
      var isList = lines.every(function(l) { return /^\\s*[-*]\\s+/.test(l); });
      if (isList) {
        var ul = document.createElement('ul');
        lines.forEach(function(l) {
          var li = document.createElement('li');
          li.textContent = l.replace(/^\\s*[-*]\\s+/, '');
          ul.appendChild(li);
        });
        el.appendChild(ul);
      } else {
        var pEl = document.createElement('p');
        pEl.textContent = lines.join(' ');
        el.appendChild(pEl);
      }
    });
  }
})();`
}

// ---------------------------------------------------------------------------
// HTML escape helpers (duplicated from dashboard.ts for locality)
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escAttr(s: string): string {
  return escHtml(s)
}
