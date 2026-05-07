/**
 * Unit tests for Phase 14 PR1.5 — `resolveTemplate()` + override CRUD.
 *
 * Philosophy: pure tests against a stubbed Kysely-shaped DB. We verify
 * the merge logic (override → db default → in-code catalog) and the
 * active-flag policy (forced-send categories ignore active=false).
 */

import { describe, it, expect } from 'vitest'
import {
  resolveTemplate,
  upsertTemplateOverride,
  clearTemplateOverride,
  listShopOverrides,
  getTemplate,
} from './registry.js'

// ---------------------------------------------------------------------------
// Tiny in-memory Kysely stub that covers only the shapes resolveTemplate,
// upsertTemplateOverride, clearTemplateOverride, listShopOverrides need.
// ---------------------------------------------------------------------------
//
// The stub supports two "tables":
//   - email_template_registry  (default row per template_key)
//   - email_template_overrides (override row per (shop_id, template_key))
//
// The query shape is narrow: selectFrom().select().where().where().
// executeTakeFirst(). We hand-roll filter matching against the `filters`
// list the builder collects. This is not a full Kysely impl — only
// what these four functions exercise.

type TableName = 'email_template_registry' | 'email_template_overrides'

interface RegistryRow {
  template_key: string
  subject_default: string | null
  body_html_default: string | null
  body_text_default: string | null
  active: boolean | null
}

interface OverrideRow {
  shop_id: string
  template_key: string
  subject_custom: string | null
  body_html_custom: string | null
  body_text_custom: string | null
  active: boolean | null
}

function makeStubDb() {
  const registry: RegistryRow[] = []
  const overrides: OverrideRow[] = []

  // ─── Generic where-chain ──────────────────────────────────────────────
  function whereChain<T extends Record<string, unknown>>(table: T[], cols: readonly string[]) {
    const filters: Array<[string, string, unknown]> = []
    const api = {
      where(col: string, op: string, val: unknown) {
        filters.push([col, op, val])
        return api
      },
      execute: async () => {
        const rows = table.filter((row) => filters.every(([c, _o, v]) => row[c] === v))
        return rows.map((row) => {
          const out: Record<string, unknown> = {}
          for (const c of cols) out[c] = row[c]
          return out
        })
      },
      executeTakeFirst: async () => {
        const results = await api.execute()
        return results[0]
      },
    }
    return api
  }

  // ─── selectFrom ───────────────────────────────────────────────────────
  function selectFrom(table: TableName) {
    return {
      select(cols: readonly string[]) {
        if (table === 'email_template_registry') return whereChain(registry, cols)
        return whereChain(overrides, cols)
      },
    }
  }

  // ─── insertInto (with onConflict) ─────────────────────────────────────
  function insertInto(table: TableName) {
    if (table !== 'email_template_overrides') {
      throw new Error('stub only supports insert to email_template_overrides')
    }
    return {
      values(v: Record<string, unknown>) {
        return {
          onConflict(
            cb: (oc: {
              columns: (cols: readonly string[]) => {
                doUpdateSet: (set: Record<string, unknown>) => unknown
              }
            }) => unknown,
          ) {
            let updateSet: Record<string, unknown> | null = null
            cb({
              columns: () => ({
                doUpdateSet(set: Record<string, unknown>) {
                  updateSet = set
                  return {}
                },
              }),
            })
            return {
              execute: async () => {
                const existing = overrides.find(
                  (r) => r.shop_id === v.shop_id && r.template_key === v.template_key,
                )
                if (existing) {
                  Object.assign(existing, updateSet ?? {})
                } else {
                  overrides.push({
                    shop_id: v.shop_id as string,
                    template_key: v.template_key as string,
                    subject_custom: (v.subject_custom as string | null) ?? null,
                    body_html_custom: (v.body_html_custom as string | null) ?? null,
                    body_text_custom: (v.body_text_custom as string | null) ?? null,
                    active: (v.active as boolean | null) ?? true,
                  })
                }
              },
            }
          },
        }
      },
    }
  }

  // ─── deleteFrom ───────────────────────────────────────────────────────
  function deleteFrom(table: TableName) {
    if (table !== 'email_template_overrides') {
      throw new Error('stub only supports delete on email_template_overrides')
    }
    const filters: Array<[string, unknown]> = []
    const api = {
      where(col: string, _op: string, val: unknown) {
        filters.push([col, val])
        return api
      },
      execute: async () => {
        const keepIdx = overrides
          .map((r, i) => ({ r, i }))
          .filter(({ r }) => !filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v))
          .map(({ i }) => i)
        const keep = keepIdx.map((i) => overrides[i])
        overrides.length = 0
        overrides.push(...keep)
      },
    }
    return api
  }

  return {
    _seedRegistry(rows: RegistryRow[]) {
      registry.push(...rows)
    },
    _seedOverrides(rows: OverrideRow[]) {
      overrides.push(...rows)
    },
    _dumpOverrides() {
      return [...overrides]
    },
    selectFrom,
    insertInto,
    deleteFrom,
  }
}

