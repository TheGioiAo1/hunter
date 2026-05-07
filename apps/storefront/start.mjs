/**
 * PM2 cluster-mode entry for gbox-storefront.
 * See apps/accounts/start.mjs for the full rationale.
 */
import { tsImport } from 'tsx/esm/api'
await tsImport('./src/server.ts', import.meta.url)
