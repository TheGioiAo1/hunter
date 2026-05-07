/**
 * SectionChip — small icon+label tile representing a single detected
 * Gbox Dawn section from a cloned page. The icon map covers the 20
 * stock Dawn sections; unknown section IDs fall back to 🧩.
 */

import { esc } from './esc.js'

export const SECTION_ICONS: Record<string, string> = {
  hero: '🎯',
  'featured-collection': '🛍️',
  'image-with-text': '🖼️',
  newsletter: '📧',
  testimonials: '💬',
  'rich-text': '📝',
  video: '🎬',
  collage: '🎨',
  slideshow: '🎞️',
  'collection-list': '📚',
  'featured-product': '⭐',
  'custom-liquid': '💧',
  contact: '📮',
  'page-content': '📄',
  'blog-posts': '📰',
  'product-recommendations': '✨',
  logos: '🏷️',
  countdown: '⏳',
  banner: '🎌',
  accordion: '📂',
}

function titleCase(id: string): string {
  return id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export interface SectionChipProps {
  sectionId: string
  position: number
  meta?: string
}

export function renderSectionChip(p: SectionChipProps): string {
  const icon = SECTION_ICONS[p.sectionId] ?? '🧩'
  const meta = p.meta ?? `position ${p.position}`
  return `
<div class="gbx-section-chip">
  <div class="gbx-section-icon">${icon}</div>
  <div class="gbx-section-label">${esc(titleCase(p.sectionId))}</div>
  <div class="gbx-section-meta">${esc(meta)}</div>
</div>`
}

export const sectionChipCss = `
.gbx-section-chip { background:var(--surface-1);border:1px solid var(--border);border-radius:6px;padding:10px;text-align:center }
.gbx-section-icon { font-size:20px;line-height:1 }
.gbx-section-label { color:var(--text);font-size:11px;font-weight:600;margin-top:4px }
.gbx-section-meta { color:var(--text-muted);font-size:9px;margin-top:2px }
`
