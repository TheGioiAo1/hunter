/**
 * Discord notification provider
 * Uses Discord Webhook API — zero dependencies
 */
'use strict';

const { send } = require('../lib/sender.cjs');
const { extractFields } = require('../lib/format.cjs');

/**
 * Format message for Discord (Discord markdown)
 * @param {Object} input - Hook input with snake_case fields
 * @returns {string}
 */
function formatMessage(input) {
  const { hookType, projectDir, projectName, timestamp, sessionDisplay, agentType } = extractFields(input);

  switch (hookType) {
    case 'Stop':
      return `🚀 **Project Task Completed**\n📅 ${timestamp}\n📁 ${projectName}\n🆔 ${sessionDisplay}\n📍 \`${projectDir}\``;

    case 'SubagentStop': {
      const agentType = input.agent_type || 'unknown';
      return `🤖 **Subagent Completed** (${agentType})\n📅 ${timestamp}\n📁 ${projectName}\n🆔 ${sessionDisplay}\n📍 \`${projectDir}\``;
    }

    case 'AskUserPrompt':
      return `💬 **User Input Needed**\n📅 ${timestamp}\n📁 ${projectName}\n🆔 ${sessionDisplay}\nClaude is waiting for your input.\n📍 \`${projectDir}\``;

    default:
      return `📝 **Code Event** (${hookType})\n📅 ${timestamp}\n📁 ${projectName}\n🆔 ${sessionDisplay}\n📍 \`${projectDir}\``;
  }
}

module.exports = {
  name: 'discord',

  /**
   * Check if Discord provider is enabled
   * @param {Object} env - Environment variables
   * @returns {boolean}
   */
  isEnabled: (env) => !!env.DISCORD_WEBHOOK_URL,

  /**
   * Send notification to Discord
   * @param {Object} input - Hook input data (snake_case fields)
   * @param {Object} env - Environment variables
   * @returns {Promise<{success: boolean, error?: string, throttled?: boolean}>}
   */
  send: async (input, env) => {
    const message = formatMessage(input);
    return send('discord', env.DISCORD_WEBHOOK_URL, { content: message });
  }
};
