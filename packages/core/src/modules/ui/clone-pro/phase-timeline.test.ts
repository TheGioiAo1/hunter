import { describe, it, expect } from 'vitest'
import { renderPhaseTimeline, phaseTimelineCss } from './phase-timeline.js'

describe('PhaseTimeline', () => {
  const phases = [
    { id: 'discovery', label: 'Discovery', status: 'done' as const, meta: '48 pages · 12s' },
    {
      id: 'execution',
      label: 'Execution',
      status: 'active' as const,
      meta: '45%',
      substeps: ['Homepage clone', 'Section map'],
    },
    { id: 'verification', label: 'Verification', status: 'pending' as const },
  ]
  it('renders three nodes', () => {
    const html = renderPhaseTimeline({ phases })
    expect((html.match(/gbx-phase-node/g) ?? []).length).toBe(3)
  })
  it('marks done nodes with status-succeeded color', () => {
    expect(renderPhaseTimeline({ phases })).toContain('var(--status-succeeded)')
  })
  it('marks active nodes with status-running color', () => {
    expect(renderPhaseTimeline({ phases })).toContain('var(--status-running)')
  })
  it('renders substeps under active phase', () => {
    const html = renderPhaseTimeline({ phases })
    expect(html).toContain('Homepage clone')
    expect(html).toContain('Section map')
  })
  it('each node is keyboard-focusable', () => {
    expect(renderPhaseTimeline({ phases })).toContain('tabindex="0"')
  })
  it('each node has aria-label with status', () => {
    expect(renderPhaseTimeline({ phases })).toContain('aria-label="Discovery: done"')
  })
  it('escapes label text', () => {
    expect(
      renderPhaseTimeline({
        phases: [{ id: 'x', label: '<img>', status: 'pending' }],
      }),
    ).not.toContain('<img>')
  })
  it('exports phaseTimelineCss', () => {
    expect(phaseTimelineCss).toMatch(/gbx-phase/)
  })
})
