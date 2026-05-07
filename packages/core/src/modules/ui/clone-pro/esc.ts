/**
 * esc — shared HTML-escape helper used by every clone-pro UI
 * component. Replaces the five structural characters with their
 * named entities so untrusted props (store URLs, error messages,
 * section IDs, CSRF tokens) never break attribute boundaries or
 * introduce tags.
 *
 * Null / undefined collapse to the empty string so callers don't
 * have to guard upstream.
 */
export function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] as string,
  )
}