// A non-forced-send template (we pick one from the real catalog so the
// in-code fallback path is realistic).
const MARKETING_KEY = 'campaign_promo' // spec.category = 'marketing'
// A forced-send template — transactional, used to verify active=false
// is ignored.
const TXN_KEY = 'order_confirmation'   // spec.category = 'transactional'

describe('resolveTemplate — PR1.5 merge logic', () => {
  it('returns null for unknown keys', async () => {
    const db = makeStubDb()
    const out = await resolveTemplate(db, 'shop-a', 'no_such_template_xyz')
    expect(out).toBeNull()
  })

  it('platform-scope (shopId=null) bypasses the DB entirely', async () => {
    const db = makeStubDb()
    const out = await resolveTemplate(db, null, MARKETING_KEY)
    expect(out).not.toBeNull()
    expect(out!.overridden).toBe(false)
    // Falls through to the in-code catalog since no DB row exists.
    const spec = getTemplate(MARKETING_KEY)!
    expect(out!.subject).toBe(spec.subject)
    expect(out!.active).toBe(true)
  })

  it('null db arg short-circuits even when shopId is set (test + preview path)', async () => {
    const out = await resolveTemplate(null, 'shop-a', MARKETING_KEY)
    expect(out).not.toBeNull()
    expect(out!.overridden).toBe(false)
  })

  it('uses in-code defaults when no DB row exists (pre-seed dev box)', async () => {
    const db = makeStubDb()
    const out = await resolveTemplate(db, 'shop-a', MARKETING_KEY)
    expect(out).not.toBeNull()
    const spec = getTemplate(MARKETING_KEY)!
    expect(out!.subject).toBe(spec.subject)
    expect(out!.bodyHtml).toBe(spec.bodyHtml)
    expect(out!.overridden).toBe(false)
  })

  it('DB default row beats in-code catalog when present', async () => {
    const db = makeStubDb()
    db._seedRegistry([
      {
        template_key: MARKETING_KEY,
        subject_default: 'DB-level subject',
        body_html_default: '<h1>DB-level HTML</h1>',
        body_text_default: 'DB-level text',
        active: true,
      },
    ])
    const out = await resolveTemplate(db, 'shop-a', MARKETING_KEY)
    expect(out!.subject).toBe('DB-level subject')
    expect(out!.bodyHtml).toBe('<h1>DB-level HTML</h1>')
    expect(out!.bodyText).toBe('DB-level text')
    expect(out!.overridden).toBe(false)
  })

  it('shop override beats DB default AND in-code catalog', async () => {
    const db = makeStubDb()
    db._seedRegistry([
      {
        template_key: MARKETING_KEY,
        subject_default: 'DB default subject',
        body_html_default: '<h1>DB default</h1>',
        body_text_default: 'DB default text',
        active: true,
      },
    ])
    db._seedOverrides([
      {
        shop_id: 'shop-a',
        template_key: MARKETING_KEY,
        subject_custom: 'Shop custom subject',
        body_html_custom: '<h1>Shop custom</h1>',
        body_text_custom: 'Shop custom text',
        active: true,
      },
    ])
    const out = await resolveTemplate(db, 'shop-a', MARKETING_KEY)
    expect(out!.subject).toBe('Shop custom subject')
    expect(out!.bodyHtml).toBe('<h1>Shop custom</h1>')
    expect(out!.bodyText).toBe('Shop custom text')
    expect(out!.overridden).toBe(true)
  })

  it('partial override — only subject_custom set — falls through other fields', async () => {
    const db = makeStubDb()
    db._seedRegistry([
      {
        template_key: MARKETING_KEY,
        subject_default: 'DB subject',
        body_html_default: '<h1>DB HTML</h1>',
        body_text_default: 'DB text',
        active: true,
      },
    ])
    db._seedOverrides([
      {
        shop_id: 'shop-a',
        template_key: MARKETING_KEY,
        subject_custom: 'Only subject override',
        body_html_custom: null,
        body_text_custom: null,
        active: true,
      },
    ])
    const out = await resolveTemplate(db, 'shop-a', MARKETING_KEY)
    expect(out!.subject).toBe('Only subject override')
    expect(out!.bodyHtml).toBe('<h1>DB HTML</h1>')
    expect(out!.bodyText).toBe('DB text')
    expect(out!.overridden).toBe(true)
  })

  it('overrides scoped per shop — shop-b does not see shop-a override', async () => {
    const db = makeStubDb()
    db._seedOverrides([
      {
        shop_id: 'shop-a',
        template_key: MARKETING_KEY,
        subject_custom: 'Shop-a only',
        body_html_custom: null,
        body_text_custom: null,
        active: true,
      },
    ])
    const outA = await resolveTemplate(db, 'shop-a', MARKETING_KEY)
    const outB = await resolveTemplate(db, 'shop-b', MARKETING_KEY)
    expect(outA!.subject).toBe('Shop-a only')
    expect(outA!.overridden).toBe(true)
    const spec = getTemplate(MARKETING_KEY)!
    expect(outB!.subject).toBe(spec.subject)
    expect(outB!.overridden).toBe(false)
  })

  it('override.active=false on marketing template → resolved.active=false', async () => {
    const db = makeStubDb()
    db._seedOverrides([
      {
        shop_id: 'shop-a',
        template_key: MARKETING_KEY,
        subject_custom: null,
        body_html_custom: null,
        body_text_custom: null,
        active: false,
      },
    ])
    const out = await resolveTemplate(db, 'shop-a', MARKETING_KEY)
    expect(out!.active).toBe(false)
    expect(out!.overridden).toBe(true)
  })

  it('override.active=false on TRANSACTIONAL template → IGNORED (seller footgun guard)', async () => {
    const db = makeStubDb()
    db._seedOverrides([
      {
        shop_id: 'shop-a',
        template_key: TXN_KEY,
        subject_custom: null,
        body_html_custom: null,
        body_text_custom: null,
        active: false,
      },
    ])
    const out = await resolveTemplate(db, 'shop-a', TXN_KEY)
    expect(out!.active).toBe(true) // forced through regardless
    // overridden still true — the toggle is there, we just don't honour it.
    expect(out!.overridden).toBe(true)
  })

  it('DB default with active=false on marketing → resolved.active=false (god-admin-level disable)', async () => {
    const db = makeStubDb()
    db._seedRegistry([
      {
        template_key: MARKETING_KEY,
        subject_default: 'X',
        body_html_default: '<p>Y</p>',
        body_text_default: 'Y',
        active: false,
      },
    ])
    const out = await resolveTemplate(db, 'shop-a', MARKETING_KEY)
    expect(out!.active).toBe(false)
  })

  it('DB default with active=false on TRANSACTIONAL → resolved.active=true', async () => {
    const db = makeStubDb()
    db._seedRegistry([
      {
        template_key: TXN_KEY,
        subject_default: 'X',
        body_html_default: '<p>Y</p>',
        body_text_default: 'Y',
        active: false,
      },
    ])
    const out = await resolveTemplate(db, 'shop-a', TXN_KEY)
    expect(out!.active).toBe(true)
  })
})

