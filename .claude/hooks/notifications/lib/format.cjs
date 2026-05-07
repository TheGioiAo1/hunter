/**
 * Shared formatting utilities for notification providers
 */
'use strict';

const path = require('path');

/**
 * Format timestamp as YYYY-MM-DD HH:MM:SS
 * @returns {string}
 */
function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
         `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * Extract common fields from hook input
 * @param {Object} input - Hook input with snake_case fields
 * @returns {Object} Extracted fields
 */
function extractFields(input) {
  const hookType = input.hook_event_name || 'unknown';
  const projectDir = input.cwd || '';
  const sessionId = input.session_id || '';
  return {
    hookType,
    projectDir,
    projectName: projectDir ? path.basename(projectDir) : 'unknown',
    timestamp: getTimestamp(),
    sessionDisplay: sessionId ? `${sessionId.slice(0, 8)}...` : 'N/A',
    agentType: input.agent_type || 'unknown',
  };
}

module.exports = { getTimestamp, extractFields };
