import { describe, it, expect } from 'vitest'
import { repoGlobTool } from './repo-glob.ts'

describe('repo.glob', () => {
  it('matches simple *.ts pattern', async () => {
    const result = await repoGlobTool.run(
      { pattern: '*.ts' },
      {
        repoRoot: '/repo',
        walkOverride: async () => ['/repo/a.ts', '/repo/b.js', '/repo/c.ts'],
      },
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect((result.data as any).matches).toEqual(['a.ts', 'c.ts'])
    }
  })

  it('matches **/*.ts recursively', async () => {
    const result = await repoGlobTool.run(
      { pattern: '**/*.ts' },
      {
        repoRoot: '/repo',
        walkOverride: async () => [
          '/repo/a.ts',
          '/repo/src/b.ts',
          '/repo/src/nested/c.ts',
          '/repo/README.md',
        ],
      },
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect((result.data as any).matches).toEqual(['a.ts', 'src/b.ts', 'src/nested/c.ts'])
    }
  })

  it('matches brace expansion {ts,tsx}', async () => {
    const result = await repoGlobTool.run(
      { pattern: '**/*.{ts,tsx}' },
      {
        repoRoot: '/repo',
        walkOverride: async () => ['/repo/a.ts', '/repo/b.tsx', '/repo/c.js'],
      },
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect((result.data as any).matches).toEqual(['a.ts', 'b.tsx'])
    }
  })

  it('honors limit', async () => {
    const result = await repoGlobTool.run(
      { pattern: '*.ts', limit: 2 },
      {
        repoRoot: '/repo',
        walkOverride: async () => ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts', '/repo/d.ts'],
      },
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect((result.data as any).matches).toHaveLength(2)
      expect((result.data as any).truncated).toBe(true)
    }
  })

  it('rejects empty pattern', () => {
    expect(() => repoGlobTool.parseInput({ pattern: '' })).toThrow()
  })
})
