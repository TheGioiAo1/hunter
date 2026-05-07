/**
 * Clone Pro — resume helpers tests
 *
 * Pins the two properties we care about most:
 *
 *   1. `computeResumeFromStage` picks the correct resume point from
 *      an arbitrary stages_json payload and returns null when a full
 *      re-run is the only safe option.
 *
 *   2. `RESUMABLE_STAGES` and `CLONE_STAGES_ORDER` stay in sync with
 *      the pipeline's `CloneStage` type — catching refactors that
 *      rename or reorder stages without updating this list.
 */
import { describe, it, expect } from 'vitest'
import type { CloneJobStageEntry } from '@gbox/db/schema/tables.js'
import {
  CLONE_STAGES_ORDER,
  RESUMABLE_STAGES,
  isResumableStage,
  stageIsBefore,
  computeResumeFromStage,
} from './resume.js'

function stage(
  s: string,
  status: CloneJobStageEntry['status'],
): CloneJobStageEntry {
  return {
    stage: s,
    status,
    started_at: '2026-04-16T00:00:00Z',
    finished_at: '2026-04-16T00:01:00Z',
  }
}

// ---------------------------------------------------------------------------
// CLONE_STAGES_ORDER + RESUMABLE_STAGES invariants
// ---------------------------------------------------------------------------

describe('CLONE_STAGES_ORDER', () => {
  it('has all 10 pipeline stages in canonical order', () => {
    expect(CLONE_STAGES_ORDER).toEqual([
      'detect',
      'crawl',
      'extract_design',
      'extract_content',
      'generate_theme',
      'import_data',
      'ingest_media',
      'apply_brand',
      'seo_optimize',
      'finalize',
    ])
  })

  it('has no duplicates', () => {
    expect(new Set(CLONE_STAGES_ORDER).size).toBe(CLONE_STAGES_ORDER.length)
  })
})

describe('RESUMABLE_STAGES', () => {
  it('covers only the tail stages that read from DB/config alone', () => {
    expect(Array.from(RESUMABLE_STAGES).sort()).toEqual([
      'apply_brand',
      'finalize',
      'seo_optimize',
    ])
  })

  it('isResumableStage agrees with the set', () => {
    expect(isResumableStage('apply_brand')).toBe(true)
    expect(isResumableStage('seo_optimize')).toBe(true)
    expect(isResumableStage('finalize')).toBe(true)
    expect(isResumableStage('crawl')).toBe(false)
    expect(isResumableStage('import_data')).toBe(false)
  })
})

describe('stageIsBefore', () => {
  it('returns true for stages earlier in the pipeline', () => {
    expect(stageIsBefore('crawl', 'seo_optimize')).toBe(true)
    expect(stageIsBefore('detect', 'finalize')).toBe(true)
  })
  it('returns false for equal or later stages', () => {
    expect(stageIsBefore('seo_optimize', 'seo_optimize')).toBe(false)
    expect(stageIsBefore('finalize', 'seo_optimize')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeResumeFromStage
// ---------------------------------------------------------------------------

describe('computeResumeFromStage', () => {
  it('returns null for an empty stages array', () => {
    expect(computeResumeFromStage([])).toBeNull()
  })

  it('returns null when the failure happened before any resumable stage', () => {
    // Last good stage: import_data (index 5). Next is ingest_media (6),
    // which is NOT resumable — so caller must re-run the whole job.
    const stages = [
      stage('detect', 'succeeded'),
      stage('crawl', 'succeeded'),
      stage('extract_design', 'succeeded'),
      stage('extract_content', 'succeeded'),
      stage('generate_theme', 'succeeded'),
      stage('import_data', 'succeeded'),
      stage('ingest_media', 'failed'),
    ]
    expect(computeResumeFromStage(stages)).toBeNull()
  })

  it('returns apply_brand when ingest_media succeeded and apply_brand failed', () => {
    const stages = [
      stage('detect', 'succeeded'),
      stage('ingest_media', 'succeeded'),
      stage('apply_brand', 'failed'),
    ]
    expect(computeResumeFromStage(stages)).toBe('apply_brand')
  })

  it('returns seo_optimize when apply_brand succeeded and seo_optimize failed', () => {
    const stages = [
      stage('detect', 'succeeded'),
      stage('ingest_media', 'succeeded'),
      stage('apply_brand', 'succeeded'),
      stage('seo_optimize', 'failed'),
    ]
    expect(computeResumeFromStage(stages)).toBe('seo_optimize')
  })

  it('returns finalize when seo_optimize succeeded and finalize failed', () => {
    const stages = [
      stage('seo_optimize', 'succeeded'),
      stage('finalize', 'failed'),
    ]
    expect(computeResumeFromStage(stages)).toBe('finalize')
  })

  it('treats "skipped" the same as "succeeded"', () => {
    const stages = [
      stage('ingest_media', 'skipped'),
      stage('apply_brand', 'failed'),
    ]
    expect(computeResumeFromStage(stages)).toBe('apply_brand')
  })

  it('ignores "running" and "failed" stages when picking the last good one', () => {
    const stages = [
      stage('ingest_media', 'succeeded'),
      stage('apply_brand', 'failed'),
      stage('apply_brand', 'running'), // a retry attempt
    ]
    expect(computeResumeFromStage(stages)).toBe('apply_brand')
  })

  it('returns null when everything already finished successfully', () => {
    const stages = [
      stage('seo_optimize', 'succeeded'),
      stage('finalize', 'succeeded'),
    ]
    expect(computeResumeFromStage(stages)).toBeNull()
  })

  it('ignores unknown stage names defensively', () => {
    const stages = [
      stage('bogus', 'succeeded') as CloneJobStageEntry,
      stage('apply_brand', 'succeeded'),
      stage('seo_optimize', 'failed'),
    ]
    expect(computeResumeFromStage(stages)).toBe('seo_optimize')
  })
})
