/**
 * Clone Pro v7 — defaultDeployTheme SSH bridge.
 *
 * Replaces the no-op shim Sprint 5 used. When `DEPLOY_OVER_SSH=1` is
 * set on the worker process, this function shells out via SSH on the
 * configured storefront server (Server 3, default `unbutu1@192.168.1.19`)
 * and pipes `scripts/deploy-theme-v7.sh` on stdin with the shop_id +
 * theme_zip_s3_key as positional args.
 *
 * The deploy script (committed at `scripts/deploy-theme-v7.sh`):
 *   1. `aws s3 cp s3://$BUCKET/$KEY /tmp/theme-$SHOP.zip`
 *   2. `mv /var/www/themes/$SHOP /var/www/themes/$SHOP.bak`
 *   3. `unzip /tmp/theme-$SHOP.zip -d /var/www/themes/$SHOP`
 *   4. `chown -R unbutu1:unbutu1 /var/www/themes/$SHOP`
 *   5. `pm2 reload gbox-storefront`
 *
 * The bridge is deliberately env-gated:
 *   - Local vitest / Windows dev: `DEPLOY_OVER_SSH` unset → no-op.
 *   - Server 2 (where the worker runs): set the env to '1' explicitly
 *     so SSH only fires in production.
 *
 * Iron Rule 5: errors propagate up to `runStage11V7` (Stage 11 wrapper)
 * which scrubs via `safeMessage()` before any seller-facing channel
 * sees the diagnostic. Raw stderr / exit-code / SSH key paths stay
 * server-side in pino logs.
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface DefaultDeployThemeInput {
  shopId: string
  themeZipS3Key: string
}

/**
 * Deploy the rendered theme.zip onto the storefront server via SSH.
 *
 * Returns a clean Promise<void> on success. On failure, throws an
 * `Error` whose `.message` is the raw SSH/exec diagnostic — the
 * caller (`runStage11V7`) is responsible for wrapping it via
 * `safeMessage()` before the seller sees it.
 *
 * @throws Error when STOREFRONT_SSH_HOST is missing or SSH fails.
 */
export async function defaultDeployTheme(
  input: DefaultDeployThemeInput,
): Promise<void> {
  if (process.env.DEPLOY_OVER_SSH !== '1') {
    // Local / test mode. Log a hint so we never get a silent miss.
    console.warn(
      `[v7-deploy-theme] DEPLOY_OVER_SSH unset — skipping SSH deploy ` +
        `for shop=${input.shopId} key=${input.themeZipS3Key}`,
    )
    return
  }

  const sshHost = process.env.STOREFRONT_SSH_HOST
  if (!sshHost) {
    // Misconfigured production: env says deploy, no host configured.
    // Throwing here is intentional — the alternative (silent skip)
    // would leave the catalog published against a stale theme on
    // Server 3 with no audit trail.
    throw new Error(
      'STOREFRONT_SSH_HOST not configured (set to e.g. "unbutu1@192.168.1.19")',
    )
  }

  // Build the command. We pipe the deploy script via stdin so the
  // remote box doesn't need a copy of the script — it executes whatever
  // we shell. Positional args after `--` go to `bash -s` which forwards
  // them to the script as $1, $2, etc.
  const cmd =
    `ssh ${sshHost} "bash -s" -- ` +
    `${input.shopId} ${input.themeZipS3Key} ` +
    `< scripts/deploy-theme-v7.sh`

  // 2-minute timeout matches the runbook — `aws s3 cp` + `unzip` +
  // `pm2 reload` should finish well under 60s for a typical theme
  // bundle (~5MB). 120s gives headroom for a slow S3 region.
  const { stdout, stderr } = await execAsync(cmd, { timeout: 120_000 })

  // Always log stdout for the audit trail. Worker pino captures this.
  if (stdout) console.log('[v7-deploy-theme] stdout:', stdout)
  // stderr being non-empty isn't necessarily an error (the deploy
  // script logs progress to stderr). Surface it so we can grep for
  // "Permission denied" etc. in pino without failing the call.
  if (stderr) console.warn('[v7-deploy-theme] stderr:', stderr)
}
