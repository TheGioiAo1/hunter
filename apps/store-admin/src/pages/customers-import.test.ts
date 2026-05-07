/**
 * Store-admin — customers-import handler tests (Phase 4 PR4).
 *
 * The page glues together the pure CSV modules and the DB. We mock
 * the three pure functions (parser, plan builder, applier) so this
 * suite is purely about the handler: request routing, error paths,
 * session-handoff, and bell-notification firing.
 *
 * Same vi.mock pattern as customers.lifecycle.test.ts so we can assert
 * on the rendered HTML snippets the handler emits.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Mocks (must be declared BEFORE importing the SUT) --------------------

// Core CSV pipeline. Each test tunes the return value of these so we
// can exercise the happy + error paths without depending on real CSV.
const parseCustomersCsv = vi.fn()
const buildImportPlan = vi.fn()
const applyImportPlan = vi.fn()

vi.mock('@gbox/core/modules/customers/csv/index.js', () => ({
  parseCustomersCsv: (...a: any[]) => parseCustomersCsv(...a),
  buildImportPlan: (...a: any[]) => buildImportPlan(...a),
  applyImportPlan: (...a: any[]) => applyImportPlan(...a),
  ParseError: class ParseError extends Error {
    line: number
    column: number | null
    constructor(message: string, line: number, column: number | null = null) {
      super(message)
      this.line = line
      this.column = column
    }
  },
}))

const notifyMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../lib/notify.js', () => ({
  notify: (...a: any[]) => notifyMock(...a),
  byActor: vi.fn((u: any) => `By ${u?.name ?? 'unknown'}`),
}))

vi.mock('../layouts/seller-layout.js', () => ({
  sellerLayout: vi.fn((opts: any) => `<html>${opts.content}</html>`),
  esc: (s: string) => (s == null ? '' : String(s)),
}))

import type { Request, Response } from 'express'
// Pull the mocked ParseError class so we can throw instances the SUT
// recognises with `instanceof ParseError`.
import { ParseError } from '@gbox/core/modules/customers/csv/index.js'
import {
  getCustomerImport,
  postCustomerImportUpload,
  postCustomerImportCommit,
  __resetImportSessionsForTests,
} from './customers-import.js'

// ---- Helpers --------------------------------------------------------------

const SHOP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SHOP_SLUG = 'shop-4'
const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

function baseReq(overrides: Partial<Request> = {}): any {
  return {
    store: { id: SHOP_ID, slug: SHOP_SLUG, name: 'Shop Four' },
    storeUser: {
      id: USER_ID,
      name: 'Seller',
      email: 's@example.com',
      role: 'owner',
      storeRole: 'owner',
    },
    query: {},
    body: {},
    file: undefined,
    ...overrides,
  }
}

function baseRes(): any {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    sent: '' as string,
    redirectedTo: null as string | null,
    status(c: number) {
      this.statusCode = c
      return this
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v
    },
    send(x: string) {
      this.sent = x
    },
    redirect(u: string) {
      this.redirectedTo = u
    },
    write(_x: string) { return true },
    end() { /* noop */ },
  }
  return res
}

// Minimal db stand-in — the page never hits it directly; only the
// mocked CSV pipeline does, and those calls are intercepted.
const fakeDb = {} as any

// ---- Tests ----------------------------------------------------------------

describe('getCustomerImport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetImportSessionsForTests()
  })

  it('renders the upload form', async () => {
    const req = baseReq()
    const res = baseRes()
    await getCustomerImport(req, res, fakeDb)
    expect(res.sent).toContain('Import customers')
    expect(res.sent).toContain('Upload CSV')
    expect(res.sent).toContain(`${SHOP_SLUG}/customers/import/upload`)
  })

  it('shows the success banner when ?success= is set', async () => {
    const req = baseReq({ query: { success: 'Imported%202%20created' } } as any)
    const res = baseRes()
    await getCustomerImport(req, res, fakeDb)
    expect(res.sent).toContain('Import complete')
    expect(res.sent).toContain('Imported 2 created')
  })
})

