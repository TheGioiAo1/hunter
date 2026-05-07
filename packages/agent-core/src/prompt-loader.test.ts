import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPrompt, hashPrompt } from './prompt-loader.ts'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agent-core-prompt-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadPrompt — happy path', () => {
  it('reads a named prompt file from the given dir', async () => {
    writeFileSync(join(tmpDir, 'test-prompt.md'), '# hello\nworld')

    const result = await loadPrompt({ name: 'test-prompt', promptsDir: tmpDir })

    expect(result.name).toBe('test-prompt')
    expect(result.content).toContain('# hello')
    expect(result.content).toContain('world')
    expect(result.rawHash.startsWith('sha256:')).toBe(true)
  })

  it('interpolates {{CURRENT_PHASE}}', async () => {
    writeFileSync(join(tmpDir, 'p.md'), 'phase is {{CURRENT_PHASE}}')

    const result = await loadPrompt({
      name: 'p',
      promptsDir: tmpDir,
      currentPhase: 'Phase 9.1',
    })

    expect(result.content).toBe('phase is Phase 9.1')
  })

  it('interpolates {{RECENT_COMMITS}} with multi-line input', async () => {
    writeFileSync(join(tmpDir, 'p.md'), 'last commits:\n{{RECENT_COMMITS}}')

    const result = await loadPrompt({
      name: 'p',
      promptsDir: tmpDir,
      recentCommits: 'abc123 feat: x\ndef456 fix: y',
    })

    expect(result.content).toContain('abc123 feat: x')
    expect(result.content).toContain('def456 fix: y')
  })

  it('defaults missing placeholders to sentinel values', async () => {
    writeFileSync(join(tmpDir, 'p.md'), '{{CURRENT_PHASE}} / {{RECENT_COMMITS}}')

    const result = await loadPrompt({ name: 'p', promptsDir: tmpDir })

    expect(result.content).toBe('(unknown) / (none)')
  })

  it('interpolates {{TIMESTAMP}} with an ISO string', async () => {
    writeFileSync(join(tmpDir, 'p.md'), 'now: {{TIMESTAMP}}')

    const result = await loadPrompt({ name: 'p', promptsDir: tmpDir })

    // Match ISO-8601 ending in Z
    expect(result.content).toMatch(/now: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
  })
})

describe('loadPrompt — safety', () => {
  it('rejects names with slashes', async () => {
    await expect(
      loadPrompt({ name: 'evil/passwd', promptsDir: tmpDir }),
    ).rejects.toThrow(/unsafe prompt name/)
  })

  it('rejects names with ..', async () => {
    await expect(
      loadPrompt({ name: '..', promptsDir: tmpDir }),
    ).rejects.toThrow(/unsafe prompt name/)
  })

  it('rejects empty name', async () => {
    await expect(
      loadPrompt({ name: '', promptsDir: tmpDir }),
    ).rejects.toThrow(/unsafe prompt name/)
  })
})

describe('hashPrompt — stability', () => {
  it('produces the same hash for CRLF and LF variants', () => {
    const lf = 'line1\nline2\n'
    const crlf = 'line1\r\nline2\r\n'
    expect(hashPrompt(lf)).toBe(hashPrompt(crlf))
  })

  it('produces a different hash when content differs', () => {
    expect(hashPrompt('abc')).not.toBe(hashPrompt('abd'))
  })

  it('returns a 16-hex-char suffix prefixed with sha256:', () => {
    const h = hashPrompt('anything')
    expect(h).toMatch(/^sha256:[0-9a-f]{16}$/)
  })
})
