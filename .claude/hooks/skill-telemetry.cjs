#!/usr/bin/env node
/**
 * skill-telemetry.cjs — UserPromptSubmit + Stop hook
 *
 * Logs skill invocations and turn lifecycle to
 * .claude/telemetry/skill-usage.jsonl for post-hoc analysis
 * (which skill is fat, which is rarely used, which often fails).
 *
 * Events logged:
 *   - turn_start: UserPromptSubmit fired; detects `/skill-name` pattern
 *   - turn_end:   Stop fired; closes the turn
 *
 * Output: .claude/telemetry/skill-usage.jsonl (JSON Lines, rotates ~5MB)
 * Opt-out: set `hooks.skill-telemetry = false` in .claude/.claude-config.json
 * Fail-open: any error → exit 0, never block the turn.
 *
 * Analysis tip: pair turn_start + turn_end by session_id + ordering to
 * compute duration and per-skill frequency via jq:
 *   cat .claude/telemetry/skill-usage.jsonl | jq -c 'select(.skill)'
 */

try {
  const fs = require('fs');
  const path = require('path');

  // Read stdin (hook input from Claude Code)
  let stdin = '';
  try { stdin = fs.readFileSync(0, 'utf-8').trim(); } catch {}
  const data = stdin ? JSON.parse(stdin) : {};
  const event = data.hook_event_name || '';
  const sessionId = data.session_id || '';

  const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Opt-out check — lightweight, direct read (avoid full config cascade)
  function isEnabled() {
    try {
      const p = path.join(projectRoot, '.claude', '.claude-config.json');
      if (!fs.existsSync(p)) return true;
      const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return !(cfg.hooks && cfg.hooks['skill-telemetry'] === false);
    } catch {
      return true;
    }
  }

  if (!isEnabled()) process.exit(0);

  const telemetryDir = path.join(projectRoot, '.claude', 'telemetry');
  const logFile = path.join(telemetryDir, 'skill-usage.jsonl');
  const MAX_BYTES = 5 * 1024 * 1024; // 5 MB soft cap

  try {
    if (!fs.existsSync(telemetryDir)) fs.mkdirSync(telemetryDir, { recursive: true });
  } catch {}

  function detectSkill(prompt) {
    if (!prompt || typeof prompt !== 'string') return null;
    // Leading `/skill-name` at start of prompt (after optional whitespace)
    const m = prompt.trim().match(/^\/([a-z][a-z0-9-]*)\b/);
    return m ? m[1] : null;
  }

  function rotateIfNeeded() {
    try {
      if (!fs.existsSync(logFile)) return;
      const stat = fs.statSync(logFile);
      if (stat.size < MAX_BYTES) return;
      // Keep last ~50% of lines
      const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
      const half = Math.floor(lines.length / 2);
      fs.writeFileSync(logFile, lines.slice(half).join('\n') + '\n', 'utf-8');
    } catch {}
  }

  function writeEntry(entry) {
    try {
      rotateIfNeeded();
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {}
  }

  const ts = new Date().toISOString();

  if (event === 'UserPromptSubmit') {
    const prompt = data.prompt || '';
    const skill = detectSkill(prompt);
    writeEntry({
      ts,
      event: 'turn_start',
      session_id: sessionId,
      skill: skill || null,
      prompt_len: prompt.length
    });
  } else if (event === 'Stop') {
    writeEntry({
      ts,
      event: 'turn_end',
      session_id: sessionId
    });
  }

  process.exit(0);
} catch {
  // Fail-open — never block a turn because telemetry broke
  process.exit(0);
}
