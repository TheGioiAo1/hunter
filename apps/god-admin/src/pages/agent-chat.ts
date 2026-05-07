/**
 * God Admin — Agent Chat Panel
 *
 * GET  /god-admin/agent                   — render the chat page
 * POST /god-admin/agent/chat-proxy        — proxy chat turn to sidecar
 * POST /god-admin/agent/kill-proxy        — proxy kill to sidecar
 * POST /god-admin/agent/approval-proxy    — proxy tier-3 approval to sidecar
 * POST /god-admin/agent/killswitch        — touch/unlink the killswitch file
 *
 * Architecture:
 *   - The dashboard does NOT talk to the model directly. It mints
 *     a short-lived internal JWT (signInternalJwt from agent-core)
 *     and forwards the chat body to the sidecar on :4326.
 *   - The sidecar's SSE stream is piped byte-for-byte back to the
 *     browser so the client-side script (agent-chat-client.ts) can
 *     parse `event: <type>` + `data: <json>` frames directly.
 *
 * Security:
 *   - Only the Default God Admin (level 0) can reach these routes.
 *     The existing god-auth middleware enforces that globally.
 *   - The internal JWT is minted per-request and lasts 5 minutes.
 *     Even if the HS256 secret leaks to the LAN, an attacker still
 *     has to ALSO phish a god-admin session cookie.
 */

import type { Request, Response } from 'express'
import { existsSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { signInternalJwt } from '@gbox/agent-core'
import { godLayout } from '../layouts/god-layout.js'

// ---------------------------------------------------------------------------
// Config — sidecar URL + shared JWT secret
// ---------------------------------------------------------------------------

function sidecarBaseUrl(): string {
  return process.env.AGENT_SIDECAR_URL ?? 'http://127.0.0.1:4326'
}

function jwtSecret(): string {
  const secret = process.env.AGENT_INTERNAL_JWT_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      'AGENT_INTERNAL_JWT_SECRET must be set to a 32+ character string ' +
        '(matching the sidecar). Use `openssl rand -hex 32`.',
    )
  }
  return secret
}

function killswitchPath(): string {
  return process.env.AGENT_KILLSWITCH_FILE ?? '/srv/gbox-platform/.agent-killswitch'
}

/**
 * Synchronous on-disk check of the killswitch flag. Only called at
 * page-render time (not in the hot request path), so a sync stat is
 * the cheapest and most honest way to ask "is the brake pulled?".
 * Falls back to `false` on any filesystem error (e.g. permission
 * denied in dev) — the dedicated /agent/killswitch POST route still
 * enforces the real authority, this is just the header badge.
 */
