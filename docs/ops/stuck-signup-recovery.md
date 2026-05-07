# Stuck Signup Recovery Runbook

**Filed:** 2026-04-24
**Status:** Canonical runbook (Phase 14 PR8 post-mortem artefact)
**Audience:** Gbox support + platform oncall. Platform-internal only
(Iron Rule 5 — never quote any path from this file back to a seller).
**Triggering case:** user `lamdiepanh1903@gmail.com` — signup submitted
pre-PR8, OTP email never left the box, user now wedged.

---

## Symptoms

A seller reports one of:

- "I signed up but never got my verification email."
- "When I try to sign up again it says my email is already used."
- "The resend button doesn't work / I don't see the verify page."

What's happening under the hood:

1. `POST /accounts/signup` created a `users` row with
   `status='pending_verification'` and saved an OTP hash to
   `password_reset_token` / `password_reset_expires`.
2. Something went wrong with OTP delivery (old bug cluster A — HTTP
   shim silently dropped; new bug 6/7 would instead mark
   `email_deliveries.status='failed'` loudly).
3. OTP hash expired after 10 min (`OTP_EXPIRY_MS` in
   `packages/core/src/modules/auth/otp.ts`). The `users` row is still
   `pending_verification`.
4. Seller tries to re-signup → server.ts line 377 hits "email already
   exists" branch (`res.status(409)`), which **does not differentiate
   `pending_verification` from `active`**. So the user can't self-serve.
5. Seller tries "resend OTP" → that path requires the `gbox_verify`
   cookie set in step 1 of the original signup. Expired (short TTL).

The user is wedged. They need ops to either unstick the row or
self-serve an alternate path.

## Decision tree

```
Seller opened a support ticket
           │
           ▼
Is the seller's identity verified beyond reasonable doubt?
(matched Gbox deal contact / known domain / referral code)
           │
     ┌─────┴─────┐
     │ no        │ yes
     ▼           ▼
  Option A    Does the seller want to change their email?
  (delete        │
   pending)   ┌──┴──┐
              │ yes │ no
              ▼     ▼
          Option A  Option C (preferred)
                    (re-issue OTP, same email)
```

- **Option A — delete pending row.** Safe default. Works without
  identity verification. Seller resubmits signup from scratch.
- **Option B — manual activate.** Skips email verification.
  **Requires** strong identity verification. Audit-logged.
- **Option C — re-issue OTP.** Preserves account and audit trail.
  Requires a working email path (post-PR8 this is the happy path).

All three options produce an `audit_logs` entry so a future auditor
can reconstruct what ops did.

> **Schema note.** The audit table is `audit_logs` (plural). Columns
> used below: `action` (text), `user_id`, `resource_type`,
> `resource_id`, `details` (jsonb), `ip_address`. No CHECK constraint
> on `action`, but the `AuditAction` TS union in
> `packages/core/src/modules/auth/audit.ts` is the source of truth —
> add any new strings used here to that union in a follow-up PR so
> type-safe callers can emit them.

---

## Pre-work (run first for every ticket)

All SQL runs against `gbox_platform` on server 1 (`192.168.1.13`). Use
the `gbox` role. Substitute the reported email address for the
`<EMAIL>` placeholder.

```sql
-- 1. Inspect the pending user
SELECT id, email, status, created_at,
       password_reset_expires AS otp_expires_at,
       (password_reset_expires IS NOT NULL) AS has_pending_otp
FROM   users
WHERE  email = '<EMAIL>';

-- 2. Inspect recent delivery attempts for that address
SELECT id, template_key, status, failed_reason,
       smtp_message_id, created_at, sent_at
FROM   email_deliveries
WHERE  recipient_email = '<EMAIL>'
ORDER  BY created_at DESC
LIMIT  10;

-- 3. Confirm the user has not already created any stores / sessions
--    (sanity check — a user past verify won't land here but cheap
--    insurance)
SELECT COUNT(*) AS shop_count
FROM   shops s
JOIN   user_shops us ON us.shop_id = s.id
WHERE  us.user_id = (SELECT id FROM users WHERE email = '<EMAIL>');
```

