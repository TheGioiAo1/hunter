/**
 * Clone Pro — ai-alt-text-optimizer tests
 *
 * Pins the behaviour contract for the batch alt-text generator:
 *
 *   - Finds images where alt is NULL or '' and fills them via the AI bridge
 *   - Uses product title as context in the AI call
 *   - Persists `alt` back to product_images via UPDATE
 *   - Respects dryRun (no writes)
 *   - Truncates AI output to 125 chars
 *   - Counts failures (thrown + empty-result) without aborting the run
 *   - Emits progress events with 1-based index and total
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { optimizeAltTextForShop } from './ai-alt-text-optimizer.js'
import type { AIBridge } from './ai-bridge.js'

// ---------------------------------------------------------------------------
// AIBridge stub
// ---------------------------------------------------------------------------

function makeAi(overrides: Partial<AIBridge> = {}): AIBridge {
  return {
    provider: 'openai' as any,
    capabilities: {
      layoutAnalysis: true,
      sectionDetection: true,
      contentRewriting: true,
      imageAltText: true,
      seoOptimization: true,
    } as any,
    analyzeLayout: vi.fn() as any,
    analyzeContent: vi.fn() as any,
    generateAltText: vi.fn().mockResolvedValue('A red leather handbag.'),
    suggestSections: vi.fn() as any,
    rewriteContent: vi.fn() as any,
    generateSeoMeta: vi.fn() as any,
    ...overrides,
  } as AIBridge
}

// ---------------------------------------------------------------------------
// Chainable mock DB
//
// The optimizer issues one SELECT with a JOIN + WHERE, then N UPDATEs
// — all single-table. The mock ignores the join and just returns the
// rows we seed for `product_images`.
// ---------------------------------------------------------------------------

interface DbState {
  readonly rows: Array<{ id: string; src: string; productTitle: string | null }>
  readonly updates: Array<{ id: string; alt: string }>
}

function makeDb(
  rows: Array<{ id: string; src: string; productTitle: string | null }>,
): { db: any; state: DbState } {
  const state: DbState = { rows, updates: [] }

  const selectBuilder: any = {
    innerJoin: () => selectBuilder,
    select: () => selectBuilder,
    where: () => selectBuilder,
    limit: () => selectBuilder,
    execute: vi.fn().mockResolvedValue(rows),
  }

  function makeUpdate() {
    let currentId = ''
    let currentSet: Record<string, any> = {}
    const builder: any = {
      set: (v: Record<string, any>) => {
        currentSet = v
        return builder
      },
      where: (col: string, _op: string, val: any) => {
        if (col === 'id') currentId = val
        return builder
      },
      execute: vi.fn().mockImplementation(async () => {
        state.updates.push({ id: currentId, alt: currentSet.alt })
      }),
    }
    return builder
  }

  const db = {
    selectFrom: vi.fn().mockImplementation(() => selectBuilder),
    updateTable: vi.fn().mockImplementation(() => makeUpdate()),
  }

  return { db, state }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('optimizeAltTextForShop — core behaviour', () => {
  it('generates and persists alt text for each missing image', async () => {
    const ai = makeAi()
    const { db, state } = makeDb([
      { id: 'i1', src: 'https://cdn/a.jpg', productTitle: 'Red Shoe' },
      { id: 'i2', src: 'https://cdn/b.jpg', productTitle: 'Blue Hat' },
    ])

    const result = await optimizeAltTextForShop({ db, shopId: 's1', ai })

    expect(ai.generateAltText).toHaveBeenCalledTimes(2)
    expect(ai.generateAltText).toHaveBeenNthCalledWith(1, 'https://cdn/a.jpg', 'Red Shoe')
    expect(ai.generateAltText).toHaveBeenNthCalledWith(2, 'https://cdn/b.jpg', 'Blue Hat')
    expect(state.updates).toEqual([
      { id: 'i1', alt: 'A red leather handbag.' },
      { id: 'i2', alt: 'A red leather handbag.' },
    ])
    expect(result.optimized).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.total).toBe(2)
  })

  it('passes empty string as context when productTitle is null', async () => {
    const ai = makeAi()
    const { db } = makeDb([
      { id: 'i1', src: 'https://cdn/x.jpg', productTitle: null },
    ])

    await optimizeAltTextForShop({ db, shopId: 's1', ai })

    expect(ai.generateAltText).toHaveBeenCalledWith('https://cdn/x.jpg', '')
  })

  it('honours dryRun — no UPDATE issued', async () => {
    const ai = makeAi()
    const { db, state } = makeDb([
      { id: 'i1', src: 'https://cdn/a.jpg', productTitle: 'T' },
    ])

    const result = await optimizeAltTextForShop({
      db,
      shopId: 's1',
      ai,
      dryRun: true,
    })

    expect(state.updates).toHaveLength(0)
    expect(result.optimized).toBe(1)
  })

  it('is a safe no-op when there are zero candidates', async () => {
    const ai = makeAi()
    const { db } = makeDb([])

    const result = await optimizeAltTextForShop({ db, shopId: 's1', ai })

    expect(ai.generateAltText).not.toHaveBeenCalled()
    expect(result).toEqual({ optimized: 0, failed: 0, total: 0 })
  })
})

describe('optimizeAltTextForShop — truncation', () => {
  it('caps alt text at 125 chars', async () => {
    const long = 'A'.repeat(400)
    const ai = makeAi({
      generateAltText: vi.fn().mockResolvedValue(long),
    })
    const { db, state } = makeDb([
      { id: 'i1', src: 'https://cdn/a.jpg', productTitle: 'x' },
    ])

    await optimizeAltTextForShop({ db, shopId: 's1', ai })

    expect(state.updates[0]!.alt.length).toBeLessThanOrEqual(125)
  })

  it('trims surrounding whitespace from the AI response', async () => {
    const ai = makeAi({
      generateAltText: vi.fn().mockResolvedValue('   A clean alt.   '),
    })
    const { db, state } = makeDb([
      { id: 'i1', src: 'https://cdn/a.jpg', productTitle: 'x' },
    ])

    await optimizeAltTextForShop({ db, shopId: 's1', ai })

    expect(state.updates[0]!.alt).toBe('A clean alt.')
  })
})

describe('optimizeAltTextForShop — failures are non-fatal', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('counts thrown errors as failures and keeps going', async () => {
    const ai = makeAi({
      generateAltText: vi
        .fn()
        .mockRejectedValueOnce(new Error('429 too many'))
        .mockResolvedValue('ok alt'),
    })
    const { db, state } = makeDb([
      { id: 'i1', src: 'https://cdn/a.jpg', productTitle: 'A' },
      { id: 'i2', src: 'https://cdn/b.jpg', productTitle: 'B' },
    ])

    const result = await optimizeAltTextForShop({ db, shopId: 's1', ai })

    expect(result.failed).toBe(1)
    expect(result.optimized).toBe(1)
    expect(state.updates).toEqual([{ id: 'i2', alt: 'ok alt' }])
  })

  it('counts empty AI result as a failure (no update)', async () => {
    const ai = makeAi({
      generateAltText: vi.fn().mockResolvedValue(''),
    })
    const { db, state } = makeDb([
      { id: 'i1', src: 'https://cdn/a.jpg', productTitle: 'T' },
    ])

    const result = await optimizeAltTextForShop({ db, shopId: 's1', ai })

    expect(result.optimized).toBe(0)
    expect(result.failed).toBe(1)
    expect(state.updates).toHaveLength(0)
  })
})

describe('optimizeAltTextForShop — progress reporting', () => {
  it('fires progress with 1-based index and label', async () => {
    const ai = makeAi()
    const { db } = makeDb([
      { id: 'i1', src: 'https://cdn/a.jpg', productTitle: 'Red Shoe' },
      { id: 'i2', src: 'https://cdn/b.jpg', productTitle: null },
    ])
    const progress = vi.fn()

    await optimizeAltTextForShop({
      db,
      shopId: 's1',
      ai,
      onProgress: progress,
    })

    expect(progress).toHaveBeenCalledTimes(2)
    expect(progress.mock.calls[0]).toEqual([1, 2, 'image:Red Shoe'])
    // Null productTitle falls back to the image id in the label.
    expect(progress.mock.calls[1]).toEqual([2, 2, 'image:i2'])
  })
})
