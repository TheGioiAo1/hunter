/**
 * Gbox Platform — Theme Asset Storage helper tests
 *
 * Decision #1 Step 1.16. Drives the R2 promotion / cleanup logic
 * with a `MemoryStore` so we can cover every branch without
 * Postgres or live R2.
 *
 * Coverage:
 *   1. prepareAssetForStorage — small inline (no objectStore touched)
 *   2. prepareAssetForStorage — small inline (objectStore present but unused)
 *   3. prepareAssetForStorage — large + objectStore → R2 path + sentinel
 *   4. prepareAssetForStorage — large + no objectStore → inline fallback
 *   5. prepareAssetForStorage — custom threshold drives the R2 path
 *   6. prepareAssetForStorage — content type forwarded to objectStore.put
 *   7. deleteAssetIfR2 — null/undefined/empty/inline → no-op
 *   8. deleteAssetIfR2 — r2 ref → calls objectStore.delete
 *   9. deleteAssetIfR2 — no objectStore → no-op even with r2 ref
 *  10. deleteAssetIfR2 — swallows delete errors via onError hook
 *  11. reconcileAssetReplacement — inline→inline → nothing
 *  12. reconcileAssetReplacement — inline→r2 → nothing
 *  13. reconcileAssetReplacement — r2→r2 same key → nothing (overwrite)
 *  14. reconcileAssetReplacement — r2→inline → cleans old R2 blob
 *  15. reconcileAssetReplacement — r2→r2 different key → cleans old R2 blob
 *  16. duplicateAsset — null source → null
 *  17. duplicateAsset — inline source → verbatim copy
 *  18. duplicateAsset — r2 source + objectStore → new key, body copied
 *  19. duplicateAsset — r2 source + no objectStore → throws
 *  20. duplicateAsset — r2 source missing in store → throws
 */

import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../storage/memory-store.js'
import {
  deleteAssetIfR2,
  duplicateAsset,
  prepareAssetForStorage,
  reconcileAssetReplacement,
} from './asset-storage.js'
import {
  formatR2ReferenceForAsset,
  R2_THRESHOLD_BYTES,
} from './r2-ref.js'

const THEME_A = 'theme-aaa'
const THEME_B = 'theme-bbb'

describe('prepareAssetForStorage', () => {
  it('keeps small assets inline (no objectStore touched)', async () => {
    const store = new MemoryStore()
    const result = await prepareAssetForStorage(
      THEME_A,
      'snippets/card.liquid',
      'hello world',
      'text/x-liquid',
      { objectStore: store },
    )
    expect(result.kind).toBe('inline')
    expect(result.valueToStore).toBe('hello world')
    expect(result.byteSize).toBe(11)
    expect(store._size()).toBe(0)
  })

  it('keeps small assets inline even with no objectStore', async () => {
    const result = await prepareAssetForStorage(
      THEME_A,
      'snippets/card.liquid',
      'hi',
      null,
    )
    expect(result.kind).toBe('inline')
    expect(result.valueToStore).toBe('hi')
  })

  it('promotes large assets to R2 when an objectStore is present', async () => {
    const store = new MemoryStore()
    const big = 'a'.repeat(R2_THRESHOLD_BYTES + 100)
    const result = await prepareAssetForStorage(
      THEME_A,
      'assets/theme.css',
      big,
      'text/css',
      { objectStore: store },
    )
    expect(result.kind).toBe('r2')
    expect(result.valueToStore).toBe(
      formatR2ReferenceForAsset(THEME_A, 'assets/theme.css'),
    )
    expect(result.byteSize).toBe(big.length)
    expect(store._size()).toBe(1)
    const stored = await store.get('themes/theme-aaa/assets/theme.css')
    expect(stored).not.toBeNull()
    expect(new TextDecoder().decode(stored!)).toBe(big)
  })

  it('falls back to inline when no objectStore (large value, no R2 wire)', async () => {
    const big = 'a'.repeat(R2_THRESHOLD_BYTES + 100)
    const result = await prepareAssetForStorage(
      THEME_A,
      'assets/theme.css',
      big,
      'text/css',
    )
    expect(result.kind).toBe('inline')
    expect(result.valueToStore).toBe(big)
  })

  it('honors a custom threshold (drives R2 path with small payloads)', async () => {
    const store = new MemoryStore()
    const result = await prepareAssetForStorage(
      THEME_A,
      'snippets/card.liquid',
      'this is bigger than four bytes',
      null,
      { objectStore: store, threshold: 4 },
    )
    expect(result.kind).toBe('r2')
    expect(store._size()).toBe(1)
  })

  it('forwards content type to objectStore.put', async () => {
    const store = new MemoryStore()
    await prepareAssetForStorage(
      THEME_A,
      'assets/theme.css',
      'a'.repeat(10),
      'text/css',
      { objectStore: store, threshold: 4 },
    )
    expect(store._getContentType('themes/theme-aaa/assets/theme.css')).toBe(
      'text/css',
    )
  })

  it('handles undefined content type', async () => {
    const store = new MemoryStore()
    await prepareAssetForStorage(
      THEME_A,
      'foo',
      'a'.repeat(10),
      undefined,
      { objectStore: store, threshold: 4 },
    )
    expect(store._getContentType('themes/theme-aaa/foo')).toBeUndefined()
  })
})

