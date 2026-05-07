import { describe, it, expect } from 'vitest'
import { renderFindingRow, findingRowCss } from './finding-row.js'

describe('FindingRow', () => {
  it('renders critical severity with red icon', () => {
    const html = renderFindingRow({
      finding: { severity: 'critical', title: 'Broken link', body: '/about missing' },
    })
    expect(html).toContain('var(--status-failed)')
    expect(html).toContain('!')
  })
  it('renders warning severity with amber icon', () => {
    const html = renderFindingRow({
      finding: { severity: 'warning', title: 'Slow', body: 'LCP 3.1s' },
    })
    expect(html).toContain('var(--status-paused)')
    expect(html).toContain('⚠')
  })
  it('renders info severity with blue icon', () => {
    const html = renderFindingRow({
      finding: { severity: 'info', title: 'Hint', body: 'tip' },
    })
    expect(html).toContain('var(--status-running)')
    expect(html).toContain('ℹ')
  })
  it('renders body text', () => {
    expect(
      renderFindingRow({
        finding: { severity: 'info', title: 't', body: 'very specific body text' },
      }),
    ).toContain('very specific body text')
  })
  it('renders inline action links', () => {
    const html = renderFindingRow({
      finding: {
        severity: 'warning',
        title: 't',
        body: 'b',
        actions: [
          { label: 'Fix', href: '/fix' },
          { label: 'Ignore', href: '/ignore' },
        ],
      },
    })
    expect(html).toContain('href="/fix"')
    expect(html).toContain('Fix')
    expect(html).toContain('Ignore')
  })
  it('escapes title and body', () => {
    const html = renderFindingRow({
      finding: { severity: 'warning', title: '<img>', body: '<script>' },
    })
    expect(html).not.toContain('<img>')
    expect(html).not.toContain('<script>')
  })
  it('sets data-severity for client filter', () => {
    expect(
      renderFindingRow({
        finding: { severity: 'critical', title: 't', body: 'b' },
      }),
    ).toContain('data-severity="critical"')
  })
  it('exports findingRowCss', () => {
    expect(findingRowCss).toMatch(/gbx-finding/)
  })
})
