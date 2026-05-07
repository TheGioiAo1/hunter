/**
 * Gbox Platform — XML tag streaming parser
 *
 * LLMs are dramatically more stable at emitting XML-tagged output
 * than at emitting pure JSON, because an LLM can "close a tag"
 * incrementally but can't close a JSON object without emitting every
 * prior field. That means when we ask a model to describe 20 sections
 * of a site in one stream:
 *
 *   - JSON approach: the UI can't render section 0 until section 19
 *     finishes and the whole `{sections:[...]}` object balances.
 *   - XML approach: section 0 arrives in its own `<section>` tag,
 *     the UI renders it immediately, and sections 1–19 stream in.
 *
 * This parser takes incremental text chunks (as they arrive from a
 * provider's SSE stream) and yields well-formed `XmlEvent`s. It is
 * deliberately minimal — it is NOT a general-purpose XML parser:
 *
 *   - No entities (&amp;, &#123;) — attribute/content text is raw.
 *   - No namespaces, no DOCTYPE, no CDATA (we don't ask models to
 *     produce those).
 *   - No nested tags of the same name — LLM outputs in our prompts
 *     are flat lists of tags, and forbidding nesting simplifies
 *     state enormously.
 *
 * The parser tolerates malformed fragments: if we see `<section>text`
 * but never a `</section>`, on `finish()` we emit whatever we have
 * with a synthetic `incomplete: true` flag so callers can decide
 * whether to trust partial content.
 *
 * Inspired by open-lovable's streaming XML protocol (see the
 * integration plan at docs/superpowers/plans/2026-04-16-open-lovable…).
 * The implementation is ours — zero dependencies, worker-compatible.
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type XmlEvent =
  /**
   * A complete open tag has been parsed. Emitted BEFORE the tag's
   * body streams in — lets the UI react (show a spinner for that
   * section) without waiting for the close.
   */
  | { readonly type: 'tag_open'; readonly name: string; readonly attrs: Readonly<Record<string, string>> }
  /**
   * A chunk of character data inside the currently-open tag (or at
   * root level if no tag is open). Emitted as soon as the character
   * data is guaranteed to not be part of a tag opener.
   */
  | { readonly type: 'text'; readonly content: string; readonly inTag: string | null }
  /**
   * The current tag has closed cleanly. Fires AFTER the last text
   * event for that tag.
   */
  | { readonly type: 'tag_close'; readonly name: string }
  /**
   * Convenience event — emitted right after `tag_close` (or after a
   * self-closing tag). Carries the full accumulated body so callers
   * who don't care about streaming can act on whole tags only.
   */
  | {
      readonly type: 'tag_complete'
      readonly name: string
      readonly attrs: Readonly<Record<string, string>>
      readonly content: string
    }
  /**
   * Stream terminated with an unclosed tag. Emitted once at finish
   * with whatever body accumulated so far.
   */
  | {
      readonly type: 'tag_incomplete'
      readonly name: string
      readonly attrs: Readonly<Record<string, string>>
      readonly partial: string
    }

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Stateful streaming parser. Construct once per stream, feed chunks,
 * collect events, call `finish()` at EOF.
 *
 * Example
 * -------
 *
 *   const parser = new XmlStreamParser()
 *   const events: XmlEvent[] = []
 *   for await (const chunk of aiStream) {
 *     events.push(...parser.feed(chunk))
 *   }
 *   events.push(...parser.finish())
 */
export class XmlStreamParser {
  private buffer = ''
  /** Name of the currently-open tag, or null if at root. */
  private currentTag: { name: string; attrs: Record<string, string>; body: string } | null = null

  /** Feed a chunk of text. Returns all events that completed inside this chunk. */
  feed(chunk: string): XmlEvent[] {
    this.buffer += chunk
    return this.drain()
  }

