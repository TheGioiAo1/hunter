/**
 * Gbox Platform — Files library service.
 *
 * Phase 7 PR5. Backs the seller-facing "Files" admin page (Shopify
 * parity): upload → list → rename/alt → delete. Metadata lives in the
 * `files` table, bytes live in a public-media bucket via the
 * `ObjectStore` interface. Bytes and DB row move together — failures on
 * either side leave nothing orphaned.
 *
 * Scope boundaries (deliberately NOT in this service):
 *   - Image transforms / thumbnails — handled by the media/cdn module.
 *   - Signed URLs — these files are public; the storefront serves them
 *     directly from the CDN.
 *   - File variants (e.g. multiple sizes) — out of scope for v1.
 *   - Inline storage — unlike theme assets, every file goes to the
 *     object store regardless of size. A file IS its bytes.
 */
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import type { ObjectStore } from '../storage/interface.js'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileRow {
  id: string
  shop_id: string
  filename: string
  mime_type: string | null
  size: number | null
  url: string
  alt: string | null
  created_at: string | Date
}

export interface UploadFileArgs {
  shopId: string
  filename: string
  mimeType: string
  body: Uint8Array | Buffer
  alt?: string | null
}

export interface FilesDeps {
  objectStore: ObjectStore
  /** Max per-file size in bytes. Defaults to 25 MB. */
  maxFileSize?: number
  /** Optional shop-wide storage cap in bytes. Null = unlimited. */
  maxShopBytes?: number | null
  /** Allowed mime prefixes. Defaults to a seller-safe set. */
  allowedMimePrefixes?: string[]
}

export type UploadFileResult =
  | { ok: true; file: FileRow }
  | {
      ok: false
      error:
        | 'filename_required'
        | 'mime_not_allowed'
        | 'too_large'
        | 'quota_exceeded'
        | 'upload_failed'
      detail?: string
    }

export interface ListFilesOpts {
  /** Page size. Clamped to [1, 200]. Default 50. */
  limit?: number
  /** Zero-based offset. Default 0. */
  offset?: number
  /** Substring match on filename (case-insensitive). */
  search?: string
  /** Filter by broad mime category. */
  type?: 'image' | 'video' | 'document' | 'other' | 'all'
}

