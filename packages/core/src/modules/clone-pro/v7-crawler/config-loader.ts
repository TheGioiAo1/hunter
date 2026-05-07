/**
 * Config loader — read XPath config JSON for a given platform.
 *
 * Configs live in `./configs/<platform>.json` and are co-located with this
 * module (relative path so `tsx` / `tsc --module nodenext` resolves the
 * directory without bundler tricks). Each canonical platform has its own
 * file; site-specific overrides (lencam, etycloset, etc.) sit alongside
 * for direct loading by name when AI fallback identifies a custom site
 * matches a known shape (Sprint 2 work).
 *
 * Iron Rule 5: throws raw `Error` only — caller pipes through `safeMessage`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config, Platform } from './types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const CONFIG_DIR = join(__dirname, 'configs')

/**
 * Load the XPath config for `platform`.
 * @throws if platform is `unknown` or the file is missing/malformed.
 */
export function loadConfig(platform: Platform | string): Config {
  if (platform === 'unknown') {
    throw new Error('No config available for unknown platform — AI fallback required')
  }
  const file = `${platform}.json`
  let raw: string
  try {
    raw = readFileSync(join(CONFIG_DIR, file), 'utf8')
  } catch (e) {
    throw new Error(`Config not found for platform "${platform}"`, { cause: e })
  }
  // Strip UTF-8 BOM if present (Lonspy ConfigSite/*.json was authored on Windows).
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
  const parsed = JSON.parse(raw) as Config
  // Validate minimum shape (cheap runtime check — full schema in Sprint 2).
  if (typeof parsed.delay !== 'number') {
    throw new Error(`Invalid config "${platform}": delay must be number`)
  }
  if (!parsed.item || typeof parsed.item.xpath !== 'string' || !Array.isArray(parsed.item.elements)) {
    throw new Error(`Invalid config "${platform}": item.xpath + item.elements required`)
  }
  parsed.platform = platform
  return parsed
}

/** List every JSON config in `./configs` (canonical + site-specific). */
export function listAvailableConfigs(): string[] {
  try {
    return readdirSync(CONFIG_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort()
  } catch {
    return []
  }
}
