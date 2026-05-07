/**
 * Unit tests — platform_alert_recipients input validation (Phase 14 PR6).
 *
 * The `updateRecipient()` function has two pre-DB guards (invalid
 * alert_type + empty email) that need to fail loudly before they
 * reach Postgres and trigger a confusing CHECK violation. Those
 * guards are worth unit-testing because a god-admin UI bug that
 * sends malformed input should surface cleanly instead of spewing
 * SQL errors.
 *
 * DB-level behaviour (the actual UPDATE + RETURNING) is covered in
 * the end-to-end smoke — `scripts/smoke-phase14-pr6.ts`.
 */

import { describe, it, expect } from 'vitest'
import { updateRecipient } from './recipients.js'

describe('updateRecipient — input validation', () => {
  // We pass an intentionally minimal fake db — the guards fire before
  // any DB call, so the fake should never be exercised.
  const fakeDb = {
    updateTable() {
      throw new Error('should not reach DB')
    },
  } as never

  it('throws on unknown alert_type', async () => {
    await expect(
      updateRecipient(fakeDb, {
        alertType: 'not_a_real_alert' as never,
        recipientEmail: 'alerts@gbox.co',
      }),
    ).rejects.toThrow(/Invalid alert_type/)
  })

  it('throws on empty recipient_email', async () => {
    await expect(
      updateRecipient(fakeDb, {
        alertType: 'platform_incident_alert',
        recipientEmail: '',
      }),
    ).rejects.toThrow(/recipient_email cannot be empty/)
  })

  it('throws on whitespace-only recipient_email', async () => {
    await expect(
      updateRecipient(fakeDb, {
        alertType: 'platform_incident_alert',
        recipientEmail: '   ',
      }),
    ).rejects.toThrow(/recipient_email cannot be empty/)
  })
})
