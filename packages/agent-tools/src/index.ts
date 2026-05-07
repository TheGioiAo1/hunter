/**
 * @gbox/agent-tools — public entry point.
 *
 * Exports the shared types + registry factory, plus the concrete
 * tool definitions. The sidecar (apps/god-admin-agent) composes
 * these into a single registry at boot by calling
 * `createDefaultRegistry(deps)`.
 */

export type { ToolDef, ToolResult } from './types.ts'
export type { DispatchResult, ToolRegistry, DispatchArgs } from './registry.ts'
export { createRegistry } from './registry.ts'

// Tier 1 — read-only ---------------------------------------------------------
export { repoReadTool } from './tier1/repo-read.ts'
export type { RepoReadInput, RepoReadDeps } from './tier1/repo-read.ts'
export { repoGlobTool } from './tier1/repo-glob.ts'
export type { RepoGlobInput, RepoGlobDeps } from './tier1/repo-glob.ts'
export { repoGrepTool } from './tier1/repo-grep.ts'
export type { RepoGrepInput, RepoGrepDeps } from './tier1/repo-grep.ts'
export { dbSelectTool } from './tier1/db-select.ts'
export type { DbSelectInput, DbSelectDeps } from './tier1/db-select.ts'
export { auditSearchTool } from './tier1/audit-search.ts'
export type { AuditSearchInput, AuditSearchDeps } from './tier1/audit-search.ts'
export { gitStatusTool, gitDiffTool, gitLogTool } from './tier1/git-readonly.ts'
export type { GitReadonlyDeps, GitDiffInput, GitLogInput } from './tier1/git-readonly.ts'
export { planTodosTool } from './tier1/plan-todos.ts'
export type { PlanTodosInput, PlanTodosDeps, TodoItem, TodoStatus } from './tier1/plan-todos.ts'

// Tier 2 — moderate cost -----------------------------------------------------
export { testsRunTool } from './tier2/tests-run.ts'
export type { TestsRunInput, TestsRunDeps } from './tier2/tests-run.ts'
export { typecheckRunTool } from './tier2/typecheck-run.ts'
export type { TypecheckRunInput, TypecheckRunDeps } from './tier2/typecheck-run.ts'
export { opsHealthTool } from './tier2/ops-health.ts'
export type { OpsHealthInput, OpsHealthDeps } from './tier2/ops-health.ts'

// Tier 3 — mutations (require approval) --------------------------------------
export { repoEditTool } from './tier3/repo-edit.ts'
export type { RepoEditInput, RepoEditDeps } from './tier3/repo-edit.ts'
export { repoWriteTool } from './tier3/repo-write.ts'
export type { RepoWriteInput, RepoWriteDeps } from './tier3/repo-write.ts'
export { bashRunTool } from './tier3/bash-run.ts'
export type { BashRunInput, BashRunDeps } from './tier3/bash-run.ts'
export { gitCommitTool, gitPushTool } from './tier3/git-mutations.ts'
export type { GitCommitInput, GitPushInput, GitMutationDeps } from './tier3/git-mutations.ts'
export {
  userAdminTool,
  sessionRevokeTool,
  tokenRotateTool,
  backupNowTool,
} from './tier3/security-ops.ts'
export type {
  UserAdminInput,
  SessionRevokeInput,
  TokenRotateInput,
  SecurityOpsDeps,
} from './tier3/security-ops.ts'

// Deploy ---------------------------------------------------------------------
export { deployRunTool } from './deploy/deploy-run.ts'
export type { DeployRunInput, DeployRunDeps, DeployTarget } from './deploy/deploy-run.ts'
export { deployScheduleTool } from './deploy/deploy-schedule.ts'
export type { DeployScheduleInput, DeployScheduleDeps } from './deploy/deploy-schedule.ts'
export { opsCurrentWindowTool } from './deploy/ops-current-window.ts'
export type { OpsCurrentWindowInput, OpsCurrentWindowDeps } from './deploy/ops-current-window.ts'

