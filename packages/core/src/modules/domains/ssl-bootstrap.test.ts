/**
 * ssl-bootstrap unit tests.
 *
 * Cases:
 *   1. isSslProvisionEnabled — kill-switch precise match
 *   2. buildOrchestratorConfigFromEnv — defaults + overrides
 *   3. bootstrapSslForDomain — kill-switch off → no requestSsl call
 *   4. bootstrapSslForDomain — missing email → warn + no call
 *   5. bootstrapSslForDomain — happy path → calls requestSsl with shaped config
 *   6. bootstrapSslForDomain — orchestrator throws → swallow + log warn
 *   7. bootstrapSslForDomain — orchestrator returns ok=false → log warn
 */

import { describe, it, expect, vi } from 'vitest'
import {
  bootstrapSslForDomain,
  buildOrchestratorConfigFromEnv,
  isSslProvisionEnabled,
} from './ssl-bootstrap.js'

describe('isSslProvisionEnabled', () => {
  it('only enables on the literal string "true" (case-insensitive)', () => {
    expect(isSslProvisionEnabled({ GBOX_SSL_PROVISION_ENABLED: 'true' })).toBe(true)
    expect(isSslProvisionEnabled({ GBOX_SSL_PROVISION_ENABLED: 'TRUE' })).toBe(true)
    expect(isSslProvisionEnabled({ GBOX_SSL_PROVISION_ENABLED: 'True' })).toBe(true)
  })
  it('disables on anything else', () => {
    expect(isSslProvisionEnabled({})).toBe(false)
    expect(isSslProvisionEnabled({ GBOX_SSL_PROVISION_ENABLED: 'false' })).toBe(false)
    expect(isSslProvisionEnabled({ GBOX_SSL_PROVISION_ENABLED: '1' })).toBe(false)
    expect(isSslProvisionEnabled({ GBOX_SSL_PROVISION_ENABLED: '' })).toBe(false)
  })
})

describe('buildOrchestratorConfigFromEnv', () => {
  it('returns null when email is missing', () => {
    expect(buildOrchestratorConfigFromEnv({})).toBeNull()
  })

  it('builds config with defaults', () => {
    const cfg = buildOrchestratorConfigFromEnv({
      GBOX_LETSENCRYPT_EMAIL: 'ops@gbox.co',
    })
    expect(cfg).not.toBeNull()
    expect(cfg!.acme.accountEmail).toBe('ops@gbox.co')
    expect(cfg!.acme.legoPath).toBe('/etc/gbox/lego')
    expect(cfg!.acme.webrootPath).toBe('/var/www/acme-webroot')
    expect(cfg!.acme.environment).toBe('production')
    expect(cfg!.nginxWriter.domainsDir).toBe('/etc/nginx/gbox-domains')
    expect(cfg!.nginxWriter.storefrontUpstream).toBe('http://127.0.0.1:4326')
  })

  it('honours overrides', () => {
    const cfg = buildOrchestratorConfigFromEnv({
      GBOX_LETSENCRYPT_EMAIL: 'a@b',
      GBOX_LEGO_PATH: '/tmp/lego',
      GBOX_ACME_WEBROOT: '/tmp/webroot',
      GBOX_NGINX_DOMAINS_DIR: '/tmp/nginx',
      GBOX_STOREFRONT_UPSTREAM: 'http://10.0.0.5:4326',
      GBOX_LETSENCRYPT_STAGING: '1',
      GBOX_NGINX_NO_SUDO: '1',
    })
    expect(cfg!.acme.legoPath).toBe('/tmp/lego')
    expect(cfg!.acme.webrootPath).toBe('/tmp/webroot')
    expect(cfg!.nginxWriter.domainsDir).toBe('/tmp/nginx')
    expect(cfg!.nginxWriter.storefrontUpstream).toBe('http://10.0.0.5:4326')
    expect(cfg!.acme.environment).toBe('staging')
    expect(cfg!.nginxReloader!.noSudo).toBe(true)
  })
})

