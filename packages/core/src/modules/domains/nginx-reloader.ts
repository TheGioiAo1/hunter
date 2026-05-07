/**
 * Gbox Platform — Nginx Reloader
 * (Landing Page System Phase 1D)
 *
 * Two-step reload helper for the TLS edge:
 *
 *   1. `nginx -t`  — config syntax check. MUST pass before reload
 *                    or we risk sending SIGHUP to nginx with a
 *                    broken config, which nginx will reject but
 *                    only after logging a confusing error. Catch it
 *                    here instead.
 *
 *   2. `systemctl reload nginx` (or `nginx -s reload` as fallback).
 *                    Graceful: existing connections drain naturally,
 *                    new connections pick up the new worker set.
 *                    No dropped TCP sessions.
 *
 * Privilege model: the Node process runs as the `gbox-edge` user
 * and gains reload rights via a narrow sudoers rule:
 *
 *     gbox-edge ALL=(root) NOPASSWD: /usr/sbin/nginx -t, /bin/systemctl reload nginx
 *
 * That rule is documented in ops/edge/sudoers.d/gbox-edge (generated
 * by the bootstrap script). No other root commands are allowed —
 * minimising blast radius if the Node process is compromised.
 *
 * Debouncing: multiple rapid cert issues (e.g. a batch of 10
 * domains coming online at once) must NOT trigger 10 reloads.
 * The orchestrator collects writes into a batch and calls
 * `reloadNginxDebounced()` once at the end. For a single issue,
 * call `reloadNginx()` directly.
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'

export interface NginxReloaderConfig {
  /**
   * Command used to run `nginx -t`. Defaults to `sudo` + the nginx
   * binary path. Tests inject a fake that records the argv.
   */
  sudoBinary?: string
  nginxBinary?: string
  systemctlBinary?: string
  /** Injectable spawn. */
  spawnImpl?: typeof nodeSpawn
  /** Timeout per command (seconds). Default 15. */
  timeoutSeconds?: number
  /**
   * When true, run without sudo (useful in dev or when the Node
   * process IS root). Defaults to false.
   */
  noSudo?: boolean
}

export type NginxReloadErrorKind =
  | 'config_test_failed' // nginx -t returned non-zero
  | 'reload_failed' // systemctl reload returned non-zero
  | 'timeout'
  | 'binary_missing'
  | 'unknown'

export interface NginxReloadError {
  ok: false
  kind: NginxReloadErrorKind
  message: string
  stdout?: string
  stderr?: string
  exitCode?: number | null
}

export type NginxReloadResult =
  | { ok: true; testOutput: string; reloadOutput: string }
  | NginxReloadError

const DEFAULT_SUDO = 'sudo'
const DEFAULT_NGINX = '/usr/sbin/nginx'
const DEFAULT_SYSTEMCTL = '/bin/systemctl'
const DEFAULT_TIMEOUT_SECONDS = 15

interface SpawnOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runCmd(
  spawnImpl: typeof nodeSpawn,
  binary: string,
  args: string[],
  timeoutMs: number,
  opts?: SpawnOptions,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(binary, args, {
        ...opts,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
      })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout?.on('data', (c) => (stdout += c.toString('utf8')))
    child.stderr?.on('data', (c) => (stderr += c.toString('utf8')))
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }, timeoutMs)
    child.on('error', (err) => (stderr += `\n${err.message}`))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: timedOut ? null : code, stdout, stderr, timedOut })
    })
  })
}

/**
 * Build the argv for `nginx -t`. Split out so tests can assert on
 * the exact command without calling the (potentially injected)
 * spawn function.
 */
export function buildTestCommand(config: NginxReloaderConfig): {
  binary: string
  args: string[]
} {
  const nginx = config.nginxBinary ?? DEFAULT_NGINX
  if (config.noSudo) {
    return { binary: nginx, args: ['-t'] }
  }
  const sudo = config.sudoBinary ?? DEFAULT_SUDO
  return { binary: sudo, args: [nginx, '-t'] }
}

/**
 * Build the argv for the actual reload. Prefers `systemctl reload`
 * (the sudoers rule allows it explicitly) over `nginx -s reload`.
 */
export function buildReloadCommand(config: NginxReloaderConfig): {
  binary: string
  args: string[]
} {
  const systemctl = config.systemctlBinary ?? DEFAULT_SYSTEMCTL
  if (config.noSudo) {
    return { binary: systemctl, args: ['reload', 'nginx'] }
  }
  const sudo = config.sudoBinary ?? DEFAULT_SUDO
  return { binary: sudo, args: [systemctl, 'reload', 'nginx'] }
}

// ---------------------------------------------------------------------------
// Public: reloadNginx
// ---------------------------------------------------------------------------

