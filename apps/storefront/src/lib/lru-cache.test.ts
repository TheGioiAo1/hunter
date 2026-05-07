/**
 * Gbox Storefront — LRU Cache tests (Stage 3A.4)
 *
 * Exercises the bounded, TTL-aware LRU used by the host→shop
 * resolver. Clock is injected so expiry can be tested without
 * sleeping or touching vi.useFakeTimers.
 */

import { describe, it, expect } from 'vitest'
import { LruCache } from './lru-cache.js'

function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance(ms) {
      t += ms
    },
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('LruCache construction', () => {
  it('rejects maxEntries < 1', () => {
    expect(() => new LruCache({ maxEntries: 0, ttlMs: 1000 })).toThrow(RangeError)
  })

  it('rejects negative ttlMs', () => {
    expect(() => new LruCache({ maxEntries: 10, ttlMs: -1 })).toThrow(RangeError)
  })

  it('rejects NaN maxEntries', () => {
    expect(() => new LruCache({ maxEntries: NaN, ttlMs: 1000 })).toThrow(RangeError)
  })

  it('accepts ttlMs = 0 (TTL disabled)', () => {
    const c = new LruCache({ maxEntries: 10, ttlMs: 0 })
    c.set('a', 1)
    expect(c.get('a')).toBe(1)
  })

  it('starts empty', () => {
    const c = new LruCache({ maxEntries: 10, ttlMs: 1000 })
    expect(c.size).toBe(0)
    expect(c.get('anything')).toBeUndefined()
    expect(c.has('anything')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Basic get / set / delete
// ---------------------------------------------------------------------------

describe('LruCache basic ops', () => {
  it('returns undefined on miss', () => {
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 1000 })
    expect(c.get('nope')).toBeUndefined()
  })

  it('returns stored value on hit', () => {
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 1000 })
    c.set('a', 42)
    expect(c.get('a')).toBe(42)
  })

  it('overwrites existing value', () => {
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 1000 })
    c.set('a', 1)
    c.set('a', 2)
    expect(c.get('a')).toBe(2)
    expect(c.size).toBe(1)
  })

  it('delete removes entry and reports previous presence', () => {
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 1000 })
    c.set('a', 1)
    expect(c.delete('a')).toBe(true)
    expect(c.get('a')).toBeUndefined()
    expect(c.delete('a')).toBe(false)
  })

  it('clear drops every entry', () => {
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 1000 })
    c.set('a', 1)
    c.set('b', 2)
    c.clear()
    expect(c.size).toBe(0)
    expect(c.get('a')).toBeUndefined()
  })

  it('has returns true only for live entries', () => {
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 1000 })
    c.set('a', 1)
    expect(c.has('a')).toBe(true)
    expect(c.has('b')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// LRU eviction
// ---------------------------------------------------------------------------

describe('LruCache eviction', () => {
  it('evicts the oldest entry when over capacity', () => {
    const c = new LruCache<string, number>({ maxEntries: 2, ttlMs: 10_000 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    expect(c.get('a')).toBeUndefined() // evicted
    expect(c.get('b')).toBe(2)
    expect(c.get('c')).toBe(3)
    expect(c.size).toBe(2)
  })

  it('get refreshes recency (read promotes entry)', () => {
    const c = new LruCache<string, number>({ maxEntries: 2, ttlMs: 10_000 })
    c.set('a', 1)
    c.set('b', 2)
    // Bump a to MRU by reading it
    expect(c.get('a')).toBe(1)
    // Now inserting c should evict b (LRU), not a
    c.set('c', 3)
    expect(c.get('a')).toBe(1)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBe(3)
  })

  it('reinserting an existing key does NOT evict others', () => {
    const c = new LruCache<string, number>({ maxEntries: 2, ttlMs: 10_000 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('a', 999) // overwrite, not a new slot
    expect(c.size).toBe(2)
    expect(c.get('a')).toBe(999)
    expect(c.get('b')).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------

describe('LruCache TTL', () => {
  it('returns undefined after ttlMs elapsed', () => {
    const clock = makeClock()
    const c = new LruCache<string, number>({
      maxEntries: 10,
      ttlMs: 1000,
      now: clock.now,
    })
    c.set('a', 1)
    expect(c.get('a')).toBe(1)
    clock.advance(999)
    expect(c.get('a')).toBe(1)
    clock.advance(1) // exactly 1000ms elapsed
    expect(c.get('a')).toBeUndefined()
  })

  it('expired get does not count toward capacity after the removal', () => {
    const clock = makeClock()
    const c = new LruCache<string, number>({
      maxEntries: 2,
      ttlMs: 1000,
      now: clock.now,
    })
    c.set('a', 1)
    c.set('b', 2)
    clock.advance(2000)
    c.get('a') // triggers removal of expired entry
    expect(c.size).toBe(1)
  })

  it('has returns false for expired entries and removes them', () => {
    const clock = makeClock()
    const c = new LruCache<string, number>({
      maxEntries: 10,
      ttlMs: 1000,
      now: clock.now,
    })
    c.set('a', 1)
    clock.advance(1500)
    expect(c.has('a')).toBe(false)
    expect(c.size).toBe(0)
  })

  it('reinsert refreshes TTL', () => {
    const clock = makeClock()
    const c = new LruCache<string, number>({
      maxEntries: 10,
      ttlMs: 1000,
      now: clock.now,
    })
    c.set('a', 1)
    clock.advance(900)
    c.set('a', 2) // refresh
    clock.advance(900) // still within TTL of the second insert
    expect(c.get('a')).toBe(2)
  })

  it('ttlMs = 0 means entries never expire', () => {
    const clock = makeClock()
    const c = new LruCache<string, number>({
      maxEntries: 10,
      ttlMs: 0,
      now: clock.now,
    })
    c.set('a', 1)
    clock.advance(1_000_000_000)
    expect(c.get('a')).toBe(1)
  })
})
