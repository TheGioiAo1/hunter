/**
 * Clone-pro UI component barrel.
 *
 * Re-exports every render helper, prop type, and per-component CSS
 * constant from this directory, plus a pre-concatenated
 * `cloneProCss` bundle so pages can inline the full stylesheet in
 * one `<style>` tag without having to enumerate each component.
 */

export * from './esc.js'
export * from './grade-badge.js'
export * from './check-score.js'
export * from './phase-timeline.js'
export * from './section-chip.js'
export * from './cost-estimate.js'
export * from './job-card.js'
export * from './job-table-row.js'
export * from './finding-row.js'
export * from './ready-banner.js'
export * from './live-log.js'
export * from './clone-form.js'

import { gradeBadgeCss } from './grade-badge.js'
import { checkScoreCss } from './check-score.js'
import { phaseTimelineCss } from './phase-timeline.js'
import { sectionChipCss } from './section-chip.js'
import { costEstimateCss } from './cost-estimate.js'
import { jobCardCss } from './job-card.js'
import { jobTableRowCss } from './job-table-row.js'
import { findingRowCss } from './finding-row.js'
import { readyBannerCss } from './ready-banner.js'
import { liveLogCss } from './live-log.js'
import { cloneFormCss } from './clone-form.js'

export const cloneProCss: string = [
  gradeBadgeCss,
  checkScoreCss,
  phaseTimelineCss,
  sectionChipCss,
  costEstimateCss,
  jobCardCss,
  jobTableRowCss,
  findingRowCss,
  readyBannerCss,
  liveLogCss,
  cloneFormCss,
].join('\n')