function isKillswitchEngaged(): boolean {
  try {
    return existsSync(killswitchPath())
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/agent — render the chat panel page
// ---------------------------------------------------------------------------

export function getAgentChat(req: Request, res: Response): void {
  const user = req.godAdmin!.user
  const isDefault = req.godAdmin?.isDefaultAdmin === true

  if (!isDefault) {
    res.status(403).send(
      godLayout({
        title: 'Agent — God Admin only',
        userEmail: user.email,
        userName: user.name ?? undefined,
        isDefaultAdmin: false,
        activePath: '/god-admin/agent/chat',
        content: `
          <div class="card" style="max-width:640px;margin:40px auto;">
            <h1>Agent Chat</h1>
            <p style="color:var(--text-secondary)">
              The AI pair-programmer is only accessible to the
              <strong>Default God Admin</strong> (level 0). Your session
              does not have that level — contact the owner at
              buithai3107@gmail.com if you need access.
            </p>
          </div>`,
      }),
    )
    return
  }

  res.send(
    godLayout({
      title: 'Agent — Pair Programmer',
      userEmail: user.email,
      userName: user.name ?? undefined,
      isDefaultAdmin: true,
      activePath: '/god-admin/agent/chat',
      content: renderChatPanelHtml({ killswitchEngaged: isKillswitchEngaged() }),
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /god-admin/agent/chat-proxy — forward chat turn to sidecar SSE
// ---------------------------------------------------------------------------

export async function postAgentChatProxy(req: Request, res: Response): Promise<void> {
  const godAdmin = req.godAdmin
  if (!godAdmin || !godAdmin.isDefaultAdmin) {
    res.status(403).json({ error: 'default_god_admin_required' })
    return
  }

  const body = req.body as { aid?: string | null; text?: string } | undefined
  if (!body || typeof body.text !== 'string' || body.text.length === 0) {
    res.status(400).json({ error: 'text_required' })
    return
  }

  const aid = (body.aid && typeof body.aid === 'string' ? body.aid : 'pending')
  const token = await signInternalJwt({
    sid: godAdmin.user.id,
    aid,
    secret: jwtSecret(),
  })

  // Configure the upstream request.
  const upstreamUrl = `${sidecarBaseUrl()}/agent/chat`
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  let upstream: globalThis.Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ aid: body.aid ?? null, text: body.text }),
      signal: controller.signal,
    })
  } catch (err) {
    res.status(502).json({ error: 'sidecar_unreachable', message: (err as Error).message })
    return
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    res.status(upstream.status).json({
      error: 'sidecar_rejected',
      status: upstream.status,
      body: text.slice(0, 500),
    })
    return
  }

  // Pipe SSE back to the client.
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  } catch {
    // upstream or downstream aborted — nothing to do
  } finally {
    try {
      res.end()
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/agent/kill-proxy — forward kill to sidecar
// ---------------------------------------------------------------------------

export async function postAgentKillProxy(req: Request, res: Response): Promise<void> {
  const godAdmin = req.godAdmin
  if (!godAdmin || !godAdmin.isDefaultAdmin) {
    res.status(403).json({ error: 'default_god_admin_required' })
    return
  }
  const body = req.body as { aid?: string } | undefined
  if (!body?.aid) {
    res.status(400).json({ error: 'aid_required' })
    return
  }
  const token = await signInternalJwt({
    sid: godAdmin.user.id,
    aid: body.aid,
    secret: jwtSecret(),
  })
  try {
    const upstream = await fetch(`${sidecarBaseUrl()}/agent/kill`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ aid: body.aid }),
    })
    res.status(upstream.status).send(await upstream.text())
  } catch (err) {
    res.status(502).json({ error: 'sidecar_unreachable', message: (err as Error).message })
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/agent/approval-proxy — forward a tier-3 approval decision
//
// Request body: { aid: string, toolCallId: string, decision: 'approved'|'denied' }
// Response mirrors the sidecar (200 ok / 404 no_pending_approval / 400 invalid_body).
// The sidecar fans the decision back through the chat SSE stream as
// `approval_resolved`, so this endpoint is fire-and-forget from the UI's
// point of view (aside from surfacing 4xx to the caller).
// ---------------------------------------------------------------------------

export async function postAgentApprovalProxy(req: Request, res: Response): Promise<void> {
  const godAdmin = req.godAdmin
  if (!godAdmin || !godAdmin.isDefaultAdmin) {
    res.status(403).json({ error: 'default_god_admin_required' })
    return
  }
  const body = req.body as
    | { aid?: string; toolCallId?: string; decision?: string }
    | undefined
  const aid = body?.aid
  const toolCallId = body?.toolCallId
  const decision = body?.decision
  if (typeof aid !== 'string' || aid.length === 0) {
    res.status(400).json({ error: 'invalid_body', reason: 'aid is required' })
    return
  }
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    res.status(400).json({ error: 'invalid_body', reason: 'toolCallId is required' })
    return
  }
  if (decision !== 'approved' && decision !== 'denied') {
    res
      .status(400)
      .json({ error: 'invalid_body', reason: 'decision must be approved|denied' })
    return
  }
  const token = await signInternalJwt({
    sid: godAdmin.user.id,
    aid,
    secret: jwtSecret(),
  })
  try {
    const upstream = await fetch(`${sidecarBaseUrl()}/agent/approval`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ aid, toolCallId, decision }),
    })
    res
      .status(upstream.status)
      .type('application/json')
      .send(await upstream.text())
  } catch (err) {
    res
      .status(502)
      .json({ error: 'sidecar_unreachable', message: (err as Error).message })
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/agent/killswitch — touch or unlink the killswitch file
// ---------------------------------------------------------------------------

export async function postAgentKillswitch(req: Request, res: Response): Promise<void> {
  const godAdmin = req.godAdmin
  if (!godAdmin || !godAdmin.isDefaultAdmin) {
    res.status(403).json({ error: 'default_god_admin_required' })
    return
  }
  const body = req.body as { action?: 'engage' | 'disengage' } | undefined
  const action = body?.action
  if (action !== 'engage' && action !== 'disengage') {
    res.status(400).json({ error: 'action_must_be_engage_or_disengage' })
    return
  }
  const path = killswitchPath()
  try {
    if (action === 'engage') {
      await writeFile(path, `engaged by ${godAdmin.user.email} at ${new Date().toISOString()}\n`)
    } else {
      try {
        await unlink(path)
      } catch (err) {
        // ENOENT is fine — already disengaged.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    // `state` is the post-action truth of the brake; the client uses
    // it to flip its UI without a round-trip stat call. `action` is
    // kept for backwards compat with the original v1 callers.
    res.json({ ok: true, action, path, state: action === 'engage' ? 'engaged' : 'disengaged' })
  } catch (err) {
    res.status(500).json({ error: 'killswitch_write_failed', message: (err as Error).message })
  }
}

// ---------------------------------------------------------------------------
// HTML — chat panel shell. All client-side logic is inlined below so
// there is no build step in god-admin for static assets.
// ---------------------------------------------------------------------------

interface RenderChatPanelProps {
  /**
   * Initial killswitch state, read at render time via `existsSync`.
   * The client tracks its own state after the first toggle, but the
   * very first paint needs to reflect reality so admins don't see a
   * stale "Engage" button on a sidecar that's already frozen.
   */
  killswitchEngaged: boolean
}

function renderChatPanelHtml(props: RenderChatPanelProps): string {
  const ks = props.killswitchEngaged
  // Header button state is built from a single source of truth so the
  // SSR initial paint and the client-side toggle share vocabulary.
  const ksLabel = ks ? 'Disengage killswitch' : 'Engage killswitch'
  const ksStateClass = ks ? 'is-engaged' : 'is-safe'
  const ksStateText = ks ? '🔴 Killswitch engaged' : '🟢 Sidecar live'
  return `
    <style>
      .agent-chat { display:flex; flex-direction:column; height:calc(100vh - 120px); max-width:960px; margin:0 auto; gap:12px; }
      .agent-chat__header { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:var(--surface-1); border:1px solid var(--border); border-radius:8px; gap:12px; }
      .agent-chat__header-left { min-width:0; }
      .agent-chat__header-right { display:flex; align-items:center; gap:10px; flex-shrink:0; }
      .agent-chat__title { font-weight:600; font-size:14px; color:var(--text-primary); }
      .agent-chat__status { font-size:12px; color:var(--text-secondary); }
      .agent-chat__status.is-error { color:var(--red); }
      .agent-chat__status.is-streaming { color:var(--blue); }

      /* Context-usage pill (spec §8 state 2) */
      .agent-chat__context-pill {
        display:inline-flex; align-items:center; gap:6px;
        padding:4px 10px; background:var(--surface-0); border:1px solid var(--border);
        border-radius:999px; font-size:11px;
        font-family:ui-monospace, 'SF Mono', Menlo, monospace;
        color:var(--text-secondary);
      }
      .agent-chat__context-pill.is-warn { color:#b45309; border-color:#f59e0b; background:#fef3c7; }
      .agent-chat__context-pill.is-danger { color:#b91c1c; border-color:#ef4444; background:#fee2e2; }
      .agent-chat__context-label { font-weight:600; letter-spacing:0.04em; text-transform:uppercase; }
      .agent-chat__context-value { font-variant-numeric:tabular-nums; }

      .agent-chat__messages { flex:1; overflow-y:auto; padding:16px; background:var(--surface-0); border:1px solid var(--border); border-radius:8px; font-family:ui-monospace, 'SF Mono', Menlo, monospace; font-size:13px; line-height:1.6; }
      .agent-chat__msg { margin-bottom:16px; }
      .agent-chat__msg-role { font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.5px; margin-bottom:4px; color:var(--text-secondary); }
      .agent-chat__msg--user .agent-chat__msg-role { color:var(--blue); }
      .agent-chat__msg--assistant .agent-chat__msg-role { color:var(--green); }
      .agent-chat__msg--tool .agent-chat__msg-role { color:var(--purple, #a855f7); }
      .agent-chat__msg--error .agent-chat__msg-role { color:var(--red); }
      .agent-chat__msg-body { white-space:pre-wrap; word-break:break-word; color:var(--text-primary); }

      /* Collapsible tool output (spec §8 "collapsible on long tool outputs") */
      .agent-chat__msg-body--collapsible { position:relative; max-height:6em; overflow:hidden; cursor:pointer; }
      .agent-chat__msg-body--collapsible::after {
        content:"▾ click to expand";
        position:absolute; left:0; right:0; bottom:0;
        padding:2px 4px; text-align:center;
        background:linear-gradient(to bottom, transparent, var(--surface-0) 70%);
        color:var(--text-secondary); font-size:10px; letter-spacing:0.04em;
      }
      .agent-chat__msg-body--expanded { max-height:none; cursor:zoom-out; }
      .agent-chat__msg-body--expanded::after { content:"▴ click to collapse"; background:transparent; position:static; display:block; margin-top:4px; }

      /* Choice cards (spec §8 "<choices> markdown block → A/B/C/D buttons") */
      .agent-chat__choices { display:flex; flex-direction:column; gap:6px; margin-top:8px; padding:10px; background:var(--surface-0); border:1px dashed var(--border); border-radius:6px; }
      .agent-chat__choices-hint { font-size:10px; color:var(--text-secondary); letter-spacing:0.04em; text-transform:uppercase; }
      .agent-chat__choice { display:flex; align-items:flex-start; gap:8px; padding:8px 12px; background:var(--surface-1); border:1px solid var(--border); border-radius:6px; color:var(--text-primary); cursor:pointer; font:inherit; font-size:13px; text-align:left; line-height:1.45; transition:background 120ms, border-color 120ms; }
      .agent-chat__choice:hover { background:var(--blue); color:#fff; border-color:var(--blue); }
      .agent-chat__choice-letter { font-weight:700; color:var(--blue); min-width:1.2em; }
      .agent-chat__choice:hover .agent-chat__choice-letter { color:#fff; }

      /* System notices (compact_triggered, killswitch toggle, etc.) */
      .agent-chat__notice { margin:8px 0; padding:6px 10px; background:var(--surface-0); border-left:3px solid var(--blue); border-radius:4px; color:var(--text-secondary); font-size:11px; }

      /* Session ID pill (spec §8 state 2 header — "session ID") */
      .agent-chat__session-pill {
        display:inline-flex; align-items:center; gap:6px;
        padding:4px 10px; background:var(--surface-0); border:1px solid var(--border);
        border-radius:999px; font-size:11px;
        font-family:ui-monospace, 'SF Mono', Menlo, monospace;
        color:var(--text-secondary); text-decoration:none;
      }
      .agent-chat__session-pill:hover { color:var(--blue); border-color:var(--blue); }
      .agent-chat__session-pill[aria-disabled="true"] { opacity:0.6; pointer-events:none; }
      .agent-chat__session-label { font-weight:600; letter-spacing:0.04em; text-transform:uppercase; }
      .agent-chat__session-value { font-variant-numeric:tabular-nums; }

      /* Killswitch state pill (Phase B PR-3 — Gap #13). Shown next to
         the toggle button so admins always see the current brake state
         without having to guess from the button label alone. */
      .agent-chat__killswitch-state {
        display:inline-flex; align-items:center;
        padding:4px 10px; border-radius:999px;
        font-size:11px; font-weight:600; letter-spacing:0.04em;
      }
      .agent-chat__killswitch-state.is-safe { color:#047857; background:#d1fae5; border:1px solid #10b981; }
      .agent-chat__killswitch-state.is-engaged { color:#b91c1c; background:#fee2e2; border:1px solid #ef4444; }
      .agent-chat__btn--warn { background:#f59e0b; color:#fff; border-color:#f59e0b; }

      .agent-chat__composer { display:flex; gap:8px; padding:12px; background:var(--surface-1); border:1px solid var(--border); border-radius:8px; }
      .agent-chat__composer-input { display:flex; flex-direction:column; gap:4px; flex:1; min-width:0; }
      .agent-chat__textarea { min-height:60px; max-height:200px; resize:vertical; padding:8px 12px; background:var(--surface-0); border:1px solid var(--border); border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:13px; }
      .agent-chat__hint { font-size:10px; color:var(--text-secondary); text-align:right; }
      .agent-chat__buttons { display:flex; flex-direction:column; gap:8px; }
      .agent-chat__btn { padding:8px 16px; border-radius:6px; border:1px solid var(--border); background:var(--surface-0); color:var(--text-primary); cursor:pointer; font-size:13px; font-weight:500; }
      .agent-chat__btn--primary { background:var(--blue); color:#fff; border-color:var(--blue); }
      .agent-chat__btn--primary:disabled { opacity:0.5; cursor:not-allowed; }
      .agent-chat__btn--danger { background:var(--red); color:#fff; border-color:var(--red); }
      .agent-chat__approval { margin:8px 0 16px; padding:12px 14px; background:var(--yellow-bg, #fef3c7); border:1px solid var(--yellow, #f59e0b); border-radius:8px; color:#78350f; font-size:13px; line-height:1.5; }
      .agent-chat__approval-head { display:flex; align-items:center; gap:8px; font-weight:600; margin-bottom:4px; }
      .agent-chat__approval-badge { display:inline-block; padding:2px 8px; border-radius:4px; background:#f59e0b; color:#fff; font-size:10px; text-transform:uppercase; letter-spacing:0.5px; }
      .agent-chat__approval-name { font-family:ui-monospace, 'SF Mono', Menlo, monospace; color:#78350f; }
      .agent-chat__approval-input { margin:6px 0; padding:8px 10px; background:rgba(255,255,255,0.6); border-radius:4px; font-family:ui-monospace, 'SF Mono', Menlo, monospace; font-size:12px; color:#451a03; word-break:break-word; max-height:160px; overflow:auto; }
      .agent-chat__approval-actions { display:flex; gap:8px; margin-top:10px; }
      .agent-chat__approval-btn { padding:6px 14px; border-radius:6px; border:1px solid transparent; cursor:pointer; font-size:13px; font-weight:500; }
      .agent-chat__approval-btn--approve { background:#16a34a; color:#fff; border-color:#16a34a; }
      .agent-chat__approval-btn--deny { background:#fff; color:#b91c1c; border-color:#b91c1c; }
      .agent-chat__approval-btn:disabled { opacity:0.6; cursor:not-allowed; }
      .agent-chat__approval.is-resolved { opacity:0.75; }
      .agent-chat__approval.is-resolved.decision-approved { background:#dcfce7; border-color:#16a34a; color:#14532d; }
      .agent-chat__approval.is-resolved.decision-denied { background:#fee2e2; border-color:#b91c1c; color:#7f1d1d; }
      .agent-chat__approval.is-resolved.decision-timeout { background:var(--surface-1); border-color:var(--border); color:var(--text-secondary); }
      .agent-chat__approval-status { margin-top:6px; font-size:12px; font-style:italic; }
    </style>
    <div class="agent-chat" data-killswitch-engaged="${ks ? 'true' : 'false'}">
      <div class="agent-chat__header">
        <div class="agent-chat__header-left">
          <div class="agent-chat__title">Gbox Pair Programmer</div>
          <div class="agent-chat__status" id="agent-status">idle</div>
        </div>
        <div class="agent-chat__header-right">
          <a class="agent-chat__session-pill" id="agent-session-pill" href="#"
             aria-disabled="true" title="Session ID — click to open replay once the first turn starts">
            <span class="agent-chat__session-label">Session</span>
            <span class="agent-chat__session-value" id="agent-session-value">—</span>
          </a>
          <div class="agent-chat__context-pill" id="agent-context" title="Approximate context tokens used · updates on compact events"
               aria-label="Context usage">
            <span class="agent-chat__context-label">Context</span>
            <span class="agent-chat__context-value" id="agent-context-value">— / 180k</span>
          </div>
          <span class="agent-chat__killswitch-state ${ksStateClass}" id="agent-killswitch-state" aria-live="polite">${ksStateText}</span>
          <button class="agent-chat__btn ${ks ? 'agent-chat__btn--warn' : 'agent-chat__btn--danger'}" id="agent-killswitch-btn"
                  type="button" data-action="${ks ? 'disengage' : 'engage'}">${ksLabel}</button>
        </div>
      </div>
      <div class="agent-chat__messages" id="agent-messages" aria-live="polite"></div>
      <div class="agent-chat__composer">
        <div class="agent-chat__composer-input">
          <textarea class="agent-chat__textarea" id="agent-input" placeholder="Describe what you need…" autocomplete="off"></textarea>
          <div class="agent-chat__hint">Enter to send · Shift+Enter for newline</div>
        </div>
        <div class="agent-chat__buttons">
          <button class="agent-chat__btn agent-chat__btn--primary" id="agent-send-btn" type="button">Send</button>
          <button class="agent-chat__btn" id="agent-stop-btn" type="button" disabled>Stop</button>
        </div>
      </div>
    </div>
    <script>${agentChatClientScript()}</script>`
}

// ---------------------------------------------------------------------------
// Inline client script (pure vanilla JS).
// ---------------------------------------------------------------------------

function agentChatClientScript(): string {
  return `
  (function() {
    var messagesEl = document.getElementById('agent-messages');
    var inputEl = document.getElementById('agent-input');
    var sendBtn = document.getElementById('agent-send-btn');
    var stopBtn = document.getElementById('agent-stop-btn');
    var killBtn = document.getElementById('agent-killswitch-btn');
    var killState = document.getElementById('agent-killswitch-state');
    var statusEl = document.getElementById('agent-status');
    var contextPill = document.getElementById('agent-context');
    var contextValue = document.getElementById('agent-context-value');
    var sessionPill = document.getElementById('agent-session-pill');
    var sessionValue = document.getElementById('agent-session-value');

    var currentAid = null;
    var currentAssistant = null;
    var currentAbort = null;
    // toolCallId → { root, statusEl, approveBtn, denyBtn } for in-flight approvals.
    // We also keep resolved cards around so late 'approval_resolved' events can still find them.
    var approvalCards = Object.create(null);

    // -----------------------------------------------------------------
    // Context-usage tracking (spec §6.1 thresholds: 140k warn / 160k compact / 180k ceiling)
    // -----------------------------------------------------------------
    var CONTEXT_BUDGET = 180000;
    var CONTEXT_WARN = 140000;
    var CONTEXT_DANGER = 160000;
    var tokenEstimate = 0;
    var deltaCharCounter = 0;

    function fmtK(n) {
      if (n < 1000) return String(n);
      if (n < 10000) return (n / 1000).toFixed(1) + 'k';
      return Math.round(n / 1000) + 'k';
    }
    function estimateTokens(text) {
      // Rough char/4 heuristic; spec §6.1 tolerates estimate since real
      // count only surfaces on compact_triggered (backend tokenizer).
      return Math.ceil((text || '').length / 4);
    }
    function updateContextPill(tokens) {
      tokenEstimate = Math.max(0, tokens);
      if (!contextValue || !contextPill) return;
      contextValue.textContent = fmtK(tokenEstimate) + ' / 180k';
      contextPill.classList.remove('is-warn', 'is-danger');
      if (tokenEstimate >= CONTEXT_DANGER) contextPill.classList.add('is-danger');
      else if (tokenEstimate >= CONTEXT_WARN) contextPill.classList.add('is-warn');
    }
    function addEstimatedTokens(text) {
      tokenEstimate += estimateTokens(text);
      // Throttle pill updates — only repaint every ~400 delta-chars so
      // streaming stays cheap. A final refresh happens on \`done\`.
      deltaCharCounter += (text || '').length;
      if (deltaCharCounter >= 400) {
        deltaCharCounter = 0;
        updateContextPill(tokenEstimate);
      }
    }

    // -----------------------------------------------------------------
    // Message rendering
    // -----------------------------------------------------------------
    function appendMessage(role, text) {
      var wrap = document.createElement('div');
      wrap.className = 'agent-chat__msg agent-chat__msg--' + role;
      var head = document.createElement('div');
      head.className = 'agent-chat__msg-role';
      head.textContent = role;
      var body = document.createElement('div');
      body.className = 'agent-chat__msg-body';
      body.textContent = text;
      wrap.appendChild(head);
      wrap.appendChild(body);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return body;
    }

    function appendCollapsibleMessage(role, text) {
      var wrap = document.createElement('div');
      wrap.className = 'agent-chat__msg agent-chat__msg--' + role;
      var head = document.createElement('div');
      head.className = 'agent-chat__msg-role';
      head.textContent = role;
      var body = document.createElement('div');
      body.className = 'agent-chat__msg-body';
      body.textContent = text;
      // Collapsible threshold: ~240 chars or >6 newlines feels like
      // "long" output in practice without hiding short diff snippets.
      if (text.length > 240 || (text.match(/\\n/g) || []).length > 6) {
        body.classList.add('agent-chat__msg-body--collapsible');
        body.addEventListener('click', function() {
          body.classList.toggle('agent-chat__msg-body--expanded');
        });
      }
      wrap.appendChild(head);
      wrap.appendChild(body);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendNotice(text) {
      var el = document.createElement('div');
      el.className = 'agent-chat__notice';
      el.textContent = text;
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function setStatus(text, cls) {
      statusEl.textContent = text;
      statusEl.className = 'agent-chat__status' + (cls ? ' ' + cls : '');
    }

    // -----------------------------------------------------------------
    // Choice cards — parse <choices>…</choices> from assistant at turn end
    // -----------------------------------------------------------------
    function renderChoicesFromAssistant(bodyEl) {
      if (!bodyEl) return;
      var text = bodyEl.textContent || '';
      var match = text.match(/<choices>([\\s\\S]*?)<\\/choices>/i);
      if (!match) return;
      var raw = match[1].trim();
      var lines = raw.split(/\\n+/).map(function(l) { return l.trim(); }).filter(Boolean);
      if (lines.length === 0) return;

      // Strip the block from the visible assistant text.
      bodyEl.textContent = text.replace(/<choices>[\\s\\S]*?<\\/choices>/i, '').trim();

      var container = document.createElement('div');
      container.className = 'agent-chat__choices';
      var hint = document.createElement('div');
      hint.className = 'agent-chat__choices-hint';
      hint.textContent = 'Choose one · click to reply';
      container.appendChild(hint);

      lines.forEach(function(line, idx) {
        var btn = document.createElement('button');
        btn.className = 'agent-chat__choice';
        btn.type = 'button';
        var m = line.match(/^([A-Za-z0-9])[\\)\\.\\:]\\s*(.+)$/);
        var letter = m ? m[1].toUpperCase() : String.fromCharCode(65 + idx);
        var label = m ? m[2] : line;
        var letterSpan = document.createElement('span');
        letterSpan.className = 'agent-chat__choice-letter';
        letterSpan.textContent = letter + '.';
        var labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        btn.appendChild(letterSpan);
        btn.appendChild(labelSpan);
        btn.addEventListener('click', function() {
          if (sendBtn.disabled) return;
          inputEl.value = label;
          sendMessage();
        });
        container.appendChild(btn);
      });
      bodyEl.parentElement.appendChild(container);
    }

    // -----------------------------------------------------------------
    // Approval cards — interactive approve/deny UI for tool calls
    // -----------------------------------------------------------------
    function appendApprovalCard(data) {
      var toolCallId = data.toolCallId;
      var name = data.name || '<unknown>';
      // Sidecar emits 'normalizedInput' (see SseEvent type); tolerate 'input' too.
      var input = (data.normalizedInput !== undefined) ? data.normalizedInput : data.input;
      var root = document.createElement('div');
      root.className = 'agent-chat__approval';
      root.setAttribute('data-tool-call-id', toolCallId);

      var head = document.createElement('div');
      head.className = 'agent-chat__approval-head';
      var badge = document.createElement('span');
      badge.className = 'agent-chat__approval-badge';
      badge.textContent = 'approval required';
      var nameEl = document.createElement('span');
      nameEl.className = 'agent-chat__approval-name';
      nameEl.textContent = name;
      head.appendChild(badge);
      head.appendChild(nameEl);
      root.appendChild(head);

      if (input !== undefined && input !== null) {
        var inputBox = document.createElement('div');
        inputBox.className = 'agent-chat__approval-input';
        var json;
        try { json = JSON.stringify(input, null, 2); } catch (e) { json = String(input); }
        if (json && json.length > 1500) json = json.slice(0, 1500) + '…';
        inputBox.textContent = json || '';
        root.appendChild(inputBox);
      }

      var actions = document.createElement('div');
      actions.className = 'agent-chat__approval-actions';
      var approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.className = 'agent-chat__approval-btn agent-chat__approval-btn--approve';
      approveBtn.textContent = 'Approve';
      var denyBtn = document.createElement('button');
      denyBtn.type = 'button';
      denyBtn.className = 'agent-chat__approval-btn agent-chat__approval-btn--deny';
      denyBtn.textContent = 'Deny';
      actions.appendChild(approveBtn);
      actions.appendChild(denyBtn);
      root.appendChild(actions);

      var statusLine = document.createElement('div');
      statusLine.className = 'agent-chat__approval-status';
      statusLine.textContent = 'Waiting for your decision…';
      root.appendChild(statusLine);

      messagesEl.appendChild(root);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      var card = {
        root: root,
        statusEl: statusLine,
        approveBtn: approveBtn,
        denyBtn: denyBtn,
        resolved: false,
      };
      approvalCards[toolCallId] = card;

      function submit(decision) {
        if (card.resolved) return;
        // Optimistically disable to prevent double-fire.
        approveBtn.disabled = true;
        denyBtn.disabled = true;
        statusLine.textContent = 'Submitting ' + decision + '…';
        if (!currentAid) {
          statusLine.textContent = 'No active session — cannot submit decision.';
          approveBtn.disabled = false;
          denyBtn.disabled = false;
          return;
        }
        fetch('/god-admin/agent/approval-proxy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ aid: currentAid, toolCallId: toolCallId, decision: decision }),
        }).then(function(res) {
          if (res.status === 404) {
            // Already resolved / timed out on the sidecar — the
            // authoritative resolve event will arrive via SSE anyway.
            return;
          }
          if (!res.ok) {
            return res.text().then(function(txt) {
              statusLine.textContent = 'Submit failed (HTTP ' + res.status + '): ' + txt.slice(0, 200);
              approveBtn.disabled = false;
              denyBtn.disabled = false;
            });
          }
        }).catch(function(err) {
          statusLine.textContent = 'Submit error: ' + String(err);
          approveBtn.disabled = false;
          denyBtn.disabled = false;
        });
      }

      approveBtn.addEventListener('click', function() { submit('approved'); });
      denyBtn.addEventListener('click', function() { submit('denied'); });
      return card;
    }

    function resolveApprovalCard(toolCallId, decision) {
      var card = approvalCards[toolCallId];
      if (!card) return;
      card.resolved = true;
      card.approveBtn.disabled = true;
      card.denyBtn.disabled = true;
      card.root.classList.add('is-resolved');
      card.root.classList.add('decision-' + decision);
      var label = decision === 'approved' ? 'Approved' :
                  decision === 'denied'   ? 'Denied'   :
                  decision === 'timeout'  ? 'Timed out (no decision)' :
                  String(decision);
      card.statusEl.textContent = label;
    }

    // -----------------------------------------------------------------
    // SSE handler
    // -----------------------------------------------------------------
    function handleSseEvent(type, data) {
      if (type === 'session_opened') {
        currentAid = data.aid;
        // Populate the session ID pill (spec §8 state 2 header).
        // Clicking the pill jumps to the replay page for forensics/audit.
        if (sessionPill && sessionValue && currentAid) {
          var short = String(currentAid).slice(0, 8);
          sessionValue.textContent = short + '…';
          sessionPill.setAttribute('href', '/god-admin/agent/sessions/' + encodeURIComponent(currentAid));
          sessionPill.setAttribute('aria-disabled', 'false');
          sessionPill.setAttribute('title', 'Session ' + currentAid + ' — click to open replay');
          sessionPill.setAttribute('target', '_blank');
          sessionPill.setAttribute('rel', 'noopener');
        }
      } else if (type === 'assistant_delta') {
        if (!currentAssistant) currentAssistant = appendMessage('assistant', '');
        currentAssistant.textContent += (data.text || '');
        addEstimatedTokens(data.text || '');
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else if (type === 'tool_use') {
        appendCollapsibleMessage('tool', '→ ' + data.name + '  ' + JSON.stringify(data.input));
      } else if (type === 'tool_result') {
        appendCollapsibleMessage('tool', '← ' + JSON.stringify(data.output));
      } else if (type === 'tool_guard_rejected') {
        appendMessage('error', 'Guard rejected [' + data.layer + ']: ' + data.reason);
      } else if (type === 'approval_required') {
        // PR #17 wires the interactive approve/deny card (was a
        // placeholder "UI card coming soon" notice before).
        appendApprovalCard(data);
      } else if (type === 'approval_resolved') {
        resolveApprovalCard(data.toolCallId, data.decision);
      } else if (type === 'compact_triggered') {
        var before = data.tokensBeforeCompact || 0;
        var after = data.tokensAfterCompact || 0;
        appendNotice('Context compacted: ' + fmtK(before) + ' → ' + fmtK(after) + ' tokens');
        updateContextPill(after);
      } else if (type === 'circuit_breaker') {
        setStatus('circuit breaker ' + data.state, 'is-error');
      } else if (type === 'error') {
        appendMessage('error', data.message || 'unknown error');
        setStatus('error', 'is-error');
      } else if (type === 'done') {
        if (currentAssistant) renderChoicesFromAssistant(currentAssistant);
        currentAssistant = null;
        updateContextPill(tokenEstimate);
        setStatus('idle');
        sendBtn.disabled = false;
        stopBtn.disabled = true;
      }
    }

    function parseSseChunk(buf) {
      var events = [];
      var lines = buf.split('\\n');
      var evtType = 'message';
      var dataLines = [];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line === '') {
          if (dataLines.length) {
            var payload = dataLines.join('\\n');
            try { events.push({ type: evtType, data: JSON.parse(payload) }); }
            catch (e) { events.push({ type: evtType, data: payload }); }
          }
          evtType = 'message';
          dataLines = [];
        } else if (line.indexOf('event:') === 0) {
          evtType = line.slice(6).trim();
        } else if (line.indexOf('data:') === 0) {
          dataLines.push(line.slice(5).trim());
        }
      }
      return events;
    }

    // -----------------------------------------------------------------
    // Send turn — prefixes current page path so the agent has
    // dashboard-page context (spec §8 State 2 "auto-attached to prompt")
    // -----------------------------------------------------------------
    async function sendMessage() {
      var text = inputEl.value.trim();
      if (!text) return;
      appendMessage('user', text);
      inputEl.value = '';
      sendBtn.disabled = true;
      stopBtn.disabled = false;
      setStatus('streaming…', 'is-streaming');
      addEstimatedTokens(text);
      updateContextPill(tokenEstimate);

      var pagePath = (window.location && window.location.pathname) || '';
      var payloadText = pagePath
        ? '[context: god-admin page ' + pagePath + ']\\n\\n' + text
        : text;

      currentAbort = new AbortController();
      try {
        var res = await fetch('/god-admin/agent/chat-proxy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ aid: currentAid, text: payloadText }),
          signal: currentAbort.signal,
        });
        if (!res.ok || !res.body) {
          var errText = await res.text();
          appendMessage('error', 'HTTP ' + res.status + ': ' + errText.slice(0, 300));
          setStatus('error', 'is-error');
          sendBtn.disabled = false;
          stopBtn.disabled = true;
          return;
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\\n\\n')) !== -1) {
            var frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (frame.indexOf(': ka') === 0) continue; // heartbeat
            var events = parseSseChunk(frame + '\\n');
            for (var j = 0; j < events.length; j++) {
              handleSseEvent(events[j].type, events[j].data);
            }
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          appendMessage('error', String(err));
          setStatus('error', 'is-error');
        } else {
          setStatus('aborted', 'is-error');
        }
        sendBtn.disabled = false;
        stopBtn.disabled = true;
      }
    }

    // -----------------------------------------------------------------
    // Event wiring
    // -----------------------------------------------------------------
    sendBtn.addEventListener('click', function() { sendMessage(); });
    inputEl.addEventListener('keydown', function(e) {
      // Enter → send. Shift+Enter → newline (default behavior).
      // Ctrl/Cmd+Enter also sends (kept for muscle memory).
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) sendMessage();
      }
    });
    stopBtn.addEventListener('click', function() {
      if (currentAbort) currentAbort.abort();
      if (currentAid) {
        fetch('/god-admin/agent/kill-proxy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ aid: currentAid }),
        });
      }
    });
    // ---------------------------------------------------------------
    // Killswitch toggle (Phase B PR-3 — Gap #13 "disengage path")
    // ---------------------------------------------------------------
    // Button label + data-action flip together; confirm copy also
    // diverges because "lift the brake" is a noticeably different
    // decision from "slam the brake."
    function applyKillswitchState(engaged) {
      if (!killBtn || !killState) return;
      killBtn.setAttribute('data-action', engaged ? 'disengage' : 'engage');
      killBtn.textContent = engaged ? 'Disengage killswitch' : 'Engage killswitch';
      killBtn.classList.toggle('agent-chat__btn--danger', !engaged);
      killBtn.classList.toggle('agent-chat__btn--warn', engaged);
      killState.textContent = engaged ? '🔴 Killswitch engaged' : '🟢 Sidecar live';
      killState.classList.toggle('is-engaged', engaged);
      killState.classList.toggle('is-safe', !engaged);
    }
    killBtn.addEventListener('click', async function() {
      var action = killBtn.getAttribute('data-action') === 'disengage' ? 'disengage' : 'engage';
      var prompt = action === 'engage'
        ? 'Engage the killswitch? All in-flight agent runs will be aborted and no new turns will be accepted until it is disengaged.'
        : 'Disengage the killswitch? The sidecar will start accepting new turns on its next health poll.';
      if (!confirm(prompt)) return;
      killBtn.disabled = true;
      try {
        var res = await fetch('/god-admin/agent/killswitch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: action }),
        });
        var body = await res.json();
        if (res.ok) {
          // The POST handler returns { state: 'engaged' | 'disengaged', path }.
          // Fall back to inferring from the requested action if the shape
          // ever drifts, so the UI doesn't get stuck on a stale label.
          var nowEngaged = body.state ? body.state === 'engaged' : action === 'engage';
          applyKillswitchState(nowEngaged);
          appendNotice('Killswitch ' + (nowEngaged ? 'engaged' : 'disengaged') + (body.path ? ' — ' + body.path : ''));
          setStatus(nowEngaged ? 'KILLSWITCH ENGAGED' : 'killswitch cleared', nowEngaged ? 'is-error' : '');
        } else {
          setStatus('killswitch failed: ' + (body.message || body.error), 'is-error');
        }
      } catch (e) {
        setStatus('killswitch error: ' + String(e), 'is-error');
      } finally {
        killBtn.disabled = false;
      }
    });

    // Initial pill render so the widget isn't empty on load.
    updateContextPill(0);
  })();`
}
