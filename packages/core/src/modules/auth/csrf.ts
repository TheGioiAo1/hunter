/**
 * Gbox Platform — CSRF Protection Module
 *
 * Token-based CSRF protection using SHA-256 hash pairs.
 * Per IRON RULE #1: CSRF tokens on ALL forms.
 *
 * Usage:
 *   1. On session init: call generateCSRFPair(), store `secret` in session,
 *      send `token` to client (hidden form field or meta tag).
 *   2. On form submit: call validateCSRF(submittedToken, sessionSecret).
 */

import { randomBytes, createHash, timingSafeEqual } from "crypto";

/**
 * Generate a CSRF token derived from a session ID.
 * Useful when you want a token bound to the current session.
 */
export function generateCSRFToken(sessionId: string): string {
  const random = randomBytes(32).toString("hex");
  const token = createHash("sha256")
    .update(sessionId + random)
    .digest("hex");
  return token;
}

/**
 * Generate a matched CSRF pair (token + secret).
 *
 * - Store `secret` server-side (session/cookie).
 * - Send `token` to the client (form field / header).
 * - On submit, call `validateCSRF(token, secret)`.
 */
export function generateCSRFPair(): { token: string; secret: string } {
  const secret = randomBytes(32).toString("hex");
  const token = createHash("sha256").update(secret).digest("hex");
  return { token, secret };
}

/**
 * Validate a submitted CSRF token against the stored secret.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateCSRF(token: string, secret: string): boolean {
  if (!token || !secret) return false;
  const expected = createHash("sha256").update(secret).digest("hex");
  // Timing-safe comparison
  try {
    const tokenBuf = Buffer.from(token, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (tokenBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(tokenBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Generate an HTML hidden input element for embedding a CSRF token in forms.
 */
export function csrfHiddenField(token: string): string {
  // Escape the token value to prevent XSS via token injection
  const escaped = token.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[ch] ?? ch;
  });
  return `<input type="hidden" name="_csrf" value="${escaped}">`;
}
