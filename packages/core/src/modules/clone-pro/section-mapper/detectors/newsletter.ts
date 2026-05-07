/**
 * Newsletter-signup detector.
 *
 * Recognised by a form containing an <input type="email"> — almost
 * universal across e-commerce homepages. Secondary signals:
 *
 *   - class contains 'newsletter', 'subscribe', 'signup', 'mailing',
 *     'email-signup', 'footer-signup'
 *   - <form action> contains 'contact', 'subscribe', 'newsletter', or
 *     'klaviyo' / 'mailchimp' domain hints
 *
 * We deliberately pick the FIRST matching form — there's rarely more
 * than one, and if there are two (page-level + footer-level), the
 * page-level one wins because it iterates first.
 *
 * Extracted settings (Gbox Dawn's `newsletter` schema):
 *   - heading    → nearest h2/h3 above/inside the form's block
 *   - subheading → first <p> inside the form's block
 */

import type { DetectedSection } from '../types.js'
import {
  cleanText,
  iterateBlocks,
  makeDetectedSection,
  type DetectorContext,
} from './shared.js'

const NEWSLETTER_CLASS_RE =
  /\b(newsletter|subscribe|signup|mailing|email-signup|footer-signup|email-capture)\b/i

const NEWSLETTER_ACTION_HINT_RE = /(newsletter|subscribe|contact|klaviyo|mailchimp|mc\.us|mailerlite)/i

export function detectNewsletter(ctx: DetectorContext): DetectedSection | null {
  const { $ } = ctx
  const blocks = iterateBlocks($)

  for (const { index, el } of blocks) {
    const candidate = findNewsletterCandidate($, el)
    if (candidate) return extract(candidate, index)
  }

  // Fallback: any <form> at document level with an email input. Don't
  // assign a `position` for this — it's unlikely to be in the main flow.
  const fallback = $('form').filter((_, form) => {
    const $f = $(form)
    return $f.find('input[type="email"]').length > 0
  }).first()
  if (fallback.length > 0) {
    const block = fallback.closest('section, div, aside, footer')
    return extract(block.length > 0 ? block : fallback, Number.MAX_SAFE_INTEGER)
  }

  return null
}

// ---------------------------------------------------------------------------
// Candidate detection
// ---------------------------------------------------------------------------

function findNewsletterCandidate(
  $: ReturnType<typeof iterateBlocks>[number]['el']['find'] extends (...args: any[]) => any
    ? DetectorContext['$']
    : DetectorContext['$'],
  el: ReturnType<DetectorContext['$']>,
): ReturnType<DetectorContext['$']> | null {
  // Direct class hit on the block.
  const ownClass = el.attr('class') || ''
  if (NEWSLETTER_CLASS_RE.test(ownClass) && el.find('input[type="email"]').length > 0) {
    return el
  }

  // Descendant with a newsletter class + email input.
  const inner = el
    .find('[class]')
    .filter((_, node) => {
      const cls = $(node).attr('class') || ''
      if (!NEWSLETTER_CLASS_RE.test(cls)) return false
      return $(node).find('input[type="email"]').length > 0
    })
    .first()
  if (inner.length > 0) return inner

  // Form-action hint.
  const hinted = el
    .find('form[action]')
    .filter((_, form) => {
      const $f = $(form)
      if ($f.find('input[type="email"]').length === 0) return false
      const action = ($f.attr('action') || '').toLowerCase()
      return NEWSLETTER_ACTION_HINT_RE.test(action)
    })
    .first()
  if (hinted.length > 0) {
    const wrapper = hinted.closest('section, div, aside')
    return wrapper.length > 0 ? wrapper : hinted
  }

  // Plain email form anywhere inside the block.
  if (el.find('form input[type="email"]').length > 0) {
    return el
  }

  return null
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extract(
  el: ReturnType<DetectorContext['$']>,
  position: number,
): DetectedSection {
  let heading = cleanText(el.find('h2, h3').first().text())
  if (!heading) heading = cleanText(el.find('h4, h5').first().text())

  let subheading = cleanText(el.find('p').first().text())
  // Avoid using the submit-success message as a subheading.
  if (/success|subscrib|thank/i.test(subheading)) subheading = ''

  const settings: Record<string, string | number | boolean> = {
    heading: heading || 'Subscribe',
  }
  if (subheading) settings.subheading = subheading

  return makeDetectedSection('newsletter', position, settings)
}
