import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildS3Client, putObjectIfAbsent } from './s3-client.js'

const sendMock = vi.fn()
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn((input) => ({ kind: 'put', input })),
  HeadObjectCommand: vi.fn((input) => ({ kind: 'head', input })),
}))

describe('s3-client', () => {
  beforeEach(() => sendMock.mockReset())

  it('skips PUT when object already exists', async () => {
    sendMock.mockResolvedValueOnce({ ContentLength: 1024 })
    const r = await putObjectIfAbsent({
      client: buildS3Client({ region: 'ap-southeast-1' }),
      bucket: 'gbox-clone-storage', key: 'a/b/sha1.jpg', body: Buffer.from('data'), contentType: 'image/jpeg',
    })
    expect(r.uploaded).toBe(false)
    expect(r.skipped).toBe(true)
  })

  it('puts when object missing', async () => {
    sendMock.mockRejectedValueOnce({ name: 'NotFound' })
    sendMock.mockResolvedValueOnce({})
    const r = await putObjectIfAbsent({
      client: buildS3Client({ region: 'ap-southeast-1' }),
      bucket: 'gbox-clone-storage', key: 'a/b/sha1.jpg', body: Buffer.from('data'), contentType: 'image/jpeg',
    })
    expect(r.uploaded).toBe(true)
  })
})
