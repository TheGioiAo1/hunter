#!/usr/bin/env node
/**
 * agent-smoke.ts — 8 E2E acceptance scenarios for the agent sidecar.
 *
 * Boots apps/god-admin-agent/src/server.ts in-process on a random
 * port, backed by an in-memory SessionManager stub and a scripted
 * SdkQueryFn. Fires real HTTP requests (fetch, SSE parsing) against
 * the Express app to validate the full wire path:
 *
 *   JWT auth middleware → circuit breaker/killswitch gate →
 *     session open → chat SSE stream → session-manager writes →
 *       list / replay / kill
 *
 * This is the acceptance test for PR 9 (Phase 9.1). It does NOT
 * require a Postgres connection or the real Claude Agent SDK, so
 * it runs cleanly on any dev machine or CI worker:
 *
 *   npx tsx scripts/smoke/agent-smoke.ts
 *
 * Exit codes:
 *   0 — all scenarios passed
 *   1 — one or more scenarios failed
 *
 * Scenario list:
 *   1. GET  /_health               reports ok + killswitch closed
 *   2. POST /agent/chat (no JWT)   returns 401
 *   3. POST /agent/chat (bad JWT)  returns 401
 *   4. POST /agent/chat (no text)  returns 400
 *   5. POST /agent/chat happy path streams session_opened + delta + done
 *   6. GET  /agent/sessions        lists the newly-opened session
 *   7. GET  /agent/sessions/:aid   returns the replay row w/ user msg
 *   8. POST /agent/kill            closes the session with reason=killswitch
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { signInternalJwt, type SessionManager } from '../../packages/agent-core/src/index.ts'
import type {
  SessionListItem,
  SessionReplayRow,
} from '../../packages/agent-core/src/session-manager.ts'
import type {
  SdkEvent,
  SdkQueryFn,
} from '../../packages/agent-core/src/agent-runtime.ts'
import type { ChatMessage } from '../../packages/agent-core/src/types.ts'
import { buildApp } from '../../apps/god-admin-agent/src/server.ts'
import type { SidecarConfig } from '../../apps/god-admin-agent/src/config.ts'

// ---------------------------------------------------------------------------
// Pass/fail reporter (matches scripts/smoke-*.ts convention)
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++
    console.log(`  \u2713 ${name}`)
  } else {
    failed++
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// In-memory SessionManager — exercises the full route layer without Postgres.
// ---------------------------------------------------------------------------

interface FakeRow {
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
  conversation: ChatMessage[]
  compactedContext: unknown | null
  compactCount: number
  systemPromptVersion: string
  model: string
}

function createFakeSessionManager(): SessionManager & { rows: Map<string, FakeRow> } {
  const rows = new Map<string, FakeRow>()
  let counter = 0
  return {
    rows,
    async openSession({ godAdminId, systemPromptVersion, model }) {
      counter += 1
      const id = `aid-${counter.toString().padStart(4, '0')}`
      rows.set(id, {
        id,
        godAdminId,
        startedAt: new Date().toISOString(),
        endedAt: null,
        endedReason: null,
        promptCount: 0,
        toolCallCount: 0,
        toolCallRejectedCount: 0,
        approvalCount: 0,
        approvalDeniedCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        costUsd: '0.000000',
        conversation: [],
        compactedContext: null,
        compactCount: 0,
        systemPromptVersion,
        model: model ?? 'claude-opus-4-6',
      })
      return id
    },
    async appendMessage({ aid, message }) {
      const row = rows.get(aid)
      if (row) row.conversation.push(message)
    },
    async updateMetrics(input) {
      const row = rows.get(input.aid)
      if (!row) return
      if (input.inputTokensDelta) row.totalInputTokens += input.inputTokensDelta
      if (input.outputTokensDelta) row.totalOutputTokens += input.outputTokensDelta
      if (input.toolCallDelta) row.toolCallCount += input.toolCallDelta
      if (input.toolCallRejectedDelta) row.toolCallRejectedCount += input.toolCallRejectedDelta
      if (input.approvalDelta) row.approvalCount += input.approvalDelta
      if (input.approvalDeniedDelta) row.approvalDeniedCount += input.approvalDeniedDelta
      if (input.promptCountDelta) row.promptCount += input.promptCountDelta
    },
    async closeSession({ aid, reason }) {
      const row = rows.get(aid)
      if (row && !row.endedAt) {
        row.endedAt = new Date().toISOString()
        row.endedReason = reason
      }
    },
    async getReplay(aid): Promise<SessionReplayRow | null> {
      const row = rows.get(aid)
      return row ? ({ ...row } as SessionReplayRow) : null
    },
    async listSessions(input = {}): Promise<SessionListItem[]> {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
      let filtered = [...rows.values()]
      if (input.godAdminId) filtered = filtered.filter((r) => r.godAdminId === input.godAdminId)
      if (input.beforeCursor) filtered = filtered.filter((r) => r.startedAt < input.beforeCursor!)
      filtered.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      return filtered.slice(0, limit).map((row) => ({
        id: row.id,
        godAdminId: row.godAdminId,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        endedReason: row.endedReason,
        promptCount: row.promptCount,
        toolCallCount: row.toolCallCount,
        costUsd: row.costUsd,
        firstUserMessage:
          row.conversation.find((m) => m.role === 'user')?.content.slice(0, 160) ?? null,
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// Scripted SDK query — emits a small deterministic stream so the
// chat route has something to forward through SSE.
// ---------------------------------------------------------------------------

const scriptedSdkQuery: SdkQueryFn = async function* ({ userText }) {
  yield { type: 'assistant_delta', text: `echo:` } satisfies SdkEvent
  yield { type: 'assistant_delta', text: userText } satisfies SdkEvent
  yield { type: 'done' } satisfies SdkEvent
}

// ---------------------------------------------------------------------------
// SSE line parser — minimal because the runtime only emits a handful of
// event types and we only care about the `event:` / `data:` pairs.
// ---------------------------------------------------------------------------

interface ParsedEvent {
  event: string
  data: unknown
}

function parseSseStream(raw: string): ParsedEvent[] {
  const out: ParsedEvent[] = []
  const blocks = raw.split(/\n\n/)
  for (const block of blocks) {
    if (!block.trim()) continue
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!data) continue
    let parsed: unknown = data
    try {
      parsed = JSON.parse(data)
    } catch {
      /* not JSON — keep as string */
    }
    out.push({ event, data: parsed })
  }
  return out
}

