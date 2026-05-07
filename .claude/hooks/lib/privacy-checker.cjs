/**
 * privacy-checker.cjs - Privacy pattern matching for sensitive file detection
 *
 * Pure logic module - no stdin/stdout, no exit codes.
 * Detects .env, credentials, keys, etc. and manages APPROVED: prefix flow.
 */

const path = require('path');
const fs = require('fs');

const APPROVED_PREFIX = 'APPROVED:';

const SAFE_PATTERNS = [
  /\.example$/i,
  /\.sample$/i,
  /\.template$/i,
];

const PRIVACY_PATTERNS = [
  /^\.env$/,
  /^\.env\./,
  /\.env$/,
  /\/\.env\./,
  /credentials/i,
  /secrets?\.ya?ml$/i,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /id_ed25519/,
];

function isSafeFile(testPath) {
  if (!testPath) return false;
  return SAFE_PATTERNS.some(p => p.test(path.basename(testPath)));
}

function hasApprovalPrefix(testPath) {
  return testPath && testPath.startsWith(APPROVED_PREFIX);
}

function stripApprovalPrefix(testPath) {
  return hasApprovalPrefix(testPath) ? testPath.slice(APPROVED_PREFIX.length) : testPath;
}

function isSuspiciousPath(strippedPath) {
  return strippedPath.includes('..') || path.isAbsolute(strippedPath);
}

function isPrivacySensitive(testPath) {
  if (!testPath) return false;
  const cleanPath = stripApprovalPrefix(testPath);
  let normalized = cleanPath.replace(/\\/g, '/');
  try { normalized = decodeURIComponent(normalized); } catch {}
  if (isSafeFile(normalized)) return false;
  const basename = path.basename(normalized);
  return PRIVACY_PATTERNS.some(p => p.test(basename) || p.test(normalized));
}

function extractPaths(toolInput) {
  const paths = [];
  if (!toolInput) return paths;
  if (toolInput.file_path) paths.push({ value: toolInput.file_path, field: 'file_path' });
  if (toolInput.path) paths.push({ value: toolInput.path, field: 'path' });
  if (toolInput.pattern) paths.push({ value: toolInput.pattern, field: 'pattern' });

  if (toolInput.command) {
    const approvedMatch = toolInput.command.match(/APPROVED:[^\s]+/g) || [];
    approvedMatch.forEach(p => paths.push({ value: p, field: 'command' }));
    if (approvedMatch.length === 0) {
      const envMatch = toolInput.command.match(/\.env[^\s]*/g) || [];
      envMatch.forEach(p => paths.push({ value: p, field: 'command' }));
      const varAssignments = toolInput.command.match(/\w+=[^\s]*\.env[^\s]*/g) || [];
      varAssignments.forEach(a => {
        const value = a.split('=')[1];
        if (value) paths.push({ value, field: 'command' });
      });
      const cmdSubst = toolInput.command.match(/\$\([^)]*?(\.env[^\s)]*)[^)]*\)/g) || [];
      for (const subst of cmdSubst) {
        const inner = subst.match(/\.env[^\s)]*/);
        if (inner) paths.push({ value: inner[0], field: 'command' });
      }
    }
  }
  return paths.filter(p => p.value);
}

function buildPromptData(filePath) {
  const basename = path.basename(filePath);
  return {
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
}

/**
 * Main entry: check if a tool call accesses privacy-sensitive files
 */
function checkPrivacy({ toolName, toolInput, options = {} }) {
  const { disabled, allowBash = true } = options;
  if (disabled) return { blocked: false };

  const isBashTool = toolName === 'Bash';
  const paths = extractPaths(toolInput);

  for (const { value: testPath } of paths) {
    if (!isPrivacySensitive(testPath)) continue;

    if (hasApprovalPrefix(testPath)) {
      const strippedPath = stripApprovalPrefix(testPath);
      return { blocked: false, approved: true, filePath: strippedPath, suspicious: isSuspiciousPath(strippedPath) };
    }

    if (isBashTool && allowBash) {
      return { blocked: false, isBash: true, filePath: testPath, reason: `Bash command accesses sensitive file: ${testPath}` };
    }

    return { blocked: true, filePath: testPath, reason: 'Sensitive file access requires user approval', promptData: buildPromptData(testPath) };
  }

  return { blocked: false };
}

module.exports = {
  checkPrivacy,
  isSafeFile, isPrivacySensitive, hasApprovalPrefix, stripApprovalPrefix,
  isSuspiciousPath, extractPaths, buildPromptData,
  APPROVED_PREFIX, SAFE_PATTERNS, PRIVACY_PATTERNS
};