describe('deleteAssetIfR2', () => {
  it('is a no-op for null/undefined/empty/inline values', async () => {
    const store = new MemoryStore()
    await deleteAssetIfR2(null, { objectStore: store })
    await deleteAssetIfR2(undefined, { objectStore: store })
    await deleteAssetIfR2('', { objectStore: store })
    await deleteAssetIfR2('plain inline', { objectStore: store })
    expect(store._size()).toBe(0) // nothing existed; nothing changed
  })

  it('deletes the underlying R2 blob when value is an r2 ref', async () => {
    const store = new MemoryStore()
    await store.put('themes/theme-aaa/foo.css', 'body')
    expect(store._size()).toBe(1)
    await deleteAssetIfR2('r2://themes/theme-aaa/foo.css', { objectStore: store })
    expect(store._size()).toBe(0)
  })

  it('is a no-op when no objectStore is supplied (even with r2 ref)', async () => {
    // Just verify it does not throw.
    await deleteAssetIfR2('r2://themes/theme-aaa/foo.css', {})
  })

  it('swallows delete errors and reports via onError hook', async () => {
    const errs: unknown[] = []
    const flaky: any = {
      ...new MemoryStore(),
      delete: async () => {
        throw new Error('boom')
      },
    }
    await deleteAssetIfR2(
      'r2://themes/theme-aaa/foo.css',
      { objectStore: flaky },
      (e) => errs.push(e),
    )
    expect(errs).toHaveLength(1)
    expect((errs[0] as Error).message).toBe('boom')
  })
})

describe('reconcileAssetReplacement', () => {
  it('inline → inline: no R2 cleanup', async () => {
    const store = new MemoryStore()
    await reconcileAssetReplacement('old', 'new', { objectStore: store })
    expect(store._size()).toBe(0)
  })

  it('inline → r2: no R2 cleanup', async () => {
    const store = new MemoryStore()
    await store.put('themes/theme-aaa/foo.css', 'new body')
    await reconcileAssetReplacement(
      'old inline',
      'r2://themes/theme-aaa/foo.css',
      { objectStore: store },
    )
    // The new R2 blob still exists.
    expect(await store.has('themes/theme-aaa/foo.css')).toBe(true)
  })

  it('r2 → r2 same key: overwrite in place, no delete', async () => {
    const store = new MemoryStore()
    await store.put('themes/theme-aaa/foo.css', 'new body')
    await reconcileAssetReplacement(
      'r2://themes/theme-aaa/foo.css',
      'r2://themes/theme-aaa/foo.css',
      { objectStore: store },
    )
    // Same key still exists (the put was the overwrite).
    expect(await store.has('themes/theme-aaa/foo.css')).toBe(true)
  })

  it('r2 → inline: cleans up old R2 blob', async () => {
    const store = new MemoryStore()
    await store.put('themes/theme-aaa/foo.css', 'old body')
    await reconcileAssetReplacement(
      'r2://themes/theme-aaa/foo.css',
      'new inline value',
      { objectStore: store },
    )
    expect(await store.has('themes/theme-aaa/foo.css')).toBe(false)
  })

  it('r2 → r2 different key: cleans up the previous blob', async () => {
    const store = new MemoryStore()
    await store.put('themes/theme-aaa/old.css', 'old body')
    await store.put('themes/theme-aaa/new.css', 'new body')
    await reconcileAssetReplacement(
      'r2://themes/theme-aaa/old.css',
      'r2://themes/theme-aaa/new.css',
      { objectStore: store },
    )
    expect(await store.has('themes/theme-aaa/old.css')).toBe(false)
    expect(await store.has('themes/theme-aaa/new.css')).toBe(true)
  })
})

describe('duplicateAsset', () => {
  it('returns null for null source', async () => {
    const result = await duplicateAsset(null, null, THEME_B, 'foo.css')
    expect(result).toBeNull()
  })

  it('copies an inline source verbatim', async () => {
    const result = await duplicateAsset(
      '<liquid>{{ shop.name }}</liquid>',
      'text/x-liquid',
      THEME_B,
      'snippets/card.liquid',
    )
    expect(result).toBe('<liquid>{{ shop.name }}</liquid>')
  })

  it('downloads + re-uploads R2 source under the new theme key', async () => {
    const store = new MemoryStore()
    // Seed the source theme's R2 blob.
    const sourceBody = 'a'.repeat(1000)
    await store.put('themes/theme-aaa/assets/theme.css', sourceBody, {
      contentType: 'text/css',
    })

    const sourceValue = formatR2ReferenceForAsset(THEME_A, 'assets/theme.css')
    const result = await duplicateAsset(
      sourceValue,
      'text/css',
      THEME_B,
      'assets/theme.css',
      { objectStore: store },
    )

    expect(result).toBe(formatR2ReferenceForAsset(THEME_B, 'assets/theme.css'))
    // New blob exists with same body.
    const newBody = await store.get('themes/theme-bbb/assets/theme.css')
    expect(newBody).not.toBeNull()
    expect(new TextDecoder().decode(newBody!)).toBe(sourceBody)
    // Old blob untouched.
    const oldBody = await store.get('themes/theme-aaa/assets/theme.css')
    expect(oldBody).not.toBeNull()
    // Content type preserved.
    expect(store._getContentType('themes/theme-bbb/assets/theme.css')).toBe(
      'text/css',
    )
  })

  it('throws when source is r2 but no objectStore is supplied', async () => {
    const sourceValue = formatR2ReferenceForAsset(THEME_A, 'foo.css')
    await expect(
      duplicateAsset(sourceValue, null, THEME_B, 'foo.css'),
    ).rejects.toThrow(/objectStore/)
  })

  it('throws when source R2 blob is missing (orphaned reference)', async () => {
    const store = new MemoryStore()
    const sourceValue = formatR2ReferenceForAsset(THEME_A, 'gone.css')
    await expect(
      duplicateAsset(sourceValue, null, THEME_B, 'gone.css', {
        objectStore: store,
      }),
    ).rejects.toThrow(/orphaned/)
  })
})
