/**
 * Layer 2a — Command parser.
 *
 * For `bash.run` calls, turns the raw command string into a list of
 * normalized `string[]` argv-style entries so Layer 2b (blocklist) can
 * pattern-match without re-parsing. Semicolons, pipes, `&&`, `||`, and
 * command substitution all split into separate entries. Backticks and
 * $(...) are recursively unwrapped so a nested `rm -rf /` can't hide
 * inside `echo $(rm -rf /)`.
 *
 * Parser failure (unterminated quote, invalid op sequence) → reject
 * with a `parse error` reason. Empty / whitespace-only input → allow
 * with an empty parse list, letting later layers no-op cleanly.
 */

import { parse as shellParse } from 'shell-quote'
import type { GuardLayer, GuardResult, SessionContext, ToolCall } from './types.ts'

const NAME = 'command-parser'

export type ParsedCommand = string[]

/**
 * Pure parser helper — exported so blocklist tests (and future layers)
 * can reuse the same flattening logic.
 */
export function parseCommand(raw: string): ParsedCommand[] {
  if (raw.trim() === '') return []

  // shell-quote silently accepts unterminated quotes; pre-validate them
  // ourselves so the guard layer can reject a malformed command before
  // it even reaches the walker.
  validateQuotes(raw)

  // Pre-extract $(...) and `...` substrings from the raw input. shell-quote
  // either splits these into awkward token sequences (for $(...) we get
  // ["$", {op:"("}, ...]) or leaves the backticks glued to adjacent args.
  // Extract them first, recursively parse them as nested commands, and
  // replace the substring with a placeholder so the outer walker still
  // sees a clean argv.
  const nestedCommands: ParsedCommand[] = []
  const stripped = stripSubstitutions(raw, (inner) => {
    try {
      for (const n of parseCommand(inner)) nestedCommands.push(n)
    } catch {
      // Inner parse failure is ignored — outer form is preserved.
    }
  })

  let tokens: unknown[]
  try {
    tokens = shellParse(stripped)
  } catch (err) {
    throw new Error(`parse error: ${(err as Error).message}`)
  }

  const commands: ParsedCommand[] = []
  let current: string[] = []

  const commit = () => {
    if (current.length > 0) {
      commands.push(current)
      current = []
    }
  }

  // Regex that matches a pure placeholder token or a token composed
  // entirely of placeholders (so they disappear from the outer argv).
  const PLACEHOLDER_ONLY = /^(?:__AG_SUB_\d+__)+$/

  for (const t of tokens) {
    if (typeof t === 'string') {
      if (PLACEHOLDER_ONLY.test(t)) continue
      // Strip embedded placeholders from mixed tokens (e.g. `foo__AG_SUB_0__bar`).
      const cleaned = t.replace(/__AG_SUB_\d+__/g, '')
      if (cleaned === '') continue
      current.push(cleaned)
    } else if (t && typeof t === 'object') {
      // shell-quote emits operators/redirects/comments as objects.
      const obj = t as { op?: string; comment?: string; pattern?: string }
      if (obj.op) {
        // `;`, `|`, `||`, `&&`, `&` act as command boundaries for our
        // purposes. For redirects (`>`, `<`, `>>`, `<<`) we keep the
        // operator as a token on the current command so the blocklist
        // can still see `> /dev/sda`.
        const REDIRECTS = new Set(['>', '>>', '<', '<<', '&>', '>&'])
        if (REDIRECTS.has(obj.op)) {
          current.push(obj.op)
        } else {
          commit()
        }
      } else if (obj.pattern) {
        current.push(obj.pattern)
      } else if (obj.comment !== undefined) {
        // comments don't affect execution
      } else {
        // Unknown token shape — treat as unsafe and throw.
        throw new Error(`parse error: unknown token ${JSON.stringify(obj)}`)
      }
    }
  }
  commit()

  // Append any nested substitution commands we extracted up front.
  const expanded: ParsedCommand[] = [...commands, ...nestedCommands]

  // bash -c "inner" / sh -c 'inner' unwrapping — if we see [bash|sh, -c, STRING]
  // surface the inner as a parsed command too.
  const final: ParsedCommand[] = []
  for (const cmd of expanded) {
    final.push(cmd)
    if ((cmd[0] === 'bash' || cmd[0] === 'sh') && cmd[1] === '-c' && typeof cmd[2] === 'string') {
      try {
        for (const inner of parseCommand(cmd[2])) {
          final.push(inner)
        }
      } catch {
        // Inner parse failure is ignored; outer form is preserved.
      }
    }
  }

  return final
}

