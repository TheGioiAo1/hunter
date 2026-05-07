import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoReadTool } from './repo-read.ts'

describe('repo.read', () => {
  it('parseInput rejects missing path', () => {
    expect(() => repoReadTool.parseInput({})).toThrow(/path must be/)
  })

  it('parseInput accepts path + range', () => {
    expect(repoReadTool.parseInput({ path: 'x.ts', fromLine: 1, toLine: 5 })).toEqual({
      path: 'x.ts',
      fromLine: 1,
      toLine: 5,
    })
  })

  it('reads a file from repoRoot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-read-'))
    try {
      writeFileSync(join(root, 'hello.txt'), 'line1\nline2\nline3\n')
      const result = await repoReadTool.run(
        { path: 'hello.txt' },
        { repoRoot: root },
      )
      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') {
        expect((result.data as any).content).toBe('line1\nline2\nline3\n')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('applies line range', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-read-'))
    try {
      writeFileSync(join(root, 'x.txt'), 'a\nb\nc\nd\ne\n')
      const result = await repoReadTool.run(
        { path: 'x.txt', fromLine: 2, toLine: 4 },
        { repoRoot: root },
      )
      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') {
        expect((result.data as any).content).toBe('b\nc\nd')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns error when file is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-read-'))
    try {
      const result = await repoReadTool.run({ path: 'nope.txt' }, { repoRoot: root })
      expect(result.kind).toBe('error')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
