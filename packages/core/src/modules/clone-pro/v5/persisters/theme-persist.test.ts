import { describe, it, expect } from 'vitest'
import { persistTheme } from './theme-persist.js'
import type { ThemeTokens } from '../types.js'

// Fake tx matches the shape Kysely exposes — records every write so we
// can assert upsert shape without a real DB.
function makeFakeTx() {
  const writes: Array<{ table: string; values: any; conflict?: string[] }> = []
  const tx: any = {
    insertInto: (table: string) => ({
      values: (v: any) => ({
        onConflict: (cb: any) => {
          // Capture which column(s) drove onConflict.
          const conflict: { cols: string[] } = { cols: [] }
          const oc = {
            column: (c: string) => {
              conflict.cols.push(c)
              return oc
            },
            columns: (cs: string[]) => {
              conflict.cols.push(...cs)
              return oc
            },
            doUpdateSet: (_p: any) => ({
              execute: async () => {
                writes.push({ table, values: v, conflict: conflict.cols })
              },
            }),
          }
          return cb(oc)
        },
      }),
    }),
  }
  return { tx, writes }
}

const baseTokens: ThemeTokens = {
  colors: {
    primary: '#ff0000',
    secondary: '#00ff00',
    background: '#ffffff',
    text: '#000000',
  },
  typography: {
    heading_family: 'Inter',
    body_family: 'Roboto',
    base_size_px: 16,
  },
  spacing: {
    base_px: 8,
  },
  radius_px: 4,
  raw_css_vars: {
    '--x-primary': '#ff0000',
    '--x-accent': '#ffaa00',
  },
}

describe('persistTheme', () => {
  it('upserts shop_theme_tokens by shop_id with tokens_json payload', async () => {
    const { tx, writes } = makeFakeTx()
    const res = await persistTheme(tx, 'shop-1', baseTokens)

    expect(res.inserted).toBe(1)
    expect(writes).toHaveLength(1)
    expect(writes[0].table).toBe('shop_theme_tokens')
    expect(writes[0].conflict).toEqual(['shop_id'])
    expect(writes[0].values.shop_id).toBe('shop-1')
    expect(writes[0].values.tokens_json).toBeDefined()
  })

  it('stores the full ThemeTokens shape inside tokens_json', async () => {
    const { tx, writes } = makeFakeTx()
    await persistTheme(tx, 'shop-1', baseTokens)

    const stored = writes[0].values.tokens_json
    expect(stored.colors.primary).toBe('#ff0000')
    expect(stored.typography.heading_family).toBe('Inter')
    expect(stored.spacing.base_px).toBe(8)
    expect(stored.radius_px).toBe(4)
    expect(stored.raw_css_vars['--x-primary']).toBe('#ff0000')
  })

  it('propagates insert errors (does NOT swallow — pg 25P02 aborts the whole tx)', async () => {
    // Persisters run inside `withSerializable`; a caught error leaves the
    // Postgres transaction in `25P02 aborted` state and masks the real
    // failure on every subsequent query. The correct behavior is to
    // propagate so withSerializable can retry (40001/40P01) or fail clean.
    const tx: any = {
      insertInto: (_t: string) => ({
        values: (_v: any) => ({
          onConflict: (cb: any) => {
            // Drive the real Kysely shape: cb(oc) → oc.column().doUpdateSet().execute()
            const oc = {
              column: (_c: string) => oc,
              columns: (_cs: string[]) => oc,
              doUpdateSet: (_p: any) => ({
                execute: async () => {
                  throw new Error('boom')
                },
              }),
            }
            return cb(oc)
          },
        }),
      }),
    }
    await expect(persistTheme(tx as any, 'shop-1', baseTokens)).rejects.toThrow('boom')
  })
})
