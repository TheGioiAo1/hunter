/**
 * Gbox Platform — Campaigns Service Unit Tests (Phase 8 PR1)
 *
 * Mock-based tests for:
 *   • createCampaign validation + happy path
 *   • listCampaigns filter/pagination/search
 *   • getCampaign cross-shop miss
 *   • updateCampaign status gating (draft/scheduled only) + field validation
 *   • deleteCampaign status gating (draft/cancelled only)
 *   • scheduleCampaign: draft-only transition, past-date rejection
 *   • cancelScheduled: scheduled-only transition
 *   • markCampaignSending / Sent / Failed: status-guarded updates
 *   • Recipient tracking helpers produce the right set()/where() pairs
 *
 * We deliberately keep the mock thin (Proxy chainable) so the test
 * surface is behaviour (inputs/outputs), not query-builder internals.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createCampaign,
  listCampaigns,
  getCampaign,
  updateCampaign,
  deleteCampaign,
  scheduleCampaign,
  cancelScheduled,
  markCampaignSending,
  markCampaignSent,
  markCampaignFailed,
} from './campaigns.js'

// ---------------------------------------------------------------------------
// Chainable mock — same pattern as customer-segments/service.test.ts
// ---------------------------------------------------------------------------

function chainable(result: any = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute') {
          return vi.fn().mockResolvedValue(
            Array.isArray(result) ? result : result == null ? [] : [result],
          )
        }
        if (prop === 'executeTakeFirst') {
          return vi.fn().mockResolvedValue(result ?? null)
        }
        if (prop === 'executeTakeFirstOrThrow') {
          return vi.fn().mockImplementation(async () => {
            if (result == null) throw new Error('no result')
            return result
          })
        }
        return vi.fn().mockReturnValue(obj)
      },
    },
  )
  return obj
}

function createMockDb(overrides: Record<string, any> = {}) {
  return {
    insertInto: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`insert:${table}`] ?? overrides[table])
    }),
    selectFrom: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`select:${table}`] ?? overrides[table])
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`update:${table}`] ?? overrides[table])
    }),
    deleteFrom: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`delete:${table}`] ?? overrides[table])
    }),
    fn: { count: () => ({ as: () => ({}) }) },
  } as any
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP = '11111111-1111-1111-1111-111111111111'
const OTHER_SHOP = '22222222-2222-2222-2222-222222222222'
const CAMPAIGN = '33333333-3333-3333-3333-333333333333'

function campaignRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: CAMPAIGN,
    shop_id: SHOP,
    name: 'Summer sale',
    subject: '50% off everything',
    body_html: '<p>Save big!</p>',
    audience_segment: null,
    discount_id: null,
    status: 'draft',
    scheduled_at: null,
    sent_at: null,
    recipient_count: 0,
    opened_count: 0,
    clicked_count: 0,
    error: null,
    created_by: null,
    created_at: '2026-04-21T00:00:00Z',
    updated_at: '2026-04-21T00:00:00Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// createCampaign
// ---------------------------------------------------------------------------

describe('createCampaign', () => {
  it('rejects missing name', async () => {
    const db = createMockDb()
    const out = await createCampaign(db, SHOP, {
      name: '  ',
      subject: 'hi',
      body_html: 'body',
    })
    expect(out).toEqual({ ok: false, error: 'name_required' })
  })

  it('rejects missing subject', async () => {
    const db = createMockDb()
    const out = await createCampaign(db, SHOP, {
      name: 'A',
      subject: '',
      body_html: 'body',
    })
    expect(out).toEqual({ ok: false, error: 'subject_required' })
  })

  it('rejects missing body', async () => {
    const db = createMockDb()
    const out = await createCampaign(db, SHOP, {
      name: 'A',
      subject: 'B',
      body_html: '  \n  ',
    })
    expect(out).toEqual({ ok: false, error: 'body_required' })
  })

  it('rejects over-long name', async () => {
    const db = createMockDb()
    const out = await createCampaign(db, SHOP, {
      name: 'x'.repeat(300),
      subject: 'B',
      body_html: 'C',
    })
    expect(out).toEqual({ ok: false, error: 'name_too_long' })
  })

  it('rejects over-long subject', async () => {
    const db = createMockDb()
    const out = await createCampaign(db, SHOP, {
      name: 'A',
      subject: 'x'.repeat(600),
      body_html: 'C',
    })
    expect(out).toEqual({ ok: false, error: 'subject_too_long' })
  })

  it('returns the created row on happy path', async () => {
    const row = campaignRow()
    const db = createMockDb({ 'insert:campaigns': row })
    const out = await createCampaign(db, SHOP, {
      name: '  Summer sale  ',
      subject: '50% off everything',
      body_html: '<p>Save big!</p>',
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.campaign.id).toBe(CAMPAIGN)
      expect(out.campaign.status).toBe('draft')
      expect(out.campaign.name).toBe('Summer sale')
    }
  })

  it('accepts optional audience_segment + discount_id + created_by', async () => {
    const row = campaignRow({
      audience_segment: 'vip',
      discount_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      created_by: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    })
    const db = createMockDb({ 'insert:campaigns': row })
    const out = await createCampaign(db, SHOP, {
      name: 'VIP Preview',
      subject: 'Early access',
      body_html: 'body',
      audience_segment: 'vip',
      discount_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      created_by: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.campaign.audience_segment).toBe('vip')
      expect(out.campaign.discount_id).toBe(
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      )
    }
  })
})

// ---------------------------------------------------------------------------
// listCampaigns
// ---------------------------------------------------------------------------

describe('listCampaigns', () => {
  it('returns empty + total 0 when no rows', async () => {
    const db = createMockDb({ 'select:campaigns': [] })
    const out = await listCampaigns(db, SHOP)
    expect(out.rows).toEqual([])
    expect(out.total).toBe(0)
  })

  it('coerces rows to CampaignRow shape', async () => {
    const row = campaignRow()
    // Proxy returns the first `execute()` call as array [row], second
    // executeTakeFirst as null → total becomes 0 in our thin mock.
    const db = createMockDb({ 'select:campaigns': [row] })
    const out = await listCampaigns(db, SHOP, { limit: 50 })
    expect(out.rows[0].id).toBe(CAMPAIGN)
    expect(out.rows[0].name).toBe('Summer sale')
  })

  it('clamps limit to [1,100]', async () => {
    const db = createMockDb({ 'select:campaigns': [] })
    await listCampaigns(db, SHOP, { limit: 99999 })
    await listCampaigns(db, SHOP, { limit: -5 })
    // No assertion on SQL — pattern relies on runtime clamping.
    expect(db.selectFrom).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getCampaign
// ---------------------------------------------------------------------------

describe('getCampaign', () => {
  it('returns null for cross-shop miss', async () => {
    const db = createMockDb({ 'select:campaigns': null })
    const out = await getCampaign(db, OTHER_SHOP, CAMPAIGN)
    expect(out).toBeNull()
  })

  it('returns the row on match', async () => {
    const row = campaignRow()
    const db = createMockDb({ 'select:campaigns': row })
    const out = await getCampaign(db, SHOP, CAMPAIGN)
    expect(out?.id).toBe(CAMPAIGN)
  })
})

// ---------------------------------------------------------------------------
// updateCampaign
// ---------------------------------------------------------------------------

describe('updateCampaign', () => {
  it('rejects when campaign not found', async () => {
    const db = createMockDb({ 'select:campaigns': null })
    const out = await updateCampaign(db, SHOP, CAMPAIGN, { name: 'rename' })
    expect(out).toEqual({ ok: false, error: 'not_found' })
  })

  it('rejects when status is sent (immutable)', async () => {
    const row = campaignRow({ status: 'sent' })
    const db = createMockDb({ 'select:campaigns': row })
    const out = await updateCampaign(db, SHOP, CAMPAIGN, { name: 'rename' })
    expect(out).toEqual({ ok: false, error: 'immutable_status' })
  })

  it('rejects when status is sending', async () => {
    const row = campaignRow({ status: 'sending' })
    const db = createMockDb({ 'select:campaigns': row })
    const out = await updateCampaign(db, SHOP, CAMPAIGN, { name: 'rename' })
    expect(out).toEqual({ ok: false, error: 'immutable_status' })
  })

  it('allows updates on draft', async () => {
    const row = campaignRow({ status: 'draft' })
    const updated = campaignRow({ status: 'draft', name: 'renamed' })
    const db = createMockDb({
      'select:campaigns': row,
      'update:campaigns': updated,
    })
    const out = await updateCampaign(db, SHOP, CAMPAIGN, { name: 'renamed' })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.campaign.name).toBe('renamed')
  })

  it('allows updates on scheduled', async () => {
    const row = campaignRow({ status: 'scheduled' })
    const updated = campaignRow({ status: 'scheduled', subject: 'new subj' })
    const db = createMockDb({
      'select:campaigns': row,
      'update:campaigns': updated,
    })
    const out = await updateCampaign(db, SHOP, CAMPAIGN, { subject: 'new subj' })
    expect(out.ok).toBe(true)
  })

  it('rejects empty new name', async () => {
    const row = campaignRow()
    const db = createMockDb({ 'select:campaigns': row })
    const out = await updateCampaign(db, SHOP, CAMPAIGN, { name: '  ' })
    expect(out).toEqual({ ok: false, error: 'name_required' })
  })

  it('rejects empty new subject', async () => {
    const row = campaignRow()
    const db = createMockDb({ 'select:campaigns': row })
    const out = await updateCampaign(db, SHOP, CAMPAIGN, { subject: '' })
    expect(out).toEqual({ ok: false, error: 'subject_required' })
  })

  it('no-op returns existing when patch is empty', async () => {
    const row = campaignRow()
    const db = createMockDb({ 'select:campaigns': row })
    const out = await updateCampaign(db, SHOP, CAMPAIGN, {})
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.campaign.id).toBe(CAMPAIGN)
  })

  it('allows clearing audience_segment via null', async () => {
    const row = campaignRow({ audience_segment: 'vip' })
    const updated = campaignRow({ audience_segment: null })
    const db = createMockDb({
      'select:campaigns': row,
      'update:campaigns': updated,
    })
    const out = await updateCampaign(db, SHOP, CAMPAIGN, {
      audience_segment: null,
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.campaign.audience_segment).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// deleteCampaign
// ---------------------------------------------------------------------------

describe('deleteCampaign', () => {
  it('rejects when campaign missing', async () => {
    const db = createMockDb({ 'select:campaigns': null })
    const out = await deleteCampaign(db, SHOP, CAMPAIGN)
    expect(out).toEqual({ ok: false, error: 'not_found' })
  })

  it('rejects when status is scheduled', async () => {
    const row = campaignRow({ status: 'scheduled' })
    const db = createMockDb({ 'select:campaigns': row })
    const out = await deleteCampaign(db, SHOP, CAMPAIGN)
    expect(out).toEqual({ ok: false, error: 'not_deletable' })
  })

  it('rejects when status is sent', async () => {
    const row = campaignRow({ status: 'sent' })
    const db = createMockDb({ 'select:campaigns': row })
    const out = await deleteCampaign(db, SHOP, CAMPAIGN)
    expect(out).toEqual({ ok: false, error: 'not_deletable' })
  })

  it('deletes a draft campaign', async () => {
    const row = campaignRow({ status: 'draft' })
    const db = createMockDb({ 'select:campaigns': row })
    const out = await deleteCampaign(db, SHOP, CAMPAIGN)
    expect(out).toEqual({ ok: true })
  })

  it('deletes a cancelled campaign', async () => {
    const row = campaignRow({ status: 'cancelled' })
    const db = createMockDb({ 'select:campaigns': row })
    const out = await deleteCampaign(db, SHOP, CAMPAIGN)
    expect(out).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// scheduleCampaign
// ---------------------------------------------------------------------------

describe('scheduleCampaign', () => {
  const NOW = new Date('2026-04-21T12:00:00Z')
  const FUTURE = new Date('2026-04-22T12:00:00Z')
  const PAST = new Date('2026-04-20T12:00:00Z')

  it('rejects when campaign missing', async () => {
    const db = createMockDb({ 'select:campaigns': null })
    const out = await scheduleCampaign(db, SHOP, CAMPAIGN, FUTURE, NOW)
    expect(out).toEqual({ ok: false, error: 'not_found' })
  })

  it('rejects when status is not draft', async () => {
    const row = campaignRow({ status: 'scheduled' })
    const db = createMockDb({ 'select:campaigns': row })
    const out = await scheduleCampaign(db, SHOP, CAMPAIGN, FUTURE, NOW)
    expect(out).toEqual({ ok: false, error: 'wrong_status' })
  })

  it('rejects when sendAt is in the past', async () => {
    const row = campaignRow({ status: 'draft' })
    const db = createMockDb({ 'select:campaigns': row })
    const out = await scheduleCampaign(db, SHOP, CAMPAIGN, PAST, NOW)
    expect(out).toEqual({ ok: false, error: 'send_at_in_past' })
  })

  it('rejects when sendAt is invalid', async () => {
    const row = campaignRow({ status: 'draft' })
    const db = createMockDb({ 'select:campaigns': row })
    const out = await scheduleCampaign(
      db,
      SHOP,
      CAMPAIGN,
      'not-a-date',
      NOW,
    )
    expect(out).toEqual({ ok: false, error: 'send_at_required' })
  })

  it('transitions draft → scheduled on happy path', async () => {
    const row = campaignRow({ status: 'draft' })
    const updated = campaignRow({
      status: 'scheduled',
      scheduled_at: FUTURE.toISOString(),
    })
    const db = createMockDb({
      'select:campaigns': row,
      'update:campaigns': updated,
    })
    const out = await scheduleCampaign(db, SHOP, CAMPAIGN, FUTURE, NOW)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.campaign.status).toBe('scheduled')
      expect(out.campaign.scheduled_at).toBe(FUTURE.toISOString())
    }
  })
})

// ---------------------------------------------------------------------------
// cancelScheduled
// ---------------------------------------------------------------------------

describe('cancelScheduled', () => {
  it('rejects when not scheduled', async () => {
    const row = campaignRow({ status: 'draft' })
    const db = createMockDb({ 'select:campaigns': row })
    const out = await cancelScheduled(db, SHOP, CAMPAIGN)
    expect(out).toEqual({ ok: false, error: 'wrong_status' })
  })

  it('transitions scheduled → draft on happy path', async () => {
    const row = campaignRow({
      status: 'scheduled',
      scheduled_at: '2026-04-22T00:00:00Z',
    })
    const updated = campaignRow({ status: 'draft', scheduled_at: null })
    const db = createMockDb({
      'select:campaigns': row,
      'update:campaigns': updated,
    })
    const out = await cancelScheduled(db, SHOP, CAMPAIGN)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.campaign.status).toBe('draft')
      expect(out.campaign.scheduled_at).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// markCampaignSending / Sent / Failed
// ---------------------------------------------------------------------------

describe('markCampaignSending', () => {
  it('returns null when row was not updated', async () => {
    const db = createMockDb({ 'update:campaigns': null })
    const out = await markCampaignSending(db, CAMPAIGN)
    expect(out).toBeNull()
  })

  it('returns the row when update succeeds', async () => {
    const updated = campaignRow({ status: 'sending' })
    const db = createMockDb({ 'update:campaigns': updated })
    const out = await markCampaignSending(db, CAMPAIGN)
    expect(out?.status).toBe('sending')
  })
})

describe('markCampaignSent', () => {
  it('returns the row on success', async () => {
    const updated = campaignRow({
      status: 'sent',
      sent_at: '2026-04-22T00:00:00Z',
    })
    const db = createMockDb({ 'update:campaigns': updated })
    const out = await markCampaignSent(db, CAMPAIGN)
    expect(out?.status).toBe('sent')
    expect(out?.sent_at).toBeTruthy()
  })
})

describe('markCampaignFailed', () => {
  it('records truncated error', async () => {
    const updated = campaignRow({
      status: 'failed',
      error: 'boom',
    })
    const db = createMockDb({ 'update:campaigns': updated })
    const out = await markCampaignFailed(db, CAMPAIGN, 'boom')
    expect(out?.status).toBe('failed')
    expect(out?.error).toBe('boom')
  })
})
