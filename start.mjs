/**
 * Gbox Platform — API Entry Point
 *
 * Uses --import tsx (set via node_args in ecosystem.config.cjs)
 * to transpile TypeScript on the fly.
 *
 * tsx 4.x removed the register("tsx/esm") API, so we rely on
 * Node's built-in --import flag instead.
 */
await import("./server.ts");
