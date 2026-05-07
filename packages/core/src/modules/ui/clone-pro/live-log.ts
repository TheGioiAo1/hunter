/**
 * LiveLog — monospace log region that tails a Server-Sent Events
 * stream. Used on the clone-pro detail page for the "⚙️ Runtime
 * log" panel. `role="log"` + `aria-live="polite"` + non-atomic so
 * screen readers announce only newly-appended lines.
 *
 * The server-rendered shell is an empty `<div>`; the runtime script
 * (emitted by `liveLogRuntimeScriptBody`) subscribes to the SSE URL,
 * appends a `.gbx-log-line` per event, and trims to `maxLines`.
 */

import { esc } from './esc.js'

export interface LiveLogProps {
  sseUrl: string
  maxLines?: number
  id?: string
}

export function renderLiveLog(p: LiveLogProps): string {
  const id = p.id ?? 'gbx-live-log'
  const max = p.maxLines ?? 200
  return `<div id="${esc(id)}" class="gbx-live-log" role="log" aria-live="polite" aria-atomic="false" data-sse-url="${esc(p.sseUrl)}" data-max-lines="${max}"></div>`
}

export function liveLogRuntimeScriptBody(): string {
  return `
(function(){
  var el = document.querySelector('.gbx-live-log[data-sse-url]');
  if (!el || !window.EventSource) return;
  var max = parseInt(el.getAttribute('data-max-lines') || '200', 10);
  var es = new EventSource(el.getAttribute('data-sse-url'), { withCredentials: true });
  function append(level, text){
    var line = document.createElement('div');
    line.className = 'gbx-log-line gbx-log-' + level;
    var ts = new Date().toISOString().slice(11,19);
    line.innerHTML = '<span class="gbx-log-ts">[' + ts + ']</span> ' + String(text).replace(/[&<>]/g, function(c){
      return { '&':'&amp;','<':'&lt;','>':'&gt;' }[c];
    });
    el.appendChild(line);
    while (el.children.length > max) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }
  es.addEventListener('log', function(e){
    try { var d = JSON.parse(e.data); append(d.level || 'info', d.text || ''); } catch(_){}
  });
  // When the backend emits 'job.finished' (status became terminal:
  // succeeded / failed / cancelled / published) we reload the page so
  // the SSR swaps from the in-flight shell (stepper + live log) to the
  // terminal shell (verification report, publish CTA, error banner).
  // Without this, the user sits on a "running" view forever even
  // though the job already completed server-side.
  var reloaded = false;
  function reloadOnce(){
    if (reloaded) return;
    reloaded = true;
    es.close();
    // Small delay so the final log line renders before we navigate.
    setTimeout(function(){ window.location.reload(); }, 800);
  }
  es.addEventListener('job.finished', function(){ reloadOnce(); });
  es.onerror = function(){ es.close(); };
})();`
}

export const liveLogCss = `
.gbx-live-log { font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;line-height:1.7;background:var(--surface-0);color:var(--text);padding:12px 14px;max-height:220px;overflow-y:auto;border-radius:6px;border:1px solid var(--border) }
.gbx-log-line { white-space:pre-wrap;word-break:break-word }
.gbx-log-ts { color:var(--text-muted);margin-right:6px }
.gbx-log-info { color:var(--text-muted) }
.gbx-log-success { color:var(--status-succeeded) }
.gbx-log-warn { color:var(--status-paused) }
.gbx-log-error { color:var(--status-failed) }
`
