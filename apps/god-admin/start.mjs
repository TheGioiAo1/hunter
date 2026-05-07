/**
 * PM2 entry for gbox-god-admin (fork mode, single instance).
 * See apps/accounts/start.mjs for the full rationale.
 */
import { tsImport } from 'tsx/esm/api'
await tsImport('./src/server.ts', import.meta.url)
