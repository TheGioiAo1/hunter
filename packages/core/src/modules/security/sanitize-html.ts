/**
 * Security Module — HTML sanitization for user-generated content
 *
 * Used for: product reviews, customer-submitted questions, blog comments.
 *
 * Design:
 *   - Allowlist-based: only whitelisted tags and attributes survive.
 *   - Strips <script>, <style>, <iframe>, <object>, <embed>, on* handlers,
 *     and javascript: / data: URLs.
 *   - Not a full-fledged HTML parser — intentionally refuses to process
 *     malformed HTML instead of trying to fix it.
 *
 * For highly trusted content (admin theme editor, merchant page CMS) use
 * a stricter path: isomorphic-dompurify in the admin build. The reason
 * we don't depend on DOMPurify here is that pulling jsdom into the core
 * package adds ~40MB; we need a zero-dep path for the API hot path.
 *
 * If a project boundary needs richer HTML, import DOMPurify at that
 * boundary and use this only as a fallback.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'em',
  'u',
  'b',
  'i',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'span',
])

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'rel', 'target']),
  span: new Set(['class']),
  code: new Set(['class']),
}

const SAFE_URL = /^(https?:|mailto:|\/)/i

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function cleanAttrs(tag: string, rawAttrs: string): string {
  const allowed = ALLOWED_ATTRS[tag]
  if (!allowed || !rawAttrs) return ''

  const out: string[] = []
  const attrRe = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(rawAttrs)) !== null) {
    const name = m[1].toLowerCase()
    if (!allowed.has(name)) continue
    // on*= handlers are already excluded because they aren't in the allow list.

    let value = m[3] ?? m[4] ?? m[5] ?? ''
    // Strip any URL that isn't http(s)/mailto/relative.
    if (name === 'href') {
      if (!SAFE_URL.test(value.trim())) continue
    }
    // target=_blank must carry rel="noopener" to prevent tabnabbing.
    if (name === 'target' && value === '_blank') {
      out.push('target="_blank"')
      if (!rawAttrs.toLowerCase().includes('rel=')) {
        out.push('rel="noopener noreferrer"')
      }
      continue
    }
    value = escapeText(value)
    out.push(`${name}="${value}"`)
  }

  return out.length > 0 ? ' ' + out.join(' ') : ''
}

// ---------------------------------------------------------------------------
// Main: sanitizeHtml
// ---------------------------------------------------------------------------

export function sanitizeHtml(input: string): string {
  if (!input) return ''
  if (typeof input !== 'string') return ''

  // Drop <script> / <style> / <iframe> contents entirely. These are the
  // tags where the danger is inside the tag, not in attributes.
  let src = input
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // Tokenize by tag boundary.
  const out: string[] = []
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g
  let lastIndex = 0
  let m: RegExpExecArray | null

  while ((m = tagRe.exec(src)) !== null) {
    // Append any preceding text, escaped.
    if (m.index > lastIndex) {
      out.push(escapeText(src.slice(lastIndex, m.index)))
    }

    const full = m[0]
    const tag = m[1].toLowerCase()
    const isClose = full.startsWith('</')
    const rawAttrs = m[2] || ''

    if (!ALLOWED_TAGS.has(tag)) {
      // Drop the entire tag (but keep its text content, which we will
      // pick up on the next iteration via the text slice mechanism).
      lastIndex = tagRe.lastIndex
      continue
    }

    if (isClose) {
      out.push(`</${tag}>`)
    } else {
      const attrs = cleanAttrs(tag, rawAttrs)
      const selfClose = tag === 'br' || /\/\s*$/.test(rawAttrs)
      out.push(selfClose ? `<${tag}${attrs} />` : `<${tag}${attrs}>`)
    }

    lastIndex = tagRe.lastIndex
  }

  if (lastIndex < src.length) {
    out.push(escapeText(src.slice(lastIndex)))
  }

  return out.join('')
}

/**
 * Strict variant — strips ALL tags, returning plain text.
 * Use for one-liners like review titles where no formatting is welcome.
 */
export function stripHtml(input: string): string {
  if (!input) return ''
  return input.replace(/<[^>]*>/g, '').trim()
}