/**
 * Run `nginx -t` then `systemctl reload nginx`. Bails at step 1 if
 * the config doesn't parse. Returns a typed result for the caller
 * to pattern-match on.
 *
 * Intended use: called by the orchestrator after a batch of cert
 * writes lands in `/etc/nginx/gbox-domains/`. Do NOT call per-domain
 * in a loop — see `reloadNginxDebounced()`.
 */
export async function reloadNginx(
  config: NginxReloaderConfig = {},
): Promise<NginxReloadResult> {
  const spawnImpl = config.spawnImpl ?? nodeSpawn
  const timeoutMs = (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000

  const test = buildTestCommand(config)
  const testOutcome = await runCmd(spawnImpl, test.binary, test.args, timeoutMs)
  if (testOutcome.timedOut) {
    return {
      ok: false,
      kind: 'timeout',
      message: `nginx -t timed out after ${timeoutMs / 1000}s`,
      stdout: testOutcome.stdout,
      stderr: testOutcome.stderr,
    }
  }
  if (testOutcome.exitCode !== 0) {
    if (
      testOutcome.stderr.toLowerCase().includes('enoent') ||
      testOutcome.stderr.toLowerCase().includes('no such file')
    ) {
      return {
        ok: false,
        kind: 'binary_missing',
        message: `nginx binary not found — set NginxReloaderConfig.nginxBinary (stderr: ${testOutcome.stderr.trim()})`,
        stdout: testOutcome.stdout,
        stderr: testOutcome.stderr,
        exitCode: testOutcome.exitCode,
      }
    }
    return {
      ok: false,
      kind: 'config_test_failed',
      message: testOutcome.stderr.trim() || testOutcome.stdout.trim() || 'nginx -t failed',
      stdout: testOutcome.stdout,
      stderr: testOutcome.stderr,
      exitCode: testOutcome.exitCode,
    }
  }

  const reload = buildReloadCommand(config)
  const reloadOutcome = await runCmd(
    spawnImpl,
    reload.binary,
    reload.args,
    timeoutMs,
  )
  if (reloadOutcome.timedOut) {
    return {
      ok: false,
      kind: 'timeout',
      message: `systemctl reload nginx timed out after ${timeoutMs / 1000}s`,
      stdout: reloadOutcome.stdout,
      stderr: reloadOutcome.stderr,
    }
  }
  if (reloadOutcome.exitCode !== 0) {
    return {
      ok: false,
      kind: 'reload_failed',
      message:
        reloadOutcome.stderr.trim() ||
        reloadOutcome.stdout.trim() ||
        'systemctl reload nginx failed',
      stdout: reloadOutcome.stdout,
      stderr: reloadOutcome.stderr,
      exitCode: reloadOutcome.exitCode,
    }
  }

  return {
    ok: true,
    testOutput: testOutcome.stdout + testOutcome.stderr,
    reloadOutput: reloadOutcome.stdout + reloadOutcome.stderr,
  }
}

// ---------------------------------------------------------------------------
// Debounced reload
// ---------------------------------------------------------------------------

/**
 * Debounced wrapper: coalesces multiple reload requests within a
 * `debounceMs` window into a single actual reload. Useful for batch
 * provisioning where 10 domains finish issuance in the same tick —
 * we want ONE reload, not 10.
 *
 * Implementation is deliberately per-instance so unit tests can
 * create a fresh debouncer without leaking state between runs.
 */
export class DebouncedNginxReloader {
  private pending: Promise<NginxReloadResult> | null = null
  private timer: NodeJS.Timeout | null = null
  private resolve: ((v: NginxReloadResult) => void) | null = null

  constructor(
    private readonly config: NginxReloaderConfig = {},
    private readonly debounceMs = 1000,
  ) {}

  /**
   * Schedule a reload. If one is already scheduled within the
   * debounce window, the returned promise resolves with the same
   * result as the already-scheduled one.
   */
  request(): Promise<NginxReloadResult> {
    if (this.pending) return this.pending

    this.pending = new Promise<NginxReloadResult>((resolve) => {
      this.resolve = resolve
      this.timer = setTimeout(async () => {
        const result = await reloadNginx(this.config)
        this.pending = null
        this.timer = null
        this.resolve = null
        resolve(result)
      }, this.debounceMs)
    })
    return this.pending
  }

  /**
   * Cancel a pending scheduled reload (if any) and resolve the
   * pending promise with `reason`. Used on shutdown so callers
   * awaiting a reload don't hang forever.
   */
  cancel(reason: NginxReloadError = {
    ok: false,
    kind: 'unknown',
    message: 'DebouncedNginxReloader cancelled',
  }): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.resolve) {
      this.resolve(reason)
      this.resolve = null
    }
    this.pending = null
  }
}
