/**
 * Gbox Platform — XmlStreamParser tests
 *
 * These tests pin the parser's streaming contract:
 *
 *   1. Complete tags emit open → text* → close → tag_complete in
 *      that order.
 *   2. Partial chunks do NOT produce spurious events. The parser
 *      must wait for enough data to know a tag is real.
 *   3. Self-closing tags emit the full sequence immediately.
 *   4. Unclosed tags at end-of-stream surface as `tag_incomplete`.
 *   5. Attributes survive chunking (no silent data loss).
 *   6. Malformed input is ignored, not crashed.
 *
 * The parser is the foundation of every streaming AI feature we
 * build on top (SEO, alt-text, section mapping), so regressions
 * here ripple everywhere — hence the thorough coverage.
 */

import { describe, it, expect } from 'vitest'
import { XmlStreamParser, collectTags, type XmlEvent } from './xml-stream-parser.js'

function feed(parser: XmlStreamParser, ...chunks: string[]): XmlEvent[] {
  const events: XmlEvent[] = []
  for (const c of chunks) events.push(...parser.feed(c))
  events.push(...parser.finish())
  return events
}

describe('XmlStreamParser — happy paths', () => {
  it('emits open, text, close, complete for a simple paired tag', () => {
    const p = new XmlStreamParser()
    const events = feed(p, '<section>hello world</section>')
    expect(events).toEqual([
      { type: 'tag_open', name: 'section', attrs: {} },
      { type: 'text', content: 'hello world', inTag: 'section' },
      { type: 'tag_close', name: 'section' },
      { type: 'tag_complete', name: 'section', attrs: {}, content: 'hello world' },
    ])
  })

  it('parses attributes with double quotes, single quotes, and bare values', () => {
    const p = new XmlStreamParser()
    const events = feed(
      p,
      `<section type="hero" class='big' index=3>body</section>`,
    )
    const open = events.find((e) => e.type === 'tag_open')
    expect(open).toEqual({
      type: 'tag_open',
      name: 'section',
      attrs: { type: 'hero', class: 'big', index: '3' },
    })
  })

  it('treats self-closing tags as complete immediately', () => {
    const p = new XmlStreamParser()
    const events = feed(p, '<meta name="title" />')
    expect(events.map((e) => e.type)).toEqual(['tag_open', 'tag_close', 'tag_complete'])
    const complete = events.find((e) => e.type === 'tag_complete')!
    expect(complete).toMatchObject({
      name: 'meta',
      attrs: { name: 'title' },
      content: '',
    })
  })

  it('streams multiple sibling tags in order', () => {
    const p = new XmlStreamParser()
    const events = feed(p, '<a>1</a><b>2</b><c>3</c>')
    const completes = events.filter((e): e is Extract<XmlEvent, { type: 'tag_complete' }> =>
      e.type === 'tag_complete',
    )
    expect(completes.map((c) => [c.name, c.content])).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ])
  })

  it('preserves text at root level between tags', () => {
    const p = new XmlStreamParser()
    const events = feed(p, 'prefix <a>body</a> suffix')
    const texts = events.filter((e): e is Extract<XmlEvent, { type: 'text' }> => e.type === 'text')
    const rootTexts = texts.filter((t) => t.inTag === null).map((t) => t.content)
    // Whitespace-only text is suppressed; 'prefix ' + ' suffix' both have non-whitespace
    expect(rootTexts).toContain('prefix ')
    expect(rootTexts).toContain(' suffix')
  })
})

describe('XmlStreamParser — streaming', () => {
  it('defers events until a tag opener is complete across chunks', () => {
    const p = new XmlStreamParser()
    // Feed the opener split across two chunks.
    const midEvents = p.feed('<sec')
    expect(midEvents).toEqual([]) // Nothing to emit yet.

    const more = p.feed('tion>body</section>')
    const types = more.map((e) => e.type)
    expect(types).toEqual(['tag_open', 'text', 'tag_close', 'tag_complete'])
  })

  it('defers a closer until it is unambiguous across chunks', () => {
    const p = new XmlStreamParser()
    p.feed('<section>body')
    // Partial closer — must not emit tag_close yet.
    const mid = p.feed('</sec')
    expect(mid.find((e) => e.type === 'tag_close')).toBeUndefined()

    const end = p.feed('tion>')
    const types = end.map((e) => e.type)
    expect(types).toContain('tag_close')
    expect(types).toContain('tag_complete')
  })

  it('emits safe body text before a partial closer so UI can stream', () => {
    const p = new XmlStreamParser()
    p.feed('<section>')
    const events = p.feed('hello</s')
    // `hello` should fire (safe), but `</s` should be held.
    const texts = events.filter((e): e is Extract<XmlEvent, { type: 'text' }> => e.type === 'text')
    expect(texts.map((t) => t.content)).toEqual(['hello'])
  })

  it('handles the body arriving in many small chunks', () => {
    const p = new XmlStreamParser()
    p.feed('<s>')
    const pieces = ['a', 'b', 'c', 'd', 'e']
    const collected: string[] = []
    for (const piece of pieces) {
      for (const event of p.feed(piece)) {
        if (event.type === 'text') collected.push(event.content)
      }
    }
    expect(collected).toEqual(pieces)

    const end = p.feed('</s>')
    const complete = end.find((e) => e.type === 'tag_complete') as Extract<
      XmlEvent,
      { type: 'tag_complete' }
    >
    expect(complete.content).toBe('abcde')
  })
})

describe('XmlStreamParser — failure modes', () => {
  it('emits tag_incomplete when the stream ends with an open tag', () => {
    const p = new XmlStreamParser()
    const events = feed(p, '<section type="hero">partial body never closed')
    const incomplete = events.find((e) => e.type === 'tag_incomplete') as Extract<
      XmlEvent,
      { type: 'tag_incomplete' }
    >
    expect(incomplete).toBeDefined()
    expect(incomplete.name).toBe('section')
    expect(incomplete.attrs).toEqual({ type: 'hero' })
    expect(incomplete.partial).toBe('partial body never closed')
  })

  it('ignores stray closing tags without a matching opener', () => {
    const p = new XmlStreamParser()
    const events = feed(p, 'text</unknown>more')
    // Should emit text only — no open/close for the stray.
    const tagEvents = events.filter((e) => e.type !== 'text')
    expect(tagEvents).toEqual([])
  })

  it('rejects tag names with invalid characters', () => {
    const p = new XmlStreamParser()
    const events = feed(p, '<<bad>body</<bad>>')
    // Nothing should open — malformed name → skipped.
    const opens = events.filter((e) => e.type === 'tag_open')
    expect(opens).toEqual([])
  })

  it('survives an empty feed', () => {
    const p = new XmlStreamParser()
    expect(p.feed('')).toEqual([])
    expect(p.finish()).toEqual([])
  })
})

describe('collectTags helper', () => {
  it('collects every matching tag_complete from an async stream', async () => {
    async function* stream(): AsyncGenerator<string> {
      yield '<section index="0">Hero</section>'
      yield '<section index="1">Featured</section>'
      yield '<meta name="ignored" />'
      yield '<section index="2">Footer</section>'
    }

    const sections = await collectTags(stream(), 'section')
    expect(sections).toEqual([
      { attrs: { index: '0' }, content: 'Hero' },
      { attrs: { index: '1' }, content: 'Featured' },
      { attrs: { index: '2' }, content: 'Footer' },
    ])
  })
})
