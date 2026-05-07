/**
 * Gbox Platform — Review Votes Unit Tests (Phase 10 PR3)
 *
 * Pure unit tests for `hashVoterFingerprint`. The transactional
 * submit/remove code is covered by the smoke script against a real
 * Postgres instance — its counter updates depend on SQL-level
 * atomicity that the mock-DB harness can't faithfully reproduce.
 */

import { describe, it, expect } from 'vitest'
import { hashVoterFingerprint } from './votes.js'

describe('Reviews / Votes', () => {
  describe('hashVoterFingerprint', () => {
    it('returns a 64-char hex digest', () => {
      const h = hashVoterFingerprint('1.2.3.4', 'ua/1', 'salt')
      expect(h).toMatch(/^[a-f0-9]{64}$/)
    })

    it('is deterministic', () => {
      expect(hashVoterFingerprint('1.2.3.4', 'ua', 's')).toBe(
        hashVoterFingerprint('1.2.3.4', 'ua', 's'),
      )
    })

    it('changes with ip', () => {
      expect(hashVoterFingerprint('1.2.3.4', 'ua', 's')).not.toBe(
        hashVoterFingerprint('9.9.9.9', 'ua', 's'),
      )
    })

    it('changes with UA', () => {
      expect(hashVoterFingerprint('1.2.3.4', 'ua1', 's')).not.toBe(
        hashVoterFingerprint('1.2.3.4', 'ua2', 's'),
      )
    })

    it('changes with salt', () => {
      expect(hashVoterFingerprint('1.2.3.4', 'ua', 's1')).not.toBe(
        hashVoterFingerprint('1.2.3.4', 'ua', 's2'),
      )
    })

    it('tolerates null UA', () => {
      const h = hashVoterFingerprint('1.2.3.4', null, 's')
      expect(h).toMatch(/^[a-f0-9]{64}$/)
    })

    it('tolerates empty inputs', () => {
      const h = hashVoterFingerprint('', '', '')
      expect(h).toMatch(/^[a-f0-9]{64}$/)
    })
  })
})