describe('bootstrapSslForDomain', () => {
  function deps(over: Partial<Parameters<typeof bootstrapSslForDomain>[2]> = {}) {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      requestSsl: vi.fn(async () => ({ ok: true, record: {}, certificate: {} } as any)),
      ...over,
    }
  }

  it('kill-switch off → does NOT call requestSsl', async () => {
    const d = deps()
    await bootstrapSslForDomain(
      {} as any,
      { shopId: 's1', domainId: 'd1', domain: 'tw3.store' },
      {
        envImpl: {} as NodeJS.ProcessEnv,
        loggerImpl: { info: d.info, warn: d.warn },
        requestSslImpl: d.requestSsl,
      },
    )
    expect(d.requestSsl).not.toHaveBeenCalled()
    expect(d.info).toHaveBeenCalled()
  })

  it('missing email → warn + no call', async () => {
    const d = deps()
    await bootstrapSslForDomain(
      {} as any,
      { shopId: 's1', domainId: 'd1', domain: 'tw3.store' },
      {
        envImpl: { GBOX_SSL_PROVISION_ENABLED: 'true' } as NodeJS.ProcessEnv,
        loggerImpl: { info: d.info, warn: d.warn },
        requestSslImpl: d.requestSsl,
      },
    )
    expect(d.requestSsl).not.toHaveBeenCalled()
    expect(d.warn).toHaveBeenCalled()
  })

  it('happy path → calls requestSsl with config built from env', async () => {
    const d = deps()
    await bootstrapSslForDomain(
      {} as any,
      { shopId: 's1', domainId: 'd1', domain: 'tw3.store' },
      {
        envImpl: {
          GBOX_SSL_PROVISION_ENABLED: 'true',
          GBOX_LETSENCRYPT_EMAIL: 'ops@gbox.co',
        } as NodeJS.ProcessEnv,
        loggerImpl: { info: d.info, warn: d.warn },
        requestSslImpl: d.requestSsl,
      },
    )
    expect(d.requestSsl).toHaveBeenCalledTimes(1)
    const args = d.requestSsl.mock.calls[0]
    expect(args[1]).toEqual({ shopId: 's1', domainId: 'd1' })
    expect(args[2].acme.accountEmail).toBe('ops@gbox.co')
    expect(d.info).toHaveBeenCalled()
  })

  it('orchestrator throws → swallow + log warn (verify endpoint stays clean)', async () => {
    const d = deps({
      requestSsl: vi.fn(async () => {
        throw new Error('lego exploded')
      }),
    })
    await expect(
      bootstrapSslForDomain(
        {} as any,
        { shopId: 's1', domainId: 'd1', domain: 'tw3.store' },
        {
          envImpl: {
            GBOX_SSL_PROVISION_ENABLED: 'true',
            GBOX_LETSENCRYPT_EMAIL: 'ops@gbox.co',
          } as NodeJS.ProcessEnv,
          loggerImpl: { info: d.info, warn: d.warn },
          requestSslImpl: d.requestSsl,
        },
      ),
    ).resolves.toBeUndefined()
    expect(d.warn).toHaveBeenCalledWith(
      expect.stringContaining('unexpected provisioning error'),
    )
  })

  it('orchestrator returns ok=false → log warn but no throw', async () => {
    const d = deps({
      requestSsl: vi.fn(async () => ({
        ok: false,
        code: 'acme_error',
        message: 'rate limited',
        kind: 'rate_limited',
      } as any)),
    })
    await bootstrapSslForDomain(
      {} as any,
      { shopId: 's1', domainId: 'd1', domain: 'tw3.store' },
      {
        envImpl: {
          GBOX_SSL_PROVISION_ENABLED: 'true',
          GBOX_LETSENCRYPT_EMAIL: 'ops@gbox.co',
        } as NodeJS.ProcessEnv,
        loggerImpl: { info: d.info, warn: d.warn },
        requestSslImpl: d.requestSsl,
      },
    )
    expect(d.warn).toHaveBeenCalledWith(
      expect.stringContaining('provisioning failed'),
    )
  })
})
