/**
 * GradeBadge — renders a letter-grade pill (A–F) with status color.
 *
 * Three sizes: `sm` (22px chip), `md` (32px chip, default), `lg`
 * (72px circle used in the verification hero). Color comes from the
 * `--grade-a`..`--grade-f` tokens in `SELLER_STYLES` so light/dark
 * parity is automatic.
 */

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F'

export interface GradeBadgeProps {
  grade: Grade
  score?: number
  size?: 'sm' | 'md' | 'lg'
}

export function renderGradeBadge(p: GradeBadgeProps): string {
  const size = p.size ?? 'md'
  const tokenVar = `var(--grade-${p.grade.toLowerCase()})`
  const label =
    p.score != null
      ? `Grade ${p.grade} (${p.score} of 100)`
      : `Grade ${p.grade}`
  return `<span class="gbx-grade ${size}" style="--grade-color:${tokenVar}" aria-label="${label}" title="${label}">${p.grade}</span>`
}

export const gradeBadgeCss = `
.gbx-grade { display:inline-flex;align-items:center;justify-content:center;border-radius:6px;color:#fff;font-weight:700;background:var(--grade-color);box-shadow:0 0 14px color-mix(in srgb,var(--grade-color) 35%,transparent);line-height:1 }
.gbx-grade.sm { width:22px;height:22px;font-size:11px;border-radius:4px }
.gbx-grade.md { width:32px;height:32px;font-size:14px }
.gbx-grade.lg { width:72px;height:72px;font-size:36px;border-radius:50% }
`