describe('postCustomerImportUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetImportSessionsForTests()
  })

  it('redirects with no_file error when nothing is uploaded', async () => {
    const req = baseReq()
    const res = baseRes()
    await postCustomerImportUpload(req, res, fakeDb)
    expect(res.redirectedTo).toBe(`/admin/store/${SHOP_SLUG}/customers/import?error=no_file`)
    expect(parseCustomersCsv).not.toHaveBeenCalled()
  })

  it('renders the plan preview with a commit form on happy path', async () => {
    parseCustomersCsv.mockReturnValue({
      customers: [
        {
          sourceRow: 2,
          first_name: 'Ada',
          last_name: 'Lovelace',
          email: 'ada@example.com',
          phone: null,
          accepts_marketing: false,
          note: null,
          tags: null,
          tax_exempt: false,
          address: null,
          extraColumns: {},
        },
      ],
      notes: [],
    })
    buildImportPlan.mockResolvedValue({
      items: [
        {
          emailKey: 'ada@example.com',
          parsed: {
            sourceRow: 2,
            first_name: 'Ada',
            last_name: 'Lovelace',
            email: 'ada@example.com',
            phone: null,
            accepts_marketing: false,
            note: null,
            tags: null,
            tax_exempt: false,
            address: null,
            extraColumns: {},
          },
          action: 'create',
          existingCustomerId: null,
          existingDefaultAddressId: null,
          issues: [],
        },
      ],
      issues: [],
      stats: { creating: 1, updating: 0, blocked: 0, warnings: 0 },
    })

    const req = baseReq({
      file: {
        buffer: Buffer.from('Email\nada@example.com\n', 'utf8'),
        originalname: 'customers.csv',
        mimetype: 'text/csv',
      },
    } as any)
    const res = baseRes()

    await postCustomerImportUpload(req, res, fakeDb)

    expect(parseCustomersCsv).toHaveBeenCalledTimes(1)
    expect(buildImportPlan).toHaveBeenCalledTimes(1)
    expect(res.sent).toContain('Dry-run summary')
    expect(res.sent).toContain('Commit import')
    // The commit form carries the opaque session key — just prove
    // the hidden field is there.
    expect(res.sent).toMatch(/name="session_key"\s+value="[^"]+"/)
    // Bell notification fired for the preview step.
    expect(notifyMock).toHaveBeenCalled()
    const firstCall = notifyMock.mock.calls[0]?.[1]
    expect(firstCall?.type).toBe('customers_import_previewed')
  })

  it('renders the parse error banner when the parser throws', async () => {
    parseCustomersCsv.mockImplementation(() => {
      throw new ParseError('Email column missing', 1, null)
    })

    const req = baseReq({
      file: {
        buffer: Buffer.from('Name\nAda\n', 'utf8'),
        originalname: 'bad.csv',
        mimetype: 'text/csv',
      },
    } as any)
    const res = baseRes()

    await postCustomerImportUpload(req, res, fakeDb)
    expect(res.sent).toContain('Could not parse')
    expect(res.sent).toContain('Line 1')
    expect(res.sent).toContain('Email column missing')
    // Should fire the failure notification.
    const call = notifyMock.mock.calls[0]?.[1]
    expect(call?.type).toBe('customers_import_failed')
  })
})

