/**
 * Unit tests for the Files library handlers (Phase 7 PR5).
 *
 * The service layer itself is covered in
 * `packages/core/src/modules/files/service.test.ts`. Here we only assert
 * the HTTP plumbing:
 *   - tenancy guards on delete/update (cross-shop id → flash=not_found)
 *   - happy-path redirects carry the filename/error code
 *   - multer edge cases (no file attached)
 *   - rename modal wiring (filename + alt thread through)
 *
 * End-to-end with live Postgres + a real upload is in
 * scripts/smoke-phase7-pr5.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@gbox/core/modules/files/service.js', () => ({
  uploadFile: vi.fn(),
  listFiles: vi.fn(),
  getFile: vi.fn(),
  deleteFile: vi.fn(),
  updateFile: vi.fn(),
  quotaFor: vi.fn(() => 500 * 1024 * 1024),
  mimeCategory: vi.fn((m: string | null) => {
    if (!m) return 'other'
    if (m.startsWith('image/')) return 'image'
    if (m.startsWith('video/')) return 'video'
    if (m.startsWith('audio/')) return 'audio'
    if (m.startsWith('application/pdf') || m.startsWith('text/')) return 'document'
    return 'other'
  }),
}))
vi.mock('@gbox/core/modules/storage/index.js', () => ({
  getPublicMediaStore: vi.fn(() => ({ _fake: true })),
}))
vi.mock('../layouts/seller-layout.js', () => ({
  sellerLayout: vi.fn((opts: any) => `<layout>${opts.content}</layout>`),
  esc: (s: string) => String(s ?? ''),
}))
vi.mock('../lib/notify.js', () => ({
  notify: vi.fn(),
  byActor: vi.fn(() => 'By test'),
}))

import {
  uploadFile,
  listFiles,
  getFile,
  deleteFile,
  updateFile,
} from '@gbox/core/modules/files/service.js'
import {
  getFilesPage,
  postUploadFile,
  postDeleteFile,
  postUpdateFile,
} from './files.js'

// ---------------------------------------------------------------------
// Request / Response test doubles
// ---------------------------------------------------------------------

function makeReq(opts: {
  shopId?: string
  userId?: string
  fileId?: string
  query?: Record<string, string>
  body?: Record<string, unknown>
  file?: { originalname: string; mimetype: string; size: number; buffer: Buffer } | undefined
} = {}) {
  return {
    store: {
      id: opts.shopId ?? 'shop-1',
      slug: 'my-store',
      name: 'My Store',
    },
    storeUser: {
      id: opts.userId ?? 'user-1',
      name: 'Thai',
      email: 'thai@example.com',
      role: 'owner',
      storeRole: 'owner',
    },
    params: opts.fileId ? { id: opts.fileId } : {},
    query: opts.query ?? {},
    body: opts.body ?? {},
    file: opts.file,
    headers: {},
    csrfToken: 'csrf-xyz',
  } as any
}

function makeRes() {
  const res: any = { _body: null, _status: 200, _redirect: null }
  res.status = vi.fn().mockImplementation((n: number) => {
    res._status = n
    return res
  })
  res.send = vi.fn().mockImplementation((b: any) => {
    res._body = b
    return res
  })
  res.json = vi.fn().mockImplementation((b: any) => {
    res._body = b
    return res
  })
  res.redirect = vi.fn().mockImplementation((loc: string) => {
    res._redirect = loc
    return res
  })
  return res
}

// The service-layer DB stubs don't care about the `db` argument because
// every call is mocked — we just need a stand-in that the handlers can
// pass through as `db`. The `selectFrom('shops')` inside the upload /
// list handlers hits a small chain, so we mock that explicitly below.
function makeDb() {
  const plan = 'free'
  return {
    selectFrom: vi.fn(() => ({
      select: vi.fn(() => ({
        where: vi.fn(() => ({
          executeTakeFirst: vi.fn(async () => ({ plan })),
        })),
      })),
    })),
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no files in the store.
  ;(listFiles as any).mockResolvedValue({ rows: [], total: 0, usedBytes: 0 })
})

// ---------------------------------------------------------------------
// getFilesPage
// ---------------------------------------------------------------------

describe('getFilesPage', () => {
  it('renders a 200 with the Files title when the shop is empty', async () => {
    const req = makeReq()
    const res = makeRes()
    await getFilesPage(req, res, makeDb())

    expect(res._status).toBe(200)
    expect(String(res._body)).toContain('Files')
    // Header widget shows 0 total / 0 B used.
    expect(String(res._body)).toContain('Total Files')
    // No files yet banner.
    expect(String(res._body)).toContain('No files match these filters yet.')
  })

  it('passes the search/type/page query through to listFiles', async () => {
    const req = makeReq({ query: { q: 'hero', type: 'image', page: '2' } })
    const res = makeRes()
    await getFilesPage(req, res, makeDb())

    expect(listFiles).toHaveBeenCalledWith(
      expect.anything(),
      'shop-1',
      expect.objectContaining({
        search: 'hero',
        type: 'image',
        limit: 24,
        offset: 24,
      }),
    )
  })

  it('defaults type=all when the query value is bogus', async () => {
    const req = makeReq({ query: { type: 'garbage' } })
    const res = makeRes()
    await getFilesPage(req, res, makeDb())

    expect(listFiles).toHaveBeenCalledWith(
      expect.anything(),
      'shop-1',
      expect.objectContaining({ type: 'all' }),
    )
  })

  it('surfaces the `?uploaded=` flash banner', async () => {
    const req = makeReq({ query: { uploaded: 'hero.jpg' } })
    const res = makeRes()
    await getFilesPage(req, res, makeDb())
    expect(String(res._body)).toContain('Uploaded')
    expect(String(res._body)).toContain('hero.jpg')
  })

  it('surfaces the `?err=too_large` flash banner with a friendly message', async () => {
    const req = makeReq({ query: { err: 'too_large' } })
    const res = makeRes()
    await getFilesPage(req, res, makeDb())
    // Friendly copy, not the raw error code.
    expect(String(res._body)).toContain('20 MB')
  })

  it('renders file cards with Copy URL / Edit / Delete actions', async () => {
    ;(listFiles as any).mockResolvedValueOnce({
      rows: [
        {
          id: 'f1',
          shop_id: 'shop-1',
          filename: 'hero.jpg',
          mime_type: 'image/jpeg',
          size: 4096,
          url: 'https://cdn.gbox.co/files/shop-1/f1/hero.jpg',
          alt: 'Hero banner',
          created_at: '2026-04-21T00:00:00Z',
        },
      ],
      total: 1,
      usedBytes: 4096,
    })
    const req = makeReq()
    const res = makeRes()
    await getFilesPage(req, res, makeDb())

    expect(String(res._body)).toContain('hero.jpg')
    expect(String(res._body)).toContain('Copy URL')
    expect(String(res._body)).toContain('Edit')
    expect(String(res._body)).toContain('Delete')
    expect(String(res._body)).toContain('files/f1/delete')
  })
})

// ---------------------------------------------------------------------
// postUploadFile
// ---------------------------------------------------------------------

describe('postUploadFile', () => {
  it('redirects to ?err=no_file when multer did not attach a file', async () => {
    const req = makeReq({ file: undefined })
    const res = makeRes()
    await postUploadFile(req, res, makeDb())

    expect(res._redirect).toContain('err=no_file')
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('delegates to uploadFile and redirects to ?uploaded=<filename> on success', async () => {
    ;(uploadFile as any).mockResolvedValue({
      ok: true,
      file: {
        id: 'f1',
        shop_id: 'shop-1',
        filename: 'hero.jpg',
        mime_type: 'image/jpeg',
        size: 4096,
        url: 'https://cdn.gbox.co/files/shop-1/f1/hero.jpg',
        alt: null,
        created_at: new Date(),
      },
    })
    const req = makeReq({
      file: {
        originalname: 'hero.jpg',
        mimetype: 'image/jpeg',
        size: 4096,
        buffer: Buffer.from('x'.repeat(4096)),
      },
    })
    const res = makeRes()
    await postUploadFile(req, res, makeDb())

    expect(uploadFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        shopId: 'shop-1',
        filename: 'hero.jpg',
        mimeType: 'image/jpeg',
      }),
      expect.objectContaining({
        maxFileSize: 20 * 1024 * 1024,
        // `quotaFor('free')` is mocked to 500 MB.
        maxShopBytes: 500 * 1024 * 1024,
      }),
    )
    expect(res._redirect).toContain('uploaded=hero.jpg')
  })

  it('forwards service errors into the ?err=<code> flash code', async () => {
    ;(uploadFile as any).mockResolvedValue({ ok: false, error: 'quota_exceeded' })
    const req = makeReq({
      file: {
        originalname: 'big.mp4',
        mimetype: 'video/mp4',
        size: 10,
        buffer: Buffer.alloc(10),
      },
    })
    const res = makeRes()
    await postUploadFile(req, res, makeDb())
    expect(res._redirect).toContain('err=quota_exceeded')
  })

  it('maps multer LIMIT_FILE_SIZE errors to ?err=too_large', async () => {
    ;(uploadFile as any).mockImplementation(() => {
      const e: any = new Error('File too large')
      e.code = 'LIMIT_FILE_SIZE'
      throw e
    })
    const req = makeReq({
      file: {
        originalname: 'huge.mp4',
        mimetype: 'video/mp4',
        size: 99999999,
        buffer: Buffer.alloc(10),
      },
    })
    const res = makeRes()
    await postUploadFile(req, res, makeDb())
    expect(res._redirect).toContain('err=too_large')
  })
})

// ---------------------------------------------------------------------
// postDeleteFile
// ---------------------------------------------------------------------

describe('postDeleteFile', () => {
  it('redirects to ?err=not_found when the id is cross-shop (service returns null)', async () => {
    ;(getFile as any).mockResolvedValue(null)
    const req = makeReq({ fileId: 'foreign' })
    const res = makeRes()
    await postDeleteFile(req, res, makeDb())

    expect(res._redirect).toContain('err=not_found')
    // The whole point: we never even try to delete.
    expect(deleteFile).not.toHaveBeenCalled()
  })

  it('delegates and redirects to ?deleted=<filename>', async () => {
    ;(getFile as any).mockResolvedValue({
      id: 'f1',
      shop_id: 'shop-1',
      filename: 'hero.jpg',
      mime_type: 'image/jpeg',
      size: 1,
      url: 'u',
      alt: null,
      created_at: new Date(),
    })
    ;(deleteFile as any).mockResolvedValue({ ok: true })

    const req = makeReq({ fileId: 'f1' })
    const res = makeRes()
    await postDeleteFile(req, res, makeDb())

    expect(deleteFile).toHaveBeenCalledWith(
      expect.anything(),
      'shop-1',
      'f1',
      expect.objectContaining({ objectStore: expect.anything() }),
    )
    expect(res._redirect).toContain('deleted=hero.jpg')
  })
})

// ---------------------------------------------------------------------
// postUpdateFile
// ---------------------------------------------------------------------

describe('postUpdateFile', () => {
  it('redirects to ?err=not_found when updateFile returns null (cross-shop)', async () => {
    ;(updateFile as any).mockResolvedValue(null)
    const req = makeReq({ fileId: 'foreign', body: { filename: 'x.png' } })
    const res = makeRes()
    await postUpdateFile(req, res, makeDb())
    expect(res._redirect).toContain('err=not_found')
  })

  it('passes filename + alt through and redirects with the sanitized name', async () => {
    ;(updateFile as any).mockResolvedValue({
      id: 'f1',
      shop_id: 'shop-1',
      filename: 'new.png',
      alt: 'A red hat',
      mime_type: 'image/png',
      size: 1,
      url: 'u',
      created_at: new Date(),
    })

    const req = makeReq({
      fileId: 'f1',
      body: { filename: 'new.png', alt: 'A red hat' },
    })
    const res = makeRes()
    await postUpdateFile(req, res, makeDb())

    expect(updateFile).toHaveBeenCalledWith(
      expect.anything(),
      'shop-1',
      'f1',
      expect.objectContaining({ filename: 'new.png', alt: 'A red hat' }),
    )
    expect(res._redirect).toContain('updated=new.png')
  })

  it('treats an empty alt string as null (clear the field)', async () => {
    ;(updateFile as any).mockResolvedValue({
      id: 'f1',
      shop_id: 'shop-1',
      filename: 'a.png',
      alt: null,
      mime_type: 'image/png',
      size: 1,
      url: 'u',
      created_at: new Date(),
    })

    const req = makeReq({
      fileId: 'f1',
      body: { alt: '' },
    })
    const res = makeRes()
    await postUpdateFile(req, res, makeDb())

    expect(updateFile).toHaveBeenCalledWith(
      expect.anything(),
      'shop-1',
      'f1',
      expect.objectContaining({ alt: null }),
    )
  })
})
