/**
 * Gbox Platform — MemoryStore Unit Tests
 *
 * Decision #1 Step 1.2a — Exercises every branch of the MemoryStore
 * implementation so the theme engine can rely on a known-good in-memory
 * backend in its own tests without retesting ObjectStore semantics
 * themselves.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryStore } from './memory-store.js'

describe('MemoryStore', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = new MemoryStore()
  })

  it('put + get round-trip with string body', async () => {
    const url = await store.put('assets/style.css', 'body { color: red }')
    expect(url).toBe('memory://assets/style.css')

    const got = await store.get('assets/style.css')
    expect(got).not.toBeNull()
    const text = new TextDecoder().decode(got!)
    expect(text).toBe('body { color: red }')
  })

  it('put + get round-trip with Uint8Array body', async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    await store.put('blob.bin', bytes)

    const got = await store.get('blob.bin')
    expect(got).not.toBeNull()
    expect(Array.from(got!)).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('has() reflects put and delete', async () => {
    expect(await store.has('k')).toBe(false)
    await store.put('k', 'v')
    expect(await store.has('k')).toBe(true)
    await store.delete('k')
    expect(await store.has('k')).toBe(false)
  })

  it('get() returns null for missing key', async () => {
    expect(await store.get('does-not-exist')).toBeNull()
  })

  it('delete() is idempotent on missing key', async () => {
    // Should not throw.
    await store.delete('never-existed')
    expect(await store.has('never-existed')).toBe(false)
  })

  it('put() preserves contentType and cacheControl', async () => {
    await store.put('css/theme.css', 'body{}', {
      contentType: 'text/css',
      cacheControl: 'public, max-age=60',
    })
    expect(store._getContentType('css/theme.css')).toBe('text/css')
    expect(store._getCacheControl('css/theme.css')).toBe('public, max-age=60')
  })

  it('url() returns memory:// sentinel scheme', () => {
    expect(store.url('foo/bar.png')).toBe('memory://foo/bar.png')
  })

  it('name property is "memory"', () => {
    expect(store.name).toBe('memory')
  })

  it('_clear() wipes all objects', async () => {
    await store.put('a', '1')
    await store.put('b', '2')
    expect(store._size()).toBe(2)
    store._clear()
    expect(store._size()).toBe(0)
    expect(await store.has('a')).toBe(false)
  })
})