Expected for a wedged signup:
- `users.status = 'pending_verification'`.
- `email_deliveries` — either **zero** rows (pre-PR8 shim silently
  dropped before the insert ever happened) or rows with
  `status='failed'` / `status='queued'` past the 10-min zombie grace.
- `shop_count = 0`.

If `shop_count > 0` or `status != 'pending_verification'` — **stop,
escalate to Thai.** You're looking at a different bug than this
runbook covers.

---

## Option A — Delete the pending row (default)

Lets the seller redo signup from scratch. Idempotent and blameless.

```sql
-- Dry-run: confirm exactly one row will go
SELECT id, email, status, created_at
FROM   users
WHERE  email = '<EMAIL>'
  AND  status = 'pending_verification';
-- expect: exactly 1 row, status=pending_verification

-- Actual delete, wrapped in a transaction so you can ROLLBACK if the
-- select didn't match
BEGIN;

-- Capture the victim id first so the audit row references it by UUID
-- even though the user row itself is about to go.
WITH victim AS (
  SELECT id
  FROM   users
  WHERE  email = '<EMAIL>'
    AND  status = 'pending_verification'
)
INSERT INTO audit_logs (action, user_id, resource_type, resource_id, details)
SELECT 'support_deleted_pending_signup',
       victim.id,
       'auth',
       victim.id,
       jsonb_build_object(
         'reason',   'stuck OTP — PR8 post-mortem cluster A',
         'operator', current_user,
         'ticket',   '<TICKET-ID>',
         'email',    '<EMAIL>'
       )
FROM victim;
-- expect: INSERT 0 1

DELETE FROM users
 WHERE email = '<EMAIL>'
   AND status = 'pending_verification'
 RETURNING id, email;
-- expect: exactly 1 row returned

COMMIT;
```

> **`audit_logs.action` vocabulary.** `support_deleted_pending_signup`
> is a new string. The DB has no CHECK on `action` (Phase 0 audit
> module keeps it open), but the Phase 4 CRM admin UI filters by
> known values. Add this + the other `support_*` strings below to the
> `AuditAction` TS union in `packages/core/src/modules/auth/audit.ts`
> in a follow-up PR if ops uses Options A/B/C more than twice a
> quarter.

Tell the seller (Iron Rule 5 safe copy):

> We've cleared the incomplete signup attempt on our side. Please
> visit `accounts.gbox.co/signup` and create the account again — you
> should receive a fresh verification code within a minute. If the
> code still doesn't arrive please contact Gbox support with the
> ticket ID above.

**Do not** say "your account was in a bad state" or "a bug prevented
email delivery" — that leaks architecture and undermines trust.

---

## Option B — Manual activation (identity-verified only)

Use only when the seller has been identity-verified through another
channel AND you cannot afford to make them redo signup (e.g. they're
a deal contact, or post-deal onboarding). Skips OTP entirely.

```sql
BEGIN;

-- Note: the merchant `users` table does NOT have an `email_verified_at`
-- column (that lives on the storefront `customers` table — different
-- auth model). For the merchant table the verified state is encoded as
-- `status='active' AND password_reset_token IS NULL`, which is exactly
-- what the OTP-verify path sets via `auth/otp.ts::verifyOTP()`.
UPDATE users
   SET status = 'active',
       password_reset_token = NULL,
       password_reset_expires = NULL
 WHERE email = '<EMAIL>'
   AND status = 'pending_verification'
 RETURNING id, email, status;
-- expect: exactly 1 row

INSERT INTO audit_logs (action, user_id, resource_type, resource_id, details)
SELECT 'support_manual_activation',
       id,
       'auth',
       id,
       jsonb_build_object(
         'reason',   'identity-verified out-of-band, skipping OTP',
         'operator', current_user,
         'ticket',   '<TICKET-ID>',
         'verification_method', '<deal-contact|referral|phone>',
         'email',    '<EMAIL>'
       )
FROM users WHERE email = '<EMAIL>';

COMMIT;
```