describe('Override CRUD', () => {
  it('upsert inserts on first call, updates on second', async () => {
    const db = makeStubDb()
    await upsertTemplateOverride(db, {
      shopId: 'shop-a',
      templateKey: MARKETING_KEY,
      subjectCustom: 'First',
      bodyHtmlCustom: '<p>v1</p>',
    })
    expect(db._dumpOverrides()).toHaveLength(1)
    expect(db._dumpOverrides()[0].subject_custom).toBe('First')

    await upsertTemplateOverride(db, {
      shopId: 'shop-a',
      templateKey: MARKETING_KEY,
      subjectCustom: 'Second',
    })
    expect(db._dumpOverrides()).toHaveLength(1)
    expect(db._dumpOverrides()[0].subject_custom).toBe('Second')
    // body_html_custom should NOT be touched (undefined in the second call)
    expect(db._dumpOverrides()[0].body_html_custom).toBe('<p>v1</p>')
  })

  it('upsert with explicit null clears a field', async () => {
    const db = makeStubDb()
    await upsertTemplateOverride(db, {
      shopId: 'shop-a',
      templateKey: MARKETING_KEY,
      subjectCustom: 'Initial',
    })
    await upsertTemplateOverride(db, {
      shopId: 'shop-a',
      templateKey: MARKETING_KEY,
      subjectCustom: null,
    })
    expect(db._dumpOverrides()[0].subject_custom).toBeNull()
  })

  it('clearTemplateOverride removes the row (reset-to-default)', async () => {
    const db = makeStubDb()
    await upsertTemplateOverride(db, {
      shopId: 'shop-a',
      templateKey: MARKETING_KEY,
      subjectCustom: 'X',
    })
    expect(db._dumpOverrides()).toHaveLength(1)
    await clearTemplateOverride(db, 'shop-a', MARKETING_KEY)
    expect(db._dumpOverrides()).toHaveLength(0)
  })

  it('listShopOverrides returns only rows for that shop', async () => {
    const db = makeStubDb()
    await upsertTemplateOverride(db, {
      shopId: 'shop-a',
      templateKey: 'campaign_promo',
      subjectCustom: 'A',
    })
    await upsertTemplateOverride(db, {
      shopId: 'shop-a',
      templateKey: 'review_request',
      subjectCustom: 'B',
    })
    await upsertTemplateOverride(db, {
      shopId: 'shop-b',
      templateKey: 'campaign_promo',
      subjectCustom: 'C',
    })
    const list = await listShopOverrides(db, 'shop-a')
    expect(list).toHaveLength(2)
    expect(list.map((r) => r.template_key).sort()).toEqual(['campaign_promo', 'review_request'])
  })
})
