# Environment Variables — Gbox Platform

Central reference for runtime flags used across the three server
processes (accounts, store-admin, storefront) and the two server
environments (dev = server 1, prod = gbox.co future-deploy).

Per-process secrets (DB creds, SMTP passwords, payment keys) live in
`/home/botesty/gbox-platform/.env` on each server — see
`.env.example` in the repo root for the full template.

This file documents the **behaviour-altering flags** — feature gates,
kill-switches, rollout toggles. Each row describes how a flag is read,
what it defaults to, and which surfaces consult it.

---

## Convention

Unless stated otherwise, each flag:

- Is read via `process.env.*` from `apps/*/src/server.ts` on boot.
- Is hot-swappable with `pm2 restart <proc> --update-env` after editing
  `/home/botesty/gbox-platform/.env` (plain `pm2 restart` skips dotenv).
- Defaults to the value marked **Default** when unset.
- Is **case-insensitive** where a boolean is expected — compared via
  `raw.toLowerCase() !== 'false'` style checks so a typo doesn't
  accidentally kill a production surface.

---

## Feature flags

### `GBOX_ONBOARDING_WIZARD_ENABLED`

- **Default:** `true` (unset treated as enabled)
- **Off value:** the literal `false` (case-insensitive)
- **Read by:**
  - `apps/store-admin/src/middleware/onboarding-gate.ts` —
    `isWizardEnabled()`. When off, the gate short-circuits to
    `next()`: no forced redirects into `/onboarding/first-run`, no
    `res.locals.showOnboardingBanner` set, no banner rendered.
  - `apps/accounts/src/pages/create-store.ts` — `postCreateStore`.
    When off, falls back to the pre-wizard `/accounts/store-created`
    bounce page instead of `/accounts/welcome-to-admin`.
- **Not read by:**
  - `apps/store-admin/src/pages/domains.ts postVerifyDomain` —
    the domain-verify nudge still redirects to `/onboarding/first-run?from=domain-verified` regardless. Rationale in
    `docs/runbooks/custom-domain-verification.md` §4.1 "Onboarding
    wizard nudge".
  - The wizard pages themselves (`first-run`, `clone`, `skip`,
    `dismiss-banner`) render normally when hit directly. The kill-switch
    is a **redirect suppressor**, not a page blocker — sellers who
    already have the URL can still see the wizard, but no normal
    navigation path sends them there when the flag is off.
- **Purpose:** in-place rollback without redeploying. If the wizard
  ships a regression on server 1, flip `.env` to `=false`, run
  `pm2 restart gbox-store-admin gbox-accounts --update-env`, and the
  platform returns to pre-wizard behaviour in seconds. Sellers who are
  mid-clone (state=`cloning`) are unaffected — the clone-pro runner
  hooks fire regardless of this flag because their SQL guards
  (`WHERE onboarding_state='cloning' AND onboarding_clone_job_id=?`)
  are inherently safe for non-wizard shops.
- **Plan reference:** `docs/superpowers/plans/2026-04-18-store-onboarding-wizard.md` Task F2.

---

## See also

- `docs/runbooks/custom-domain-verification.md` §8 — domain-related
  env vars (`GBOX_PLATFORM_IP_V4`, `GBOX_PLATFORM_CNAME_TARGET`).
- `.env.example` — full template with DB, email, payment keys.
