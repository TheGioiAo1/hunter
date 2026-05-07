import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathWhitelist } from './path-whitelist.ts'
import type { ToolCall, SessionContext } from './types.ts'

/**
 * The layer inspects tool calls that carry a `path` field. Non-path
 * calls (e.g. bash.run) are pass-through — the chain's later layers
 * handle those.
 */

let repoRoot: string
let crossRepoRoot: string
let symlinkedFile: string
let symlinksWorked = true

beforeAll(() => {
  // Two fake repo roots + one symlink that escapes them, used across
  // all cases in this suite.
  repoRoot = mkdtempSync(join(tmpdir(), 'gbox-platform-'))
  crossRepoRoot = mkdtempSync(join(tmpdir(), 'gbox-emdash-admin-'))
  mkdirSync(join(repoRoot, 'apps', 'storefront'), { recursive: true })
  writeFileSync(join(repoRoot, 'apps', 'storefront', 'index.ts'), '// ok')
  writeFileSync(join(repoRoot, '.env'), 'SECRET=1')
  mkdirSync(join(repoRoot, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(repoRoot, 'node_modules', 'react', 'index.js'), 'module.exports={}')

  // Symlink inside repo that points OUTSIDE both roots — must be denied
  // after symlink resolution.
  try {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    writeFileSync(join(outside, 'stolen.txt'), 'secret')
    symlinkedFile = join(repoRoot, 'escape-link')
    symlinkSync(join(outside, 'stolen.txt'), symlinkedFile)
  } catch (err) {
    // Windows without Developer Mode / admin cannot create file symlinks.
    // The symlink-escape case is Linux-focused; skip it on this host.
    symlinksWorked = false
    symlinkedFile = ''
  }
})

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  rmSync(crossRepoRoot, { recursive: true, force: true })
})

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: 's1',
    godAdminId: 'u1',
    toolCallCount: 0,
    tier3CallsLast5Min: [],
    consecutiveEditFailures: new Map(),
    bashInFlight: false,
    circuitBreakerOpen: false,
    trafficLevel: 'low',
    currentTime: new Date('2026-04-10T10:00:00Z'),
    repoRoot,
    crossRepoRoots: [crossRepoRoot],
    ...overrides,
  }
}

function call(name: string, input: unknown, tier: 1 | 2 | 3 | 4 = 3): ToolCall {
  return { id: 'tc1', name, input, tier }
}

describe('pathWhitelist', () => {
  it('allows absolute path inside repo root / apps/', async () => {
    const r = await pathWhitelist.check(
      call('repo.read', { path: join(repoRoot, 'apps', 'storefront', 'index.ts') }),
      ctx(),
    )
    expect(r).toEqual({ allowed: true })
  })

  it('allows a relative path resolved against repoRoot', async () => {
    const r = await pathWhitelist.check(
      call('repo.read', { path: 'apps/storefront/index.ts' }),
      ctx(),
    )
    expect(r).toEqual({ allowed: true })
  })

  it('allows path inside crossRepoRoots entry', async () => {
    mkdirSync(join(crossRepoRoot, 'src'), { recursive: true })
    writeFileSync(join(crossRepoRoot, 'src', 'x.ts'), '')
    const r = await pathWhitelist.check(
      call('repo.read', { path: join(crossRepoRoot, 'src', 'x.ts') }),
      ctx(),
    )
    expect(r).toEqual({ allowed: true })
  })

  it.each([
    ['.env', '.env'],
    ['.env.local', '.env.local'],
    ['node_modules dep', 'node_modules/react/index.js'],
    ['.git/objects', '.git/objects/pack/pack-abc.idx'],
    ['.git/hooks', '.git/hooks/pre-commit'],
    ['dist', 'dist/bundle.js'],
    ['build', 'build/index.html'],
    ['.superpowers', '.superpowers/state.json'],
  ])('denies %s', async (_label, rel) => {
    const r = await pathWhitelist.check(
      call('repo.read', { path: join(repoRoot, rel) }),
      ctx(),
    )
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.layer).toBe('path-whitelist')
  })

  it('denies path traversal that escapes repo root', async () => {
    const r = await pathWhitelist.check(
      call('repo.read', { path: join(repoRoot, 'apps', '..', '..', '..', 'etc', 'passwd') }),
      ctx(),
    )
    expect(r.allowed).toBe(false)
  })

  it('denies symlink that escapes allowed roots after resolution', async (t) => {
    // Windows without Developer Mode / admin cannot create file symlinks,
    // so beforeAll may have failed to create the symlinked fixture. Skip
    // at runtime (post-beforeAll) rather than using it.skipIf, which is
    // evaluated at collection time before the fixture flag is set.
    if (!symlinksWorked) {
      t.skip()
      return
    }
    const r = await pathWhitelist.check(
      call('repo.read', { path: symlinkedFile }),
      ctx(),
    )
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/symlink|outside/i)
  })

  it('passes through tool calls with no path field (e.g. bash.run)', async () => {
    const r = await pathWhitelist.check(
      call('bash.run', { command: 'npm test' }),
      ctx(),
    )
    expect(r).toEqual({ allowed: true })
  })

  it('rejects tool calls whose path field is not a string', async () => {
    const r = await pathWhitelist.check(
      call('repo.read', { path: 42 }),
      ctx(),
    )
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/path must be a string/i)
  })

  it('rejects tool calls where path is an empty string', async () => {
    const r = await pathWhitelist.check(
      call('repo.read', { path: '' }),
      ctx(),
    )
    expect(r.allowed).toBe(false)
  })

  it('denies .env deep in a nested app dir (glob match, not prefix)', async () => {
    mkdirSync(join(repoRoot, 'apps', 'web'), { recursive: true })
    writeFileSync(join(repoRoot, 'apps', 'web', '.env.production'), '')
    const r = await pathWhitelist.check(
      call('repo.read', { path: join(repoRoot, 'apps', 'web', '.env.production') }),
      ctx(),
    )
    expect(r.allowed).toBe(false)
  })
})