describe('postCustomerImportCommit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetImportSessionsForTests()
  })

  it('redirects with an error when the session key is unknown', async () => {
    const req = baseReq({ body: { session_key: 'nope' } } as any)
    const res = baseRes()
    await postCustomerImportCommit(req, res, fakeDb)
    expect(res.redirectedTo).toContain('/customers/import?error=')
    expect(res.redirectedTo).toContain('expired')
    expect(applyImportPlan).not.toHaveBeenCalled()
  })

  it('applies the plan and redirects with a success banner', async () => {
    // First, run an upload to populate the session map. The plan
    // must have at least one writable row so the commit form (and
    // therefore the session_key hidden input) is rendered.
    parseCustomersCsv.mockReturnValue({
      customers: [
        {
          sourceRow: 2, first_name: 'Ada', last_name: 'Lovelace',
          email: 'ada@example.com', phone: null, accepts_marketing: false,
          note: null, tags: null, tax_exempt: false, address: null,
          extraColumns: {},
        },
      ],
      notes: [],
    })
    buildImportPlan.mockResolvedValue({
      items: [
        {
          emailKey: 'ada@example.com',
          parsed: {
            sourceRow: 2, first_name: 'Ada', last_name: 'Lovelace',
            email: 'ada@example.com', phone: null, accepts_marketing: false,
            note: null, tags: null, tax_exempt: false, address: null,
            extraColumns: {},
          },
          action: 'create',
          existingCustomerId: null,
          existingDefaultAddressId: null,
          issues: [],
        },
      ],
      issues: [],
      stats: { creating: 1, updating: 0, blocked: 0, warnings: 0 },
    })

    const uploadReq = baseReq({
      file: {
        buffer: Buffer.from('Email\nada@example.com\n', 'utf8'),
        originalname: 'small.csv',
        mimetype: 'text/csv',
      },
    } as any)
    const uploadRes = baseRes()
    await postCustomerImportUpload(uploadReq, uploadRes, fakeDb)

    // Extract the session key from the rendered HTML.
    const match = /name="session_key"\s+value="([^"]+)"/.exec(uploadRes.sent)
    expect(match).not.toBeNull()
    const sessionKey = match![1]

    applyImportPlan.mockResolvedValue({
      items: [],
      stats: { created: 2, updated: 1, skipped: 0, errored: 0 },
    })

    const commitReq = baseReq({ body: { session_key: sessionKey } } as any)
    const commitRes = baseRes()
    await postCustomerImportCommit(commitReq, commitRes, fakeDb)

    expect(applyImportPlan).toHaveBeenCalledTimes(1)
    expect(commitRes.redirectedTo).toContain('/customers/import?success=')
    expect(decodeURIComponent(commitRes.redirectedTo!)).toContain('2 created')
    expect(decodeURIComponent(commitRes.redirectedTo!)).toContain('1 updated')
    // Bell notification for the successful commit.
    const commitCall = notifyMock.mock.calls.find(
      ([, payload]: any) => payload?.type === 'customers_imported',
    )
    expect(commitCall).toBeDefined()
  })

  it('redirects with an error when applyImportPlan throws', async () => {
    // Same setup as the success test — upload first to mint a session_key.
    parseCustomersCsv.mockReturnValue({
      customers: [
        {
          sourceRow: 2, first_name: 'Ada', last_name: 'Lovelace',
          email: 'ada@example.com', phone: null, accepts_marketing: false,
          note: null, tags: null, tax_exempt: false, address: null,
          extraColumns: {},
        },
      ],
      notes: [],
    })
    buildImportPlan.mockResolvedValue({
      items: [
        {
          emailKey: 'ada@example.com',
          parsed: {
            sourceRow: 2, first_name: 'Ada', last_name: 'Lovelace',
            email: 'ada@example.com', phone: null, accepts_marketing: false,
            note: null, tags: null, tax_exempt: false, address: null,
            extraColumns: {},
          },
          action: 'create',
          existingCustomerId: null,
          existingDefaultAddressId: null,
          issues: [],
        },
      ],
      issues: [],
      stats: { creating: 1, updating: 0, blocked: 0, warnings: 0 },
    })
    const uploadReq = baseReq({
      file: {
        buffer: Buffer.from('Email\nada@example.com\n', 'utf8'),
        originalname: 'x.csv',
        mimetype: 'text/csv',
      },
    } as any)
    const uploadRes = baseRes()
    await postCustomerImportUpload(uploadReq, uploadRes, fakeDb)
    const key = /name="session_key"\s+value="([^"]+)"/.exec(uploadRes.sent)![1]

    applyImportPlan.mockRejectedValue(new Error('DB is on fire'))

    const req = baseReq({ body: { session_key: key } } as any)
    const res = baseRes()
    await postCustomerImportCommit(req, res, fakeDb)
    expect(res.redirectedTo).toContain('/customers/import?error=')
    expect(decodeURIComponent(res.redirectedTo!)).toContain('DB is on fire')
  })
})
