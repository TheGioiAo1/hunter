/**
 * Clone Pro v4 — Asset Integrity Check tests
 *
 * Behaviours under test:
 *   - Flat ratio scoring when no downloadedUrls provided
 *   - Tier-weighted scoring when downloadedUrls is provided
 *   - 0 expected assets → safe 100 with info finding
 *   - Discovery/execution gap emits a warning
 */

import { describe, it, expect } from 'vitest'
import { runAssetCheck } from './asset-check.js'
import type { AssetInventory, DiscoveredAsset } from '../discovery/asset-scanner.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asset(url: string, type: DiscoveredAsset['type'] = 'image'): DiscoveredAsset {
  return {
    url,
    absoluteUrl: url,
    type,
    priority: 'media',
    foundOn: [],
    attribute: 'src',
  } as DiscoveredAsset
}

function makeInventory(
  critical: DiscoveredAsset[],
  high: DiscoveredAsset[],
  media: DiscoveredAsset[],
): AssetInventory {
  const all = [...critical, ...high, ...media]
  return {
    assets: all,
    summary: {
      totalAssets: all.length,
      byType: {} as any,
      byPriority: {} as any,
      externalDomains: [],
      estimatedTotalSizeMB: 0,
      cssFiles: 0,
      jsFiles: 0,
      fontFiles: 0,
      imageFiles: 0,
    },
    criticalAssets: critical,
    highPriorityAssets: high,
    mediaAssets: media,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAssetCheck — flat ratio fallback', () => {
  it('returns 100 when all downloads succeeded', () => {
    const inventory = makeInventory([asset('https://cdn/a.css', 'css')], [], [])
    const result = runAssetCheck({
      inventory,
      stats: { assetsDownloaded: 1, assetsFailed: 0, totalAssetBytes: 1024 },
    })
    expect(result.score).toBe(100)
    expect(result.passed).toBe(true)
  })

  it('reflects failure ratio in the score', () => {
    const inventory = makeInventory([], [], [
      asset('https://cdn/a.jpg'),
      asset('https://cdn/b.jpg'),
      asset('https://cdn/c.jpg'),
      asset('https://cdn/d.jpg'),
    ])
    const result = runAssetCheck({
      inventory,
      stats: { assetsDownloaded: 3, assetsFailed: 1, totalAssetBytes: 100 },
    })
    expect(result.score).toBe(75)
    expect(result.findings.some((f) => f.message.includes('1 of 4'))).toBe(true)
  })

  it('returns 100 and skips when no assets expected', () => {
    const inventory = makeInventory([], [], [])
    const result = runAssetCheck({
      inventory,
      stats: { assetsDownloaded: 0, assetsFailed: 0, totalAssetBytes: 0 },
    })
    expect(result.score).toBe(100)
    expect(result.passed).toBe(true)
    expect(result.findings[0].severity).toBe('info')
  })
})

describe('runAssetCheck — tier-weighted scoring', () => {
  it('penalises heavily when critical assets are missing', () => {
    const critical = [asset('https://cdn/theme.css', 'css'), asset('https://cdn/font.woff2', 'font')]
    const high = [asset('https://cdn/theme.js', 'js')]
    const media = [asset('https://cdn/hero.jpg')]
    const inventory = makeInventory(critical, high, media)

    // Downloaded the JS + media but missed the CSS + font.
    const downloaded = new Set(['https://cdn/theme.js', 'https://cdn/hero.jpg'])
    const result = runAssetCheck({
      inventory,
      stats: { assetsDownloaded: 2, assetsFailed: 2, totalAssetBytes: 1024 },
      downloadedUrls: downloaded,
    })
    // critical 0/2 (ratio 0 * 70) + high 1/1 (ratio 1 * 20) + media 1/1 (1*10) = 30
    expect(result.score).toBe(30)
    expect(result.findings.some(
      (f) => f.severity === 'critical' && f.message.includes('Critical'),
    )).toBe(true)
    expect(result.passed).toBe(false)
  })

  it('gives full marks when every tier is 100%', () => {
    const critical = [asset('https://cdn/a.css', 'css')]
    const high = [asset('https://cdn/a.js', 'js')]
    const media = [asset('https://cdn/a.jpg')]
    const inventory = makeInventory(critical, high, media)
    const downloaded = new Set(['https://cdn/a.css', 'https://cdn/a.js', 'https://cdn/a.jpg'])

    const result = runAssetCheck({
      inventory,
      stats: { assetsDownloaded: 3, assetsFailed: 0, totalAssetBytes: 1024 },
      downloadedUrls: downloaded,
    })
    expect(result.score).toBe(100)
    expect(result.passed).toBe(true)
  })

  it('still passes when only media is partial (80% threshold)', () => {
    // 1 critical 100% (70), 1 high 100% (20), 5 media with 3/5 (10 * 0.6 = 6) = 96
    const critical = [asset('https://cdn/a.css', 'css')]
    const high = [asset('https://cdn/a.js', 'js')]
    const media = [
      asset('https://cdn/a.jpg'),
      asset('https://cdn/b.jpg'),
      asset('https://cdn/c.jpg'),
      asset('https://cdn/d.jpg'),
      asset('https://cdn/e.jpg'),
    ]
    const inventory = makeInventory(critical, high, media)
    const downloaded = new Set([
      'https://cdn/a.css',
      'https://cdn/a.js',
      'https://cdn/a.jpg',
      'https://cdn/b.jpg',
      'https://cdn/c.jpg',
    ])
    const result = runAssetCheck({
      inventory,
      stats: { assetsDownloaded: 5, assetsFailed: 2, totalAssetBytes: 1024 },
      downloadedUrls: downloaded,
    })
    expect(result.score).toBeGreaterThanOrEqual(80)
    // Media tier is warning-level, not critical.
    const mediaFinding = result.findings.find((f) => f.message.includes('Media'))
    expect(mediaFinding?.severity).toBe('warning')
  })
})

describe('runAssetCheck — discovery/execution gap', () => {
  it('emits a warning when stats attempted fewer assets than inventory discovered', () => {
    const inventory = makeInventory(
      [],
      [],
      [asset('https://cdn/a.jpg'), asset('https://cdn/b.jpg'), asset('https://cdn/c.jpg')],
    )
    const result = runAssetCheck({
      inventory,
      // Only attempted 1 — inventory had 3.
      stats: { assetsDownloaded: 1, assetsFailed: 0, totalAssetBytes: 100 },
    })
    expect(result.findings.some(
      (f) => f.severity === 'warning' && f.message.includes('only attempted'),
    )).toBe(true)
  })
})
