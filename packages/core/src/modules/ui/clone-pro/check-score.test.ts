import { describe, it, expect } from 'vitest'
import { renderCheckScore, checkScoreCss } from './check-score.js'

describe('CheckScore', () => {
  it('renders name + numeric score', () => {
    const html = renderCheckScore({ name: 'CSS Match', score: 98, status: 'pass' })
    expect(html).toContain('CSS Match')
    expect(html).toContain('>98<')
  })
  it('uses status-succeeded border for pass', () => {
    expect(renderCheckScore({ name: 'x', score: 100, status: 'pass' })).toContain(
      'var(--status-succeeded)',
    )
  })
  it('uses status-paused border for warn', () => {
    expect(renderCheckScore({ name: 'x', score: 70, status: 'warn' })).toContain(
      'var(--status-paused)',
    )
  })
  it('uses status-failed border for fail', () => {
    expect(renderCheckScore({ name: 'x', score: 30, status: 'fail' })).toContain(
      'var(--status-failed)',
    )
  })
  it('renders weight and sub metadata when given', () => {
    const html = renderCheckScore({
      name: 'x',
      score: 80,
      status: 'pass',
      weight: 40,
      sub: '38/48',
    })
    expect(html).toContain('weight 40')
    expect(html).toContain('38/48')
  })
  it('escapes name', () => {
    expect(renderCheckScore({ name: '<img>', score: 50, status: 'warn' })).not.toContain(
      '<img>',
    )
  })
  it('exports checkScoreCss', () => {
    expect(checkScoreCss).toMatch(/gbx-check/)
  })
})
