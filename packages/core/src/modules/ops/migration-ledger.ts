/**
 * Gbox Platform — Migration Ledger Drift Detector (Phase 11 PR1)
 *
 * Every `packages/db/src/migrations/NNN_*.ts` must also be wired into
 * `packages/db/src/migrations/run.ts` — both as an `import` at the top
 * and as a `{ name, fn }` row in the exported `migrations[]` array. The
 * name in the array is the file stem (`072_phase10_perf_indexes`).
 *
 * The ledger mechanism in `run.ts` tracks applied rows by NAME, so if a
 * file lands on disk without a row in `migrations[]`, the runner silently
 * skips it ("0 applied, N skipped" with no mention of the new file) and
 * callers blame the DB for columns that never got created.
 *
 * This has already burned us multiple times — called out explicitly in
 * the Phase 9 PR1 and PR2 drain logs. See CLAUDE-EXTENDED.md:
 *
 *   "Running the script before adding the import skips the file silently
 *    (no error, just '0 applied, 69 skipped')."
 *
 * This helper gives the release-check (and unit tests) a deterministic
 * way to catch drift before it ships.
 *
 * The helper is pure — both inputs (list of filenames + run.ts source)
 * are injected, so callers (CLI or release-check) can source them from
 * disk and unit tests can source them from fixtures.
 */

export interface LedgerInputs {
  /**
   * File names found in `packages/db/src/migrations/` — `.ts` files
   * only, with the extension stripped. Caller is expected to filter
   * `run.ts` / `index.ts` / test files out.
   *
   * Example: `['001_initial', '072_phase10_perf_indexes']`.
   */
  filesOnDisk: string[]

  /**
   * Raw source of `packages/db/src/migrations/run.ts`. The helper
   * parses out `{ name: "..." }` entries and the `import { up as ... }
   * from "./FILENAME.ts"` lines from it.
   */
  runTsSource: string

  /**
   * File stems accepted as legitimate NNN-prefix collisions.
   *
   * The ledger tracks applied rows by full name, so two migrations
   * sharing the same NNN prefix are safe AS LONG AS they both land in
   * `run.ts` with distinct registrations. But unintentional collisions
   * are a footgun — if two features pick the same NNN and only one
   * gets registered, the other silently vanishes. This lets new
   * collisions fail the drift check unless explicitly accepted.
   *
   * Defaults to the known-good 053-056 cluster (see run.ts L94-105):
   * PR#10's 2FA/hardening/TLS/IP-allowlist chain collides with the
   * Phase 4/5 customer chain that landed in parallel. Both are live,
   * both apply, no data has been lost — but we want to lock this in
   * as "these four numbers were the one-time mess, no more after that."
   */
  acceptedCollisions?: readonly string[]
}

/**
 * The 9 files that make up the known-good 053-056 collision cluster.
 * New collisions outside this set fail the drift check; new additions
 * here require an explicit comment justifying why a fresh number wasn't
 * picked instead.
 */
export const DEFAULT_ACCEPTED_COLLISIONS: readonly string[] = [
  // 053 — Phase 5 thaibq promotion × PR#10 2FA
  '053_promote_thaibq_default_admin',
  '053_two_factor_auth',
  // 054 — Phase 4 customer notes × Phase 2 variant deep fields × PR#10 hardening
  '054_customer_notes',
  '054_god_admin_hardening',
  '054_variant_deep_fields',
  // 055 — Phase 4 customer segments × PR#10 edge TLS
  '055_customer_segments',
  '055_edge_tls_self_hosted',
  // 056 — Phase 4 customer lifecycle × PR#10 admin IP allowlist
  '056_admin_ip_allowlist',
  '056_customer_lifecycle',
]

export interface LedgerReport {
  /** File stems found on disk. */
  filesOnDisk: readonly string[]

  /** Names found in the `migrations[]` array (the `{ name: "..." }` rows). */
  registeredNames: readonly string[]

  /**
   * Names referenced in `import` statements at the top of run.ts.
   * We surface this so a "imported but not in array" mistake also
   * trips the drift check — that's what happened in the PR2 gotcha
   * ("forgot the { name, fn } row in the array").
   */
  importedNames: readonly string[]

