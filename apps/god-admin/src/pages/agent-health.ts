/**
 * God Admin — Agent Sidecar Health page (PR 9)
 *
 *   GET /god-admin/agent/health
 *
 * Shows the live state of the @gbox/god-admin-agent sidecar:
 *   - Up / down (based on whether /_health responds)
 *   - Port + uptime + started-at
 *   - Killswitch engaged / disengaged
 *   - Circuit breaker state (closed / open) + fail count
 *   - System prompt hash + loaded-at
 *   - Recent session count (pulled from the sidecar's list API)
 *
 * The page fetches the sidecar's `/_health` endpoint directly. No JWT
 * is needed for /_health because the sidecar binds 127.0.0.1 — only
 * the god-admin process (on the same host) can reach it.
 *
 * The recent-sessions count uses the authenticated /agent/sessions
 * endpoint so the card can show "3 sessions in the last 24h" without
 * a second database hit.
 *
 * Access: Default God Admin only, matching other /god-admin/agent/*
 * pages. Non-default admins get a 403 card.
 */

import type { Request, Response } from 'express'
import { signInternalJwt } from '@gbox/agent-core'
import { godLayout } from '../layouts/god-layout.js'

// ---------------------------------------------------------------------------
// Config helpers (duplicated across agent pages to avoid cross-import)
// ---------------------------------------------------------------------------

function sidecarBaseUrl(): string {
  return process.env.AGENT_SIDECAR_URL ?? 'http://127.0.0.1:4326'
}

