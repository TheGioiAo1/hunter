/**
 * Gbox Platform — Customer auth barrel.
 *
 * Routes import { issueLoginCode, verifyMagicLink, verifyOtpCode,
 * revokeSession } from this module. The middleware is consumed
 * separately as `customerAuth({ db })`.
 */

export {
  CUSTOMER_COOKIE_NAME,
  SESSION_TTL_DAYS,
  MAGIC_LINK_TTL_MINUTES,
  OTP_TTL_MINUTES,
  MAX_OTP_ATTEMPTS,
  CustomerAuthError,
  issueLoginCode,
  verifyMagicLink,
  verifyOtpCode,
  getSessionByToken,
  revokeSession,
  revokeAllSessions,
  type IssueCodeResult,
  type VerifyResult,
  type CustomerSessionInfo,
} from './service.js'

export {
  customerAuth,
  buildCustomerCookieOptions,
} from './middleware.js'
