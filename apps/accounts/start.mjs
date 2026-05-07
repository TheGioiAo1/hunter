/**
 * PM2 cluster-mode entry for gbox-accounts.
 *
 * Why this exists:
 *   pm2 cluster mode forks the `script` directly via node.fork() and
 *   silently drops `interpreter` / `interpreter_args`. That means
 *   `--import tsx` never reaches workers, and TS files fail to load
 *   with ERR_MODULE_NOT_FOUND as soon as they hit a `.js` import that
 *   actually points at a `.ts` source under tsx's extension magic.
 *
 * Fix:
 *   Use tsx 4.x's programmatic API (`tsImport`) from a plain .mjs
 *   entry. pm2 sees a .mjs script (node runs it natively), and
 *   tsImport installs the resolver hook for the imported subtree so
 *   every transitive TS file — including `.js` imports that resolve
 *   to `.ts` sources under workspace links — loads correctly. Works
 *   in both fork and cluster mode.
 *
 *   NOTE: the older `import { register } from 'node:module'` +
 *   `register('tsx/esm', ...)` pattern no longer works on tsx ≥4.20.
 *   tsx explicitly rejects being loaded through the deprecated
 *   `--loader` path and throws "tsx must be loaded with --import".
 */
import { tsImport } from 'tsx/esm/api'
await tsImport('./src/server.ts', import.meta.url)
