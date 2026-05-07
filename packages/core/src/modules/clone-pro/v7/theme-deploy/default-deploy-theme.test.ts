/**
 * Clone Pro v7 — defaultDeployTheme SSH bridge tests (Task 3 / worker-e2e plumbing).
 *
 * The SSH bridge is the production replacement for the no-op shim
 * Sprint 5 used as a placeholder. It runs `bash -s` over SSH on the
 * storefront server (Server 3 / 192.168.1.19) with
 * `scripts/deploy-theme-v7.sh` piped on stdin and the shop_id +
 * theme_zip_s3_key passed as positional args.
 *
 * The bridge is gated by `DEPLOY_OVER_SSH=1` so:
 *   - Local dev / vitest runs skip the SSH call entirely (no-op).
 *   - Server-2 boxes that DO have SSH access to Server 3 set the env
 *     to '1' explicitly.
 *
 * Iron Rule 5: SSH errors propagate up to `runStage11V7` which scrubs
 * via `safeMessage()` before the seller sees anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock node:child_process at the module level so `defaultDeployTheme`'s
// `promisify(exec)` returns a stub we control. Any time the bridge
// would shell out, our mock records the command + replies instantly.
const execAsyncMock = vi.fn()

vi.mock('node:child_process', () => ({
  exec: (cmd: string, opts: any, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    // exec(cmd, opts, cb) signature
    const result = execAsyncMock(cmd, opts)
    if (result instanceof Promise) {
      result
        .then((r: any) => cb(null, r.stdout ?? '', r.stderr ?? ''))
        .catch((err: Error) => cb(err, '', ''))
    } else {
      cb(null, (result as any)?.stdout ?? '', (result as any)?.stderr ?? '')
    }
  },
}))

// Import AFTER mocks — top-level bindings get bound to the real (mocked)
// child_process at import time.
import { defaultDeployTheme } from './default-deploy-theme.js'

describe('defaultDeployTheme — SSH bridge', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    execAsyncMock.mockReset()
    // Wipe any leftover env from a prior test.
    delete process.env.DEPLOY_OVER_SSH
    delete process.env.STOREFRONT_SSH_HOST
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('is a no-op when DEPLOY_OVER_SSH is unset (local dev / test)', async () => {
    // Without the env flag, the bridge prints a warning and returns.
    // No SSH attempted.
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await defaultDeployTheme({ shopId: 'shop-1', themeZipS3Key: 'themes/shop-1/v1.zip' })
    expect(execAsyncMock).not.toHaveBeenCalled()
    expect(consoleWarnSpy).toHaveBeenCalled()
    consoleWarnSpy.mockRestore()
  })

  it('throws a server-side error when DEPLOY_OVER_SSH=1 but STOREFRONT_SSH_HOST is missing', async () => {
    process.env.DEPLOY_OVER_SSH = '1'
    // No STOREFRONT_SSH_HOST set.
    await expect(
      defaultDeployTheme({ shopId: 'shop-1', themeZipS3Key: 'themes/shop-1/v1.zip' }),
    ).rejects.toThrow(/STOREFRONT_SSH_HOST/)
    // Iron Rule 5: this Error is caught by runStage11V7 + scrubbed via
    // safeMessage before reaching seller surfaces. The .message is
    // for server logs only.
    expect(execAsyncMock).not.toHaveBeenCalled()
  })

  it('invokes ssh with the deploy script piped on stdin and shop_id + s3_key as args', async () => {
    process.env.DEPLOY_OVER_SSH = '1'
    process.env.STOREFRONT_SSH_HOST = 'unbutu1@192.168.1.19'
    execAsyncMock.mockResolvedValueOnce({ stdout: '[deploy-theme-v7] ok', stderr: '' })

    await defaultDeployTheme({
      shopId: '7c3d-uuid',
      themeZipS3Key: 'themes/7c3d-uuid/bundle-v1.zip',
    })

    expect(execAsyncMock).toHaveBeenCalledTimes(1)
    const [cmd, opts] = execAsyncMock.mock.calls[0]
    // Command shape: ssh <host> "bash -s" -- <shopId> <s3Key> < scripts/deploy-theme-v7.sh
    expect(cmd).toMatch(/^ssh\s+unbutu1@192\.168\.1\.19\s/)
    expect(cmd).toMatch(/bash\s+-s/)
    expect(cmd).toMatch(/7c3d-uuid/)
    expect(cmd).toMatch(/themes\/7c3d-uuid\/bundle-v1\.zip/)
    expect(cmd).toMatch(/scripts\/deploy-theme-v7\.sh/)
    // 2 minute timeout per spec (Sprint 5 Task 3).
    expect(opts).toMatchObject({ timeout: 120_000 })
  })

  it('propagates SSH command failures so the caller can surface them via safeMessage', async () => {
    process.env.DEPLOY_OVER_SSH = '1'
    process.env.STOREFRONT_SSH_HOST = 'unbutu1@192.168.1.19'
    execAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('Permission denied (publickey)'), { code: 255 }),
    )

    await expect(
      defaultDeployTheme({ shopId: 'shop-z', themeZipS3Key: 'themes/shop-z/v1.zip' }),
    ).rejects.toThrow(/Permission denied/)
  })
})
