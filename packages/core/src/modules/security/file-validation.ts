/**
 * Security Module — File upload magic-bytes validation
 *
 * Content-Type is client-controlled. A malicious user can upload an HTML
 * file with `Content-Type: image/png` and serve XSS from the storefront.
 * This helper inspects the first few bytes of the actual file and
 * refuses anything that doesn't match an allow-listed signature.
 *
 * References:
 *   https://en.wikipedia.org/wiki/List_of_file_signatures
 *   https://owasp.org/www-community/vulnerabilities/Unrestricted_File_Upload
 */

import type { Request, Response, NextFunction } from 'express'

// ---------------------------------------------------------------------------
// Signature table
//
// Each entry: (mime, extension, matcher function).
// We keep it small — only types the storefront actually needs.
// ---------------------------------------------------------------------------

export interface FileSignature {
  mime: string
  extension: string
  match: (buf: Buffer) => boolean
}

const sig = (bytes: number[], offset: number = 0) => (buf: Buffer) => {
  if (buf.length < offset + bytes.length) return false
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false
  }
  return true
}

export const SIGNATURES: FileSignature[] = [
  // JPEG
  { mime: 'image/jpeg', extension: 'jpg', match: sig([0xff, 0xd8, 0xff]) },
  // PNG
  {
    mime: 'image/png',
    extension: 'png',
    match: sig([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  // GIF87a / GIF89a
  { mime: 'image/gif', extension: 'gif', match: sig([0x47, 0x49, 0x46, 0x38]) },
  // WebP — "RIFF....WEBP"
  {
    mime: 'image/webp',
    extension: 'webp',
    match: (buf) =>
      sig([0x52, 0x49, 0x46, 0x46])(buf) &&
      sig([0x57, 0x45, 0x42, 0x50], 8)(buf),
  },
  // AVIF — "ftypavif" at offset 4
  {
    mime: 'image/avif',
    extension: 'avif',
    match: sig([0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 4),
  },
  // PDF — "%PDF-"
  {
    mime: 'application/pdf',
    extension: 'pdf',
    match: sig([0x25, 0x50, 0x44, 0x46, 0x2d]),
  },
  // SVG is intentionally NOT here — SVG is an XML document and can carry
  // <script> tags. Treat SVG as untrusted HTML and sanitize before
  // storing, don't validate via magic bytes.
]

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface DetectResult {
  ok: boolean
  mime: string | null
  extension: string | null
}

/**
 * Detect a file's real type from its bytes. Returns { ok: false } if no
 * signature matched.
 */
export function detectFileType(buf: Buffer): DetectResult {
  for (const s of SIGNATURES) {
    if (s.match(buf)) {
      return { ok: true, mime: s.mime, extension: s.extension }
    }
  }
  return { ok: false, mime: null, extension: null }
}

/**
 * Assert a file matches an allowed MIME type list based on its magic
 * bytes. Throws an Error with a user-safe message on mismatch.
 */
export function assertAllowedFileType(
  buf: Buffer,
  allowedMimes: string[],
): DetectResult {
  const detected = detectFileType(buf)
  if (!detected.ok || !detected.mime) {
    throw new Error('Unrecognized file type — upload rejected')
  }
  if (!allowedMimes.includes(detected.mime)) {
    throw new Error(
      `File type ${detected.mime} is not allowed (allowed: ${allowedMimes.join(', ')})`,
    )
  }
  return detected
}

// ---------------------------------------------------------------------------
// Express middleware factory (for use with multer or busboy-provided
// files on req.files / req.file).
// ---------------------------------------------------------------------------

export interface FileValidationOptions {
  /** Allowed real MIME types. */
  allowedMimes: string[]
  /** Max file size in bytes. Default 10MB. */
  maxBytes?: number
  /** Field name to read from req (single-file default). */
  field?: string
}

export function validateUploadedFile(opts: FileValidationOptions) {
  const { allowedMimes, maxBytes = 10 * 1024 * 1024, field = 'file' } = opts

  return function validateUploadedFileMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const file: any =
      (req as any).file ??
      (Array.isArray((req as any).files)
        ? (req as any).files.find((f: any) => f.fieldname === field)
        : (req as any).files?.[field])

    if (!file) {
      return res.status(400).json({
        error: 'file_required',
        message: `No file found on field "${field}"`,
      })
    }

    if (file.size > maxBytes) {
      return res.status(413).json({
        error: 'file_too_large',
        message: `File exceeds max size of ${maxBytes} bytes`,
      })
    }

    const buf: Buffer | undefined = file.buffer
    if (!Buffer.isBuffer(buf)) {
      return res.status(400).json({
        error: 'file_not_buffered',
        message:
          'Uploaded file has no buffer — use memory storage for magic-bytes validation',
      })
    }

    try {
      const detected = assertAllowedFileType(buf, allowedMimes)
      // Rewrite the client-provided mimetype with the real one so
      // downstream storage uses the trusted value.
      file.mimetype = detected.mime
      file.detectedExtension = detected.extension
      return next()
    } catch (err) {
      return res.status(415).json({
        error: 'unsupported_file_type',
        message: (err as Error).message,
      })
    }
  }
}
