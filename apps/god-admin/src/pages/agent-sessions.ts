/**
 * God Admin — Agent Session List + Replay pages
 *
 *   GET  /god-admin/agent/sessions          — list recent sessions
 *   GET  /god-admin/agent/sessions/:aid     — replay one session
 *
 * Both pages proxy to the sidecar's JSON endpoints (added in PR 8).
 * The dashboard does not talk to PostgreSQL directly — the sidecar
 * owns the agent_sessions table.
 *
 * Access: Default God Admin only. The existing god-auth middleware
 * enforces auth globally; we additionally gate on isDefaultAdmin in
 * the same way the chat panel does.
 */

import type { Request, Response } from 'express'
import { signInternalJwt } from '@gbox/agent-core'
import { godLayout } from '../layouts/god-layout.js'

// ---------------------------------------------------------------------------
// Config helpers (shared with agent-chat.ts; duplicated here so the
// two page files don't have a cross-import and can be moved
// independently later).
// ---------------------------------------------------------------------------

function sidecarBaseUrl(): string {
  return process.env.AGENT_SIDECAR_URL ?? 'http://127.0.0.1:4326'
}

function jwtSecret(): string {
  const secret = process.env.AGENT_INTERNAL_JWT_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      'AGENT_INTERNAL_JWT_SECRET must be set to a 32+ character string',
    )
  }
  return secret
}

function esc(s: string | null | undefined): string {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return 'in progress'
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem ? `${m}m ${rem}s` : `${m}m`
}

// ---------------------------------------------------------------------------
// Types mirroring the sidecar JSON payloads.
// ---------------------------------------------------------------------------

interface SessionListItem {
  id: string
  godAdminId: string
  startedAt: string
  endedAt: string | null
  endedReason: string | null
  promptCount: number
  toolCallCount: number
  costUsd: string
  firstUserMessage: string | null
}

interface SessionListResponse {
  items: SessionListItem[]
  nextCursor: string | null
}

interface ChatMessageRow {
  seq: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  createdAt: string
  toolCallId?: string
  toolName?: string
}

interface SessionReplayRow {
  id: string
  godAdminId: string
  startedAt: string
  endedAt: string | null
  endedReason: string | null
  promptCount: number
  toolCallCount: number
  toolCallRejectedCount: number
  approvalCount: number
  approvalDeniedCount: number
  totalInputTokens: number
  totalOutputTokens: number
  costUsd: string
  conversation: ChatMessageRow[]
  compactedContext: unknown | null
  compactCount: number
  systemPromptVersion: string
  model: string
}

// ---------------------------------------------------------------------------
// Sidecar calls
// ---------------------------------------------------------------------------

async function fetchSessionList(
  godAdminId: string,
  limit: number,
  before: string | null,
): Promise<SessionListResponse> {
  const token = await signInternalJwt({
    sid: godAdminId,
    aid: 'list',
    secret: jwtSecret(),
  })
  const url = new URL(`${sidecarBaseUrl()}/agent/sessions`)
  url.searchParams.set('limit', String(limit))
  if (before) url.searchParams.set('before', before)
  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(`sidecar list sessions: ${res.status}`)
  }
  return (await res.json()) as SessionListResponse
}

