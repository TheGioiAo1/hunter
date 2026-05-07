// Gbox Platform — @gbox/agent-guard
// 6-layer defense chain for the Claude Agent SDK pair programmer.
// See README.md for architecture overview.

export * from './types.ts'
// Layers registered in composition order as they land in later tasks.
export { pathWhitelist } from './path-whitelist.ts'
export { commandParser, parseCommand } from './command-parser.ts'
export type { ParsedCommand } from './command-parser.ts'
export { blocklist, matchBlocklist } from './blocklist.ts'
export type { BlocklistMatch } from './blocklist.ts'
export { resourceLimits, wrapBashCommand } from './resource-limits.ts'
export { rateLimit } from './rate-limit.ts'
export { createApprovalGate } from './approval-gate.ts'
export type { ApprovalEvent, ApprovalDecision, ApprovalGate, ApprovalGateOptions } from './approval-gate.ts'
export {
  deploymentSafety,
  classifyPath,
  insideDailyWindow,
  insideSundayWindow,
} from './deployment-safety.ts'
export { composeGuards, defaultGuardChain } from './compose.ts'
export type { DefaultGuardChainOptions, DefaultGuardChain } from './compose.ts'