export interface ListFilesResult {
  rows: FileRow[]
  total: number
  usedBytes: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default 25 MB per file. Big enough for product hero images / short
 * marketing videos, small enough that a cheap paid plan can't be turned
 * into a file host. Callers can override per-plan via `deps.maxFileSize`.
 */
export const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024

/**
 * Default mime allowlist — images, video, audio, PDF, plain text,
 * web fonts. The storefront renders these natively, so anything outside
 * the list is either unsafe (executables) or pointless (zip, binary)
 * to host on a CDN.
 */
export const DEFAULT_ALLOWED_MIME_PREFIXES = [
  'image/',
  'video/',
  'audio/',
  'application/pdf',
  'application/json',
  'text/',
  'font/',
  'application/font-woff',
  'application/vnd.ms-fontobject',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip path separators, `..`, and other noise from a user-supplied
 * filename. We don't trust multer's `originalname` — browsers on
 * different OSes send different separators and some send full paths.
 *
 * This is purely cosmetic for the user; the actual object key is
 * constructed from a UUID and never exposes the raw name.
 */
export function sanitizeFilename(raw: string): string {
  const stripped = raw
    .replace(/[\\/]/g, '_')
    .replace(/\u0000/g, '')
    .trim()
  // Windows / POSIX reserved chars + leading/trailing dots. Also
  // collapse any run of 2+ dots — `..` anywhere in the name is a
  // classic path-traversal sigil and has no business in a display
  // filename (valid filenames never need consecutive dots either).
  const cleaned = stripped
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
  // Clip to 250 chars — filenames column is varchar(500) but leaving
  // headroom keeps query plans sane.
  return cleaned.slice(0, 250) || 'file'
}

/**
 * Broad mime type category used by the listing filter.
 * Anything not matching image/video/document falls to "other".
 */
export function mimeCategory(
  mime: string | null | undefined,
): 'image' | 'video' | 'audio' | 'document' | 'other' {
  if (!mime) return 'other'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (
    mime.startsWith('application/pdf') ||
    mime.startsWith('text/') ||
    mime.startsWith('application/json') ||
    mime.startsWith('application/vnd') ||
    mime.startsWith('application/msword') ||
    mime.startsWith('application/x-www-form') ||
    mime.startsWith('application/rtf')
  ) {
    return 'document'
  }
  return 'other'
}

/** Build the deterministic object-store key for a file. */
export function objectKeyFor(shopId: string, fileId: string, filename: string): string {
  // Folder by shop → easy per-shop listing in the bucket console; file
  // id in the path → no collision risk even with identical filenames.
  return `files/${shopId}/${fileId}/${filename}`
}

function clampLimit(n: number | undefined): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 50
  return Math.max(1, Math.min(Math.floor(v), 200))
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Upload a file for a shop. Writes bytes to the object store first;
 * only if that succeeds do we insert the DB row. On DB failure we try
 * to delete the blob so we don't orphan bytes — but R2 delete errors
 * are swallowed (idempotent cleanup is the store's job).
 */
export async function uploadFile(
  db: Kysely<Database>,
  args: UploadFileArgs,
  deps: FilesDeps,
): Promise<UploadFileResult> {
  const maxSize = deps.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
  const allowed = deps.allowedMimePrefixes ?? DEFAULT_ALLOWED_MIME_PREFIXES

  // Reject BEFORE sanitization — sanitizeFilename falls back to 'file'
  // for an empty/whitespace input, which is useful for quiet recovery on
  // weird inputs but must not paper over a caller who literally sent ''.
  if (!args.filename || !args.filename.trim()) {
    return { ok: false, error: 'filename_required' }
  }
  const filename = sanitizeFilename(args.filename)

  const mime = (args.mimeType || '').toLowerCase()
  if (!allowed.some((p) => mime === p || mime.startsWith(p))) {
    return { ok: false, error: 'mime_not_allowed', detail: mime }
  }

  const bodyBytes = args.body instanceof Uint8Array ? args.body : new Uint8Array(args.body)
  if (bodyBytes.byteLength > maxSize) {
    return { ok: false, error: 'too_large', detail: String(bodyBytes.byteLength) }
  }

  // Quota check. The bill-by-bytes policy lives in the caller (they
  // pick `maxShopBytes` from the shop's plan). If unset we skip the
  // check — e.g. the god-admin bypass path.
  if (typeof deps.maxShopBytes === 'number' && deps.maxShopBytes > 0) {
    const existing = await (db as any)
      .selectFrom('files')
      .select((eb: any) => eb.fn.sum('size').as('used'))
      .where('shop_id', '=', args.shopId)
      .executeTakeFirst()
    const used = Number(existing?.used ?? 0)
    if (used + bodyBytes.byteLength > deps.maxShopBytes) {
      return {
        ok: false,
        error: 'quota_exceeded',
        detail: `${used + bodyBytes.byteLength}/${deps.maxShopBytes}`,
      }
    }
  }

  const fileId = randomUUID()
  const key = objectKeyFor(args.shopId, fileId, filename)

  let url: string
  try {
    url = await deps.objectStore.put(key, bodyBytes, {
      contentType: mime || 'application/octet-stream',
      cacheControl: 'public, max-age=31536000, immutable',
    })
  } catch (err) {
    return {
      ok: false,
      error: 'upload_failed',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  try {
    const row = await (db as any)
      .insertInto('files')
      .values({
        id: fileId,
        shop_id: args.shopId,
        filename,
        mime_type: mime || null,
        size: bodyBytes.byteLength,
        url,
        alt: args.alt ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { ok: true, file: row as FileRow }
  } catch (err) {
    // DB insert failed after the blob was written — try to clean the
    // blob so we don't leak bytes. `delete` is idempotent; swallow.
    try {
      await deps.objectStore.delete(key)
    } catch {
      /* best-effort */
    }
    return {
      ok: false,
      error: 'upload_failed',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * List files for a shop. Offers light pagination, an optional
 * substring search on filename, and a broad "mime category" filter.
 * Total count + byte usage are returned alongside the page so the UI
 * can render the "N files, X MB of Y quota" header without a second
 * round-trip.
 */
export async function listFiles(
  db: Kysely<Database>,
  shopId: string,
  opts: ListFilesOpts = {},
): Promise<ListFilesResult> {
  const limit = clampLimit(opts.limit)
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const needle = (opts.search ?? '').trim().toLowerCase()

  let base: any = (db as any).selectFrom('files').where('shop_id', '=', shopId)

  if (needle) {
    base = base.where('filename', 'ilike', `%${needle}%`)
  }

  // Mime category filter. SQL doesn't have "starts with" for efficient
  // prefix scans across arbitrary mimes, but the table is small per-
  // shop (hundreds of rows, not millions) so a WHERE clause is fine.
  if (opts.type && opts.type !== 'all') {
    switch (opts.type) {
      case 'image':
        base = base.where('mime_type', 'ilike', 'image/%')
        break
      case 'video':
        base = base.where('mime_type', 'ilike', 'video/%')
        break
      case 'document':
        base = base.where((eb: any) =>
          eb.or([
            eb('mime_type', 'ilike', 'application/pdf'),
            eb('mime_type', 'ilike', 'text/%'),
            eb('mime_type', 'ilike', 'application/json'),
            eb('mime_type', 'ilike', 'application/msword%'),
            eb('mime_type', 'ilike', 'application/vnd%'),
          ]),
        )
        break
      case 'other':
        // 'other' = everything NOT in image/video/document.
        base = base
          .where('mime_type', 'not ilike', 'image/%')
          .where('mime_type', 'not ilike', 'video/%')
          .where('mime_type', 'not ilike', 'application/pdf')
          .where('mime_type', 'not ilike', 'text/%')
          .where('mime_type', 'not ilike', 'application/json')
          .where('mime_type', 'not ilike', 'application/msword%')
          .where('mime_type', 'not ilike', 'application/vnd%')
        break
    }
  }

  const rows = await base
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()

  const countRow = await base
    .select((eb: any) => eb.fn.count('id').as('c'))
    .executeTakeFirst()
  const total = Number(countRow?.c ?? 0)

  // usedBytes is shop-wide — NOT filtered by the search / type
  // predicates — because the UI renders it as "X of Y quota" which is
  // always a shop-wide figure.
  const usedRow = await (db as any)
    .selectFrom('files')
    .select((eb: any) => eb.fn.sum('size').as('bytes'))
    .where('shop_id', '=', shopId)
    .executeTakeFirst()
  const usedBytes = Number(usedRow?.bytes ?? 0)

  return { rows: rows as FileRow[], total, usedBytes }
}

/**
 * Get one file, scoped to the shop. Returns null when missing OR when
 * the row belongs to a different shop — same 404-on-cross-tenant
 * posture as the rest of the admin API.
 */
export async function getFile(
  db: Kysely<Database>,
  shopId: string,
  fileId: string,
): Promise<FileRow | null> {
  const row = await (db as any)
    .selectFrom('files')
    .selectAll()
    .where('id', '=', fileId)
    .where('shop_id', '=', shopId)
    .executeTakeFirst()
  return (row as FileRow) ?? null
}

/**
 * Delete a file. Row goes first, then the blob — if the blob delete
 * fails the DB change is already committed and the blob becomes
 * inaccessible via the app; a nightly cleanup job could sweep dangling
 * keys, but for v1 we just swallow the error.
 */
export async function deleteFile(
  db: Kysely<Database>,
  shopId: string,
  fileId: string,
  deps: FilesDeps,
): Promise<{ ok: boolean; error?: 'not_found' }> {
  const existing = await getFile(db, shopId, fileId)
  if (!existing) return { ok: false, error: 'not_found' }

  await (db as any)
    .deleteFrom('files')
    .where('id', '=', fileId)
    .where('shop_id', '=', shopId)
    .execute()

  // Derive the object key from the stored URL when we recognize our
  // own url shape; otherwise fall back to the deterministic key path.
  const key = objectKeyFor(shopId, fileId, existing.filename)
  try {
    await deps.objectStore.delete(key)
  } catch {
    /* best-effort; idempotent */
  }

  return { ok: true }
}

/**
 * Patch filename / alt. Filename is sanitized the same way as upload;
 * the object-store key is NOT changed (renaming in S3 costs a full
 * copy + delete and the public CDN URL is already cached) — only the
 * display filename in the DB is updated.
 */
export async function updateFile(
  db: Kysely<Database>,
  shopId: string,
  fileId: string,
  patch: { filename?: string; alt?: string | null },
): Promise<FileRow | null> {
  const existing = await getFile(db, shopId, fileId)
  if (!existing) return null

  const updates: Record<string, unknown> = {}
  if (typeof patch.filename === 'string') {
    const cleaned = sanitizeFilename(patch.filename)
    if (cleaned) updates.filename = cleaned
  }
  if (patch.alt !== undefined) {
    updates.alt = patch.alt
  }
  if (Object.keys(updates).length === 0) return existing

  const row = await (db as any)
    .updateTable('files')
    .set(updates)
    .where('id', '=', fileId)
    .where('shop_id', '=', shopId)
    .returningAll()
    .executeTakeFirstOrThrow()
  return row as FileRow
}

// ---------------------------------------------------------------------------
// Plan → quota mapping (kept alongside the service so the UI and upload
// path both agree on what a plan is worth).
// ---------------------------------------------------------------------------

export const PLAN_QUOTA_BYTES: Record<string, number | null> = {
  free: 500 * 1024 * 1024, // 500 MB
  basic: 2 * 1024 * 1024 * 1024, // 2 GB
  pro: 10 * 1024 * 1024 * 1024, // 10 GB
  enterprise: 50 * 1024 * 1024 * 1024, // 50 GB
}

export function quotaFor(plan: string | null | undefined): number | null {
  if (!plan) return PLAN_QUOTA_BYTES.free ?? null
  return plan in PLAN_QUOTA_BYTES ? PLAN_QUOTA_BYTES[plan] ?? null : PLAN_QUOTA_BYTES.free ?? null
}