// ---------------------------------------------------------------------------
// HTTP helper that returns the raw body as a string (no streaming API
// needed — our scripted SDK finishes immediately).
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number
  headers: Record<string, string>
  body: string
}

function httpRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body,
          })
        })
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Smoke — Agent Sidecar Acceptance (PR 9)')
  console.log('=================================================')

  // Build a throwaway config. We need a real file for the prompt so
  // the watcher can hash it, plus a tmp path for the killswitch file.
  // The prompt loader resolves `<name>.md` inside promptsDir, so we
  // point it at the tmp dir and drop a file with the right basename.
  const tmp = mkdtempSync(join(tmpdir(), 'agent-smoke-'))
  const promptName = 'agent-smoke'
  const promptFile = join(tmp, `${promptName}.md`)
  writeFileSync(promptFile, '# smoke prompt\nYou are running inside the agent smoke test.\n')
  const killswitchFile = join(tmp, '.killswitch')

  const jwtSecret = 'smoke-secret-32-chars-abcdefghijklmnop'
  const config: SidecarConfig = {
    port: 0, // reassigned by listen()
    bindAddress: '127.0.0.1',
    internalJwtSecret: jwtSecret,
    killswitchFile,
    promptFile,
    promptName,
    promptsDir: tmp,
    repoRoot: tmp,
    maxConcurrency: 1,
    circuitBreakerWindowMs: 60_000,
    circuitBreakerErrorThreshold: 5,
  }

  const sessionManager = createFakeSessionManager()
  const { app, shutdown } = await buildApp({
    config,
    sdkQuery: scriptedSdkQuery,
    sessionManagerOverride: sessionManager,
  })

  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  console.log(`  Sidecar listening on ${base}`)

  try {
    // -- Scenario 1: GET /_health --------------------------------------------
    {
      const res = await httpRequest(`${base}/_health`)
      let ok = res.status === 200
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(res.body) as Record<string, unknown>
      } catch {
        ok = false
      }
      const ks = parsed['killswitch'] as { engaged?: boolean } | undefined
      const cb = parsed['circuitBreaker'] as { state?: string } | undefined
      ok =
        ok &&
        parsed['status'] === 'ok' &&
        ks?.engaged === false &&
        (cb?.state === 'closed' || cb?.state === undefined /* shape-tolerant */)
      check(
        '1. GET /_health returns ok + killswitch closed',
        ok,
        `status=${res.status} body=${res.body.slice(0, 120)}`,
      )
    }

    // -- Scenario 2: POST /agent/chat without JWT ---------------------------
    {
      const res = await httpRequest(`${base}/agent/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      })
      check(
        '2. POST /agent/chat without JWT returns 401',
        res.status === 401,
        `status=${res.status}`,
      )
    }

    // -- Scenario 3: POST /agent/chat with bad JWT --------------------------
    {
      const res = await httpRequest(`${base}/agent/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer not-a-real-jwt',
        },
        body: JSON.stringify({ text: 'hi' }),
      })
      check(
        '3. POST /agent/chat with bad JWT returns 401',
        res.status === 401,
        `status=${res.status}`,
      )
    }

    // -- Scenario 4: POST /agent/chat with empty text -----------------------
    {
      const token = await signInternalJwt({
        sid: 'god-smoke-1',
        aid: 'new',
        secret: jwtSecret,
      })
      const res = await httpRequest(`${base}/agent/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      })
      check(
        '4. POST /agent/chat with empty text returns 400',
        res.status === 400,
        `status=${res.status}`,
      )
    }

    // -- Scenario 5: POST /agent/chat happy path ----------------------------
    let capturedAid = ''
    {
      const token = await signInternalJwt({
        sid: 'god-smoke-1',
        aid: 'new',
        secret: jwtSecret,
      })
      const res = await httpRequest(`${base}/agent/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text: 'Xin chao anh' }),
      })

      const events = parseSseStream(res.body)
      const sessionOpened = events.find((e) => e.event === 'session_opened')
      // The SSE `type` discriminator lives on the `event:` line, not
      // inside `data:` — encodeSseEvent peels it off before serializing.
      const deltaEvents = events.filter((e) => e.event === 'assistant_delta')
      const doneEvent = events.find((e) => e.event === 'done')

      capturedAid =
        (sessionOpened?.data as { aid?: string } | undefined)?.aid ?? ''

      const deltaText = deltaEvents
        .map((e) => (e.data as { text: string }).text)
        .join('')

      const ok =
        res.status === 200 &&
        (res.headers['content-type'] ?? '').includes('text/event-stream') &&
        capturedAid.startsWith('aid-') &&
        deltaText === 'echo:Xin chao anh' &&
        Boolean(doneEvent)

      check(
        '5. POST /agent/chat streams session_opened + delta + done',
        ok,
        `status=${res.status} aid=${capturedAid} deltas="${deltaText}" done=${Boolean(doneEvent)}`,
      )
    }

    // -- Scenario 6: GET /agent/sessions lists the new session --------------
    {
      const token = await signInternalJwt({
        sid: 'god-smoke-1',
        aid: 'list',
        secret: jwtSecret,
      })
      const res = await httpRequest(`${base}/agent/sessions?limit=50`, {
        headers: { authorization: `Bearer ${token}` },
      })
      let parsed: { items?: Array<{ id: string; firstUserMessage?: string | null }> } = {}
      try {
        parsed = JSON.parse(res.body)
      } catch {
        /* fall through */
      }
      const found = (parsed.items ?? []).find((i) => i.id === capturedAid)
      const ok =
        res.status === 200 &&
        !!found &&
        found.firstUserMessage === 'Xin chao anh'
      check(
        '6. GET /agent/sessions lists the newly-opened session',
        ok,
        `status=${res.status} found=${Boolean(found)} first=${found?.firstUserMessage}`,
      )
    }

    // -- Scenario 7: GET /agent/sessions/:aid returns replay ----------------
    {
      const token = await signInternalJwt({
        sid: 'god-smoke-1',
        aid: capturedAid || 'x',
        secret: jwtSecret,
      })
      const res = await httpRequest(
        `${base}/agent/sessions/${encodeURIComponent(capturedAid)}`,
        { headers: { authorization: `Bearer ${token}` } },
      )
      let parsed: { id?: string; conversation?: ChatMessage[] } = {}
      try {
        parsed = JSON.parse(res.body)
      } catch {
        /* fall through */
      }
      const firstUser = parsed.conversation?.find((m) => m.role === 'user')
      const ok =
        res.status === 200 &&
        parsed.id === capturedAid &&
        firstUser?.content === 'Xin chao anh'
      check(
        '7. GET /agent/sessions/:aid returns replay row with user message',
        ok,
        `status=${res.status} id=${parsed.id} first=${firstUser?.content}`,
      )
    }

    // -- Scenario 8: POST /agent/kill closes the session --------------------
    {
      const token = await signInternalJwt({
        sid: 'god-smoke-1',
        aid: capturedAid || 'x',
        secret: jwtSecret,
      })
      const res = await httpRequest(`${base}/agent/kill`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ aid: capturedAid, reason: 'smoke-kill' }),
      })
      let parsed: { ok?: boolean } = {}
      try {
        parsed = JSON.parse(res.body)
      } catch {
        /* fall through */
      }
      const row = sessionManager.rows.get(capturedAid)
      const ok =
        res.status === 200 &&
        parsed.ok === true &&
        row?.endedReason === 'killswitch' &&
        row?.endedAt !== null
      check(
        '8. POST /agent/kill closes the session with reason=killswitch',
        ok,
        `status=${res.status} endedReason=${row?.endedReason}`,
      )
    }
  } finally {
    server.close()
    await shutdown()
    rmSync(tmp, { recursive: true, force: true })
  }

  console.log('=================================================')
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Smoke crashed:', err)
  process.exit(1)
})
