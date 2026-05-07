/**
 * Gbox Platform — Nginx Writer tests
 * (Landing Page System Phase 1D)
 *
 * Covers the template + safety assertions + atomic write flow for
 * `nginx-writer.ts`. No real filesystem access — `writeFile`,
 * `rename`, `mkdir`, `unlink` are all injected so a failed test
 * can't pollute `/etc/nginx/gbox-domains/`.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  assertSafeDomain,
  assertSafePath,
  assertSafeUpstream,
  configFilePath,
  removeDomainServerBlock,
  renderDomainServerBlock,
  writeDomainServerBlock,
  type DomainServerBlockInput,
  type NginxWriterConfig,
} from './nginx-writer.js'

// ---------------------------------------------------------------------------
// Safety helpers
// ---------------------------------------------------------------------------

describe('assertSafeDomain', () => {
  it('accepts normal merchant hostnames', () => {
    expect(() => assertSafeDomain('thaibeotit.com')).not.toThrow()
    expect(() => assertSafeDomain('shop.thaibeotit.com')).not.toThrow()
    expect(() => assertSafeDomain('a-b.c-d.example')).not.toThrow()
  })

  it('rejects uppercase (nginx is case-sensitive for server_name)', () => {
    expect(() => assertSafeDomain('Thaibeotit.com')).toThrow(/unsafe domain/)
  })

  it('rejects injection attempts', () => {
    expect(() => assertSafeDomain('evil.com; rm -rf /')).toThrow()
    expect(() => assertSafeDomain('evil.com\nserver { }')).toThrow()
    expect(() => assertSafeDomain('evil.com"')).toThrow()
  })

  it('rejects single-label names without a dot', () => {
    // IP literals slip through the current regex by design — we rely
    // on the service layer's own validator to reject those, and the
    // defence here only cares about nginx-injection safety.
    expect(() => assertSafeDomain('localhost')).toThrow()
  })
})

describe('assertSafePath', () => {
  it('accepts normal absolute POSIX paths', () => {
    expect(() =>
      assertSafePath('/etc/gbox/lego/certificates/foo.crt', 'certPath'),
    ).not.toThrow()
  })

  it('rejects relative paths', () => {
    expect(() => assertSafePath('etc/gbox/foo.crt', 'certPath')).toThrow(
      /absolute/,
    )
  })

  it('rejects parent traversal', () => {
    expect(() =>
      assertSafePath('/etc/gbox/../../etc/shadow', 'certPath'),
    ).toThrow(/parent traversal/)
  })

  it('rejects paths with quoting / newline / semicolon', () => {
    expect(() => assertSafePath('/etc/gbox/foo;rm', 'certPath')).toThrow()
    expect(() => assertSafePath('/etc/gbox/foo\nbar', 'certPath')).toThrow()
    expect(() => assertSafePath('/etc/gbox/foo"bar', 'certPath')).toThrow()
  })
})

describe('assertSafeUpstream', () => {
  it('accepts http/https upstream URLs', () => {
    expect(() => assertSafeUpstream('http://127.0.0.1:4321')).not.toThrow()
    expect(() =>
      assertSafeUpstream('https://storefront.internal:4321'),
    ).not.toThrow()
  })

  it('rejects other protocols', () => {
    expect(() => assertSafeUpstream('ftp://foo')).toThrow(/http\(s\)/)
  })

  it('rejects embedded newlines / quotes', () => {
    expect(() =>
      assertSafeUpstream('http://127.0.0.1\nrm -rf /'),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// renderDomainServerBlock
// ---------------------------------------------------------------------------

describe('renderDomainServerBlock', () => {
  const baseConfig: NginxWriterConfig = {
    domainsDir: '/etc/nginx/gbox-domains',
    storefrontUpstream: 'http://127.0.0.1:4321',
  }
  const baseInput: DomainServerBlockInput = {
    domain: 'thaibeotit.com',
    certPath: '/etc/gbox/lego/certificates/thaibeotit.com.crt',
    certKeyPath: '/etc/gbox/lego/certificates/thaibeotit.com.key',
    shopId: 'shop_abc123',
  }

  it('emits a complete dual-listen block with SSL snippet include', () => {
    const out = renderDomainServerBlock(baseConfig, baseInput)
    expect(out).toContain('listen 80;')
    expect(out).toContain('listen 443 ssl http2;')
    expect(out).toContain('server_name thaibeotit.com')
    expect(out).toContain('ssl_certificate     /etc/gbox/lego/certificates/thaibeotit.com.crt')
    expect(out).toContain('ssl_certificate_key /etc/gbox/lego/certificates/thaibeotit.com.key')
    expect(out).toContain('include snippets/gbox-ssl-common.conf;')
    expect(out).toContain('proxy_pass http://127.0.0.1:4321')
  })

  it('serves ACME challenge on port 80 + redirects the rest to HTTPS', () => {
    const out = renderDomainServerBlock(baseConfig, baseInput)
    expect(out).toContain('/.well-known/acme-challenge/')
    expect(out).toContain('/var/www/acme-webroot')
    expect(out).toContain('return 301 https://$host$request_uri;')
  })

  it('adds every alias to server_name', () => {
    const out = renderDomainServerBlock(baseConfig, {
      ...baseInput,
      aliases: ['www.thaibeotit.com'],
    })
    expect(out).toMatch(
      /server_name thaibeotit\.com www\.thaibeotit\.com/,
    )
  })

  it('emits X-Gbox-Shop-Id when shopId is provided', () => {
    const out = renderDomainServerBlock(baseConfig, baseInput)
    expect(out).toContain('X-Gbox-Shop-Id')
    expect(out).toContain('shop_abc123')
  })

  it('omits X-Gbox-Shop-Id when shopId is absent', () => {
    const out = renderDomainServerBlock(baseConfig, {
      ...baseInput,
      shopId: undefined,
    })
    expect(out).not.toContain('X-Gbox-Shop-Id')
  })

  it('emits a canonical redirect when canonicalRedirect+canonicalHost set', () => {
    const out = renderDomainServerBlock(baseConfig, {
      ...baseInput,
      aliases: ['www.thaibeotit.com'],
      canonicalRedirect: true,
      canonicalHost: 'thaibeotit.com',
    })
    expect(out).toContain('if ($host != "thaibeotit.com")')
    expect(out).toContain('return 301 https://thaibeotit.com')
  })

  it('refuses to render when the domain contains unsafe characters', () => {
    expect(() =>
      renderDomainServerBlock(baseConfig, {
        ...baseInput,
        domain: 'evil.com;rm',
      }),
    ).toThrow()
  })

  it('refuses to render when the cert path is not absolute', () => {
    expect(() =>
      renderDomainServerBlock(baseConfig, {
        ...baseInput,
        certPath: 'relative/path.crt',
      }),
    ).toThrow()
  })

  it('refuses to render when the upstream URL is bogus', () => {
    expect(() =>
      renderDomainServerBlock(
        { ...baseConfig, storefrontUpstream: 'not-a-url' },
        baseInput,
      ),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// configFilePath
// ---------------------------------------------------------------------------

describe('configFilePath', () => {
  it('maps a normal domain to <dir>/<domain>.conf', () => {
    expect(configFilePath('/etc/nginx/gbox-domains', 'thaibeotit.com')).toBe(
      '/etc/nginx/gbox-domains/thaibeotit.com.conf',
    )
  })

  it('rewrites wildcard prefix to `_.`', () => {
    expect(configFilePath('/etc/nginx/gbox-domains', '*.gbox.co')).toBe(
      '/etc/nginx/gbox-domains/_.gbox.co.conf',
    )
  })
})

// ---------------------------------------------------------------------------
// writeDomainServerBlock (atomic write via injected fs)
// ---------------------------------------------------------------------------

describe('writeDomainServerBlock', () => {
  it('writes the rendered block to <path>.tmp and renames atomically', async () => {
    const writeFileImpl = vi.fn(async () => undefined) as any
    const renameImpl = vi.fn(async () => undefined) as any
    const mkdirImpl = vi.fn(async () => undefined) as any

    const result = await writeDomainServerBlock(
      {
        domainsDir: '/etc/nginx/gbox-domains',
        storefrontUpstream: 'http://127.0.0.1:4321',
        writeFileImpl,
        renameImpl,
        mkdirImpl,
      },
      {
        domain: 'thaibeotit.com',
        certPath: '/etc/gbox/lego/certificates/thaibeotit.com.crt',
        certKeyPath: '/etc/gbox/lego/certificates/thaibeotit.com.key',
      },
    )

    expect(mkdirImpl).toHaveBeenCalledWith(
      '/etc/nginx/gbox-domains',
      expect.objectContaining({ recursive: true }),
    )
    expect(writeFileImpl).toHaveBeenCalledTimes(1)
    const writeCall = writeFileImpl.mock.calls[0]!
    expect(writeCall[0]).toBe('/etc/nginx/gbox-domains/thaibeotit.com.conf.tmp')
    expect(writeCall[1]).toContain('server_name thaibeotit.com')
    expect(renameImpl).toHaveBeenCalledWith(
      '/etc/nginx/gbox-domains/thaibeotit.com.conf.tmp',
      '/etc/nginx/gbox-domains/thaibeotit.com.conf',
    )
    expect(result.path).toBe('/etc/nginx/gbox-domains/thaibeotit.com.conf')
  })
})

// ---------------------------------------------------------------------------
// removeDomainServerBlock
// ---------------------------------------------------------------------------

describe('removeDomainServerBlock', () => {
  it('unlinks the expected path and reports removed=true', async () => {
    const unlinkImpl = vi.fn(async () => undefined) as any
    const result = await removeDomainServerBlock(
      {
        domainsDir: '/etc/nginx/gbox-domains',
        storefrontUpstream: 'http://127.0.0.1:4321',
        unlinkImpl,
      },
      'thaibeotit.com',
    )
    expect(unlinkImpl).toHaveBeenCalledWith(
      '/etc/nginx/gbox-domains/thaibeotit.com.conf',
    )
    expect(result.removed).toBe(true)
  })

  it('swallows ENOENT and returns removed=false', async () => {
    const unlinkImpl = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    }) as any
    const result = await removeDomainServerBlock(
      {
        domainsDir: '/etc/nginx/gbox-domains',
        storefrontUpstream: 'http://127.0.0.1:4321',
        unlinkImpl,
      },
      'thaibeotit.com',
    )
    expect(result.removed).toBe(false)
  })

  it('rejects unsafe domain names before touching the filesystem', async () => {
    const unlinkImpl = vi.fn(async () => undefined) as any
    await expect(
      removeDomainServerBlock(
        {
          domainsDir: '/etc/nginx/gbox-domains',
          storefrontUpstream: 'http://127.0.0.1:4321',
          unlinkImpl,
        },
        'evil.com;rm -rf /',
      ),
    ).rejects.toThrow()
    expect(unlinkImpl).not.toHaveBeenCalled()
  })
})