  /**
   * Files on disk that are NOT present in `migrations[]`. These are the
   * silent-skip bugs — migration file landed, but runner doesn't know.
   * Fails the drift check.
   */
  missingRegistrations: readonly string[]

  /**
   * Files imported at the top of run.ts but NOT present in `migrations[]`.
   * Almost always the "forgot the row" mistake.
   */
  importedButNotInArray: readonly string[]

  /**
   * Names in `migrations[]` with no corresponding file on disk. These
   * are usually the aftermath of a file being renamed or deleted
   * without updating run.ts. Fails the drift check.
   */
  orphanedRegistrations: readonly string[]

  /**
   * Files that share an NNN prefix with at least one other file AND
   * are NOT in the acceptedCollisions allowlist. Fails the drift check.
   *
   * Collisions are not inherently broken — the _migrations table keys
   * by full name, not number — but every unintentional collision we've
   * hit in the phase drain ate ~2 hours of debug time. Policy: pick a
   * fresh NNN. If you genuinely need to collide (e.g. two independent
   * branches raced), extend `DEFAULT_ACCEPTED_COLLISIONS`.
   */
  unacceptedCollisions: readonly string[]

  /** True iff every file is registered AND every registration has a file. */
  isClean: boolean
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract the `name: "..."` tokens from the `migrations[]` array.
 *
 * Matches both single and double quotes, and tolerates varying whitespace.
 * Intentionally does NOT try to parse the full TS AST — a regex is enough
 * here because the format is highly constrained (one migration per line
 * with a `name: "..."` and an `fn: up...`).
 *
 * Examples that match:
 *   { name: "001_initial", fn: up001 },
 *   { name: '072_phase10_perf_indexes', fn: up072 },
 *   {  name:   "054_variant_deep_fields",  fn: up054_variant  },
 */
export function extractRegisteredNames(source: string): string[] {
  const re = /\bname\s*:\s*['"]([\w-]+)['"]/g
  const names: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    names.push(m[1])
  }
  return names
}

/**
 * Extract the file stems from the top-of-file `import ... from "./NAME.ts"`
 * lines. Useful for catching the "imported but not in array" mistake.
 *
 * Matches both `.ts` and no-extension imports (though run.ts canonically
 * uses `.ts` — this is just defensive).
 */
export function extractImportedNames(source: string): string[] {
  const re = /from\s+['"]\.\/([\w-]+)(?:\.ts)?['"]/g
  const names: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    // Skip non-migration imports (the file imports only from ./ for
    // migrations, but defensively screen for the NNN[letter]_ stem
    // pattern — the optional letter supports companion migrations
    // like 091b_... that share a number with the primary migration).
    if (/^\d{3}[a-z]?_/.test(m[1])) {
      names.push(m[1])
    }
  }
  return names
}

// ---------------------------------------------------------------------------
// Collision detection
// ---------------------------------------------------------------------------

/**
 * Find migration files that share an NNN prefix with at least one
 * other file AND aren't in the `accepted` allowlist.
 *
 * Pure helper — caller supplies both the filename list (e.g. from
 * `fs.readdirSync`) and the allowlist.
 */
export function detectUnacceptedCollisions(
  filesOnDisk: readonly string[],
  accepted: ReadonlySet<string>,
): string[] {
  // Group stems by their NNN prefix. Anything that doesn't match
  // `^\d{3}_` is ignored — callers have already filtered run.ts /
  // index.ts / test files out, but we stay defensive.
  const byPrefix = new Map<string, string[]>()
  for (const name of filesOnDisk) {
    const m = /^(\d{3})_/.exec(name)
    if (!m) continue
    const key = m[1]
    const list = byPrefix.get(key)
    if (list) {
      list.push(name)
    } else {
      byPrefix.set(key, [name])
    }
  }

  const offenders: string[] = []
  for (const files of byPrefix.values()) {
    if (files.length < 2) continue
    // A colliding cluster is only "accepted" if every file in it
    // appears in the allowlist. If even one isn't accepted, that
    // file (and any sibling that isn't accepted) is flagged.
    for (const f of files) {
      if (!accepted.has(f)) offenders.push(f)
    }
  }
  return offenders.sort()
}

// ---------------------------------------------------------------------------
// Main analyser
// ---------------------------------------------------------------------------

export function analyseLedger(input: LedgerInputs): LedgerReport {
  const { filesOnDisk, runTsSource } = input
  const acceptedSet = new Set(
    input.acceptedCollisions ?? DEFAULT_ACCEPTED_COLLISIONS,
  )

  const registered = extractRegisteredNames(runTsSource)
  const imported = extractImportedNames(runTsSource)

  const registeredSet = new Set(registered)
  const diskSet = new Set(filesOnDisk)

  const missingRegistrations = filesOnDisk
    .filter((f) => !registeredSet.has(f))
    .sort()

  const importedButNotInArray = imported
    .filter((n) => !registeredSet.has(n))
    .sort()

  const orphanedRegistrations = registered
    .filter((n) => !diskSet.has(n))
    .sort()

  const unacceptedCollisions = detectUnacceptedCollisions(
    filesOnDisk,
    acceptedSet,
  )

  const isClean =
    missingRegistrations.length === 0 &&
    importedButNotInArray.length === 0 &&
    orphanedRegistrations.length === 0 &&
    unacceptedCollisions.length === 0

  return {
    filesOnDisk: [...filesOnDisk].sort(),
    registeredNames: [...registered].sort(),
    importedNames: [...imported].sort(),
    missingRegistrations,
    importedButNotInArray,
    orphanedRegistrations,
    unacceptedCollisions,
    isClean,
  }
}

// ---------------------------------------------------------------------------
// Human-readable formatter
// ---------------------------------------------------------------------------

export function formatLedgerReport(r: LedgerReport): string {
  const lines: string[] = []
  lines.push('Migration ledger report')
  lines.push('-'.repeat(50))
  lines.push(`  Files on disk:      ${r.filesOnDisk.length}`)
  lines.push(`  Registered (array): ${r.registeredNames.length}`)
  lines.push(`  Imported (top):     ${r.importedNames.length}`)
  lines.push('')

  if (r.missingRegistrations.length > 0) {
    lines.push(`[DRIFT] ${r.missingRegistrations.length} migration(s) on disk but NOT in migrations[] array:`)
    for (const n of r.missingRegistrations) lines.push(`  - ${n}`)
    lines.push('')
  }

  if (r.importedButNotInArray.length > 0) {
    lines.push(`[DRIFT] ${r.importedButNotInArray.length} migration(s) imported but NOT in migrations[] array:`)
    for (const n of r.importedButNotInArray) lines.push(`  - ${n}`)
    lines.push('')
  }

  if (r.orphanedRegistrations.length > 0) {
    lines.push(`[DRIFT] ${r.orphanedRegistrations.length} migration(s) in migrations[] array but NO file on disk:`)
    for (const n of r.orphanedRegistrations) lines.push(`  - ${n}`)
    lines.push('')
  }

  // Pre-PR3 callers may pass a LedgerReport-shaped fixture that
  // predates the `unacceptedCollisions` field (added with the NNN
  // collision-lint in Phase 11 PR3). Defensive `?? []` keeps the
  // formatter working with those fixtures instead of crashing on
  // `length of undefined`.
  const unaccepted = r.unacceptedCollisions ?? []
  if (unaccepted.length > 0) {
    lines.push(`[DRIFT] ${unaccepted.length} migration(s) collide on NNN prefix and are NOT in the accepted allowlist:`)
    for (const n of unaccepted) lines.push(`  - ${n}`)
    lines.push('  (pick a fresh NNN, or extend DEFAULT_ACCEPTED_COLLISIONS with justification.)')
    lines.push('')
  }

  lines.push(r.isClean ? '[ok] ledger clean — no drift detected' : '[FAIL] ledger drift detected')
  return lines.join('\n')
}
