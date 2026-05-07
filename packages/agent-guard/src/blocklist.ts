/**
 * Layer 2b — Blocklist.
 *
 * Pattern matches parsed `bash.run` commands against a fixed table of
 * dangerous operations grouped by category (A-O). The guard consumes
 * the flattened output of Layer 2a's parseCommand() so nested
 * substitution ($(...), backticks, bash -c) is already unwrapped.
 *
 * Adding a new pattern is two edits: (a) new row in PATTERNS below,
 * (b) new row in blocklist.test.ts under its category block.
 */

import { parseCommand, type ParsedCommand } from './command-parser.ts'
import type { GuardLayer, GuardResult, SessionContext, ToolCall } from './types.ts'

const NAME = 'blocklist'

export interface BlocklistMatch {
  category:
    | 'A'
    | 'B'
    | 'C'
    | 'D'
    | 'E'
    | 'F'
    | 'G'
    | 'H'
    | 'I'
    | 'J'
    | 'K'
    | 'L'
    | 'M'
    | 'N'
    | 'O'
  reason: string
}

type Matcher = (cmd: ParsedCommand, joined: string, raw: string) => BlocklistMatch | null

const SYSTEM_ROOTS = ['/etc', '/var', '/usr', '/boot', '/root', '/sys', '/proc']

function startsWithSystemRoot(arg: string): boolean {
  return SYSTEM_ROOTS.some((r) => arg === r || arg.startsWith(r + '/'))
}

