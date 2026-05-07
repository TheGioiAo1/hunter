import { describe, it, expect } from 'vitest'
import { renderSectionChip, SECTION_ICONS, sectionChipCss } from './section-chip.js'

describe('SectionChip', () => {
  it('renders the section id label', () => {
    expect(renderSectionChip({ sectionId: 'hero', position: 0 })).toContain('Hero')
  })
  it('uses the icon map for known sections', () => {
    expect(renderSectionChip({ sectionId: 'featured-collection', position: 1 })).toContain(
      SECTION_ICONS['featured-collection']!,
    )
  })
  it('falls back to a generic icon for unknown sections', () => {
    expect(renderSectionChip({ sectionId: 'unknown-xyz', position: 3 })).toContain('🧩')
  })
  it('renders meta row when supplied', () => {
    expect(
      renderSectionChip({ sectionId: 'hero', position: 0, meta: 'collection=sale' }),
    ).toContain('collection=sale')
  })
  it('renders default position-based meta when no meta given', () => {
    expect(renderSectionChip({ sectionId: 'hero', position: 4 })).toContain('position 4')
  })
  it('escapes meta string', () => {
    expect(
      renderSectionChip({ sectionId: 'hero', position: 0, meta: '<img>' }),
    ).not.toContain('<img>')
  })
  it('exports all 20 Gbox Dawn section icons', () => {
    expect(Object.keys(SECTION_ICONS).length).toBeGreaterThanOrEqual(20)
  })
  it('exports sectionChipCss', () => {
    expect(sectionChipCss).toMatch(/gbx-section-chip/)
  })
})
