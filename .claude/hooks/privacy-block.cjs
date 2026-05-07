#!/usr/bin/env node
/**
 * privacy-block.cjs - Block access to sensitive files unless user-approved
 *
 * Flow:
 * 1. LLM tries: Read ".env" → BLOCKED
 * 2. LLM asks user for permission via AskUserQuestion
 * 3. User approves → LLM retries via bash: cat ".env" → ALLOWED
 *
 * Exit: 0 = allow, 2 = block
 */

(async () => {
  try {
    const path = require('path');
    const { createHookTimer, logHookCrash } = require('./lib/hook-logger.cjs');
    const { checkPrivacy } = require('./lib/privacy-checker.cjs');
    const { isHookEnabled } = require('./lib/config-utils.cjs');

    if (!isHookEnabled('privacy-block')) process.exit(0);

    function formatBlockMessage(filePath) {
      const basename = path.basename(filePath);
      const promptData = {
        type: 'PRIVACY_PROMPT',
        file: filePath,
        basename,
        question: {
          header: 'File Access',
          text: `I need to read "${basename}" which may contain sensitive data (API keys, passwords, tokens). Do you approve?`,
          options: [
            { label: 'Yes, approve access', description: `Allow reading ${basename} this time` },
            { label: 'No, skip this file', description: 'Continue without accessing this file' }
          ]
        }
      };

      return `
\x1b[36mNOTE:\x1b[0m This is not an error - this block protects sensitive data.

\x1b[33mPRIVACY BLOCK\x1b[0m: Sensitive file access requires user approval

  \x1b[33mFile:\x1b[0m ${filePath}

  This file may contain secrets (API keys, passwords, tokens).

\x1b[90m@@PRIVACY_PROMPT_START@@\x1b[0m
${JSON.stringify(promptData, null, 2)}
\x1b[90m@@PRIVACY_PROMPT_END@@\x1b[0m

  \x1b[34mClaude:\x1b[0m Use AskUserQuestion tool with the JSON above, then:
  \x1b[32mIf "Yes":\x1b[0m Use bash to read: cat "${filePath}"
  \x1b[31mIf "No":\x1b[0m  Continue without this file.
`;
    }

    async function main() {
      const timer = createHookTimer('privacy-block', { event: 'PreToolUse' });
      let input = '';
      for await (const chunk of process.stdin) { input += chunk; }

      let hookData;
      try { hookData = JSON.parse(input); } catch (e) {
        timer.end({ status: 'warn', exit: 0, note: 'json-parse-failed', error: e.message });
        process.exit(0);
      }

      const { tool_input: toolInput, tool_name: toolName } = hookData;
      const result = checkPrivacy({ toolName, toolInput, options: { allowBash: true } });

      if (result.approved) {
        if (result.suspicious) console.error('\x1b[33mWARN:\x1b[0m Approved path is outside project:', result.filePath);
        console.error(`\x1b[32m✓\x1b[0m Privacy: User-approved access to ${path.basename(result.filePath)}`);
        timer.end({ tool: toolName, status: 'ok', exit: 0, target: path.basename(result.filePath || ''), note: result.suspicious ? 'approved-suspicious' : 'approved' });
        process.exit(0);
      }

      if (result.isBash) {
        console.error(`\x1b[33mWARN:\x1b[0m ${result.reason}`);
        timer.end({ tool: toolName, status: 'warn', exit: 0, target: path.basename(result.filePath || ''), note: 'bash-sensitive-file' });
        process.exit(0);
      }

      if (result.blocked) {
        console.error(formatBlockMessage(result.filePath));
        timer.end({ tool: toolName, status: 'block', exit: 2, target: path.basename(result.filePath || ''), note: 'approval-required' });
        process.exit(2);
      }

      timer.end({ tool: toolName, status: 'ok', exit: 0 });
      process.exit(0);
    }

    if (require.main === module) {
      main().catch((error) => {
        logHookCrash('privacy-block', error, { event: 'PreToolUse' });
        process.exit(0);
      });
    }
  } catch (e) {
    try { require('./lib/hook-logger.cjs').logHookCrash('privacy-block', e, { event: 'PreToolUse' }); } catch (_) {}
    process.exit(0);
  }
})();
