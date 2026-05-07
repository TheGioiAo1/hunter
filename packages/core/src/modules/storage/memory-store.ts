/**
 * Gbox Platform — MemoryStore
 *
 * Decision #1 Step 1.2a — In-memory `ObjectStore` implementation.
 *
 * Purpose:
 *   1. Unit tests for the theme engine that need a real ObjectStore but
 *      must never hit the network.
 *   2. Local dev when the developer has not wired R2 creds yet.
 *   3. CI, where R2 creds are not available by design.
 *
 * Never use in production: data is lost on process restart, does not
 * shard across workers, and `url()` returns a sentinel scheme
 * (`memory://`) that no HTTP client can fetch.
 */

import type { ObjectStore, PutOptions, UrlOptions } from './interface.js'

interface StoredObject {
  body: Uint8Array
  contentType?: string
  cacheControl?: string
}

export class MemoryStore implements ObjectStore {
  readonly name = 'memory'

  private readonly objects = new Map<string, StoredObject>()

  async put(key: string, body: Uint8Array | string, opts: PutOptions = {}): Promise<string> {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    this.objects.set(key, {
      body: bytes,
      contentType: opts.contentType,
      cacheControl: opts.cacheControl,
    })
    return this.url(key)
  }

  async get(key: string): Promise<Uint8Array | null> {
    const entry = this.objects.get(key)
    return entry ? entry.body : null
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async has(key: string): Promise<boolean> {
    return this.objects.has(key)
  }

  url(key: string, _opts: UrlOptions = {}): string {
    return `memory://${key}`
  }

  // -------------------------------------------------------------------------
  // Test-only helpers — not on the ObjectStore interface on purpose.
  // -------------------------------------------------------------------------

  /** Test helper: read the content type recorded at put() time. */
  _getContentType(key: string): string | undefined {
    return this.objects.get(key)?.contentType
  }

  /** Test helper: read the cache control recorded at put() time. */
  _getCacheControl(key: string): string | undefined {
    return this.objects.get(key)?.cacheControl
  }

  /** Test helper: count of stored objects. */
  _size(): number {
    return this.objects.size
  }

  /** Test helper: wipe everything. */
  _clear(): void {
    this.objects.clear()
  }
}
