/**
 * Gbox Platform — canned-reply-render.ts unit tests.
 *
 * Pins:
 *   - `{{object.path}}` tokens resolve from the context bag
 *   - unknown object → token left intact + warning
 *   - missing value   → token left intact + warning
 *   - case-insensitive token matching (spec §4.4)
 *   - whitespace around tokens preserved + allowed inside braces
 *   - non-token text passes through unchanged
 */
import { describe, it, expect } from 'vitest'
import { renderCannedReply, type CannedReplyContext } from './canned-reply-render.ts'

const ctx: CannedReplyContext = {
  seller: { display_name: 'Thai', first_name: 'Thai', last_name: 'Bui', email: 't@gbox.co' },
  shop: { name: 'My Shop', slug: 'my-shop' },
  ticket: { subject: 'Refund', id: 't-42', category: 'refund', priority: 'high' },
  agent: { display_name: 'Minh' },
}

describe('renderCannedReply', () => {
  it('substitutes a single token', () => {
    const { body, warnings } = renderCannedReply('Hi {{seller.display_name}}', ctx)
    expect(body).toBe('Hi Thai')
    expect(warnings).toEqual([])
  })

  it('substitutes multiple tokens', () => {
    const out = renderCannedReply(
      'Hi {{seller.display_name}}, about ticket "{{ticket.subject}}" from {{shop.name}}.',
      ctx,
    )
    expect(out.body).toBe('Hi Thai, about ticket "Refund" from My Shop.')
    expect(out.warnings).toEqual([])
  })

  it('allows whitespace inside the braces', () => {
    const { body } = renderCannedReply('Hi {{ seller.display_name }}', ctx)
    expect(body).toBe('Hi Thai')
  })

  it('is case-insensitive on token keys', () => {
    const { body } = renderCannedReply('Hi {{Seller.Display_Name}}', ctx)
    expect(body).toBe('Hi Thai')
  })

  it('leaves unknown objects intact + warns', () => {
    const { body, warnings } = renderCannedReply('Hello {{unknown.field}}', ctx)
    expect(body).toBe('Hello {{unknown.field}}')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/unknown object 'unknown'/)
  })

  it('leaves missing values intact + warns', () => {
    const partial: CannedReplyContext = { seller: { display_name: null } }
    const { body, warnings } = renderCannedReply('Hi {{seller.display_name}}', partial)
    expect(body).toBe('Hi {{seller.display_name}}')
    expect(warnings[0]).toMatch(/missing value 'seller.display_name'/)
  })

  it('treats undefined values as missing', () => {
    const partial: CannedReplyContext = { seller: {} }
    const { warnings } = renderCannedReply('Hi {{seller.first_name}}', partial)
    expect(warnings).toHaveLength(1)
  })

  it('passes non-token text through unchanged', () => {
    const out = renderCannedReply('No tokens here. Just prose.', ctx)
    expect(out.body).toBe('No tokens here. Just prose.')
    expect(out.warnings).toEqual([])
  })

  it('does not evaluate single-brace text', () => {
    const out = renderCannedReply('{seller.display_name} is a literal', ctx)
    expect(out.body).toBe('{seller.display_name} is a literal')
  })

  it('does not evaluate tokens with nested paths (only one level)', () => {
    // Deep paths aren't supported — the token is left intact as an "unknown" warning.
    const out = renderCannedReply('{{seller.address.city}}', ctx)
    expect(out.body).toBe('{{seller.address.city}}')
  })

  it('does not recurse: a substituted {{…}} in the value stays literal', () => {
    const spicy: CannedReplyContext = {
      seller: { display_name: '{{shop.name}}' },
    }
    const out = renderCannedReply('Hi {{seller.display_name}}', spicy)
    // Output contains the raw template text; not re-parsed.
    expect(out.body).toBe('Hi {{shop.name}}')
    expect(out.warnings).toEqual([])
  })

  it('collects multiple warnings for multiple bad tokens', () => {
    const out = renderCannedReply('{{foo.bar}} and {{baz.qux}}', ctx)
    expect(out.warnings).toHaveLength(2)
  })
})
