/**
 * CostEstimate — pure calculator + render helper for the clone-pro
 * form's live cost ticker. Pricing locked from Q5 brainstorm:
 *   - alt-text AI rewrite: 40¢ per clone
 *   - SEO AI rewrite:      25¢ per clone
 *
 * The rendered element carries a `data-cost-cents` hook so the
 * CloneForm runtime script (B11) can recompute the ticker in-place
 * when the merchant flips a toggle — no round-trip.
 */

export interface EstimateInput {
  altText: boolean
  seo: boolean
  pageCount?: number
}

export interface Estimate {
  altText: number
  seo: number
  totalCents: number
}

export function computeEstimate(i: EstimateInput): Estimate {
  const altText = i.altText ? 40 : 0
  const seo = i.seo ? 25 : 0
  return { altText, seo, totalCents: altText + seo }
}

function fmt(cents: number): string {
  if (cents === 0) return 'Free'
  return `$${(cents / 100).toFixed(2)}`
}

export function renderCostEstimate(i: EstimateInput): string {
  const e = computeEstimate(i)
  return `<span class="gbx-cost" data-cost-cents="${e.totalCents}">${fmt(e.totalCents)}</span>`
}

export const costEstimateCss = `
.gbx-cost { color:var(--text);font-weight:600 }
`
