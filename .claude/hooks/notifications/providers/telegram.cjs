/**
 * Telegram notification provider
 * Ported from telegram_notify.sh - uses Telegram Bot API
 */
'use strict';

const { send } = require('../lib/sender.cjs');
const { extractFields } = require('../lib/format.cjs');

/**
 * Format message based on hook event type (Telegram Markdown)
 * @param {Object} input - Hook input with snake_case fields
 * @returns {string} Markdown-formatted message
 */
function formatMessage(input) {
  const { hookType, projectDir, projectName, timestamp, sessionDisplay, agentType } = extractFields(input);

  switch (hookType) {
    case 'Stop':
      return `🚀 *Project Task Completed*

📅 *Time:* ${timestamp}
📁 *Project:* ${projectName}
🆔 *Session:* ${sessionDisplay}

📍 *Location:* \`${projectDir}\``;

    case 'SubagentStop':
      return `🤖 *Project Subagent Completed*

📅 *Time:* ${timestamp}
📁 *Project:* ${projectName}
🔧 *Agent Type:* ${agentType}
🆔 *Session:* ${sessionDisplay}

Specialized agent completed its task.

📍 *Location:* \`${projectDir}\``;

    case 'AskUserPrompt':
      return `💬 *User Input Needed*

📅 *Time:* ${timestamp}
📁 *Project:* ${projectName}
🆔 *Session:* ${sessionDisplay}

Claude is waiting for your input.

📍 *Location:* \`${projectDir}\``;

    default:
      return `📝 *Project Code Event*

📅 *Time:* ${timestamp}
📁 *Project:* ${projectName}
📋 *Event:* ${hookType}
🆔 *Session:* ${sessionDisplay}

📍 *Location:* \`${projectDir}\``;
  }
}

module.exports = {
  name: 'telegram',

  /**
   * Check if Telegram provider is enabled
   * @param {Object} env - Environment variables
   * @returns {boolean}
   */
  isEnabled: (env) => !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),

  /**
   * Send notification to Telegram
   * @param {Object} input - Hook input data (snake_case fields)
   * @param {Object} env - Environment variables
   * @returns {Promise<{success: boolean, error?: string, throttled?: boolean}>}
   */
  send: async (input, env) => {
    const message = formatMessage(input);
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    return send('telegram', url, {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  }
};
