#!/usr/bin/env node
/**
 * dev-rules-reminder.cjs — UserPromptSubmit Hook
 *
 * Injects per-prompt context: session info, plan state, paths, naming, rules.
 * Lean version — builds context directly, no external context-builder dep.
 * Complements context-awareness.cjs (which handles usage/quota tracking).
 *
 * Exit: 0 (non-blocking, fail-open)
 */

try {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const {
    loadConfig, resolvePlanPath, getReportsPath,
    resolveNamingPattern, normalizePath, isHookEnabled
  } = require('./lib/config-utils.cjs');
  const { createHookTimer, logHookCrash } = require('./lib/hook-logger.cjs');

  if (!isHookEnabled('dev-rules-reminder')) process.exit(0);

  function execSafe(cmd) {
    try {
      return require('child_process').execSync(cmd, {
        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch { return null; }
  }

  function wasRecentlyInjected(transcriptPath) {
    try {
      if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
      const transcript = fs.readFileSync(transcriptPath, 'utf-8');
      return transcript.split('\n').slice(-150).some(l => l.includes('[IMPORTANT] Consider Modularization'));
    } catch { return false; }
  }

  function resolveRulesPath(filename) {
    const local = path.join(process.cwd(), '.claude', 'rules', filename);
    if (fs.existsSync(local)) return '.claude/rules/' + filename;
    const global = path.join(os.homedir(), '.claude', 'rules', filename);
    if (fs.existsSync(global)) return '~/.claude/rules/' + filename;
    return null;
  }

  function resolveSkillsVenv() {
    const isWin = process.platform === 'win32';
    const bin = isWin ? 'Scripts' : 'bin';
    const exe = isWin ? 'python.exe' : 'python3';
    const local = path.join(process.cwd(), '.claude', 'skills', '.venv', bin, exe);
    if (fs.existsSync(local)) return isWin ? '.claude\\skills\\.venv\\Scripts\\python.exe' : '.claude/skills/.venv/bin/python3';
    const global = path.join(os.homedir(), '.claude', 'skills', '.venv', bin, exe);
    if (fs.existsSync(global)) return isWin ? '~\\.claude\\skills\\.venv\\Scripts\\python.exe' : '~/.claude/skills/.venv/bin/python3';
    return null;
  }

  async function main() {
    const timer = createHookTimer('dev-rules-reminder', { event: 'UserPromptSubmit' });
    try {
      const stdin = fs.readFileSync(0, 'utf-8').trim();
      if (!stdin) { timer.end({ status: 'skip', exit: 0, note: 'empty-input' }); process.exit(0); }

      const payload = JSON.parse(stdin);
      if (wasRecentlyInjected(payload.transcript_path)) {
        timer.end({ status: 'skip', exit: 0, note: 'recently-injected' });
        process.exit(0);
      }

      const config = loadConfig({ includeProject: false, includeAssertions: false });
      const sessionId = payload.session_id || process.env.CK_SESSION_ID || null;
      const baseDir = process.cwd();

      // Resolve plan + paths
      const gitBranch = execSafe('git branch --show-current');
      const resolved = resolvePlanPath(sessionId, config);
      const reportsPath = getReportsPath(resolved.path, resolved.resolvedBy, config.plan, config.paths, baseDir);
      const namePattern = resolveNamingPattern(config.plan, gitBranch);
      const plansPath = path.join(baseDir, normalizePath(config.paths?.plans) || 'plans');
      const docsPath = path.join(baseDir, normalizePath(config.paths?.docs) || 'docs');
      const devRulesPath = resolveRulesPath('development-rules.md');
      const skillsVenv = resolveSkillsVenv();

      // Language
      const thinkingLang = config.locale?.thinkingLanguage || '';
      const responseLang = config.locale?.responseLanguage || '';
      const effectiveThinking = thinkingLang || (responseLang ? 'en' : '');

      // Build context
      const lines = [];

      // Language
      const hasThinking = effectiveThinking && effectiveThinking !== responseLang;
      if (hasThinking || responseLang) {
        lines.push(`## Language`);
        if (hasThinking) lines.push(`- Thinking: Use ${effectiveThinking} for reasoning.`);
        if (responseLang) lines.push(`- Response: Respond in ${responseLang}.`);
        lines.push(``);
      }

      // Session
      const memUsed = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      const memTotal = Math.round(os.totalmem() / 1024 / 1024);
      lines.push(`## Session`);
      lines.push(`- DateTime: ${new Date().toLocaleString()} | CWD: ${baseDir}`);
      lines.push(`- OS: ${process.platform} | Memory: ${memUsed}MB/${memTotal}MB`);
      lines.push(``);

      // Rules
      lines.push(`## Rules`);
      if (devRulesPath) lines.push(`- Dev rules: "${devRulesPath}"`);
      lines.push(`- Plans → "${plansPath}" | Docs → "${docsPath}"`);
      lines.push(`- DO NOT create markdown files outside plans/ or docs/ unless user requests`);
      if (skillsVenv) lines.push(`- Python skills venv: \`${skillsVenv}\``);
      lines.push(`- YAGNI / KISS / DRY | Concise reports, list unresolved Qs at end`);
      lines.push(``);

      // Modularization
      lines.push(`## [IMPORTANT] Consider Modularization:`);
      lines.push(`- If code file > 200 lines, split into focused modules`);
      lines.push(`- Use kebab-case names (self-documenting for LLM tools)`);
      lines.push(`- Check existing modules before creating new`);
      lines.push(``);

      // Plan context
      lines.push(`## Plan Context`);
      if (resolved.resolvedBy === 'session') lines.push(`- Plan: ${resolved.path}`);
      else if (resolved.resolvedBy === 'branch') lines.push(`- Plan: none | Suggested: ${resolved.path}`);
      else lines.push(`- Plan: none`);
      lines.push(`- Reports: ${reportsPath}`);
      if (gitBranch) lines.push(`- Branch: ${gitBranch}`);
      lines.push(``);

      // Naming
      lines.push(`## Naming`);
      lines.push(`- Report: \`${reportsPath}{type}-${namePattern}.md\``);
      lines.push(`- Plan dir: \`${plansPath}/${namePattern}/\``);

      console.log(lines.join('\n'));
      timer.end({ status: 'ok', exit: 0, note: 'context-injected' });
      process.exit(0);
    } catch (error) {
      console.error(`Dev rules hook error: ${error.message}`);
      logHookCrash('dev-rules-reminder', error, { event: 'UserPromptSubmit' });
      process.exit(0);
    }
  }

  main();
} catch (e) {
  try { require('./lib/hook-logger.cjs').logHookCrash('dev-rules-reminder', e, { event: 'UserPromptSubmit' }); } catch (_) {}
  process.exit(0);
}
