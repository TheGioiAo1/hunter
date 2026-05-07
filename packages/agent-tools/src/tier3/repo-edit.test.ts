import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoEditTool } from './repo-edit.ts'

function setup(): { root: string } {
  return { root: mkdtempSync(join(tmpdir(), 'repo-edit-')) }
}

describe('repo.edit', () => {
  it('replaces a single unique occurrence', async () => {
    const { root } = setup()
    try {
      writeFileSync(join(root, 'f.ts'), 'const a = 1\nconst b = 2\n')
      const result = await repoEditTool.run(
        { path: 'f.ts', oldString: 'const b = 2', newString: 'const b = 42' },
        { repoRoot: root },
      )
      expect(result.kind).toBe('ok')
      expect(readFileSync(join(root, 'f.ts'), 'utf-8')).toBe('const a = 1\nconst b = 42\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails with ambiguous when oldString matches multiple times without replaceAll', async () => {
    const { root } = setup()
    try {
      writeFileSync(join(root, 'f.ts'), 'x\nx\nx\n')
      const result = await repoEditTool.run(
        { path: 'f.ts', oldString: 'x', newString: 'y' },
        { repoRoot: root },
      )
      expect(result.kind).toBe('error')
      if (result.kind === 'error') {
        expect(result.code).toBe('ambiguous')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaceAll=true rewrites every match', async () => {
    const { root } = setup()
    try {
      writeFileSync(join(root, 'f.ts'), 'x\nx\nx\n')
      const result = await repoEditTool.run(
        { path: 'f.ts', oldString: 'x', newString: 'y', replaceAll: true },
        { repoRoot: root },
      )
      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') {
        expect((result.data as any).replacements).toBe(3)
      }
      expect(readFileSync(join(root, 'f.ts'), 'utf-8')).toBe('y\ny\ny\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails when oldString is not found', async () => {
    const { root } = setup()
    try {
      writeFileSync(join(root, 'f.ts'), 'abc')
      const result = await repoEditTool.run(
        { path: 'f.ts', oldString: 'xyz', newString: 'qqq' },
        { repoRoot: root },
      )
      expect(result.kind).toBe('error')
      if (result.kind === 'error') expect(result.code).toBe('not_found')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('parseInput rejects identical old/new strings', () => {
    expect(() =>
      repoEditTool.parseInput({ path: 'f.ts', oldString: 'x', newString: 'x' }),
    ).toThrow(/must differ/)
  })
})