Follow-up manual step: the signup flow redirects the user to
`STORE_ADMIN_BASE_URL/stores` AFTER OTP verify. Because you skipped
verify, the user still needs a login. They should go to
`accounts.gbox.co/login` with their original password.

If they forgot the password during the stuck period, run the password
reset through the normal `/forgot-password` flow — which now also
goes through the PR8 in-process email stack, so confirm
`email_deliveries` shows a `status='sent'` row for
`template_key='customer_password_reset'`.

---

## Option C — Re-issue OTP (preferred when email path is verified green)

Keeps the original `users` row and audit lineage. Generates a fresh
OTP, saves the hash, and fires the signup template through the
current (PR8) email stack.

Run via a one-off `tsx` script — **do not** paste OTP values into
SQL. The OTP is plaintext on the wire; put it on the user's screen
via the email, not into shell history.

```bash
# On server 1, as the gbox pm2 user:
cd /path/to/gbox-platform
npx tsx scripts/support/reissue-signup-otp.ts --email '<EMAIL>' --ticket '<TICKET-ID>'
```

> **Script does not yet exist.** This runbook documents the
> *intended* tool. For the `lamdiepanh1903@gmail.com` case, prefer
> Option A. If Option C demand climbs, land
> `scripts/support/reissue-signup-otp.ts` in a tiny PR — it should:
> 1. Select the user row, assert `status='pending_verification'`.
> 2. Call `generateOTP()` + `saveOTP(db, userId, otp)`.
> 3. Call `sendSignupOtpEmail(db, { email, otp, userId })`.
> 4. Refuse to proceed if the previous `email_deliveries` row for
>    that address in the last hour is `status='failed'` with
>    `failed_reason` matching the bug-7 transport-misconfig pattern —
>    that's an infra problem (Option A won't help either; fix SMTP
>    creds first).
> 5. Emit `audit_log` entry `support_reissued_signup_otp`.

Until the script lands, do Option C by hand in a `tsx repl`, making
sure to run it FROM inside `apps/accounts` so the core email module
resolves the same way it does at runtime.

---

## After the fix — verify and follow up

Whichever option you used:

```sql
-- 1. Row state matches intent
SELECT id, email, status,
       password_reset_expires IS NOT NULL AS has_otp,
       email_verified_at
FROM   users
WHERE  email = '<EMAIL>';

-- 2. audit_logs recorded the action
SELECT created_at, action, details->>'operator' AS operator,
       details->>'ticket' AS ticket
FROM   audit_logs
WHERE  action LIKE 'support_%'
ORDER  BY created_at DESC
LIMIT  5;
```

Close the support ticket with the Iron Rule 5-safe message from the
relevant option above. **Do not** forward any of the SQL / internal
event names to the seller.

## Preventing recurrence

This kind of ticket should be vanishingly rare post-PR8:

- Bug 6 makes silent ConsoleTransport fallback impossible in prod —
  missing SMTP creds throw at boot.
- Bug 7 surfaces transport-resolution errors into
  `email_deliveries.failed_reason` so ops can see them in a SQL query.
- Bug 8 stops the idempotency fast-path from pretending an old
  `failed` send was a fresh success.
- Bug 9 sweeps zombie `queued` rows every 5 min and marks them
  `failed` with a searchable reason string.

If this runbook fires more than once a month, treat it as a bug, not a
support ticket — there's an upstream regression.

## Cross-references

- Signup flow: `apps/accounts/src/pages/signup.ts` (`postSignup`).
- OTP module: `packages/core/src/modules/auth/otp.ts` (10-min TTL).
- Signup email helper: `apps/accounts/src/lib/send-signup-otp.ts`.
- Email delivery audit table: migration 083 (`email_deliveries`).
- Audit log schema: `audit_logs` (Phase 0, extended in migration 052
  for Phase 9.1 agent attribution).
- Accounts service deployment: `docs/ops/accounts-service-deployment.md`.
