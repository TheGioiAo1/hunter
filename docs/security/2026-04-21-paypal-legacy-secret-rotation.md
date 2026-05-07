# Security Remediation: Legacy PayPal Secret Rotation

**Filed:** 2026-04-21  
**Severity:** HIGH (pre-beta blocker)  
**Owner action required:** Thai Bui — rotate via PayPal Partner Portal  
**Status:** OPEN — awaiting owner rotation

---

## What we found

The legacy Woo plugin repo `gbox-paypal` (sibling to `gbox-platform`, not
part of this monorepo) commits a live PayPal Partner client secret in
plaintext at:

- **File:** `includes/helpers.php`  
- **Lines 12–14:** live-endpoint credentials (`api.paypal.com`) — active
- **Lines 6–10:** sandbox credentials — commented out but also in git history

Both secrets should be treated as **permanently burned** — any checkout
of that repo by anyone with clone access has the live secret. We do NOT
reproduce the secret value in this document (to avoid spreading it
further); reference it only by file + line.

The exposed material is specifically:

- `MY_PAYPAL_CLIENT_ID` — public half, OK to keep
- `MY_PAYPAL_SECRET` — the Basic-auth secret used for `/v1/oauth2/token`
  exchange. **This is the credential that must rotate.**
- `MY_PAYPAL_PARTNER_ID = 'LNMXG2LZD6362'` — public identifier, OK
- `MY_PAYPAL_BN_CODE = 'Gbox_Ecom'` — public attribution code, OK

Only the secret on line 13 actively authenticates against
`api.paypal.com`. Everything else is public metadata.

## Why this matters for the Phase 12 beta

Phase 12 makes PayPal Partner Platform the **only** payment gateway for
beta merchants (spec §decision-locked-2026-04-21). The backend uses the
same Partner credentials as the legacy plugin to create Orders v2 +
Refunds v2 calls on behalf of every connected merchant. If the burned
secret is used to mint a rogue access token, an attacker could:

1. Enumerate connected merchants via `/v1/customer/partners/.../merchant-integrations`.
2. Capture + refund orders they didn't create (refund is idempotency-key-
   guarded on our side but PayPal honors the API call regardless).
3. Drain the webhook verification endpoint by minting fake webhooks
   signed with our PayPal-issued certificate.

Before opening beta to 5K-10K sellers, the credential must be rotated
and the new value must never touch source control.

## Rotation procedure (owner)

1. Log in to <https://www.paypal.com/bizsignup/partner/entry> as
   buithai3107@gmail.com.
2. Navigate **My Apps & Credentials** → the Gbox Partner app (the one
   bound to Partner ID `LNMXG2LZD6362`).
3. Click **Manage** → **Secrets** → **Generate new secret**. PayPal
   keeps the old secret valid for 24h so you can redeploy without
   downtime.
4. Copy the new 80-char secret ONCE (PayPal only shows it at generation).
5. Stash it in `~/.gbox-deploy.env` on the deploy host (chmod 600) as:
   ```
   PAYPAL_PARTNER_SECRET=<new-80-char-secret>
   ```
6. Redeploy server 1 (main API) via
   `scripts/deploy/deploy-production.sh --update` — `ecosystem.config.cjs`
   picks up the env var on PM2 reload.
7. Return to the PayPal dashboard and **revoke** the old secret. Access
   tokens issued under the old secret invalidate within 9 hours per
   PayPal docs.
8. Monitor `/var/log/pm2/gbox-api-error.log` on server 1 for
   `PayPal token error` entries for ~24h; none expected post-rotation.

## Why the platform (TS port) is already safe

The new TypeScript partner module at
`packages/core/src/modules/payments/paypal-partner/config.ts` reads
credentials exclusively from env vars:

```ts
export function getPayPalPartnerConfig(): PartnerConfig {
  const clientId = process.env.PAYPAL_PARTNER_CLIENT_ID
  const secret = process.env.PAYPAL_PARTNER_SECRET
  if (!clientId || !secret) throw new Error('PayPal Partner not configured')
  ...
}
```

Plus `.env.example` ships with those vars **empty** (the values must be
filled in per environment), so the platform itself does not carry the
secret in git. The remediation surface is strictly the legacy Woo repo
+ any deploy host where the secret was previously written by hand.

## Things to NOT do

- **Do NOT `git filter-branch` the legacy repo to "remove" the secret.**
  History rewrites don't erase clones; the secret is burned the moment
  it was pushed. Rotation at PayPal is the only effective control.
- **Do NOT paste the new secret into this document or any chat message.**
  Treat it like a cold-wallet seed phrase: PayPal Portal → deploy host
  env file, nowhere else.
- **Do NOT reuse the old secret in any tooling** (even "just for
  staging"). PayPal recycles secret IDs; a burned secret stays burned.

## Post-rotation verification

After the new secret is in `~/.gbox-deploy.env` and server 1 has been
reloaded, run from a dev box (or server 2):

```bash
curl -v https://api.paypal.com/v1/oauth2/token \
  -u "$PAYPAL_PARTNER_CLIENT_ID:$PAYPAL_PARTNER_SECRET" \
  -d grant_type=client_credentials
```

A fresh 200 with a `Bearer` token proves the new credentials are live.
Then:

```bash
curl -v https://api.paypal.com/v1/oauth2/token \
  -u "$PAYPAL_PARTNER_CLIENT_ID:$OLD_BURNED_SECRET" \
  -d grant_type=client_credentials
```

Should return `401 invalid_client` after PayPal's revoke propagates
(within 9h). Only once that second curl returns 401 is the rotation
complete.

## Tracking

- Flagged in Sprint 0 pre-beta hardening run, 2026-04-21.
- Not blocking for code merge of Sprint 0 fixes (platform doesn't
  carry the secret) — blocking for beta cutover.
- Close this doc once both curls above show the expected responses and
  24h of PM2 logs show no token errors.
