/**
 * Gbox Platform — StaticLoader
 *
 * Decision #1 Step 1.3 — Filesystem-backed `TemplateLoader`. Reads
 * theme files from a directory rooted at `baseDir` using Node's
 * `fs/promises`.
 *
 * Use cases:
 *   1. Seeding the gbox-dawn starter theme into a new shop's
 *      `theme_assets` rows (Step 1.13). The seed task instantiates
 *      `new StaticLoader('packages/core/src/modules/themes/seed/gbox-dawn')`,
 *      lists every file, and bulk-inserts.
 *   2. Local theme dev with `npm run theme:watch`. The dev server
 *      points the engine at `./themes/<name>` on disk and reloads on
 *      change without touching the database.
 *   3. Tests — the i18n service tests use MemoryI18nService for
 *      isolation, but template loader tests use a real temp dir to
 *      catch bugs the in-memory shortcut would hide.
 *
 * NOT for production runtime. Production uses `DbLoader` (Step 1.6)
 * because:
 *   - Cloudflare Workers have no `fs` module.
 *   - Multi-tenant rendering needs per-shop isolation that a shared
 *     filesystem can't provide cleanly.
 *   - Theme upgrades + edits flow through the database, not file
 *     uploads to a directory.
 *
 * Security:
 *   Every input path goes through `normalizeLogicalPath()` (rejects
 *   `..` and `.` segments) AND we re-resolve the final absolute path
 *   and check it stays under `baseDir`. The double-check defends
 *   against Node version-specific quirks in path handling.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  type LoadResult,
  type LogicalPath,
  type TemplateLoader,
  normalizeLogicalPath,
} from './loader.js'

export interface StaticLoaderOptions {
  /**
   * Diagnostic label that shows up in error messages and the
   * `name` getter. Defaults to the basename of `baseDir`.
   */
  label?: string
}

export class StaticLoader implements TemplateLoader {
  readonly name: string
  private readonly baseDir: string
  /** Cached resolved absolute baseDir for traversal checks. */
  private readonly baseAbs: string

  constructor(baseDir: string, opts: StaticLoaderOptions = {}) {
    if (!baseDir) throw new Error('StaticLoader: baseDir is required')
    this.baseDir = baseDir
    this.baseAbs = path.resolve(baseDir)
    this.name = `static:${opts.label ?? path.basename(this.baseAbs)}`
  }

  // -------------------------------------------------------------------------
  // Path resolver — normalize → resolve → confine to baseDir
  // -------------------------------------------------------------------------

  /**
   * Convert a logical path to an absolute filesystem path. Returns
   * `null` if the resolved path escapes `baseDir` (defense in depth
   * against path-traversal that slips past `normalizeLogicalPath`).
   */
  private resolveAbs(logical: LogicalPath): string | null {
    const norm = normalizeLogicalPath(logical)
    const abs = path.resolve(this.baseAbs, norm)
    // Confine: abs must be inside baseAbs (or equal to it). On Windows
    // both paths are normalized to backslashes by path.resolve, so the
    // prefix check is portable.
    const rel = path.relative(this.baseAbs, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return null
    }
    return abs
  }

  // -------------------------------------------------------------------------
  // load
  // -------------------------------------------------------------------------

  async load(logical: LogicalPath): Promise<string | null> {
    const abs = this.resolveAbs(logical)
    if (!abs) return null
    try {
      return await fs.readFile(abs, 'utf8')
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'EISDIR') return null
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // loadWithMeta
  // -------------------------------------------------------------------------

  async loadWithMeta(logical: LogicalPath): Promise<LoadResult | null> {
    const abs = this.resolveAbs(logical)
    if (!abs) return null
    try {
      const [source, stat] = await Promise.all([
        fs.readFile(abs, 'utf8'),
        fs.stat(abs),
      ])
      return {
        source,
        updatedAt: stat.mtime.toISOString(),
        // sha256 intentionally omitted — DbLoader will provide it from the
        // stored column. Computing it here on every read would be wasted
        // CPU; callers that need it can hash `source` themselves.
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'EISDIR') return null
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // exists
  // -------------------------------------------------------------------------

  async exists(logical: LogicalPath): Promise<boolean> {
    const abs = this.resolveAbs(logical)
    if (!abs) return false
    try {
      const st = await fs.stat(abs)
      return st.isFile()
    } catch (err: any) {
      if (err?.code === 'ENOENT') return false
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  async list(prefix: string = ''): Promise<LogicalPath[]> {
    // The prefix is a logical path, not a filesystem path. Normalize
    // unless it's empty (the empty case means "everything").
    let prefixLogical = ''
    if (prefix) {
      // Allow trailing slash so callers can write `list('snippets/')`.
      const trimmed = prefix.replace(/\/+$/, '')
      if (trimmed.length > 0) {
        prefixLogical = normalizeLogicalPath(trimmed)
      }
    }

    const startDir = prefixLogical
      ? path.resolve(this.baseAbs, prefixLogical)
      : this.baseAbs

    // If startDir doesn't exist, return empty (don't throw).
    let startStat
    try {
      startStat = await fs.stat(startDir)
    } catch (err: any) {
      if (err?.code === 'ENOENT') return []
      throw err
    }

    if (!startStat.isDirectory()) {
      // Prefix points at a single file, not a dir.
      if (startStat.isFile()) return [prefixLogical]
      return []
    }

    const out: LogicalPath[] = []
    await this.walkDir(startDir, out)

    // Convert filesystem paths back to logical paths (POSIX-style,
    // relative to baseAbs).
    const logicalPaths = out
      .map((abs) => path.relative(this.baseAbs, abs).replace(/\\/g, '/'))
      .sort()

    return logicalPaths
  }

  /** Recursive directory walk that pushes file paths into `out`. */
  private async walkDir(dir: string, out: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    // Sort here too so the recursion order is deterministic, helps tests.
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.walkDir(full, out)
      } else if (entry.isFile()) {
        out.push(full)
      }
      // Symlinks, sockets, etc. ignored on purpose.
    }
  }
}
