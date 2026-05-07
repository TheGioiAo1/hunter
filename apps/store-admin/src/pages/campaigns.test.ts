/**
 * Store-admin — campaigns route handlers (Phase 8 PR1).
 *
 * Covers:
 *   - getCampaignsList renders list + empty state, respects tab/search/page
 *   - getCampaignEditor new vs edit vs terminal
 *   - postCreateCampaign validation-reject redirect vs success redirect
 *   - postUpdateCampaign immutable_status rejection
 *   - postDeleteCampaign success + not-deletable
 *   - postScheduleCampaign send_at_required / send_at_in_past / ok
 *   - postCancelCampaign ok path
 *
 * Service layer is fully mocked; we test only the HTTP surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks (MUST come before SUT import) -----------------------------------

vi.mock('@gbox/core/modules/marketing/campaigns.js', () => ({
  listCampaigns: vi.fn(),
  getCampaign: vi.fn(),
  createCampaign: vi.fn(),
  updateCampaign: vi.fn(),
  deleteCampaign: vi.fn(),
  scheduleCampaign: vi.fn(),
  cancelScheduled: vi.fn(),
}))

vi.mock('@gbox/core/modules/auth/csrf.js', () => ({
  csrfHiddenField: vi.fn(() => '<input type="hidden" name="_csrf" value="mock" />'),
}))

vi.mock('../middleware/store-auth.js', () => ({
  logSellerAction: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../layouts/seller-layout.js', () => ({
  sellerLayout: vi.fn((opts: any) => `<html>${opts.content}</html>`),
  esc: (s: string) => String(s ?? ''),
}))

import type { Request, Response } from 'express'
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  scheduleCampaign,
  cancelScheduled,
} from '@gbox/core/modules/marketing/campaigns.js'
import {
  getCampaignsList,
  getCampaignEditor,
  postCreateCampaign,
  postUpdateCampaign,
  postDeleteCampaign,
  postScheduleCampaign,
  postCancelCampaign,
} from './campaigns.js'

// --- Fixtures --------------------------------------------------------------

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_SLUG = 'test-shop'
const CAMPAIGN_ID = '22222222-2222-2222-2222-222222222222'
const USER_ID = '66666666-6666-6666-6666-666666666666'

function makeReq(
  body: Record<string, unknown> = {},
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): Request {
  return {
    body,
    query,
    params: { slug: SHOP_SLUG, ...params },
    store: { id: SHOP_ID, slug: SHOP_SLUG, name: 'Test Shop' },
    storeUser: {
      id: USER_ID,
      name: 'Thai Admin',
      email: 'thai@example.com',
      role: 'owner',
      storeRole: 'owner',
    },
    csrfToken: 'mock-token',
  } as unknown as Request
}

function makeRes() {
  const redirect = vi.fn()
  const status = vi.fn().mockReturnThis()
  const send = vi.fn()
  return { redirect, status, send } as unknown as Response & {
    redirect: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    status: ReturnType<typeof vi.fn>
  }
}

const fakeDb = {} as any

function campaignRow(overrides: Partial<any> = {}) {
  return {
    id: CAMPAIGN_ID,
    shop_id: SHOP_ID,
    name: 'Spring sale',
    subject: 'Subject line',
    body_html: '<p>Hi</p>',
    audience_segment: null,
    discount_id: null,
    status: 'draft' as const,
    scheduled_at: null,
    sent_at: null,
    recipient_count: 0,
    opened_count: 0,
    clicked_count: 0,
    error: null,
    created_by: USER_ID,
    created_at: '2026-04-21T00:00:00.000Z',
    updated_at: '2026-04-21T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// getCampaignsList
// ---------------------------------------------------------------------------

describe('getCampaignsList', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the empty state when no rows', async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ rows: [], total: 0 })

    const req = makeReq()
    const res = makeRes()
    await getCampaignsList(req, res, fakeDb)

    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('No campaigns yet')
    expect(html).toContain('New campaign')
    expect(listCampaigns).toHaveBeenCalledWith(fakeDb, SHOP_ID, {
      status: undefined,
      search: '',
      limit: 20,
      offset: 0,
    })
  })

  it('renders rows with name + subject + status badge', async () => {
    vi.mocked(listCampaigns).mockResolvedValue({
      rows: [campaignRow({ name: 'My Campaign', subject: 'Hello!', status: 'draft' })],
      total: 1,
    })

    const req = makeReq()
    const res = makeRes()
    await getCampaignsList(req, res, fakeDb)

    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('My Campaign')
    expect(html).toContain('Hello!')
    expect(html).toContain('Draft')
  })

  it('passes tab filter to listCampaigns for scheduled tab', async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ rows: [], total: 0 })

    const req = makeReq({}, {}, { tab: 'scheduled' })
    const res = makeRes()
    await getCampaignsList(req, res, fakeDb)

    expect(listCampaigns).toHaveBeenCalledWith(fakeDb, SHOP_ID, {
      status: ['scheduled', 'sending'],
      search: '',
      limit: 20,
      offset: 0,
    })
  })

  it('passes search + pagination offset', async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ rows: [], total: 50 })

    const req = makeReq({}, {}, { q: 'spring', page: '3' })
    const res = makeRes()
    await getCampaignsList(req, res, fakeDb)

    expect(listCampaigns).toHaveBeenCalledWith(fakeDb, SHOP_ID, {
      status: undefined,
      search: 'spring',
      limit: 20,
      offset: 40,
    })
  })

  it('renders ok flash banner when ?ok=campaign_created', async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ rows: [], total: 0 })
    const req = makeReq({}, {}, { ok: 'campaign_created' })
    const res = makeRes()
    await getCampaignsList(req, res, fakeDb)
    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('Campaign created.')
  })
})

// ---------------------------------------------------------------------------
// getCampaignEditor
// ---------------------------------------------------------------------------

describe('getCampaignEditor', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders new-campaign form when /new', async () => {
    const req = makeReq({}, { id: 'new' })
    const res = makeRes()
    await getCampaignEditor(req, res, fakeDb)

    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('New campaign')
    expect(html).toContain('name="name"')
    expect(html).toContain('name="subject"')
    expect(html).toContain('name="body_html"')
    // No schedule / cancel / delete blocks for new
    expect(html).not.toMatch(/Schedule send/)
    expect(html).not.toMatch(/Danger zone/)
  })

  it('redirects with not_found when campaign missing', async () => {
    vi.mocked(getCampaign).mockResolvedValue(null)

    const req = makeReq({}, { id: CAMPAIGN_ID })
    const res = makeRes()
    await getCampaignEditor(req, res, fakeDb)

    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=not_found'),
    )
  })

  it('renders draft editor with schedule + delete blocks', async () => {
    vi.mocked(getCampaign).mockResolvedValue(campaignRow({ status: 'draft' }))

    const req = makeReq({}, { id: CAMPAIGN_ID })
    const res = makeRes()
    await getCampaignEditor(req, res, fakeDb)

    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('Edit: Spring sale')
    expect(html).toContain('Schedule send')
    expect(html).toContain('Danger zone')
    // Form fields not readonly
    expect(html).not.toMatch(/disabled.*name="name"/)
  })

  it('renders scheduled campaign with cancel-schedule action', async () => {
    vi.mocked(getCampaign).mockResolvedValue(
      campaignRow({ status: 'scheduled', scheduled_at: '2099-01-01T00:00:00.000Z' }),
    )

    const req = makeReq({}, { id: CAMPAIGN_ID })
    const res = makeRes()
    await getCampaignEditor(req, res, fakeDb)

    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('Scheduled for')
    expect(html).toContain('Cancel schedule')
    expect(html).not.toMatch(/Danger zone/)
  })

  it('locks form readonly for terminal status sent', async () => {
    vi.mocked(getCampaign).mockResolvedValue(
      campaignRow({
        status: 'sent',
        sent_at: '2026-04-20T00:00:00.000Z',
        recipient_count: 50,
        opened_count: 25,
        clicked_count: 5,
      }),
    )

    const req = makeReq({}, { id: CAMPAIGN_ID })
    const res = makeRes()
    await getCampaignEditor(req, res, fakeDb)

    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('read-only')
    expect(html).toContain('Delivery stats')
    // The inputs should all be rendered with the disabled attribute
    expect(html).toMatch(/disabled/)
    // No save button
    expect(html).not.toContain('Save changes')
  })

  it('surfaces delivery error for failed status', async () => {
    vi.mocked(getCampaign).mockResolvedValue(
      campaignRow({ status: 'failed', error: 'Email delivery is not configured.' }),
    )

    const req = makeReq({}, { id: CAMPAIGN_ID })
    const res = makeRes()
    await getCampaignEditor(req, res, fakeDb)

    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('Delivery error:')
    expect(html).toContain('Email delivery is not configured.')
  })
})

// ---------------------------------------------------------------------------
// postCreateCampaign
// ---------------------------------------------------------------------------

describe('postCreateCampaign', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects with error when validation fails', async () => {
    vi.mocked(createCampaign).mockResolvedValue({ ok: false, error: 'name_required' })

    const req = makeReq({ name: '', subject: 's', body_html: 'b' })
    const res = makeRes()
    await postCreateCampaign(req, res, fakeDb)

    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringContaining('/new?error=name_required'),
    )
  })

  it('redirects to editor with ok flash when created', async () => {
    vi.mocked(createCampaign).mockResolvedValue({
      ok: true,
      campaign: campaignRow({ name: 'Fresh' }),
    })

    const req = makeReq({ name: 'Fresh', subject: 'S', body_html: 'B' })
    const res = makeRes()
    await postCreateCampaign(req, res, fakeDb)

    expect(createCampaign).toHaveBeenCalledWith(fakeDb, SHOP_ID, {
      name: 'Fresh',
      subject: 'S',
      body_html: 'B',
      audience_segment: null,
      created_by: USER_ID,
    })
    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`/${CAMPAIGN_ID}\\?ok=campaign_created`)),
    )
  })

  it('trims audience_segment and passes tag to service', async () => {
    vi.mocked(createCampaign).mockResolvedValue({
      ok: true,
      campaign: campaignRow(),
    })

    const req = makeReq({
      name: 'N',
      subject: 'S',
      body_html: 'B',
      audience_segment: '  vip   ',
    })
    const res = makeRes()
    await postCreateCampaign(req, res, fakeDb)

    expect(createCampaign).toHaveBeenCalledWith(
      fakeDb,
      SHOP_ID,
      expect.objectContaining({ audience_segment: 'vip' }),
    )
  })
})

// ---------------------------------------------------------------------------
// postUpdateCampaign
// ---------------------------------------------------------------------------

describe('postUpdateCampaign', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects back with immutable_status when service refuses', async () => {
    vi.mocked(updateCampaign).mockResolvedValue({
      ok: false,
      error: 'immutable_status',
    })

    const req = makeReq({ name: 'X' }, { id: CAMPAIGN_ID })
    const res = makeRes()
    await postUpdateCampaign(req, res, fakeDb)

    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=immutable_status'),
    )
  })

  it('redirects with ok flash when updated', async () => {
    vi.mocked(updateCampaign).mockResolvedValue({
      ok: true,
      campaign: campaignRow({ name: 'Updated' }),
    })

    const req = makeReq(
      { name: 'Updated', subject: 'S2', body_html: 'B2' },
      { id: CAMPAIGN_ID },
    )
    const res = makeRes()
    await postUpdateCampaign(req, res, fakeDb)

    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringContaining('ok=campaign_updated'),
    )
  })
})

// ---------------------------------------------------------------------------
// postDeleteCampaign
// ---------------------------------------------------------------------------

describe('postDeleteCampaign', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects to list with ok=campaign_deleted', async () => {
    vi.mocked(deleteCampaign).mockResolvedValue({ ok: true })

    const req = makeReq({}, { id: CAMPAIGN_ID })
    const res = makeRes()
    await postDeleteCampaign(req, res, fakeDb)

    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringMatching(/marketing\/campaigns\?ok=campaign_deleted$/),
    )
  })

  it('redirects back with not_deletable error', async () => {
    vi.mocked(deleteCampaign).mockResolvedValue({
      ok: false,
      error: 'not_deletable',
    })

    const req = makeReq({}, { id: CAMPAIGN_ID })
    const res = makeRes()
    await postDeleteCampaign(req, res, fakeDb)

    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=not_deletable'),
    )
  })
})

// ---------------------------------------------------------------------------
// postScheduleCampaign
// ---------------------------------------------------------------------------

describe('postScheduleCampaign', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects when send_at missing', async () => {
    const req = makeReq({ send_at: '' }, { id: CAMPAIGN_ID })
    const res = makeRes()
    await postScheduleCampaign(req, res, fakeDb)

    expect(scheduleCampaign).not.toHaveBeenCalled()
    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=send_at_required'),
    )
  })

  it('rejects when send_at is malformed', async () => {
    const req = makeReq({ send_at: 'not-a-date' }, { id: CAMPAIGN_ID })
    const res = makeRes()
    await postScheduleCampaign(req, res, fakeDb)

    expect(scheduleCampaign).not.toHaveBeenCalled()
    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=send_at_required'),
    )
  })

  it('forwards send_at_in_past from service', async () => {
    vi.mocked(scheduleCampaign).mockResolvedValue({
      ok: false,
      error: 'send_at_in_past',
    })

    const req = makeReq(
      { send_at: '2020-01-01T00:00' },
      { id: CAMPAIGN_ID },
    )
    const res = makeRes()
    await postScheduleCampaign(req, res, fakeDb)

    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=send_at_in_past'),
    )
  })

  it('redirects with ok when scheduled', async () => {
    vi.mocked(scheduleCampaign).mockResolvedValue({
      ok: true,
      campaign: campaignRow({
        status: 'scheduled',
        scheduled_at: '2099-01-01T00:00:00.000Z',
      }),
    })

    const req = makeReq(
      { send_at: '2099-01-01T00:00' },
      { id: CAMPAIGN_ID },
    )
    const res = makeRes()
    await postScheduleCampaign(req, res, fakeDb)

    expect(scheduleCampaign).toHaveBeenCalled()
    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringContaining('ok=campaign_scheduled'),
    )
  })
})

// ---------------------------------------------------------------------------
// postCancelCampaign
// ---------------------------------------------------------------------------

describe('postCancelCampaign', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects with ok=campaign_cancelled', async () => {
    vi.mocked(cancelScheduled).mockResolvedValue({
      ok: true,
      campaign: campaignRow({ status: 'draft' }),
    })

    const req = makeReq({}, { id: CAMPAIGN_ID })
    const res = makeRes()
    await postCancelCampaign(req, res, fakeDb)

    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringContaining('ok=campaign_cancelled'),
    )
  })

  it('forwards wrong_status rejection', async () => {
    vi.mocked(cancelScheduled).mockResolvedValue({
      ok: false,
      error: 'wrong_status',
    })

    const req = makeReq({}, { id: CAMPAIGN_ID })
    const res = makeRes()
    await postCancelCampaign(req, res, fakeDb)

    expect((res as any).redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=wrong_status'),
    )
  })
})
