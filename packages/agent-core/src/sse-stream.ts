/**
 * SSE wire format encoder for agent events.
 *
 * Event format (per MDN EventSource spec):
 *
 *   event: <event-name>
 *   data: <json-serialized payload>
 *
 *   <blank line>
 *
 * Consumers:
 * - apps/god-admin-agent (sidecar) writes these to the response stream.
 * - apps/god-admin chat panel `useSseStream` composable parses them.
 *
 * Keep-alive: the EventSource spec says any line beginning with ":" is
 * a comment and resets the client's reconnect timer without dispatching
 * anything. We send `: ka\n\n` every 15s so intermediaries don't close
 * the connection during long thinking pauses.
 */

import type { SseEvent } from './types.ts'

export interface EncodedSseFrame {
  /** The UTF-8 bytes ready to write to the HTTP response. */
  bytes: Uint8Array
  /** Plain-text form for tests / debug logs. */
  text: string
}

const TEXT_ENCODER = new TextEncoder()

/**
 * Encode one SseEvent into a single SSE frame.
 *
 * The event name in the `event:` line mirrors the `type` discriminator
 * so clients can dispatch with `eventSource.addEventListener(type, ...)`.
 */
export function encodeSseEvent(event: SseEvent): EncodedSseFrame {
  const { type, ...rest } = event
  const payload = JSON.stringify(rest)
  const text = `event: ${type}\ndata: ${payload}\n\n`
  return { text, bytes: TEXT_ENCODER.encode(text) }
}

/**
 * Keep-alive comment frame. 15s is the standard interval (nginx default
 * proxy_read_timeout is 60s).
 */
export function sseKeepAlive(): EncodedSseFrame {
  const text = `: ka\n\n`
  return { text, bytes: TEXT_ENCODER.encode(text) }
}
