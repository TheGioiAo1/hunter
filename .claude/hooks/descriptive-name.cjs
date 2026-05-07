#!/usr/bin/env node
/**
 * Descriptive Name Hook - Inject file naming guidance on Write PreToolUse
 *
 * Fires on: PreToolUse (Write)
 * Purpose: Encourage descriptive, kebab-case file names for LLM discoverability
 *
 * Exit Codes:
 *   0 - Always (fail-open, non-blocking)
 */

// Crash wrapper
try {
  const { isHookEnabled } = require('./lib/config-utils.cjs');
  const { createHookTimer, logHookCrash } = require('./lib/hook-logger.cjs');

  if (!isHookEnabled('descriptive-name')) {
    process.exit(0);
  }

  try {
    const timer = createHookTimer('descriptive-name', { event: 'PreToolUse', tool: 'Write' });
    let injectedPrompt = `## File naming guidance:
- Skip this guidance if you are creating markdown or plain text files
- Prefer kebab-case for JS/TS/Python/shell (.js, .ts, .py, .sh) with descriptive names
- Respect language conventions: C#/Java/Kotlin/Swift use PascalCase (.cs, .java, .kt, .swift), Go/Rust use snake_case (.go, .rs)
- Other languages: follow their ecosystem's standard naming convention
- Goal: self-documenting names for LLM tools (Grep, Glob, Search)`;

    console.log(JSON.stringify({
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "additionalContext": injectedPrompt
      }
    }));

    timer.end({ status: 'ok', exit: 0 });
    process.exit(0);

  } catch (error) {
    console.error('WARN: Hook error, allowing operation -', error.message);
    logHookCrash('descriptive-name', error, { event: 'PreToolUse', tool: 'Write' });
    process.exit(0);
  }
} catch (e) {
  try {
    const { logHookCrash } = require('./lib/hook-logger.cjs');
    logHookCrash('descriptive-name', e, { event: 'PreToolUse', tool: 'Write' });
  } catch (_) {}
  process.exit(0); // fail-open
}