  /** Call at end of stream. Flushes any pending text and reports unclosed tags. */
  finish(): XmlEvent[] {
    const events: XmlEvent[] = []

    // Flush remaining buffer as text (outside a tag) or body (inside).
    if (this.buffer.length > 0) {
      if (this.currentTag) {
        this.currentTag.body += this.buffer
        events.push({
          type: 'text',
          content: this.buffer,
          inTag: this.currentTag.name,
        })
      } else if (this.buffer.trim().length > 0) {
        events.push({ type: 'text', content: this.buffer, inTag: null })
      }
      this.buffer = ''
    }

    if (this.currentTag) {
      events.push({
        type: 'tag_incomplete',
        name: this.currentTag.name,
        attrs: this.currentTag.attrs,
        partial: this.currentTag.body,
      })
      this.currentTag = null
    }

    return events
  }

  // ── Private ────────────────────────────────────────────────────

  /**
   * Scan the buffer for complete tag openers/closers. Partial tags
   * (e.g. `<section` with no `>` yet) are left in the buffer for the
   * next feed.
   */
  private drain(): XmlEvent[] {
    const events: XmlEvent[] = []

    while (this.buffer.length > 0) {
      if (this.currentTag) {
        // Inside a tag — scan for its closer.
        const closeMarker = `</${this.currentTag.name}>`
        const closeIdx = this.buffer.indexOf(closeMarker)
        if (closeIdx === -1) {
          // No closer yet. If the buffer ends with a partial closer
          // (e.g. `…text</sec`), keep that tail in the buffer; emit
          // the safe prefix as text.
          const partialCloseStart = findPartialCloseStart(this.buffer, this.currentTag.name)
          if (partialCloseStart === -1) {
            // Whole buffer is safe body.
            if (this.buffer.length > 0) {
              this.currentTag.body += this.buffer
              events.push({
                type: 'text',
                content: this.buffer,
                inTag: this.currentTag.name,
              })
              this.buffer = ''
            }
          } else if (partialCloseStart > 0) {
            const safe = this.buffer.slice(0, partialCloseStart)
            this.currentTag.body += safe
            events.push({ type: 'text', content: safe, inTag: this.currentTag.name })
            this.buffer = this.buffer.slice(partialCloseStart)
          }
          // Either way, we're done for this chunk — need more data.
          return events
        }

        // Found the closer. Emit body text + close + complete.
        const body = this.buffer.slice(0, closeIdx)
        this.buffer = this.buffer.slice(closeIdx + closeMarker.length)
        if (body.length > 0) {
          this.currentTag.body += body
          events.push({
            type: 'text',
            content: body,
            inTag: this.currentTag.name,
          })
        }
        const closed = this.currentTag
        events.push({ type: 'tag_close', name: closed.name })
        events.push({
          type: 'tag_complete',
          name: closed.name,
          attrs: closed.attrs,
          content: closed.body,
        })
        this.currentTag = null
      } else {
        // Outside a tag — look for the next opener.
        const openIdx = this.buffer.indexOf('<')
        if (openIdx === -1) {
          // No more tags in this buffer — emit everything as text.
          if (this.buffer.trim().length > 0) {
            events.push({ type: 'text', content: this.buffer, inTag: null })
          }
          this.buffer = ''
          return events
        }

        if (openIdx > 0) {
          // Text before the next tag.
          const text = this.buffer.slice(0, openIdx)
          if (text.trim().length > 0) {
            events.push({ type: 'text', content: text, inTag: null })
          }
          this.buffer = this.buffer.slice(openIdx)
        }

        // Find the matching `>` to parse the opener.
        const closeBracketIdx = this.buffer.indexOf('>')
        if (closeBracketIdx === -1) {
          // Partial opener — wait for more data.
          return events
        }

        const rawTag = this.buffer.slice(1, closeBracketIdx) // strip `<` and `>`
        this.buffer = this.buffer.slice(closeBracketIdx + 1)

        // Closing tag we weren't expecting (no current tag). Skip.
        if (rawTag.startsWith('/')) {
          continue
        }

        // Self-closing tag: `<tag attr="val" />`
        const isSelfClosing = rawTag.endsWith('/')
        const tagBody = isSelfClosing ? rawTag.slice(0, -1).trim() : rawTag.trim()

        const parsed = parseTagHeader(tagBody)
        if (!parsed) continue // Malformed — skip.

        events.push({ type: 'tag_open', name: parsed.name, attrs: parsed.attrs })

        if (isSelfClosing) {
          events.push({ type: 'tag_close', name: parsed.name })
          events.push({
            type: 'tag_complete',
            name: parsed.name,
            attrs: parsed.attrs,
            content: '',
          })
        } else {
          this.currentTag = { name: parsed.name, attrs: parsed.attrs, body: '' }
        }
      }
    }

    return events
  }
}

