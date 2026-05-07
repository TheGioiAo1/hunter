/**
 * Clone-Pro runner — auto-publish gate (Phase 20 P2).
 *
 * `shouldAutoPublish` is a pure decision function — given the env
 * snapshot and the per-clone config override, return true iff the
 * runner should flip a clean-succeeded job to `published`.
 *
 * This test locks the contract:
 *
 *   - per-clone `false` ALWAYS wins (seller opt-out)
 *   - env `AUTO_PUBLISH_AFTER_CLONE === 'false'` disables platform-wide
 *     (ops kill-switch, no redeploy)
 *   - any other env value (including unset) enables auto-publish —
 *     this matches the spec D5 default-ON-in-prod choice
 */

import { describe, it, expect } from 'vitest'
import { shouldAutoPublish } from './runner.js'

describe('shouldAutoPublish — env default ON (Phase 20 D5)', () => {
  it('env unset + override unset → true (prod default)', () => {
    expect(shouldAutoPublish({ env: {}, configOverride: undefined })).toBe(true)
  })

  it('env "true" + override unset → true', () => {
    expect(
      shouldAutoPublish({
        env: { AUTO_PUBLISH_AFTER_CLONE: 'true' } as any,
        configOverride: undefined,
      }),
    ).toBe(true)
  })

  it('env "1" / "yes" / random string + override unset → true (only literal "false" disables)', () => {
    for (const raw of ['1', 'yes', 'on', 'whatever']) {
      expect(
        shouldAutoPublish({
          env: { AUTO_PUBLISH_AFTER_CLONE: raw } as any,
          configOverride: undefined,
        }),
        `env=${raw}`,
      ).toBe(true)
    }
  })
})

describe('shouldAutoPublish — kill switches', () => {
  it('env "false" + override unset → false (ops kill-switch wins)', () => {
    expect(
      shouldAutoPublish({
        env: { AUTO_PUBLISH_AFTER_CLONE: 'false' } as any,
        configOverride: undefined,
      }),
    ).toBe(false)
  })

  it('env "FALSE" / "False" → false (case-insensitive)', () => {
    for (const raw of ['FALSE', 'False', 'fAlSe']) {
      expect(
        shouldAutoPublish({
          env: { AUTO_PUBLISH_AFTER_CLONE: raw } as any,
          configOverride: undefined,
        }),
        `env=${raw}`,
      ).toBe(false)
    }
  })

  it('per-clone override false → false (seller opt-out wins regardless of env)', () => {
    expect(
      shouldAutoPublish({
        env: { AUTO_PUBLISH_AFTER_CLONE: 'true' } as any,
        configOverride: false,
      }),
    ).toBe(false)
  })

  it('env "false" + override true → false (kill-switch beats explicit YES)', () => {
    // The kill-switch is genuinely a kill-switch — when ops flip it,
    // they want NO auto-publish across the fleet, even if a caller
    // explicitly asks for one. A seller who really needs to publish
    // a stuck clone goes through the manual `postCloneProPublish`
    // route, which has its own grade + critical-finding gates.
    expect(
      shouldAutoPublish({
        env: { AUTO_PUBLISH_AFTER_CLONE: 'false' } as any,
        configOverride: true,
      }),
    ).toBe(false)
  })

  it('env unset + override true → true (explicit YES does not need an env opt-in)', () => {
    expect(
      shouldAutoPublish({
        env: {},
        configOverride: true,
      }),
    ).toBe(true)
  })
})

describe('shouldAutoPublish — Iron Rule 5 + safety', () => {
  it('non-string env values are treated as "not the literal false"', () => {
    // Defensive: process.env always gives strings, but make sure the
    // helper doesn't crash on a forced cast.
    expect(
      shouldAutoPublish({
        env: { AUTO_PUBLISH_AFTER_CLONE: 0 as any } as any,
        configOverride: undefined,
      }),
    ).toBe(true)
  })

  it('null configOverride is the same as undefined (default ON)', () => {
    expect(
      shouldAutoPublish({
        env: {},
        configOverride: null as any,
      }),
    ).toBe(true)
  })
})
