/**
 * Slack notification provider
 * Uses Slack Incoming Webhook — zero dependencies
 */
'use strict';

const { send } = require('../lib/sender.cjs');
const { extractFields } = require('../lib/format.cjs');

/**
 * Format message for Slack (mrkdwn)
 * @param {Object} input - Hook input with snake_case fields
 * @returns {string}
 */
function formatMessage(input) {
  const { hookType, projectDir, projectName, timestamp, sessionDisplay, agentType } = extractFields(input);

  switch (hookType) {
    case 'Stop':
      return `:rocket: *Project Task Completed*\n:calendar: ${timestamp}\n:file_folder: ${projectName}\n:id: ${sessionDisplay}\n:round_pushpin: \`${projectDir}\``;

    case 'SubagentStop': {
      const agentType = input.agent_type || 'unknown';
      return `:robot_face: *Subagent Completed* (${agentType})\n:calendar: ${timestamp}\n:file_folder: ${projectName}\n:id: ${sessionDisplay}\n:round_pushpin: \`${projectDir}\``;
    }

    case 'AskUserPrompt':
      return `:speech_balloon: *User Input Needed*\n:calendar: ${timestamp}\n:file_folder: ${projectName}\n:id: ${sessionDisplay}\nClaude is waiting for your input.\n:round_pushpin: \`${projectDir}\``;

    default:
      return `:memo: *Code Event* (${hookType})\n:calendar: ${timestamp}\n:file_folder: ${projectName}\n:id: ${sessionDisplay}\n:round_pushpin: \`${projectDir}\``;
  }
}

module.exports = {
  name: 'slack',

  /**
   * Check if Slack provider is enabled
   * @param {Object} env - Environment variables
   * @returns {boolean}
   */
  isEnabled: (env) => !!env.SLACK_WEBHOOK_URL,

  /**
   * Send notification to Slack
   * @param {Object} input - Hook input data (snake_case fields)
   * @param {Object} env - Environment variables
   * @returns {Promise<{success: boolean, error?: string, throttled?: boolean}>}
   */
  send: async (input, env) => {
    const message = formatMessage(input);
    return send('slack', env.SLACK_WEBHOOK_URL, { text: message });
  }
};