// ---------------------------------------------------------------------------
// Default registry factory
// ---------------------------------------------------------------------------

import type { ToolDef } from './types.ts'
import { createRegistry, type ToolRegistry } from './registry.ts'
import { repoReadTool } from './tier1/repo-read.ts'
import { repoGlobTool } from './tier1/repo-glob.ts'
import { repoGrepTool } from './tier1/repo-grep.ts'
import { dbSelectTool } from './tier1/db-select.ts'
import { auditSearchTool } from './tier1/audit-search.ts'
import { gitStatusTool, gitDiffTool, gitLogTool } from './tier1/git-readonly.ts'
import { planTodosTool } from './tier1/plan-todos.ts'
import { testsRunTool } from './tier2/tests-run.ts'
import { typecheckRunTool } from './tier2/typecheck-run.ts'
import { opsHealthTool } from './tier2/ops-health.ts'
import { repoEditTool } from './tier3/repo-edit.ts'
import { repoWriteTool } from './tier3/repo-write.ts'
import { bashRunTool } from './tier3/bash-run.ts'
import { gitCommitTool, gitPushTool } from './tier3/git-mutations.ts'
import {
  userAdminTool,
  sessionRevokeTool,
  tokenRotateTool,
  backupNowTool,
} from './tier3/security-ops.ts'
import { deployRunTool } from './deploy/deploy-run.ts'
import { deployScheduleTool } from './deploy/deploy-schedule.ts'
import { opsCurrentWindowTool } from './deploy/ops-current-window.ts'

/**
 * Build the canonical registry the sidecar uses in prod. Callers
 * pass a single `deps` object whose shape is the intersection of
 * every tool's Deps type — in practice the sidecar's deps object
 * has one field per dependency (repoRoot, db, git, store, etc.)
 * and TypeScript's structural matching makes every tool accept it.
 */
export function createDefaultRegistry<TDeps>(): ToolRegistry<TDeps> {
  const all: Array<ToolDef<any, TDeps>> = [
    // tier 1
    repoReadTool as unknown as ToolDef<any, TDeps>,
    repoGlobTool as unknown as ToolDef<any, TDeps>,
    repoGrepTool as unknown as ToolDef<any, TDeps>,
    dbSelectTool as unknown as ToolDef<any, TDeps>,
    auditSearchTool as unknown as ToolDef<any, TDeps>,
    gitStatusTool as unknown as ToolDef<any, TDeps>,
    gitDiffTool as unknown as ToolDef<any, TDeps>,
    gitLogTool as unknown as ToolDef<any, TDeps>,
    planTodosTool as unknown as ToolDef<any, TDeps>,
    opsCurrentWindowTool as unknown as ToolDef<any, TDeps>,
    // tier 2
    testsRunTool as unknown as ToolDef<any, TDeps>,
    typecheckRunTool as unknown as ToolDef<any, TDeps>,
    opsHealthTool as unknown as ToolDef<any, TDeps>,
    // tier 3
    repoEditTool as unknown as ToolDef<any, TDeps>,
    repoWriteTool as unknown as ToolDef<any, TDeps>,
    bashRunTool as unknown as ToolDef<any, TDeps>,
    gitCommitTool as unknown as ToolDef<any, TDeps>,
    gitPushTool as unknown as ToolDef<any, TDeps>,
    userAdminTool as unknown as ToolDef<any, TDeps>,
    sessionRevokeTool as unknown as ToolDef<any, TDeps>,
    tokenRotateTool as unknown as ToolDef<any, TDeps>,
    backupNowTool as unknown as ToolDef<any, TDeps>,
    // deploy
    deployRunTool as unknown as ToolDef<any, TDeps>,
    deployScheduleTool as unknown as ToolDef<any, TDeps>,
  ]
  return createRegistry(all)
}
