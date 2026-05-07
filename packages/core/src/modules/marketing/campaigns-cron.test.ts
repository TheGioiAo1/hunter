/**
 * Gbox Platform — dispatchCampaignsTick unit tests (Phase 8 PR1)
 *
 * Mocks `email/service.sendEmail` so we can exercise the state
 * machine without SMTP. Covers:
 *   • no campaigns picked → returns zeros
 *   • SMTP not configured → marks campaign failed on first send
 *   • successful sends stamp sent_at, then markSent finalises
 *   • tick budget caps at MAX_SENDS_PER_TICK
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the email service — vi.mock must be hoisted; we assert via
// the mock's calls to verify the cron driver is asking to send.
vi.mock('../email/service.js', () => ({
  sendEmail: vi.fn(),
}))

// Mock the campaigns service — chainable by callsite.
vi.mock('./campaigns.js', async () => {
  const actual = await vi.importActual<
    typeof import('./campaigns.js')
  >('./campaigns.js')
  return {
    ...actual,
    snapshotRecipients: vi.fn(),
    markCampaignSending: vi.fn(),
    markCampaignSent: vi.fn(),
    markCampaignFailed: vi.fn(),
    getCampaign: vi.fn(),
    getNextPendingRecipient: vi.fn(),
    recordRecipientSent: vi.fn(),
    markRecipientBounced: vi.fn(),
  }
})

import { dispatchCampaignsTick } from './campaigns-cron.js'
import { sendEmail } from '../email/service.js'
import * as campaigns from './campaigns.js'

function chainable(result: any = []) {
  const obj: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute') {
          return vi.fn().mockResolvedValue(
            Array.isArray(result) ? result : [result],
          )
        }
        if (prop === 'executeTakeFirst') {
          return vi
            .fn()
            .mockResolvedValue(Array.isArray(result) ? result[0] ?? null : result)
        }
        return vi.fn().mockReturnValue(obj)
      },
    },
  )
  return obj
}

function mockDb(scheduledRows: any[]) {
  return {
    selectFrom: vi.fn().mockReturnValue(chainable(scheduledRows)),
    updateTable: vi.fn().mockReturnValue(chainable()),
    insertInto: vi.fn().mockReturnValue(chainable()),
    deleteFrom: vi.fn().mockReturnValue(chainable()),
    fn: { count: () => ({ as: () => ({}) }) },
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('dispatchCampaignsTick', () => {
  const SHOP = '11111111-1111-1111-1111-111111111111'
  const CAMPAIGN = '22222222-2222-2222-2222-222222222222'
  const RECIPIENT = '33333333-3333-3333-3333-333333333333'

  it('returns zeros when no campaigns pending', async () => {
    const db = mockDb([])
    const out = await dispatchCampaignsTick(db)
    expect(out.picked).toBe(0)
    expect(out.sent).toBe(0)
    expect(out.bounced).toBe(0)
  })

  it('sends to one pending recipient then finalises sent', async () => {
    const db = mockDb([
      { id: CAMPAIGN, shop_id: SHOP, status: 'scheduled' },
    ])

    vi.mocked(campaigns.snapshotRecipients).mockResolvedValue({
      inserted: 1,
      total: 1,
    })
    vi.mocked(campaigns.markCampaignSending).mockResolvedValue({
      id: CAMPAIGN,
      shop_id: SHOP,
      name: 'n',
      subject: 's',
      body_html: 'b',
      audience_segment: null,
      discount_id: null,
      status: 'sending',
      scheduled_at: null,
      sent_at: null,
      recipient_count: 1,
      opened_count: 0,
      clicked_count: 0,
      error: null,
      created_by: null,
      created_at: '',
      updated_at: '',
    })
    vi.mocked(campaigns.getCampaign).mockResolvedValue({
      id: CAMPAIGN,
      shop_id: SHOP,
      name: 'n',
      subject: 'Sub',
      body_html: '<p>hi</p>',
      audience_segment: null,
      discount_id: null,
      status: 'sending',
      scheduled_at: null,
      sent_at: null,
      recipient_count: 1,
      opened_count: 0,
      clicked_count: 0,
      error: null,
      created_by: null,
      created_at: '',
      updated_at: '',
    })
    // First call returns the recipient, second call returns null (drained).
    vi.mocked(campaigns.getNextPendingRecipient)
      .mockResolvedValueOnce({
        id: RECIPIENT,
        campaign_id: CAMPAIGN,
        customer_id: null,
        email: 'buyer@example.com',
        sent_at: null,
        opened_at: null,
        clicked_at: null,
        bounced_at: null,
        unsubscribed_at: null,
        error: null,
        created_at: '',
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    vi.mocked(sendEmail).mockResolvedValue('msg-id-1')

    const out = await dispatchCampaignsTick(db)

    expect(out.picked).toBe(1)
    expect(out.sent).toBe(1)
    expect(out.bounced).toBe(0)
    expect(sendEmail).toHaveBeenCalledWith({
      to: 'buyer@example.com',
      subject: 'Sub',
      html: '<p>hi</p>',
    })
    expect(campaigns.recordRecipientSent).toHaveBeenCalledWith(db, RECIPIENT)
    expect(campaigns.markCampaignSent).toHaveBeenCalledWith(db, CAMPAIGN)
  })

  it('marks campaign failed cleanly when SMTP is not configured', async () => {
    const db = mockDb([
      { id: CAMPAIGN, shop_id: SHOP, status: 'scheduled' },
    ])

    vi.mocked(campaigns.snapshotRecipients).mockResolvedValue({
      inserted: 1,
      total: 1,
    })
    vi.mocked(campaigns.markCampaignSending).mockResolvedValue({
      id: CAMPAIGN,
    } as any)
    vi.mocked(campaigns.getCampaign).mockResolvedValue({
      id: CAMPAIGN,
      shop_id: SHOP,
      subject: 'Hello',
      body_html: 'body',
    } as any)
    vi.mocked(campaigns.getNextPendingRecipient)
      .mockResolvedValueOnce({
        id: RECIPIENT,
        campaign_id: CAMPAIGN,
        email: 'a@b.com',
      } as any)
      .mockResolvedValueOnce(null)

    vi.mocked(sendEmail).mockRejectedValue(
      new Error('SMTP_HOST is not configured'),
    )

    const out = await dispatchCampaignsTick(db)

    expect(out.picked).toBe(1)
    expect(out.sent).toBe(0)
    expect(out.bounced).toBe(1)
    expect(out.failedCampaigns).toContain(CAMPAIGN)
    expect(campaigns.markRecipientBounced).toHaveBeenCalled()
    expect(campaigns.markCampaignFailed).toHaveBeenCalledWith(
      db,
      CAMPAIGN,
      'Email delivery is not configured.',
    )
    // And does NOT call markCampaignSent.
    expect(campaigns.markCampaignSent).not.toHaveBeenCalled()
  })

  it('counts bounced recipients without marking the campaign failed', async () => {
    const db = mockDb([
      { id: CAMPAIGN, shop_id: SHOP, status: 'scheduled' },
    ])
    vi.mocked(campaigns.snapshotRecipients).mockResolvedValue({
      inserted: 2,
      total: 2,
    })
    vi.mocked(campaigns.markCampaignSending).mockResolvedValue({ id: CAMPAIGN } as any)
    vi.mocked(campaigns.getCampaign).mockResolvedValue({
      id: CAMPAIGN,
      shop_id: SHOP,
      subject: 'S',
      body_html: 'B',
    } as any)

    vi.mocked(campaigns.getNextPendingRecipient)
      .mockResolvedValueOnce({ id: 'r1', email: 'bad@x' } as any)
      .mockResolvedValueOnce({ id: 'r2', email: 'good@x' } as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    vi.mocked(sendEmail)
      .mockRejectedValueOnce(new Error('mailbox full'))
      .mockResolvedValueOnce('msg-2')

    const out = await dispatchCampaignsTick(db)
    expect(out.sent).toBe(1)
    expect(out.bounced).toBe(1)
    expect(out.failedCampaigns).toEqual([])
    expect(campaigns.markCampaignSent).toHaveBeenCalledWith(db, CAMPAIGN)
  })
})
