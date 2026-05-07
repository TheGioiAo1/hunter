/**
 * Gbox Platform — String filter unit tests
 *
 * Decision #1 Step 1.4 — Exercises every Shopify-compatible string
 * filter registered via `registerStringFilters()`. Each case renders
 * a tiny Liquid template so we exercise the real registration path,
 * not just the helper functions directly. This guarantees the filter
 * shows up under the expected name in a live Liquid instance.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { Liquid } from 'liquidjs'
import { registerStringFilters } from './string.js'

let liquid: Liquid

beforeAll(() => {
  liquid = new Liquid({
    strictFilters: true,
    strictVariables: false,
    outputEscape: undefined, // tests check raw filter output
  })
  registerStringFilters(liquid)
})

async function render(tpl: string, ctx: Record<string, unknown> = {}): Promise<string> {
  return liquid.parseAndRender(tpl, ctx)
}

// ---------------------------------------------------------------------------
// Case-change filters
// ---------------------------------------------------------------------------

describe('string filters — case', () => {
  it('upcase', async () => {
    expect(await render('{{ "hello" | upcase }}')).toBe('HELLO')
  })
  it('downcase', async () => {
    expect(await render('{{ "HELLO" | downcase }}')).toBe('hello')
  })
  it('capitalize: first letter upper, rest unchanged', async () => {
    // Shopify quirk: does NOT lowercase the rest.
    expect(await render('{{ "hello WORLD" | capitalize }}')).toBe('Hello WORLD')
  })
  it('capitalize: empty string', async () => {
    expect(await render('{{ "" | capitalize }}')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// pluralize
// ---------------------------------------------------------------------------

describe('string filters — pluralize', () => {
  it('singular at count=1', async () => {
    expect(
      await render('{{ 1 | pluralize: "item", "items" }}'),
    ).toBe('item')
  })
  it('plural at count=0', async () => {
    expect(
      await render('{{ 0 | pluralize: "item", "items" }}'),
    ).toBe('items')
  })
  it('plural at count=5', async () => {
    expect(
      await render('{{ 5 | pluralize: "item", "items" }}'),
    ).toBe('items')
  })
})

// ---------------------------------------------------------------------------
// truncate / truncatewords
// ---------------------------------------------------------------------------

describe('string filters — truncate', () => {
  it('returns unchanged when shorter than limit', async () => {
    expect(
      await render('{{ "short" | truncate: 20 }}'),
    ).toBe('short')
  })
  it('truncates + adds ellipsis', async () => {
    expect(
      await render('{{ "one two three four five" | truncate: 10 }}'),
    ).toBe('one two...')
  })
  it('respects custom ellipsis', async () => {
    expect(
      await render('{{ "abcdefghij" | truncate: 8, "…" }}'),
    ).toBe('abcdefg…')
  })
  it('defaults to length 50', async () => {
    const s = 'x'.repeat(60)
    const out = await render(`{{ "${s}" | truncate }}`)
    expect(out.length).toBe(50)
    expect(out.endsWith('...')).toBe(true)
  })
})

describe('string filters — truncatewords', () => {
  it('keeps full string when word count ≤ n', async () => {
    expect(
      await render('{{ "one two three" | truncatewords: 5 }}'),
    ).toBe('one two three')
  })
  it('truncates at N words with ellipsis', async () => {
    expect(
      await render('{{ "one two three four five" | truncatewords: 2 }}'),
    ).toBe('one two...')
  })
  it('custom ellipsis', async () => {
    expect(
      await render('{{ "one two three four" | truncatewords: 2, " →" }}'),
    ).toBe('one two →')
  })
})

// ---------------------------------------------------------------------------
// strip / strip_html / strip_newlines / newline_to_br
// ---------------------------------------------------------------------------

describe('string filters — strip variants', () => {
  it('strip trims both ends', async () => {
    expect(await render('{{ "  hi  " | strip }}')).toBe('hi')
  })
  it('lstrip trims left', async () => {
    expect(await render('{{ "  hi  " | lstrip }}')).toBe('hi  ')
  })
  it('rstrip trims right', async () => {
    expect(await render('{{ "  hi  " | rstrip }}')).toBe('  hi')
  })
  it('strip_html removes tags', async () => {
    expect(
      await render('{{ "<p>Hello <b>world</b></p>" | strip_html }}'),
    ).toBe('Hello world')
  })
  it('strip_html removes script content', async () => {
    expect(
      await render('{{ "<script>alert(1)</script>safe" | strip_html }}'),
    ).toBe('safe')
  })
  it('strip_html removes style content', async () => {
    expect(
      await render('{{ "<style>body{}</style>text" | strip_html }}'),
    ).toBe('text')
  })
  it('strip_html removes comments', async () => {
    expect(
      await render('{{ "<!-- x -->y" | strip_html }}'),
    ).toBe('y')
  })
  it('strip_newlines removes \\r\\n', async () => {
    const tpl = `{% assign s = "a
b
c" %}{{ s | strip_newlines }}`
    expect(await render(tpl)).toBe('abc')
  })
  it('newline_to_br inserts <br />', async () => {
    const tpl = `{% assign s = "a
b" %}{{ s | newline_to_br }}`
    expect(await render(tpl)).toBe('a<br />b')
  })
})

// ---------------------------------------------------------------------------
// replace family
// ---------------------------------------------------------------------------

describe('string filters — replace family', () => {
  it('replace substitutes all', async () => {
    expect(
      await render('{{ "a-b-c" | replace: "-", "_" }}'),
    ).toBe('a_b_c')
  })
  it('replace_first only first occurrence', async () => {
    expect(
      await render('{{ "a-b-c" | replace_first: "-", "_" }}'),
    ).toBe('a_b-c')
  })
  it('remove deletes all', async () => {
    expect(
      await render('{{ "hello world" | remove: "l" }}'),
    ).toBe('heo word')
  })
  it('remove_first deletes first only', async () => {
    expect(
      await render('{{ "hello world" | remove_first: "l" }}'),
    ).toBe('helo world')
  })
  it('append', async () => {
    expect(await render('{{ "foo" | append: ".liquid" }}')).toBe('foo.liquid')
  })
  it('prepend', async () => {
    expect(await render('{{ "name" | prepend: "Hello, " }}')).toBe('Hello, name')
  })
})

// ---------------------------------------------------------------------------
// escape family
// ---------------------------------------------------------------------------

describe('string filters — escape', () => {
  it('escape encodes XML entities', async () => {
    expect(
      await render('{{ \'<a href="x">Tom & Jerry</a>\' | escape }}'),
    ).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;')
  })
  it('h is an alias for escape', async () => {
    expect(await render('{{ "<b>" | h }}')).toBe('&lt;b&gt;')
  })
  it('escape_once does not double-escape existing entities', async () => {
    expect(
      await render('{{ "a & b &amp; c" | escape_once }}'),
    ).toBe('a &amp; b &amp; c')
  })
})

// ---------------------------------------------------------------------------
// handle / handleize
// ---------------------------------------------------------------------------

describe('string filters — handle/handleize', () => {
  it('handle lowercases and hyphenates', async () => {
    expect(await render('{{ "Hello World!" | handle }}')).toBe('hello-world')
  })
  it('handleize is an alias', async () => {
    expect(
      await render('{{ "Pro T-Shirt (2024)" | handleize }}'),
    ).toBe('pro-t-shirt-2024')
  })
  it('trims leading/trailing hyphens', async () => {
    expect(await render('{{ "!!hello!!" | handle }}')).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// Hash + encoding
// ---------------------------------------------------------------------------

describe('string filters — hashes & encodings', () => {
  it('md5', async () => {
    // Known: md5("abc") = 900150983cd24fb0d6963f7d28e17f72
    expect(await render('{{ "abc" | md5 }}')).toBe('900150983cd24fb0d6963f7d28e17f72')
  })
  it('sha1', async () => {
    expect(
      await render('{{ "abc" | sha1 }}'),
    ).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
  })
  it('sha256', async () => {
    expect(
      await render('{{ "abc" | sha256 }}'),
    ).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('base64_encode + base64_decode round-trip', async () => {
    expect(await render('{{ "hello" | base64_encode }}')).toBe('aGVsbG8=')
    expect(await render('{{ "aGVsbG8=" | base64_decode }}')).toBe('hello')
  })
  it('base64_url_safe_encode', async () => {
    // `?>?` → base64 `Pz4/` → url-safe `Pz4_`
    expect(
      await render('{{ "?>?" | base64_url_safe_encode }}'),
    ).toBe('Pz4_')
  })
  it('base64_url_safe_decode', async () => {
    expect(
      await render('{{ "Pz4_" | base64_url_safe_decode }}'),
    ).toBe('?>?')
  })
})

// ---------------------------------------------------------------------------
// default
// ---------------------------------------------------------------------------

describe('string filters — default', () => {
  it('fires on null', async () => {
    expect(
      await render('{{ missing | default: "fallback" }}'),
    ).toBe('fallback')
  })
  it('fires on empty string', async () => {
    expect(
      await render('{{ "" | default: "fallback" }}'),
    ).toBe('fallback')
  })
  it('fires on empty array', async () => {
    expect(
      await render('{{ arr | default: "fallback" }}', { arr: [] }),
    ).toBe('fallback')
  })
  it('does NOT fire on 0', async () => {
    expect(
      await render('{{ 0 | default: "fallback" }}'),
    ).toBe('0')
  })
  it('does NOT fire on "0" string', async () => {
    expect(
      await render('{{ "0" | default: "fallback" }}'),
    ).toBe('0')
  })
  it('does NOT fire on non-empty value', async () => {
    expect(
      await render('{{ "real" | default: "fallback" }}'),
    ).toBe('real')
  })
})
