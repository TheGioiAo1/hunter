/**
 * Gbox Platform — BullMQ Redis connection
 *
 * BullMQ requires `ioredis` (it uses Lua scripts and blocking commands
 * that the official `redis` v5 client wraps differently). We keep a
 * SEPARATE singleton ioredis connection so it doesn't fight with the
 * existing node-redis client used for cache/idempotency/sessions.
 *
 * The connection URL comes from REDIS_URL — same as the main cache.
 *
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ workers — without
 * it, BLPOP and friends will throw on transient connection blips.
 */

import IORedis, { type RedisOptions } from 'ioredis'

let connection: IORedis | null = null

export function getQueueConnection(): IORedis {
  if (connection) return connection

  const url = process.env.REDIS_URL || 'redis://localhost:6379'

  const opts: RedisOptions = {
    // Required by BullMQ — disables internal retry-per-command which
    // would otherwise interfere with BullMQ's own retry logic.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  }

  connection = new IORedis(url, opts)

  connection.on('error', (err) => {
    // Don't spam logs on reconnect — only log distinct errors.
    if (err.message && !err.message.includes('ECONNRESET')) {
      console.error('[queue] ioredis error:', err.message)
    }
  })

  return connection
}

/**
 * Gracefully close the BullMQ connection. Call from SIGINT/SIGTERM.
 */
export async function closeQueueConnection(): Promise<void> {
  if (connection) {
    await connection.quit().catch(() => {})
    connection = null
  }
}