const PATTERNS: Matcher[] = [
  // -----------------------------------------------------------------
  // A — Destructive rm -rf
  //
  // We match on the raw string in addition to the parsed argv, because
  // shell-quote drops glob patterns (`/*`) and unresolved env-var
  // expansions (`$HOME`) from its parse output — so a purely argv-based
  // check would miss `rm -rf /*` and `rm -rf $HOME`.
  // -----------------------------------------------------------------
  (cmd, _joined, raw) => {
    if (cmd[0] !== 'rm') return null
    const hasR = cmd.some((a) => a === '-rf' || a === '-Rf' || a === '-fr' || a === '-r' || a === '-R')
    if (!hasR) return null
    const targets = cmd.slice(1).filter((a) => !a.startsWith('-'))
    const LETHAL = new Set(['/', '/*', '~', '$HOME', '.', '..', '/root', '/etc', '/var', '/usr'])
    for (const t of targets) {
      if (LETHAL.has(t)) {
        return { category: 'A', reason: `destructive rm -rf target: ${t}` }
      }
    }
    // Raw-string fallback for targets shell-quote strips (globs, env vars).
    if (/^\s*rm\s+(-[rRf]+\s+)+(\/\*|\$HOME|~|\/)\s*$/.test(raw)) {
      return { category: 'A', reason: 'destructive rm -rf target (raw match)' }
    }
    if (/\brm\s+(-[rRf]+\s+)+(\/\*|\$HOME)(\s|$)/.test(raw)) {
      return { category: 'A', reason: 'destructive rm -rf target (raw match)' }
    }
    return null
  },

  // -----------------------------------------------------------------
  // B — Privilege escalation
  // -----------------------------------------------------------------
  (cmd) => {
    if (cmd[0] === 'sudo' || cmd[0] === 'doas') {
      return { category: 'B', reason: `privilege escalation via ${cmd[0]}` }
    }
    return null
  },

  // -----------------------------------------------------------------
  // C — Disk / partition
  // -----------------------------------------------------------------
  (cmd) => {
    if (cmd[0] === 'dd') {
      const hasOfDev = cmd.some((a) => a.startsWith('of=/dev/') && !a.startsWith('of=/dev/null'))
      if (hasOfDev) return { category: 'C', reason: 'dd writes to a block device' }
    }
    if (cmd[0]?.startsWith('mkfs')) return { category: 'C', reason: `filesystem creation: ${cmd[0]}` }
    if (cmd[0] === 'fdisk' || cmd[0] === 'parted') {
      return { category: 'C', reason: `partition tool: ${cmd[0]}` }
    }
    return null
  },

  // -----------------------------------------------------------------
  // D — Fork bombs
  //
  // parseCommand() splits on pipes/semicolons and strips many shell
  // metacharacters, so per-command `joined` values no longer contain
  // the telltale sequences (`:(){`, `| yes | yes`, `while … &`). These
  // patterns are only recognisable in the original raw string.
  // -----------------------------------------------------------------
  (_cmd, _joined, raw) => {
    // Classic `:(){ :|:& };:` — match on the raw form, tolerating
    // whitespace. The signature is the `:|:&` body or the function-decl
    // prefix `:(){`.
    if (/:\s*\(\s*\)\s*\{/.test(raw) || /:\s*\|\s*:\s*&/.test(raw)) {
      return { category: 'D', reason: 'classic fork bomb pattern' }
    }
    if (/while\s+true/i.test(raw) && /sh\s*-c/i.test(raw) && /&/.test(raw)) {
      return { category: 'D', reason: 'infinite spawning subshell loop' }
    }
    if (/\byes\b\s*\|\s*yes\b\s*\|\s*yes\b/i.test(raw)) {
      return { category: 'D', reason: 'yes pipe chain (fork bomb)' }
    }
    return null
  },

  // -----------------------------------------------------------------
  // E — Pipe-to-shell. parseCommand() splits pipes into separate
  // entries, so per-command `joined` never contains `|`. We must scan
  // the raw command string to catch `curl … | bash`.
  // -----------------------------------------------------------------
  (_cmd, _joined, raw) => {
    const fetch = /\b(curl|wget|fetch)\b/i
    const shell = /\|\s*(sh|bash|zsh|ksh|python3?|perl|ruby)\b/i
    if (fetch.test(raw) && shell.test(raw)) {
      return { category: 'E', reason: 'pipe-to-shell from network fetch' }
    }
    return null
  },

  // -----------------------------------------------------------------
  // F — Device writes
  // -----------------------------------------------------------------
  (cmd, joined) => {
    // Redirection into /dev/sd*, /dev/nvme*, /dev/hd*
    const DEVICE_RE = /\/dev\/(sd[a-z]\d*|nvme\d+n\d+(p\d+)?|hd[a-z]\d*|vd[a-z]\d*)/
    if (joined.match(DEVICE_RE)) {
      // dd of= already caught by C, but echo/cat > /dev/sda is F.
      if (cmd.includes('>') || cmd.some((a) => a.startsWith('of=/dev/'))) {
        return { category: 'F', reason: 'write to block device file' }
      }
      // Also catch plain `> /dev/sda` where `>` was preserved as a token.
      for (let i = 0; i < cmd.length - 1; i++) {
        if (cmd[i] === '>' && DEVICE_RE.test(cmd[i + 1]!)) {
          return { category: 'F', reason: 'write to block device file' }
        }
      }
    }
    return null
  },

  // -----------------------------------------------------------------
  // G — Permission bombs
  // -----------------------------------------------------------------
  (cmd) => {
    if (cmd[0] === 'chmod') {
      const mode = cmd.find((a) => /^[0-7]{3,4}$/.test(a) || a === '777')
      const target = cmd.slice(1).find((a) => !a.startsWith('-') && !/^[0-7]{3,4}$/.test(a))
      if (mode && target && (startsWithSystemRoot(target) || target === '/')) {
        return { category: 'G', reason: `chmod ${mode} on system path ${target}` }
      }
    }
    if (cmd[0] === 'chown') {
      // chown [flags] USER[:GROUP] PATH [PATH...] — the *last* positional
      // argument is the path, not the user. Walking `i > 0` in the sliced
      // array misfires on `chown -R nobody /etc` because `nobody` lives at
      // sliced-index 1 and gets returned before `/etc`.
      const positional = cmd.slice(1).filter((a) => !a.startsWith('-'))
      const target = positional[positional.length - 1]
      if (target && startsWithSystemRoot(target)) {
        return { category: 'G', reason: `chown on system path ${target}` }
      }
    }
    return null
  },

  // -----------------------------------------------------------------
  // H — Killswitch tampering
  // -----------------------------------------------------------------
  (_cmd, joined) => {
    if (joined.includes('/tmp/gbox-agent-killswitch')) {
      if (/\brm\b|\bmv\b|\bcp\b|>\s*\/tmp\/gbox-agent-killswitch/.test(joined)) {
        return { category: 'H', reason: 'tampering with agent killswitch flag file' }
      }
    }
    return null
  },

  // -----------------------------------------------------------------
  // I — Network exfil primitives
  // -----------------------------------------------------------------
  (cmd, joined) => {
    if ((cmd[0] === 'nc' || cmd[0] === 'ncat') && cmd.includes('-l')) {
      return { category: 'I', reason: 'netcat listener' }
    }
    if (/(python3?)\s+-m\s+http\.server/.test(joined)) {
      // Only dangerous if directory is / or /etc/… — we allow project-scoped dev servers.
      if (/--directory\s+(\/|\/etc|\/root|\/var)/.test(joined)) {
        return { category: 'I', reason: 'http.server exposing system directory' }
      }
    }
    return null
  },

  // -----------------------------------------------------------------
  // J — Process / cron tampering
  // -----------------------------------------------------------------
  (cmd) => {
    if (cmd[0] === 'crontab' && cmd.includes('-r')) {
      return { category: 'J', reason: 'crontab -r wipes scheduled tasks' }
    }
    if (cmd[0] === 'kill' && cmd.includes('-9') && cmd.includes('1')) {
      return { category: 'J', reason: 'kill -9 PID 1 (init)' }
    }
    if (cmd[0] === 'killall' && cmd.includes('-9') && cmd.some((a) => a === 'systemd' || a === 'init')) {
      return { category: 'J', reason: 'killall init process' }
    }
    return null
  },

  // -----------------------------------------------------------------
  // K — Package manager rewrites
  // -----------------------------------------------------------------
  (_cmd, joined) => {
    if (/\bnpm\s+config\s+set\s+registry\b/.test(joined)) {
      return { category: 'K', reason: 'npm registry override' }
    }
    if (/\byarn\s+config\s+set\s+npmRegistryServer\b/.test(joined)) {
      return { category: 'K', reason: 'yarn registry override' }
    }
    if (/\bpip\s+install\b.*--index-url/.test(joined)) {
      return { category: 'K', reason: 'pip --index-url override' }
    }
    return null
  },

  // -----------------------------------------------------------------
  // L — SSH key exfil
  // -----------------------------------------------------------------
  (_cmd, joined) => {
    if (/id_rsa|id_ed25519|id_ecdsa/.test(joined)) {
      if (/\bcat\b|\bscp\b|\bcp\b|\brsync\b/.test(joined)) {
        return { category: 'L', reason: 'SSH private key exfiltration pattern' }
      }
    }
    return null
  },

  // -----------------------------------------------------------------
  // M — Systemd / init tampering
  // -----------------------------------------------------------------
  (cmd, joined) => {
    if (cmd[0] === 'systemctl' || /\bsystemctl\b/.test(joined)) {
      const verbs = ['disable', 'mask', 'stop', 'kill']
      if (verbs.some((v) => cmd.includes(v) || joined.includes(` ${v} `))) {
        return { category: 'M', reason: 'systemctl mutation of system service' }
      }
    }
    return null
  },

  // -----------------------------------------------------------------
  // N — History / log wipe
  // -----------------------------------------------------------------
  (cmd, joined) => {
    if (cmd[0] === 'history' && cmd.includes('-c')) {
      return { category: 'N', reason: 'history -c' }
    }
    if (/>\s*~?\/?\.bash_history/.test(joined)) {
      return { category: 'N', reason: 'bash history truncation' }
    }
    if (/\brm\b.*\/var\/log\//.test(joined)) {
      return { category: 'N', reason: 'deleting /var/log entries' }
    }
    if (cmd[0] === 'truncate' && cmd.some((a) => a.startsWith('/var/log'))) {
      return { category: 'N', reason: 'truncating /var/log entries' }
    }
    return null
  },

  // -----------------------------------------------------------------
  // O — eval
  // -----------------------------------------------------------------
  (cmd) => {
    if (cmd[0] === 'eval') {
      return { category: 'O', reason: 'eval of arbitrary string' }
    }
    return null
  },
]

export function matchBlocklist(parsed: ParsedCommand[], raw: string = ''): BlocklistMatch | null {
  // Fallback: if the caller only supplied parsed input, reconstruct a
  // best-effort raw string by joining each command with ' ; '. This lets
  // the pure-helper callsites (and tests that pass parsed directly) still
  // exercise raw-dependent categories.
  const effectiveRaw = raw === '' ? parsed.map((c) => c.join(' ')).join(' ; ') : raw
  for (const cmd of parsed) {
    const joined = cmd.join(' ')
    for (const matcher of PATTERNS) {
      const hit = matcher(cmd, joined, effectiveRaw)
      if (hit) return hit
    }
  }
  return null
}

interface BashInput {
  command?: unknown
}

export const blocklist: GuardLayer = {
  name: NAME,
  async check(call: ToolCall, _ctx: SessionContext): Promise<GuardResult> {
    if (call.name !== 'bash.run') return { allowed: true }
    const input = call.input as BashInput | null
    const raw = typeof input?.command === 'string' ? input.command : ''
    if (raw === '') return { allowed: true } // empty allowed; command-parser already handled invalid shape

    let parsed: ParsedCommand[]
    try {
      parsed = parseCommand(raw)
    } catch {
      // Parser will reject this in Layer 2a — here we pass to preserve
      // single-responsibility and a single rejection point.
      return { allowed: true }
    }

    const hit = matchBlocklist(parsed, raw)
    if (hit) {
      return { allowed: false, layer: NAME, reason: `category ${hit.category}: ${hit.reason}` }
    }
    return { allowed: true }
  },
}