async function fetchSessionReplay(
  godAdminId: string,
  aid: string,
): Promise<SessionReplayRow | null> {
  const token = await signInternalJwt({
    sid: godAdminId,
    aid,
    secret: jwtSecret(),
  })
  const res = await fetch(`${sidecarBaseUrl()}/agent/sessions/${encodeURIComponent(aid)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`sidecar replay: ${res.status}`)
  return (await res.json()) as SessionReplayRow
}

// ---------------------------------------------------------------------------
// GET /god-admin/agent/sessions — list page
// ---------------------------------------------------------------------------

export async function getAgentSessionList(req: Request, res: Response): Promise<void> {
  const godAdmin = req.godAdmin
  if (!godAdmin || !godAdmin.isDefaultAdmin) {
    res.status(403).send(
      godLayout({
        title: 'Agent Sessions — forbidden',
        userEmail: godAdmin?.user.email ?? '',
        userName: godAdmin?.user.name ?? undefined,
        isDefaultAdmin: false,
        activePath: '/god-admin/agent/sessions',
        content: `<div class="card" style="max-width:640px;margin:40px auto;">
          <h1>Agent Sessions</h1>
          <p>Default God Admin only.</p>
        </div>`,
      }),
    )
    return
  }

  const beforeParam = typeof req.query['before'] === 'string' ? req.query['before'] : null
  const limit = 50

  let data: SessionListResponse
  try {
    data = await fetchSessionList(godAdmin.user.id, limit, beforeParam)
  } catch (err) {
    res.status(502).send(
      godLayout({
        title: 'Agent Sessions — sidecar unreachable',
        userEmail: godAdmin.user.email,
        userName: godAdmin.user.name ?? undefined,
        isDefaultAdmin: true,
        activePath: '/god-admin/agent/sessions',
        content: `<div class="card" style="max-width:640px;margin:40px auto;">
          <h1>Agent Sessions</h1>
          <p style="color:var(--red)">Sidecar unreachable: ${esc((err as Error).message)}</p>
          <p>Check <code>pm2 list | grep agent</code> on server 1.</p>
        </div>`,
      }),
    )
    return
  }

  // Bucket each row for the client-side filter: active rows have no
  // endedAt, errored rows set endedReason to something other than
  // "closed" / "user_quit", everything else is "closed." The bucket
  // rides along as a data-status attribute on the <tr> so the client
  // filter doesn't have to re-parse the cell content.
  function statusBucket(item: SessionListItem): 'active' | 'errored' | 'closed' {
    if (item.endedAt === null) return 'active'
    const reason = (item.endedReason ?? '').toLowerCase()
    if (reason === '' || reason === 'closed' || reason === 'user_quit' || reason === 'done') return 'closed'
    return 'errored'
  }

  const rows = data.items
    .map((item) => {
      const preview = item.firstUserMessage ?? '(no user message yet)'
      const duration = fmtDuration(item.startedAt, item.endedAt)
      const bucket = statusBucket(item)
      const ended =
        bucket === 'active'
          ? `<span class="badge badge-blue">active</span>`
          : bucket === 'errored'
            ? `<span class="badge badge-red">${esc(item.endedReason ?? 'errored')}</span>`
            : `<span class="badge badge-gray">${esc(item.endedReason ?? 'closed')}</span>`
      return `
        <tr data-status="${bucket}" data-search="${esc(preview.toLowerCase())}">
          <td class="mono" style="white-space:nowrap">
            <a href="/god-admin/agent/sessions/${esc(item.id)}">${esc(item.id.slice(0, 8))}…</a>
          </td>
          <td>${esc(fmtDateTime(item.startedAt))}</td>
          <td>${esc(duration)}</td>
          <td>${ended}</td>
          <td style="text-align:right">${item.promptCount}</td>
          <td style="text-align:right">${item.toolCallCount}</td>
          <td style="text-align:right">$${esc(item.costUsd)}</td>
          <td style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${esc(preview)}
          </td>
        </tr>`
    })
    .join('\n')

  const nextLink = data.nextCursor
    ? `<a class="btn" href="/god-admin/agent/sessions?before=${encodeURIComponent(data.nextCursor)}">Older →</a>`
    : ''

  // Summary counts for the chip row — server-rendered so non-JS
  // clients still see the totals even before the filter wires up.
  const counts = {
    all: data.items.length,
    active: data.items.filter((i) => statusBucket(i) === 'active').length,
    errored: data.items.filter((i) => statusBucket(i) === 'errored').length,
    closed: data.items.filter((i) => statusBucket(i) === 'closed').length,
  }

  res.send(
    godLayout({
      title: 'Agent Sessions',
      userEmail: godAdmin.user.email,
      userName: godAdmin.user.name ?? undefined,
      isDefaultAdmin: true,
      activePath: '/god-admin/agent/sessions',
      content: `
        <style>
          .agent-sessions__filters { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:12px; }
          .agent-sessions__chip {
            display:inline-flex; align-items:center; gap:6px;
            padding:6px 12px; background:var(--surface-0); border:1px solid var(--border);
            border-radius:999px; font-size:12px; cursor:pointer;
            color:var(--text-primary); transition:background 120ms, border-color 120ms;
          }
          .agent-sessions__chip:hover { background:var(--surface-1); border-color:var(--blue); }
          .agent-sessions__chip.is-active { background:var(--blue); border-color:var(--blue); color:#fff; }
          .agent-sessions__chip-count { font-variant-numeric:tabular-nums; opacity:0.75; font-weight:600; }
          .agent-sessions__search {
            flex:1; min-width:200px; padding:6px 12px;
            background:var(--surface-0); border:1px solid var(--border);
            border-radius:6px; color:var(--text-primary); font-size:12px;
          }
          .agent-sessions__hidden { display:none; }
          .agent-sessions__empty { text-align:center; padding:32px; color:var(--text-secondary); }
        </style>
        <div style="max-width:1200px;margin:0 auto;padding:24px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
            <h1 style="margin:0">Agent Sessions <span id="agent-sessions-visible" style="font-size:14px;color:var(--text-secondary);font-weight:400">(${counts.all})</span></h1>
            <div style="display:flex;gap:8px">
              <a class="btn" href="/god-admin/agent/chat">← Back to Chat</a>
              ${nextLink}
            </div>
          </div>
          <div class="card">
            <div class="agent-sessions__filters" role="tablist" aria-label="Status filter">
              <button class="agent-sessions__chip is-active" data-status-filter="all" role="tab" aria-selected="true">
                All <span class="agent-sessions__chip-count">${counts.all}</span>
              </button>
              <button class="agent-sessions__chip" data-status-filter="active" role="tab" aria-selected="false">
                Active <span class="agent-sessions__chip-count">${counts.active}</span>
              </button>
              <button class="agent-sessions__chip" data-status-filter="errored" role="tab" aria-selected="false">
                Errored <span class="agent-sessions__chip-count">${counts.errored}</span>
              </button>
              <button class="agent-sessions__chip" data-status-filter="closed" role="tab" aria-selected="false">
                Closed <span class="agent-sessions__chip-count">${counts.closed}</span>
              </button>
              <input type="search" class="agent-sessions__search" id="agent-sessions-search"
                     placeholder="Search first message…" autocomplete="off" aria-label="Filter by first message" />
            </div>
            <table class="table" style="width:100%">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th style="text-align:right">Prompts</th>
                  <th style="text-align:right">Tools</th>
                  <th style="text-align:right">Cost</th>
                  <th>First message</th>
                </tr>
              </thead>
              <tbody id="agent-sessions-tbody">
                ${rows || '<tr><td colspan="8" class="agent-sessions__empty">No sessions yet.</td></tr>'}
              </tbody>
            </table>
            <div id="agent-sessions-empty-filtered" class="agent-sessions__empty agent-sessions__hidden">
              No sessions match the current filter.
            </div>
          </div>
        </div>
        <script>${sessionsFilterClientScript()}</script>`,
    }),
  )
}

// ---------------------------------------------------------------------------
// GET /god-admin/agent/sessions/:aid — replay page
// ---------------------------------------------------------------------------

function renderMessageBlock(m: ChatMessageRow): string {
  const stamp = esc(fmtDateTime(m.createdAt))
  const roleBadge =
    m.role === 'user'
      ? '<span class="badge badge-blue">user</span>'
      : m.role === 'assistant'
        ? '<span class="badge badge-green">assistant</span>'
        : m.role === 'tool'
          ? '<span class="badge badge-yellow">tool</span>'
          : '<span class="badge badge-gray">system</span>'

  const headerRight = m.toolName ? `<code>${esc(m.toolName)}</code>` : ''

  return `
    <div class="msg msg-${m.role}" style="margin-bottom:12px">
      <div class="msg-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div>${roleBadge} <span class="mono" style="color:var(--text-secondary);font-size:12px">seq ${m.seq}</span></div>
        <div style="font-size:12px;color:var(--text-secondary)">${stamp} ${headerRight}</div>
      </div>
      <pre class="msg-body" style="white-space:pre-wrap;word-break:break-word;padding:12px;background:var(--bg-subtle);border-radius:6px;margin:0;font-size:13px">${esc(m.content)}</pre>
    </div>`
}

// ---------------------------------------------------------------------------
// Client script (Phase B PR-4) — status chips + free-text search.
// Pure vanilla JS, inlined to keep the static-asset story simple.
// ---------------------------------------------------------------------------

function sessionsFilterClientScript(): string {
  return `
  (function() {
    var chips = document.querySelectorAll('[data-status-filter]');
    var search = document.getElementById('agent-sessions-search');
    var tbody = document.getElementById('agent-sessions-tbody');
    var visibleCount = document.getElementById('agent-sessions-visible');
    var emptyMsg = document.getElementById('agent-sessions-empty-filtered');
    if (!chips.length || !tbody) return;

    var activeStatus = 'all';
    var searchText = '';

    function applyFilters() {
      var rows = tbody.querySelectorAll('tr[data-status]');
      var shown = 0;
      rows.forEach(function(row) {
        var status = row.getAttribute('data-status') || '';
        var search = row.getAttribute('data-search') || '';
        var matchStatus = activeStatus === 'all' || status === activeStatus;
        var matchSearch = !searchText || search.indexOf(searchText) !== -1;
        var visible = matchStatus && matchSearch;
        row.classList.toggle('agent-sessions__hidden', !visible);
        if (visible) shown++;
      });
      if (visibleCount) visibleCount.textContent = '(' + shown + ')';
      if (emptyMsg) emptyMsg.classList.toggle('agent-sessions__hidden', shown > 0 || rows.length === 0);
    }

    chips.forEach(function(chip) {
      chip.addEventListener('click', function() {
        chips.forEach(function(c) {
          c.classList.remove('is-active');
          c.setAttribute('aria-selected', 'false');
        });
        chip.classList.add('is-active');
        chip.setAttribute('aria-selected', 'true');
        activeStatus = chip.getAttribute('data-status-filter') || 'all';
        applyFilters();
      });
    });

    if (search) {
      search.addEventListener('input', function() {
        searchText = String(search.value || '').toLowerCase().trim();
        applyFilters();
      });
    }
  })();`
}

export async function getAgentSessionReplay(req: Request, res: Response): Promise<void> {
  const godAdmin = req.godAdmin
  if (!godAdmin || !godAdmin.isDefaultAdmin) {
    res.status(403).json({ error: 'default_god_admin_required' })
    return
  }
  const aidParam = req.params.aid
  const aid = Array.isArray(aidParam) ? aidParam[0] : aidParam
  if (!aid) {
    res.status(400).send('aid required')
    return
  }

  let replay: SessionReplayRow | null
  try {
    replay = await fetchSessionReplay(godAdmin.user.id, aid)
  } catch (err) {
    res.status(502).send(
      godLayout({
        title: 'Agent Session — sidecar unreachable',
        userEmail: godAdmin.user.email,
        userName: godAdmin.user.name ?? undefined,
        isDefaultAdmin: true,
        activePath: '/god-admin/agent/sessions',
        content: `<p style="color:var(--red)">${esc((err as Error).message)}</p>`,
      }),
    )
    return
  }

  if (!replay) {
    res.status(404).send(
      godLayout({
        title: 'Agent Session — not found',
        userEmail: godAdmin.user.email,
        userName: godAdmin.user.name ?? undefined,
        isDefaultAdmin: true,
        activePath: '/god-admin/agent/sessions',
        content: `<div class="card" style="max-width:640px;margin:40px auto;">
          <h1>Session not found</h1>
          <p>No session with id <code>${esc(aid)}</code>.</p>
          <p><a href="/god-admin/agent/sessions">← Back to list</a></p>
        </div>`,
      }),
    )
    return
  }

  const messagesHtml = replay.conversation.map(renderMessageBlock).join('\n')

  res.send(
    godLayout({
      title: `Agent Session ${replay.id.slice(0, 8)}`,
      userEmail: godAdmin.user.email,
      userName: godAdmin.user.name ?? undefined,
      isDefaultAdmin: true,
      activePath: '/god-admin/agent/sessions',
      content: `
        <div style="max-width:960px;margin:0 auto;padding:24px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;gap:16px">
            <div>
              <h1 style="margin:0 0 4px 0">Session <span class="mono">${esc(replay.id.slice(0, 12))}</span></h1>
              <div style="color:var(--text-secondary);font-size:13px">
                Started ${esc(fmtDateTime(replay.startedAt))} ·
                ${replay.endedAt ? `ended ${esc(fmtDateTime(replay.endedAt))} (${esc(replay.endedReason ?? 'closed')})` : '<span style="color:var(--blue)">in progress</span>'}
                · duration ${esc(fmtDuration(replay.startedAt, replay.endedAt))}
              </div>
            </div>
            <a class="btn" href="/god-admin/agent/sessions">← Back to list</a>
          </div>

          <div class="card" style="margin-bottom:16px">
            <div class="stat-row" style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px">
              <div><div style="color:var(--text-secondary);font-size:12px">Prompts</div><div style="font-size:20px;font-weight:600">${replay.promptCount}</div></div>
              <div><div style="color:var(--text-secondary);font-size:12px">Tool calls</div><div style="font-size:20px;font-weight:600">${replay.toolCallCount} <span style="color:var(--red);font-size:13px">(${replay.toolCallRejectedCount} rejected)</span></div></div>
              <div><div style="color:var(--text-secondary);font-size:12px">Approvals</div><div style="font-size:20px;font-weight:600">${replay.approvalCount} <span style="color:var(--red);font-size:13px">(${replay.approvalDeniedCount} denied)</span></div></div>
              <div><div style="color:var(--text-secondary);font-size:12px">Cost</div><div style="font-size:20px;font-weight:600">$${esc(replay.costUsd)}</div></div>
            </div>
            <div style="margin-top:12px;color:var(--text-secondary);font-size:12px">
              Tokens in/out: ${replay.totalInputTokens}/${replay.totalOutputTokens} ·
              Compactions: ${replay.compactCount} ·
              Model: <code>${esc(replay.model)}</code> ·
              Prompt: <code>${esc(replay.systemPromptVersion)}</code>
            </div>
          </div>

          <div class="card">
            <h2 style="margin:0 0 12px 0">Conversation (${replay.conversation.length} messages)</h2>
            ${messagesHtml || '<p style="color:var(--text-secondary)">No messages yet.</p>'}
          </div>
        </div>`,
    }),
  )
}
