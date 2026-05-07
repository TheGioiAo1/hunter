/**
 * Gbox Platform — Storefront Entry Point
 *
 * Uses --import tsx (set via node_args in ecosystem.config.cjs)
 * to transpile TypeScript on the fly.
 */
await import("./storefront-server.ts");
