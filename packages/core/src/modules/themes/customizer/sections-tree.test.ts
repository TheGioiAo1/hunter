/**
 * Theme Customizer — sections-tree unit tests
 *
 * Cases covered:
 *   1. Empty theme returns []
 *   2. 3 sections returned in position order
 *   3. Display name = schema.name when present, humanized type when not
 *   4. blockCount derived from blocks_json array length
 *   5. Hidden sections (enabled=false) still returned (UI filters)
 */

import { describe, it, expect } from 'vitest'
import { loadSectionsTree, humanizeType } from './sections-tree.js'

// Minimal Kysely-like mock — only the chain used in loadSectionsTree.
function mockDb(rows: any[]) {
  return {
    selectFrom: () => ({
      leftJoin: () => ({
        select: () => ({
          where: () => ({
            where: () => ({
              orderBy: () => ({
                execute: async () => rows,
              }),
            }),
          }),
        }),
      }),
    }),
  } as any
}

describe('humanizeType', () => {
  it('hyphen-separated → Title Case words', () => {
    expect(humanizeType('featured-products')).toBe('Featured Products')
  })

  it('underscore-separated → Title Case words', () => {
    expect(humanizeType('hero_banner_v2')).toBe('Hero Banner V2')
  })

  it('single token capitalised', () => {
    expect(humanizeType('hero')).toBe('Hero')
  })

  it('empty string falls back', () => {
    expect(humanizeType('')).toBe('Section')
  })
})

describe('loadSectionsTree', () => {
  it('empty theme → []', async () => {
    const db = mockDb([])
    const tree = await loadSectionsTree(db, 'theme-1', 'index')
    expect(tree).toEqual([])
  })

  it('returns sections in position order with all fields', async () => {
    const db = mockDb([
      {
        id: 's1',
        key: 'hero',
        type: 'hero-banner',
        position: 0,
        enabled: true,
        blocks_json: [],
        schemaName: 'Hero Banner',
        schemaIcon: 'banner',
      },
      {
        id: 's2',
        key: 'featured',
        type: 'featured-collection',
        position: 1,
        enabled: true,
        blocks_json: [{ id: 'b1' }, { id: 'b2' }],
        schemaName: 'Featured Collection',
        schemaIcon: 'collection',
      },
    ])

    const tree = await loadSectionsTree(db, 'theme-1', 'index')
    expect(tree).toHaveLength(2)
    expect(tree[0]).toEqual({
      id: 's1',
      key: 'hero',
      type: 'hero-banner',
      name: 'Hero Banner',
      icon: 'banner',
      position: 0,
      enabled: true,
      hasBlocks: false,
      blockCount: 0,
    })
    expect(tree[1].name).toBe('Featured Collection')
    expect(tree[1].hasBlocks).toBe(true)
    expect(tree[1].blockCount).toBe(2)
  })

  it('humanizes type when schema row missing (LEFT JOIN miss)', async () => {
    const db = mockDb([
      {
        id: 's3',
        key: 'newsletter',
        type: 'email-signup',
        position: 0,
        enabled: true,
        blocks_json: null,
        schemaName: null,
        schemaIcon: null,
      },
    ])

    const tree = await loadSectionsTree(db, 'theme-1', 'index')
    expect(tree[0].name).toBe('Email Signup')
    expect(tree[0].icon).toBe('box')
    expect(tree[0].hasBlocks).toBe(false)
    expect(tree[0].blockCount).toBe(0)
  })

  it('hidden sections (enabled=false) still returned', async () => {
    const db = mockDb([
      {
        id: 's4',
        key: 'announcement',
        type: 'announcement-bar',
        position: 0,
        enabled: false,
        blocks_json: [],
        schemaName: 'Announcement Bar',
        schemaIcon: 'megaphone',
      },
    ])

    const tree = await loadSectionsTree(db, 'theme-1', 'index')
    expect(tree).toHaveLength(1)
    expect(tree[0].enabled).toBe(false)
  })

  it('handles non-array blocks_json gracefully (legacy data)', async () => {
    const db = mockDb([
      {
        id: 's5',
        key: 'rich-text',
        type: 'rich-text',
        position: 0,
        enabled: true,
        blocks_json: { malformed: true }, // not an array
        schemaName: null,
        schemaIcon: null,
      },
    ])

    const tree = await loadSectionsTree(db, 'theme-1', 'index')
    expect(tree[0].hasBlocks).toBe(false)
    expect(tree[0].blockCount).toBe(0)
  })
})
