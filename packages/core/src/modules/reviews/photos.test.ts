/**
 * Gbox Platform — Review Photos Unit Tests (Phase 10 PR3)
 *
 * The photos service has transactional semantics that the mock harness
 * can't reproduce end-to-end (SELECT→INSERT→UPDATE inside a txn). The
 * smoke script covers the live integration. Here we pin the simple
 * surface: constants + error class shape.
 */

import { describe, it, expect } from 'vitest'
import {
  MAX_PHOTOS_PER_REVIEW,
  ReviewPhotoLimitError,
} from './photos.js'

describe('Reviews / Photos', () => {
  it('caps photos at 8 per review', () => {
    expect(MAX_PHOTOS_PER_REVIEW).toBe(8)
  })

  describe('ReviewPhotoLimitError', () => {
    it('is an Error subclass', () => {
      const err = new ReviewPhotoLimitError('rev-1')
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe('ReviewPhotoLimitError')
    })

    it('embeds the review id in the message', () => {
      const err = new ReviewPhotoLimitError('rev-42')
      expect(err.message).toContain('rev-42')
      expect(err.message).toContain(String(MAX_PHOTOS_PER_REVIEW))
    })
  })
})
