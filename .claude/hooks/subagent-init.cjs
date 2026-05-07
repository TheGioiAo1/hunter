#!/usr/bin/env node
/**
 * SubagentStart Hook - Injects context to subagents (~200 tokens)
 *
 * Fires: When a subagent (Task tool call) is started
 * Injects: plan path, reports dir, naming, git info, language, rules
 * Exit: 0 (non-blocking, fail-open)
 */

try {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const {
    loadConfig, resolveNamingPattern, getGitBranch, getGitRoot, resolveProjectRoot,
    resolvePlanPath, getReportsPath, normalizePath, extractTaskListId, isHookEnabled
  } = require('./lib/config-utils.cjs');
  const { createHookTimer, logHookCrash } = require('./lib/hook-logger.cjs');

  if (!isHookEnabled('subagent-init')) process.exit(0);

  // Agents that interact with plan status
  const PLAN_AWARE = new Set([
    'planner', 'project-manager', 'code-simplifier',
    'brainstormer', 'code-reviewer', 'fullstack-developer'
  ]);

  function resolveSkillsVenv() {
    const isWin = process.platform === 'win32';
    const bin = isWin ? 'Scripts' : 'bin';
    const exe = isWin ? 'python.exe' : 'python3';
    const localVenv = path.join(process.cwd(), '.claude', 'skills', '.venv', bin, exe);
    const globalVenv = path.join(os.homedir(), '.claude', 'skills', '.venv', bin, exe);
    if (fs.existsSync(localVenv)) return isWin ? '.claude\\skills\\.venv\\Scripts\\python.exe' : '.claude/skills/.venv/bin/python3';
    if (fs.existsSync(globalVenv)) return isWin ? '~\\.claude\\skills\\.venv\\Scripts\\python.exe' : '~/.claude/skills/.venv/bin/python3';
    return null;
  }

  async function main() {
    const timer = createHookTimer('subagent-init', { event: 'SubagentStart' });
    let agentType = 'unknown';
    try {
      const stdin = fs.readFileSync(0, 'utf-8').trim();
      if (!stdin) { timer.end({ status: 'skip', exit: 0, note: 'empty-input' }); process.exit(0); }

      const payload = JSON.parse(stdin);
      agentType = payload.agent_type || 'unknown';
      const agentId = payload.agent_id || 'unknown';
      const config = loadConfig({ includeProject: false, includeAssertions: false });
      const rawCwd = payload.cwd?.trim() || process.cwd();
      // Resolve to real project root so reports/plans/docs paths never leak into
      // a sub-project (e.g. running a subagent from `<root>/frontend/`).
      const effectiveCwd = resolveProjectRoot(rawCwd);
      const gitBranch = getGitBranch(effectiveCwd);
      const baseDir = effectiveCwd;
      const namePattern = resolveNamingPattern(config.plan, gitBranch);

      const sessionId = payload.session_id || process.env.CK_SESSION_ID || null;
      const resolved = resolvePlanPath(sessionId, config);
      const reportsPath = getReportsPath(resolved.path, resolved.resolvedBy, config.plan, config.paths, baseDir);
      const activePlan = resolved.resolvedBy === 'session' ? resolved.path : '';
      const suggestedPlan = resolved.resolvedBy === 'branch' ? resolved.path : '';
      const taskListId = extractTaskListId(resolved);
      const plansPath = path.join(baseDir, normalizePath(config.paths?.plans) || 'plans');
      const docsPath = path.join(baseDir, normalizePath(config.paths?.docs) || 'docs');

      const thinkingLang = config.locale?.thinkingLanguage || '';
      const responseLang = config.locale?.responseLanguage || '';
      const effectiveThinking = thinkingLang || (responseLang ? 'en' : '');
      const skillsVenv = resolveSkillsVenv();

      // Build compact context
      const lines = [];
      lines.push(`## Subagent: ${agentType}`, `ID: ${agentId} | CWD: ${effectiveCwd}`, ``);

      lines.push(`## Context`);
      if (activePlan) {
        lines.push(`- Plan: ${activePlan}`);
        if (taskListId) lines.push(`- Task List: ${taskListId} (shared with session)`);
      } else if (suggestedPlan) {
        lines.push(`- Plan: none | Suggested: ${suggestedPlan}`);
      } else {
        lines.push(`- Plan: none`);
      }
      lines.push(`- Reports: ${reportsPath}`, `- Paths: ${plansPath}/ | ${docsPath}/`, ``);

      // Language
      const hasThinking = effectiveThinking && effectiveThinking !== responseLang;
      if (hasThinking || responseLang) {
        lines.push(`## Language`);
        if (hasThinking) lines.push(`- Thinking: Use ${effectiveThinking} for reasoning.`);
        if (responseLang) lines.push(`- Response: Respond in ${responseLang}.`);
        lines.push(``);
      }

      // Rules
      lines.push(`## Rules`);
      lines.push(`- Reports → ${reportsPath}`);
      lines.push(`- YAGNI / KISS / DRY`);
      lines.push(`- Concise, list unresolved Qs at end`);
      if (skillsVenv) {
        lines.push(`- Python scripts in .claude/skills/: Use \`${skillsVenv}\``);
        lines.push(`- Never use global pip install`);
      }

      // Naming
      lines.push(``, `## Naming`);
      lines.push(`- Report: ${path.join(reportsPath, `${agentType}-${namePattern}.md`)}`);
      lines.push(`- Plan dir: ${path.join(plansPath, namePattern)}/`);

      // Plan CLI for plan-aware agents
      if (PLAN_AWARE.has(agentType)) {
        lines.push(``, `## Plan CLI`);
        lines.push(`\`ck plan check <id>\` = completed | \`ck plan check <id> --start\` = in-progress | \`ck plan uncheck <id>\` = revert`);
      }

      // Agent-specific context from config
      const agentContext = config.subagent?.agents?.[agentType]?.contextPrefix;
      if (agentContext) {
        lines.push(``, `## Agent Instructions`, agentContext);
      }

      console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: lines.join('\n') }
      }));
      timer.end({ status: 'ok', exit: 0, target: agentType, note: 'context-injected' });
      process.exit(0);
    } catch (error) {
      console.error(`SubagentStart hook error: ${error.message}`);
      logHookCrash('subagent-init', error, { event: 'SubagentStart', target: agentType });
      process.exit(0);
    }
  }

  main();
} catch (e) {
  try { require('./lib/hook-logger.cjs').logHookCrash('subagent-init', e, { event: 'SubagentStart' }); } catch (_) {}
  process.exit(0);
}
