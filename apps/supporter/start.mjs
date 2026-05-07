/**
 * PM2 cluster-mode entry for gbox-supporter (supporter.gbox.co).
 *
 * Mirrors apps/store-admin/start.mjs: we use tsx/esm at runtime so the
 * PM2 process can boot without a build step. Production still runs
 * `npm run build` before `pm2 start` for type checks, but the live
 * process consumes the .ts source directly.
 */
import { tsImport } from 'tsx/esm/api'
await tsImport('./src/server.ts', import.meta.url)
