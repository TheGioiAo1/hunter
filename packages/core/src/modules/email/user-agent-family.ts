/**
 * Gbox Platform — User-Agent family reduction (Phase 14 PR5)
 *
 * Reduces a raw `User-Agent` HTTP header to a single family name so
 * `consent_events.user_agent_family` can be stored without leaking
 * version numbers, device names, or other re-identification vectors.
 *
 * Why family-only: GDPR Art. 5(1)(c) data minimization. We need to
 * prove "customer opted in via a Chrome browser" — we do NOT need
 * "Chrome 120.0.6099.235 on Windows 10.0.19044". The family is enough
 * evidence for the consent ledger; the version has no legal value and
 * is a fingerprint vector.
 *
 * Supported families (returned as lowercase strings):
 *   - 'chrome'    — incl. Chromium, Brave, Vivaldi (share the Chrome UA tail)
 *   - 'firefox'   — incl. Waterfox variants that advertise as Firefox
 *   - 'safari'    — WebKit-based Safari on macOS/iOS (NOT Chrome-on-iOS)
 *   - 'edge'      — Microsoft Edge (both Chromium + legacy EdgeHTML)
 *   - 'opera'     — Opera Desktop + Opera Mobile (share 'OPR/' token)
 *   - 'samsung'   — Samsung Internet browser
 *   - 'bot'       — search-engine crawlers + generic bots (Googlebot,
 *                   Bingbot, AhrefsBot, curl, wget, python-requests,
 *                   node-fetch, Postman, etc.)
 *   - 'other'     — anything we don't explicitly classify
 *   - null        — empty/missing input
 *
 * Order of checks matters: Edge's UA *contains* "Chrome" (it's Chromium-
 * based), so we check for "Edg/" or "Edge/" FIRST. Same for Opera
 * (contains "Chrome"), Samsung (contains "Chrome"), and Safari-vs-Chrome
 * (Chrome on iOS reports Safari).
 *
 * This is intentionally conservative: new browsers land in 'other' by
 * default rather than being silently misclassified.
 *
 * API contract
 * ------------
 * Pure function; no I/O, no dependencies. Importable from anywhere.
 * Safe to call with untrusted input — input is length-clamped to 500
 * chars before regex matches to avoid ReDoS.
 */

const MAX_INPUT_LEN = 500

export type UserAgentFamily =
  | 'chrome'
  | 'firefox'
  | 'safari'
  | 'edge'
  | 'opera'
  | 'samsung'
  | 'bot'
  | 'other'

/**
 * Return the user-agent family for a raw UA header string.
 *
 * @param ua  Raw `User-Agent` header value (any case). Accepts null/
 *            undefined/empty — returns null for those.
 */
export function userAgentFamily(
  ua: string | null | undefined,
): UserAgentFamily | null {
  if (ua == null) return null
  const trimmed = ua.trim()
  if (trimmed.length === 0) return null

  // Clamp to 500 chars before regex to avoid pathological inputs
  // causing quadratic backtracking in some engines.
  const clamped = trimmed.length > MAX_INPUT_LEN ? trimmed.slice(0, MAX_INPUT_LEN) : trimmed
  const lower = clamped.toLowerCase()

  // Bots first — they're the largest single class of traffic and
  // should never be classified as a real browser for consent audit.
  // `curl`, `wget`, `python-requests` etc. are library prefixes that
  // won't match the real-browser regexes below but we still want
  // 'bot' over 'other' for them.
  if (
    /\b(bot|crawler|spider|slurp|bingbot|googlebot|baiduspider|yandexbot|duckduckbot|applebot|semrushbot|ahrefsbot|mj12bot|dotbot|pingdom|uptimerobot|headlesschrome|phantomjs)\b/.test(lower) ||
    /^(curl|wget|python-requests|python-urllib|node-fetch|go-http-client|java|okhttp|axios|got|insomnia|postmanruntime)\b/.test(lower) ||
    /\b(facebookexternalhit|twitterbot|slackbot|discordbot|linkedinbot|whatsapp|telegrambot)\b/.test(lower)
  ) {
    return 'bot'
  }

  // Order matters. These checks share common tokens, so most specific
  // wins:
  //   - Edge and Opera UAs contain "Chrome" → check them before Chrome
  //   - Samsung Browser UA contains "Chrome" + "SamsungBrowser"
  //   - Chrome-on-iOS UA contains "Safari" → check "CriOS" first
  //   - Firefox-on-iOS UA contains "Safari" → check "FxiOS" first

  if (/\bedg(e|a|ios)?\//.test(lower)) return 'edge'
  if (/\bopr\//.test(lower) || /\bopera\//.test(lower)) return 'opera'
  if (/\bsamsungbrowser\//.test(lower)) return 'samsung'

  // Chrome on iOS is "CriOS", Firefox on iOS is "FxiOS" — both report
  // as Safari otherwise. Classify by the explicit iOS token.
  if (/\bcrios\//.test(lower)) return 'chrome'
  if (/\bfxios\//.test(lower)) return 'firefox'

  if (/\bfirefox\//.test(lower)) return 'firefox'
  if (/\bchrome\//.test(lower) || /\bchromium\//.test(lower)) return 'chrome'

  // Safari check must be AFTER all the "Chrome-but-also-contains-Safari"
  // checks above, because nearly every WebKit UA contains "Safari".
  if (/\bsafari\//.test(lower) && /\bversion\//.test(lower)) return 'safari'

  return 'other'
}