// ---------------------------------------------------------------------------
// Tag header parser
// ---------------------------------------------------------------------------

/**
 * Parse the inside of `<...>` into `{name, attrs}`. Returns null on
 * malformed input.
 *
 * Accepts:
 *   section                       → name=section, attrs={}
 *   section type="hero"           → name=section, attrs={type:'hero'}
 *   section type="hero" index="0" → name=section, attrs={type:'hero', index:'0'}
 */
function parseTagHeader(
  body: string,
): { name: string; attrs: Record<string, string> } | null {
  const trimmed = body.trim()
  if (trimmed.length === 0) return null

  // Name is everything up to first whitespace.
  const spaceIdx = trimmed.search(/\s/)
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)

  if (!isValidTagName(name)) return null

  const attrs: Record<string, string> = {}
  if (spaceIdx === -1) return { name, attrs }

  const rest = trimmed.slice(spaceIdx + 1)
  // Match   attr="value"  attr2='value'  attr3=value  (bare not common but tolerated)
  const attrRe = /([a-zA-Z_][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g
  let match: RegExpExecArray | null
  while ((match = attrRe.exec(rest)) !== null) {
    const key = match[1]
    const value = match[3] ?? match[4] ?? match[5] ?? ''
    attrs[key] = value
  }

  return { name, attrs }
}

function isValidTagName(name: string): boolean {
  // LLM output should only ever use alphanumeric + underscore + dash.
  // Reject anything else so malformed `<<section>` doesn't trick us.
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)
}

/**
 * Does the tail of `buf` look like the start of `</tagName>` (without
 * the full closer yet)? Returns the index where the partial closer
 * starts, or -1 if no partial match.
 *
 * Example:
 *   findPartialCloseStart('foo</sec', 'section') → 3
 *   findPartialCloseStart('foo</sec', 'footer')  → -1
 *   findPartialCloseStart('foo</',    'section') →  3
 */
function findPartialCloseStart(buf: string, tagName: string): number {
  const marker = `</${tagName}>`
  // Walk backwards from the last `<` — the partial match must start
  // at some position where the substring to end-of-buffer is a
  // proper prefix of `marker` and shorter than `marker`.
  const lt = buf.lastIndexOf('<')
  if (lt === -1) return -1
  const tail = buf.slice(lt)
  if (marker.startsWith(tail) && tail.length < marker.length) return lt
  return -1
}

// ---------------------------------------------------------------------------
// Convenience: collect all tags of a given name from a stream
// ---------------------------------------------------------------------------

/**
 * Drain an async iterable of text chunks and return every
 * `tag_complete` event whose name matches `tagName`. Useful when the
 * caller doesn't care about interleaved text or other tag names.
 */
export async function collectTags(
  chunks: AsyncIterable<string>,
  tagName: string,
): Promise<Array<{ attrs: Record<string, string>; content: string }>> {
  const parser = new XmlStreamParser()
  const out: Array<{ attrs: Record<string, string>; content: string }> = []
  for await (const chunk of chunks) {
    for (const event of parser.feed(chunk)) {
      if (event.type === 'tag_complete' && event.name === tagName) {
        out.push({ attrs: { ...event.attrs }, content: event.content })
      }
    }
  }
  for (const event of parser.finish()) {
    if (event.type === 'tag_complete' && event.name === tagName) {
      out.push({ attrs: { ...event.attrs }, content: event.content })
    }
  }
  return out
}
