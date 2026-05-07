/**
 * Adapter from @anthropic-ai/claude-agent-sdk's streaming `query()`
 * to the `SdkQueryFn` interface that @gbox/agent-core expects.
 *
 * Kept in its own file so that:
 *   1. apps/god-admin-agent/src/server.ts can dynamic-import it and
 *      the import cost of the SDK never lands in unit tests that
 *      don't need it.
 *   2. Tests can stub a fake SdkQueryFn (see adapter.test.ts).
 *
 * Event mapping (SDKMessage → our SdkEvent):
 *
 *   SDKPartialAssistantMessage (type=stream_event)
 *     └─ event.content_block_delta text_delta → assistant_delta
 *     └─ event.message_start / content_block_start / stop → (ignored)
 *
 *   SDKAssistantMessage (type=assistant)
 *     └─ message.content[] tool_use blocks → tool_use
 *     └─ message.content[] text blocks     → assistant_delta
 *                                             (fallback when partial
 *                                              stream events weren't
 *                                              enabled or we missed
 *                                              them mid-flight)
 *
 *   SDKUserMessage (type=user) with tool_result content
 *     └─ tool_result blocks → tool_result
 *
 *   SDKResultMessage (type=result)
 *     └─ subtype=error_*  → error
 *     └─ subtype=success  → (ignored — runtime emits its own done)
 *
 * Anything else is dropped silently to keep the stream focused.
 *
 * The system prompt is pulled fresh from the prompt-watcher on every
 * query() call, so hot-reloading a prompt file affects the NEXT
 * user turn without restarting the process.
 */

import type { SdkEvent, SdkQueryFn } from '@gbox/agent-core'
import type { PromptWatcher } from './prompt-watcher.ts'

export interface CreateSdkQueryOpts {
  promptWatcher: PromptWatcher
  /** Override the SDK import — tests pass a stub. */
  sdkQueryImpl?: SdkLikeQuery
  /** Anthropic model alias. Defaults to env or 'opus'. */
  model?: string
}

/**
 * Narrow the SDK's actual `query` signature down to the surface we
 * consume. This keeps the adapter testable without the runtime dep
 * and insulates us from SDK minor-version churn.
 */
export type SdkLikeQuery = (args: {
  prompt: string
  options: {
    systemPrompt: string
    model?: string
    abortController?: AbortController
    includePartialMessages?: boolean
  }
}) => AsyncIterable<SdkLikeMessage>

export type SdkLikeMessage =
  | {
      type: 'stream_event'
      event: {
        type: string
        delta?: { type?: string; text?: string }
        content_block?: { type?: string; id?: string; name?: string; input?: unknown }
        index?: number
      }
    }
  | {
      type: 'assistant'
      message: {
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: unknown }
        >
      }
    }
  | {
      type: 'user'
      message: {
        content: Array<
          | {
              type: 'tool_result'
              tool_use_id: string
              content: unknown
              is_error?: boolean
            }
          | { type: 'text'; text: string }
        >
      }
    }
  | {
      type: 'result'
      subtype: string
      is_error?: boolean
      result?: string
    }
  | { type: string; [k: string]: unknown }

export function createSdkQuery(opts: CreateSdkQueryOpts): SdkQueryFn {
  const model = opts.model ?? process.env.AGENT_MODEL ?? 'claude-opus-4-6'

  return async function* query({ userText, signal }) {
    const systemPrompt = opts.promptWatcher.current().text

    // Lazy-import the real SDK only when no override was supplied.
    // This keeps unit tests free of a hard dep on the SDK at import.
    let sdkQueryImpl = opts.sdkQueryImpl
    if (!sdkQueryImpl) {
      const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
        query: SdkLikeQuery
      }
      sdkQueryImpl = sdk.query
    }

    // Wire our AbortSignal into an AbortController the SDK can own.
    // When the runtime signals abort (user closed tab, killswitch,
    // /agent/kill), we forward to the SDK's controller and let it
    // wind down gracefully.
    const abortController = new AbortController()
    const forward = (): void => abortController.abort()
    if (signal.aborted) abortController.abort()
    else signal.addEventListener('abort', forward, { once: true })

    try {
      const iter = sdkQueryImpl({
        prompt: userText,
        options: {
          systemPrompt,
          model,
          abortController,
          includePartialMessages: true,
        },
      })

      for await (const msg of iter) {
        if (abortController.signal.aborted) return
        const events = mapSdkMessage(msg)
        for (const evt of events) {
          yield evt
          if (abortController.signal.aborted) return
        }
      }

      yield { type: 'done' } satisfies SdkEvent
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || abortController.signal.aborted) {
        yield { type: 'done' } satisfies SdkEvent
        return
      }
      yield {
        type: 'error',
        message: (err as Error).message ?? 'sdk query failed',
      } satisfies SdkEvent
    } finally {
      signal.removeEventListener('abort', forward)
    }
  }
}

/**
 * Translate one SDKMessage into zero-or-more of our SdkEvents.
 * Pure function → unit-testable without any SDK dependency.
 */
export function mapSdkMessage(msg: SdkLikeMessage): SdkEvent[] {
  switch (msg.type) {
    case 'stream_event': {
      const e = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        return [{ type: 'assistant_delta', text: e.delta.text ?? '' }]
      }
      return []
    }
    case 'assistant': {
      const content = (msg as { message: { content: Array<Record<string, unknown>> } }).message.content
      const out: SdkEvent[] = []
      for (const block of content) {
        if (block['type'] === 'text') {
          // Fallback text emit — only if we never saw a stream_event
          // partial for this block. In practice the runtime collapses
          // consecutive assistant_deltas on the UI side so emitting
          // the final text again is idempotent as long as the client
          // is the one that decides when to render.
          // We opt to NOT re-emit here — the partial stream already
          // delivered it — to avoid double text.
        } else if (block['type'] === 'tool_use') {
          out.push({
            type: 'tool_use',
            toolCallId: String(block['id'] ?? ''),
            name: String(block['name'] ?? ''),
            input: block['input'],
          })
        }
      }
      return out
    }
    case 'user': {
      const content = (msg as { message: { content: Array<Record<string, unknown>> } }).message.content
      const out: SdkEvent[] = []
      for (const block of content) {
        if (block['type'] === 'tool_result') {
          out.push({
            type: 'tool_result',
            toolCallId: String(block['tool_use_id'] ?? ''),
            output: block['content'],
          })
        }
      }
      return out
    }
    case 'result': {
      const m = msg as { subtype?: string; is_error?: boolean; result?: string }
      if (m.is_error || (m.subtype && m.subtype.startsWith('error'))) {
        return [
          {
            type: 'error',
            message: m.result ?? `sdk result: ${m.subtype ?? 'unknown_error'}`,
          },
        ]
      }
      return []
    }
    default:
      return []
  }
}