function jwtSecret(): string {
  const secret = process.env.AGENT_INTERNAL_JWT_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('AGENT_INTERNAL_JWT_SECRET must be set to a 32+ character string')
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

// ---------------------------------------------------------------------------
// Types mirroring the sidecar /_health payload shape
// ---------------------------------------------------------------------------

interface HealthPayload {
  status: string
  port: number
  uptimeMs: number
  startedAt: string
  killswitch: { engaged: boolean }
  circuitBreaker: {
    state?: 'closed' | 'open'
    failures?: number
    windowMs?: number
    threshold?: number
  }
  prompt: { hash: string; loadedAt: string }
}

interface RecentSessionsPayload {
  items: Array<{
    id: string
    startedAt: string
    endedAt: string | null
    endedReason: string | null
    costUsd: string
  }>
}

// ---------------------------------------------------------------------------
// Sidecar calls — return null on network / parse failure so the page
// can render a DOWN banner instead of 500'ing.
// ---------------------------------------------------------------------------

async function fetchSidecarHealth(): Promise<HealthPayload | null> {
  try {
    const res = await fetch(`${sidecarBaseUrl()}/_health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    return (await res.json()) as HealthPayload
  } catch {
    return null
  }
}

async function fetchRecentSessions(
  godAdminId: string,
): Promise<RecentSessionsPayload | null> {
  try {
    const token = await signInternalJwt({
      sid: godAdminId,
      aid: 'health',
      secret: jwtSecret(),
    })
    const res = await fetch(`${sidecarBaseUrl()}/agent/sessions?limit=10`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    return (await res.json()) as RecentSessionsPayload
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------------

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (parts.length === 0) parts.push(`${sec}s`)
  return parts.join(' ')
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// GET /god-admin/agent/health
// ---------------------------------------------------------------------------

export async function getAgentHealth(req: Request, res: Response): Promise<void> {
  const godAdmin = req.godAdmin
  if (!godAdmin || !godAdmin.isDefaultAdmin) {
    res.status(403).send(
      godLayout({
        title: 'Agent Health — forbidden',
        userEmail: godAdmin?.user.email ?? '',
        userName: godAdmin?.user.name ?? undefined,
        isDefaultAdmin: false,
        activePath: '/god-admin/agent/health',
        content: `<div class="card" style="max-width:640px;margin:40px auto;">
          <h1>Agent Health</h1>
          <p>Default God Admin only.</p>
        </div>`,
      }),
    )
    return
  }

  const [health, recent] = await Promise.all([
    fetchSidecarHealth(),
    fetchRecentSessions(godAdmin.user.id),
  ])

  // Phase B PR-4 — support `?format=json` so the auto-refresh poller
  // can hit the same route without scraping HTML. Authenticated via
  // the same god-admin middleware as the HTML render, so there's no
  // additional surface area to audit.
  if (req.query['format'] === 'json') {
    res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      sidecarUrl: sidecarBaseUrl(),
      up: health !== null,
      killswitch: health?.killswitch?.engaged === true,
      breaker: health?.circuitBreaker ?? null,
      port: health?.port ?? null,
      uptimeMs: health?.uptimeMs ?? null,
      startedAt: health?.startedAt ?? null,
      prompt: health?.prompt ?? null,
      recent: recent?.items ?? [],
    })
    return
  }

  const isUp = health !== null
  const killswitchOn = health?.killswitch?.engaged === true
  const breakerOpen = health?.circuitBreaker?.state === 'open'

  const bannerState =
    !isUp || killswitchOn
      ? 'down'
      : breakerOpen
      ? 'degraded'
      : 'healthy'
  const bannerLabel =
    bannerState === 'down'
      ? 'DOWN'
      : bannerState === 'degraded'
      ? 'DEGRADED'
      : 'HEALTHY'
  const bannerColor =
    bannerState === 'down'
      ? 'var(--red)'
      : bannerState === 'degraded'
      ? 'var(--yellow)'
      : 'var(--green)'

  const killswitchBadge = killswitchOn
    ? '<span class="badge badge-red">engaged</span>'
    : '<span class="badge badge-green">disengaged</span>'

  const breakerBadge = breakerOpen
    ? '<span class="badge badge-red">open</span>'
    : isUp
    ? '<span class="badge badge-green">closed</span>'
    : '<span class="badge badge-gray">unknown</span>'

  const recentRows = (recent?.items ?? [])
    .slice(0, 10)
    .map((item) => {
      const ended =
        item.endedAt === null
          ? '<span class="badge badge-blue">active</span>'
          : `<span class="badge badge-gray">${esc(item.endedReason ?? 'closed')}</span>`
      return `
        <tr>
          <td class="mono">
            <a href="/god-admin/agent/sessions/${esc(item.id)}">${esc(item.id.slice(0, 8))}…</a>
          </td>
          <td>${esc(fmtDateTime(item.startedAt))}</td>
          <td>${ended}</td>
          <td style="text-align:right">$${esc(item.costUsd)}</td>
        </tr>`
    })
    .join('\n')

  const content = `
    <style>
      .agent-banner {
        display: flex; align-items: center; gap: 16px;
        padding: 20px 24px; border-radius: 12px; margin-bottom: 24px;
        border: 1px solid var(--god-border);
      }
      .agent-banner.healthy { background: rgba(34, 197, 94, 0.08); border-color: rgba(34, 197, 94, 0.3); }
      .agent-banner.degraded { background: rgba(234, 179, 8, 0.08); border-color: rgba(234, 179, 8, 0.3); }
      .agent-banner.down { background: rgba(239, 68, 68, 0.08); border-color: rgba(239, 68, 68, 0.3); }
      .agent-banner-dot {
        width: 16px; height: 16px; border-radius: 50%;
      }
      .agent-banner-text { font-size: 20px; font-weight: 700; }
      .agent-banner-sub { font-size: 13px; color: var(--god-text-muted); margin-left: auto; }
      .info-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--god-border); }
      .info-row:last-child { border-bottom:none; }
      .info-label { color: var(--god-text-secondary); font-size: 13px; }
      .info-value { font-weight: 600; font-family: 'SF Mono', Monaco, monospace; }
    </style>

    <div style="max-width:1200px;margin:0 auto;padding:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h1 style="margin:0">Agent Sidecar Health</h1>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="agent-health__refresh-controls" style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--god-text-muted)">
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer">
              <input type="checkbox" id="agent-health-autorefresh" checked />
              <span>Auto-refresh</span>
            </label>
            <span id="agent-health-last-updated" aria-live="polite">Just now</span>
            <button type="button" class="btn" id="agent-health-refresh-btn" style="padding:4px 10px;font-size:12px">Refresh</button>
          </div>
          <a class="btn" href="/god-admin/agent/chat">← Chat</a>
          <a class="btn" href="/god-admin/agent/sessions">Sessions →</a>
        </div>
      </div>

      <div class="agent-banner ${bannerState}">
        <div class="agent-banner-dot" style="background:${bannerColor}"></div>
        <div class="agent-banner-text" style="color:${bannerColor}">${bannerLabel}</div>
        <div class="agent-banner-sub">
          ${isUp ? `sidecar at ${esc(sidecarBaseUrl())}` : `cannot reach ${esc(sidecarBaseUrl())}`}
        </div>
      </div>

      ${
        !isUp
          ? `
        <div class="card">
          <h2 style="margin-top:0">Sidecar unreachable</h2>
          <p>The agent sidecar is not responding on <code>${esc(sidecarBaseUrl())}</code>.</p>
          <p>Common fixes:</p>
          <ul>
            <li>Run <code>pm2 list | grep agent</code> on server 1 to confirm the process exists.</li>
            <li>Tail recent logs: <code>pm2 logs gbox-god-admin-agent --lines 100</code>.</li>
            <li>Manual restart: <code>pm2 restart gbox-god-admin-agent</code>.</li>
            <li>See the ops runbook: <code>docs/runbooks/2026-04-10-agent-operations.md</code>.</li>
          </ul>
        </div>`
          : `
        <div class="two-col" style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px">
          <div class="card">
            <div class="card-title" style="margin-bottom:12px">Runtime</div>
            <div class="info-row">
              <span class="info-label">Port</span>
              <span class="info-value">${health!.port}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Uptime</span>
              <span class="info-value">${esc(formatUptime(health!.uptimeMs))}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Started at</span>
              <span class="info-value">${esc(fmtDateTime(health!.startedAt))}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Killswitch</span>
              <span class="info-value">${killswitchBadge}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Circuit breaker</span>
              <span class="info-value">${breakerBadge}</span>
            </div>
            ${
              typeof health!.circuitBreaker?.failures === 'number'
                ? `<div class="info-row">
                    <span class="info-label">CB failures in window</span>
                    <span class="info-value">${health!.circuitBreaker.failures}${
                      typeof health!.circuitBreaker.threshold === 'number'
                        ? ` / ${health!.circuitBreaker.threshold}`
                        : ''
                    }</span>
                  </div>`
                : ''
            }
          </div>

          <div class="card">
            <div class="card-title" style="margin-bottom:12px">System prompt</div>
            <div class="info-row">
              <span class="info-label">Hash</span>
              <span class="info-value" style="font-size:11px">${esc(health!.prompt.hash)}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Loaded at</span>
              <span class="info-value">${esc(fmtDateTime(health!.prompt.loadedAt))}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Source</span>
              <span class="info-value" style="font-size:11px">packages/agent-core/prompts/god-admin-default.md</span>
            </div>
            <p style="margin:16px 0 0;font-size:12px;color:var(--god-text-muted)">
              Edit the source file and save — the sidecar hot-reloads without a restart.
              New chat turns use the new prompt; turns already in flight keep the old one.
            </p>
          </div>
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom:12px">Recent sessions</div>
          ${
            recent && recent.items.length > 0
              ? `<table class="table" style="width:100%">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Started</th>
                      <th>Status</th>
                      <th style="text-align:right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>${recentRows}</tbody>
                </table>`
              : '<p style="color:var(--god-text-muted)">No sessions recorded yet.</p>'
          }
        </div>`
      }
    </div>
    <script>${healthAutoRefreshScript({ initialUp: isUp, initialKillswitch: killswitchOn, initialBreakerOpen: breakerOpen })}</script>`

  res.send(
    godLayout({
      title: 'Agent Health',
      userEmail: godAdmin.user.email,
      userName: godAdmin.user.name ?? undefined,
      isDefaultAdmin: true,
      activePath: '/god-admin/agent/health',
      content,
    }),
  )
}

// ---------------------------------------------------------------------------
// Auto-refresh client script (Phase B PR-4 — Gap #16 health auto-refresh)
// ---------------------------------------------------------------------------
//
// Polls the same route with `?format=json` every 10s. If any material
// state changed (sidecar up/down, killswitch, breaker state), we do a
// full page reload so the whole render — banners, badges, cards — is
// rebuilt from the server source of truth in one pass. Otherwise we
// just bump the "Last updated Xs ago" timestamp so the admin has a
// live freshness signal without screen flicker.
//
// The toggle checkbox pauses polling entirely, useful when the admin
// is copying values or reading the runbook.

interface HealthRefreshInitial {
  initialUp: boolean
  initialKillswitch: boolean
  initialBreakerOpen: boolean
}

function healthAutoRefreshScript(init: HealthRefreshInitial): string {
  return `
  (function() {
    var POLL_MS = 10000;
    var toggle = document.getElementById('agent-health-autorefresh');
    var lastUpdatedEl = document.getElementById('agent-health-last-updated');
    var refreshBtn = document.getElementById('agent-health-refresh-btn');
    if (!toggle || !lastUpdatedEl) return;

    var initialState = {
      up: ${init.initialUp ? 'true' : 'false'},
      killswitch: ${init.initialKillswitch ? 'true' : 'false'},
      breakerOpen: ${init.initialBreakerOpen ? 'true' : 'false'}
    };
    var pageLoadedAt = Date.now();
    var timerId = null;

    function fmtAge(ms) {
      var s = Math.max(0, Math.floor(ms / 1000));
      if (s < 5) return 'Just now';
      if (s < 60) return s + 's ago';
      var m = Math.floor(s / 60);
      return m + 'm ' + (s % 60) + 's ago';
    }

    function tickAgeLabel() {
      lastUpdatedEl.textContent = fmtAge(Date.now() - pageLoadedAt);
    }

    async function pollOnce() {
      try {
        var res = await fetch(window.location.pathname + '?format=json', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        });
        if (!res.ok) return;
        var data = await res.json();
        var stateChanged =
          Boolean(data.up) !== initialState.up ||
          Boolean(data.killswitch) !== initialState.killswitch ||
          Boolean(data.breaker && data.breaker.state === 'open') !== initialState.breakerOpen;
        if (stateChanged) {
          window.location.reload();
          return;
        }
        pageLoadedAt = Date.now();
        tickAgeLabel();
      } catch (_e) {
        // Silent: the banner will go red on the next successful poll
        // if the sidecar really is down. Don't spam the console.
      }
    }

    function start() {
      if (timerId !== null) return;
      timerId = window.setInterval(pollOnce, POLL_MS);
    }
    function stop() {
      if (timerId === null) return;
      window.clearInterval(timerId);
      timerId = null;
    }

    // Separate 1s tick for the "Xs ago" label so admins see the
    // freshness count climb without waiting for the next poll.
    window.setInterval(tickAgeLabel, 1000);

    toggle.addEventListener('change', function() {
      if (toggle.checked) start();
      else stop();
    });

    if (refreshBtn) {
      refreshBtn.addEventListener('click', function() {
        pollOnce();
      });
    }

    if (toggle.checked) start();
  })();`
}
