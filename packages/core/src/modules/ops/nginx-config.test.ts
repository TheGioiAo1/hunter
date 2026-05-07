/**
 * Unit tests for nginx-config.ts
 */

import { describe, it, expect } from 'vitest'
import { generateNginxConfig } from './nginx-config.js'

describe('generateNginxConfig', () => {
  it('generates empty config with no domains', () => {
    const result = generateNginxConfig([])
    expect(result).toContain('Domains: 0')
    expect(result).toContain('upstream gbox_storefront')
  })

  it('generates HTTPS block for domain with SSL cert', () => {
    const result = generateNginxConfig([
      { domain: 'shop.example.com', shopId: 'abc12345-def', hasSslCert: true },
    ])
    expect(result).toContain('server_name shop.example.com')
    expect(result).toContain('listen 443 ssl http2')
    expect(result).toContain('ssl_certificate     /etc/letsencrypt/live/shop.example.com/fullchain.pem')
    expect(result).toContain('ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem')
    expect(result).toContain('return 301 https://$host$request_uri')
    expect(result).toContain('Strict-Transport-Security')
  })

  it('generates HTTP-only block for domain without cert', () => {
    const result = generateNginxConfig([
      { domain: 'new.example.com', shopId: 'xyz12345-ghi', hasSslCert: false },
    ])
    expect(result).toContain('server_name new.example.com')
    expect(result).toContain('listen 80')
    expect(result).toContain('.well-known/acme-challenge')
    expect(result).not.toContain('listen 443')
    expect(result).not.toContain('ssl_certificate')
  })

  it('generates mixed blocks for multiple domains', () => {
    const result = generateNginxConfig([
      { domain: 'ssl.example.com', shopId: 'a', hasSslCert: true },
      { domain: 'nossl.example.com', shopId: 'b', hasSslCert: false },
    ])
    expect(result).toContain('Domains: 2')
    expect(result).toContain('server_name ssl.example.com')
    expect(result).toContain('server_name nossl.example.com')
    // SSL domain should have 443 block
    expect(result).toContain('ssl_certificate     /etc/letsencrypt/live/ssl.example.com/fullchain.pem')
    // No-SSL domain should have acme challenge
    expect(result).toContain('.well-known/acme-challenge')
  })

  it('respects custom options', () => {
    const result = generateNginxConfig(
      [{ domain: 'test.com', shopId: 'x', hasSslCert: true }],
      {
        upstream: 'my_upstream',
        storefrontPort: 9999,
        certBasePath: '/custom/certs',
      },
    )
    expect(result).toContain('upstream my_upstream')
    expect(result).toContain('server 127.0.0.1:9999')
    expect(result).toContain('/custom/certs/test.com/fullchain.pem')
    expect(result).toContain('proxy_pass http://my_upstream')
  })
})
