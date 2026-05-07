/**
 * Gbox Platform — Support staff module public surface.
 *
 * Everything the supporter.gbox.co app (`apps/supporter`) and the
 * god-admin invite flow need, re-exported behind one barrel.
 */

// Preset catalog + 2FA mode resolver.
export {
  ALL_SCOPES,
  PERMISSION_MATRIX,
  PRESET_LABEL,
  twoFaMode,
  type SupportPermissionScope,
} from './presets.ts'

// Permission checks + Express middleware.
export {
  canStaff,
  hasAnyPermission,
  hasPermission,
  requireSupportPermission,
  type DenyLogger,
  type MinimalExpressReq,
  type MinimalExpressRes,
  type StaffRequestUser,
} from './permissions.ts'

// Invitation lifecycle.
export {
  INVITE_TOKEN_BYTES,
  INVITE_TTL_MS,
  acceptInvitation,
  createInvitation,
  expirePendingInvitations,
  findValidInvitation,
  generateInviteToken,
  hashToken,
  listInvitations,
  normalizeEmail,
  revokeInvitation,
  validateCreateInvitation,
  type CreateInvitationError,
  type CreateInvitationInput,
  type CreateInvitationResult,
  type InvitationRow,
} from './invitations.ts'

// Audit log (writer + reader).
export {
  countDeniesSince,
  listAuditRows,
  logPermissionDenied,
  logStaffAction,
  type AuditRow,
  type StaffActionEvent,
  type SupportAuditAction,
} from './audit-log.ts'
