import { describe, it, expect } from 'vitest'
import { loadConfig, listAvailableConfigs } from '../config-loader.js'

describe('config-loader', () => {
  it('loads shopify-classic config', () => {
    const cfg = loadConfig('shopify-classic')
    expect(cfg.platform).toBe('shopify-classic')
    expect(cfg.delay).toBeGreaterThan(0)
    expect(cfg.item.xpath).toBeTruthy()
    expect(cfg.item.elements.length).toBeGreaterThan(0)
  })

  it('loads shopify-hydrogen config (new for Hydrogen 2.0)', () => {
    const cfg = loadConfig('shopify-hydrogen')
    expect(cfg.platform).toBe('shopify-hydrogen')
    const hasTitle = cfg.item.elements.some((e) => e.name === 'Title')
    const hasImage = cfg.item.elements.some((e) => e.name === 'Image')
    const hasLink = cfg.item.elements.some((e) => e.name === 'Link')
    expect(hasTitle).toBe(true)
    expect(hasImage).toBe(true)
    expect(hasLink).toBe(true)
  })

  it('loads woocommerce config', () => {
    const cfg = loadConfig('woocommerce')
    expect(cfg.platform).toBe('woocommerce')
    expect(cfg.item.elements.length).toBeGreaterThan(0)
  })

  it('loads shopbase config', () => {
    const cfg = loadConfig('shopbase')
    expect(cfg.platform).toBe('shopbase')
  })

  it('loads bigcommerce config', () => {
    const cfg = loadConfig('bigcommerce')
    expect(cfg.platform).toBe('bigcommerce')
  })

  it('throws on unknown platform', () => {
    expect(() => loadConfig('unknown')).toThrow(/unknown/i)
  })

  it('listAvailableConfigs returns at least 5 platform aliases', () => {
    const list = listAvailableConfigs()
    expect(list).toContain('shopify-classic')
    expect(list).toContain('shopify-hydrogen')
    expect(list).toContain('woocommerce')
    expect(list).toContain('bigcommerce')
    expect(list).toContain('shopbase')
  })

  it('every platform config validates as Config shape', () => {
    for (const name of ['shopify-classic', 'shopify-hydrogen', 'woocommerce', 'bigcommerce', 'shopbase'] as const) {
      const cfg = loadConfig(name)
      expect(typeof cfg.delay).toBe('number')
      expect(typeof cfg.item.xpath).toBe('string')
      expect(Array.isArray(cfg.item.elements)).toBe(true)
      for (const el of cfg.item.elements) {
        expect(typeof el.name).toBe('string')
        expect(typeof el.xpath).toBe('string')
      }
    }
  })
})