/**
 * Throws a `parse error` if `raw` has an unterminated single or double
 * quote, taking backslash escaping into account. shell-quote happily
 * accepts malformed input and silently drops the opening quote, so we
 * must catch this ourselves.
 */
function validateQuotes(raw: string): void {
  let i = 0
  while (i < raw.length) {
    const c = raw[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      i++
      let closed = false
      while (i < raw.length) {
        const cc = raw[i]
        if (cc === '\\' && quote === '"') {
          i += 2
          continue
        }
        if (cc === quote) {
          closed = true
          i++
          break
        }
        i++
      }
      if (!closed) {
        throw new Error(`parse error: unterminated ${quote === '"' ? 'double' : 'single'} quote`)
      }
      continue
    }
    i++
  }
}

/**
 * Walk `raw` and extract every `$(...)` and `` `...` `` substring,
 * invoking `onInner` with the unwrapped command text. Returns a copy of
 * `raw` with each substitution replaced by a placeholder token
 * (`__AG_SUB_N__`) so the outer shell-quote parse still sees a
 * syntactically clean argv.
 *
 * Handles nested $(...) by tracking paren depth. Backticks are treated
 * as non-nestable (standard bash behaviour).
 */
function stripSubstitutions(raw: string, onInner: (inner: string) => void): string {
  let out = ''
  let i = 0
  let subId = 0
  while (i < raw.length) {
    const c = raw[i]
    // Skip quoted regions verbatim — substitutions inside single quotes
    // are literal, and inside double quotes we still want to surface the
    // inner command, but the simpler approach is to copy the quoted
    // region as-is and let the recursive parseCommand pick up any $(...)
    // when the outer command runs. Single quotes: copy verbatim.
    if (c === "'") {
      const end = raw.indexOf("'", i + 1)
      if (end === -1) {
        // validateQuotes should have caught this, but be defensive.
        out += raw.slice(i)
        return out
      }
      out += raw.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (c === '\\' && i + 1 < raw.length) {
      out += raw.slice(i, i + 2)
      i += 2
      continue
    }
    // $(...) — honour nesting via paren depth counter.
    if (c === '$' && raw[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      while (j < raw.length && depth > 0) {
        const cc = raw[j]
        if (cc === '\\') {
          j += 2
          continue
        }
        if (cc === '(') depth++
        else if (cc === ')') depth--
        if (depth === 0) break
        j++
      }
      if (depth === 0 && j < raw.length) {
        const inner = raw.slice(i + 2, j)
        onInner(inner)
        out += `__AG_SUB_${subId++}__`
        i = j + 1
        continue
      }
      // Unbalanced — fall through and copy literally.
    }
    // `...` — non-nesting.
    if (c === '`') {
      const end = raw.indexOf('`', i + 1)
      if (end !== -1) {
        const inner = raw.slice(i + 1, end)
        onInner(inner)
        out += `__AG_SUB_${subId++}__`
        i = end + 1
        continue
      }
      // Unmatched backtick — copy literally.
    }
    out += c
    i++
  }
  return out
}

interface BashInput {
  command?: unknown
}

export const commandParser: GuardLayer = {
  name: NAME,
  async check(call: ToolCall, _ctx: SessionContext): Promise<GuardResult> {
    if (call.name !== 'bash.run') {
      return { allowed: true }
    }
    const input = call.input as BashInput | null
    if (!input || typeof input !== 'object' || !('command' in input)) {
      return { allowed: false, layer: NAME, reason: 'bash.run requires a command field' }
    }
    const cmd = input.command
    if (typeof cmd !== 'string') {
      return { allowed: false, layer: NAME, reason: 'command must be a string' }
    }
    try {
      parseCommand(cmd)
    } catch (err) {
      return { allowed: false, layer: NAME, reason: (err as Error).message }
    }
    return { allowed: true }
  },
}
