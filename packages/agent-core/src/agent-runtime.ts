/**
 * AgentRuntime — thin wrapper over @anthropic-ai/claude-agent-sdk.
 *
 * Responsibilities:
 * - Own the per-aid AbortController map (for abort()).
 * - Translate the SDK's streamed message events into our SseEvent union.
 * - Fan events through the caller's onEvent callback.
 *
 * Design note:
 * The Claude Agent SDK's exact streaming API is still evolving
 * (0.2.x). Rather than coupling tightly to it, we depend on a
 * minimal interface (SdkQueryFn) that the caller injects. In prod
 * that injection happens in the sidecar boot (apps/god-admin-agent).
 * In tests we inject a fake. This lets us land PR 3 without pinning
 * to a specific SDK call shape that might change under us.
 */

import type {
  AgentRuntime,
  AgentRuntimeSendOptions,
  SseEvent,
} from './types.ts'

/**
 * Minimal interface the runtime needs from the underlying SDK.
 *
 * `query` sends a user message + returns an async iterable of SDK
 * events. The runtime maps each SDK event → one of our SseEvent
 * variants and forwards it to the caller.
 */
export interface SdkEvent {
  type:
    | 'assistant_delta'
    | 'tool_use'
    | 'tool_result'
    | 'done'
    | 'error'
  [key: string]: unknown
}

export interface SdkQueryArgs {
  aid: string
  userText: string
  signal: AbortSignal
}

export type SdkQueryFn = (args: SdkQueryArgs) => AsyncIterable<SdkEvent>

export interface CreateAgentRuntimeOptions {
  query: SdkQueryFn
}

export function createAgentRuntime(
  opts: CreateAgentRuntimeOptions,
): AgentRuntime {
  const abortControllers = new Map<string, AbortController>()

  return {
    async sendMessage(
      aid: string,
      userText: string,
      sendOpts: AgentRuntimeSendOptions,
    ): Promise<void> {
      // Build a combined abort signal: caller's signal + internal one
      // registered under this aid so abort(aid) can cancel mid-stream.
      const internal = new AbortController()
      abortControllers.set(aid, internal)

      const forward = () => internal.abort()
      if (sendOpts.signal) {
        if (sendOpts.signal.aborted) internal.abort()
        else sendOpts.signal.addEventListener('abort', forward, { once: true })
      }

      try {
        const iter = opts.query({ aid, userText, signal: internal.signal })

        for await (const sdkEvt of iter) {
          const mapped = mapSdkEvent(sdkEvt)
          if (mapped) await sendOpts.onEvent(mapped)
          if (internal.signal.aborted) break
        }

        await sendOpts.onEvent({ type: 'done' })
      } catch (err) {
        if ((err as Error).name === 'AbortError' || internal.signal.aborted) {
          // Abort is not an error from the caller's perspective — the
          // caller asked for it. Still emit `done` so the UI unsticks.
          await sendOpts.onEvent({ type: 'done' })
          return
        }
        await sendOpts.onEvent({
          type: 'error',
          message: (err as Error).message ?? 'unknown agent runtime error',
        })
      } finally {
        if (sendOpts.signal) {
          sendOpts.signal.removeEventListener('abort', forward)
        }
        abortControllers.delete(aid)
      }
    },

    abort(aid: string): void {
      const ac = abortControllers.get(aid)
      if (ac) ac.abort()
    },
  }
}

/**
 * Translate an SDK event into our SseEvent. Returns null if the
 * SDK emits something we intentionally swallow (e.g. internal
 * heartbeats). Kept in a pure function for easy unit testing.
 */
function mapSdkEvent(evt: SdkEvent): SseEvent | null {
  switch (evt.type) {
    case 'assistant_delta':
      return { type: 'assistant_delta', text: String(evt.text ?? '') }
    case 'tool_use':
      return {
        type: 'tool_use',
        toolCallId: String(evt.toolCallId ?? evt.id ?? ''),
        name: String(evt.name ?? ''),
        input: evt.input,
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        toolCallId: String(evt.toolCallId ?? evt.id ?? ''),
        output: evt.output,
      }
    case 'done':
      return null // the runtime emits its own `done` at end of turn
    case 'error':
      return {
        type: 'error',
        message: String(evt.message ?? 'sdk error'),
        code: evt.code as string | undefined,
      }
    default:
      return null
  }
}
