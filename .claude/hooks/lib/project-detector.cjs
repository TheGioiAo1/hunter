#!/usr/bin/env node
/**
 * project-detector.cjs - Project and environment detection logic
 *
 * Detects project type, package manager, framework, and runtime versions.
 * Cross-platform Python detection (Windows + Unix).
 *
 * @module project-detector
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

// ═══════════════════════════════════════════════════════════════════════════
// SAFE EXECUTION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function execSafe(cmd, timeoutMs = 5000) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (e) {
    return null;
  }
}

function execFileSafe(binary, args, timeoutMs = 2000) {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PYTHON DETECTION
// ═══════════════════════════════════════════════════════════════════════════

function isValidPythonPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (/[;&|`$(){}[\]<>!#*?]/.test(p)) return false;
  try {
    const stat = fs.statSync(p);
    return stat.isFile();
  } catch (e) {
    return false;
  }
}

function getPythonPaths() {
  const paths = [];

  if (process.env.PYTHON_PATH) {
    paths.push(process.env.PYTHON_PATH);
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    if (localAppData) {
      paths.push(path.join(localAppData, 'Microsoft', 'WindowsApps', 'python.exe'));
      paths.push(path.join(localAppData, 'Microsoft', 'WindowsApps', 'python3.exe'));
      for (const ver of ['313', '312', '311', '310', '39']) {
        paths.push(path.join(localAppData, 'Programs', 'Python', `Python${ver}`, 'python.exe'));
      }
    }

    for (const ver of ['313', '312', '311', '310', '39']) {
      paths.push(path.join(programFiles, `Python${ver}`, 'python.exe'));
      paths.push(path.join(programFilesX86, `Python${ver}`, 'python.exe'));
    }

    paths.push('C:\\Python313\\python.exe', 'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe', 'C:\\Python310\\python.exe', 'C:\\Python39\\python.exe');
  } else {
    paths.push('/usr/bin/python3', '/usr/local/bin/python3',
      '/opt/homebrew/bin/python3', '/opt/homebrew/bin/python',
      '/usr/bin/python', '/usr/local/bin/python');
  }

  return paths;
}

function findPythonBinary() {
  if (process.platform !== 'win32') {
    const whichPython3 = execSafe('which python3', 500);
    if (whichPython3 && isValidPythonPath(whichPython3)) return whichPython3;
    const whichPython = execSafe('which python', 500);
    if (whichPython && isValidPythonPath(whichPython)) return whichPython;
  } else {
    const wherePython = execSafe('where python', 500);
    if (wherePython) {
      const firstPath = wherePython.split('\n')[0].trim();
      if (isValidPythonPath(firstPath)) return firstPath;
    }
  }

  const paths = getPythonPaths();
  for (const p of paths) {
    if (isValidPythonPath(p)) return p;
  }
  return null;
}

function getPythonVersion() {
  const pythonPath = findPythonBinary();
  if (pythonPath) {
    const result = execFileSafe(pythonPath, ['--version']);
    if (result) return result;
  }
  for (const cmd of ['python3', 'python']) {
    const result = execFileSafe(cmd, ['--version']);
    if (result) return result;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// GIT DETECTION
// ═══════════════════════════════════════════════════════════════════════════

function isGitRepo(startDir) {
  let dir;
  try {
    dir = startDir || process.cwd();
  } catch (e) {
    return false;
  }
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    dir = path.dirname(dir);
  }
  return fs.existsSync(path.join(root, '.git'));
}

function getGitRemoteUrl() {
  if (!isGitRepo()) return null;
  return execSafe('git config --get remote.origin.url');
}

function getGitBranch() {
  if (!isGitRepo()) return null;
  return execSafe('git branch --show-current');
}

function getGitRoot() {
  if (!isGitRepo()) return null;
  return execSafe('git rev-parse --show-toplevel');
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT DETECTION
// ═══════════════════════════════════════════════════════════════════════════

function detectProjectType(configOverride) {
  if (configOverride && configOverride !== 'auto') return configOverride;

  if (fs.existsSync('pnpm-workspace.yaml')) return 'monorepo';
  if (fs.existsSync('lerna.json')) return 'monorepo';

  if (fs.existsSync('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      if (pkg.workspaces) return 'monorepo';
      if (pkg.main || pkg.exports) return 'library';
    } catch (e) { /* ignore */ }
  }

  return 'single-repo';
}

function detectPackageManager(configOverride) {
  if (configOverride && configOverride !== 'auto') return configOverride;

  if (fs.existsSync('bun.lockb')) return 'bun';
  if (fs.existsSync('pnpm-lock.yaml')) return 'pnpm';
  if (fs.existsSync('yarn.lock')) return 'yarn';
  if (fs.existsSync('package-lock.json')) return 'npm';

  return null;
}

function detectFramework(configOverride) {
  if (configOverride && configOverride !== 'auto') return configOverride;
  if (!fs.existsSync('package.json')) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps['next']) return 'next';
    if (deps['nuxt']) return 'nuxt';
    if (deps['astro']) return 'astro';
    if (deps['@remix-run/node'] || deps['@remix-run/react']) return 'remix';
    if (deps['svelte'] || deps['@sveltejs/kit']) return 'svelte';
    if (deps['vue']) return 'vue';
    if (deps['react']) return 'react';
    if (deps['express']) return 'express';
    if (deps['fastify']) return 'fastify';
    if (deps['hono']) return 'hono';
    if (deps['elysia']) return 'elysia';

    return null;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT OUTPUT
// ═══════════════════════════════════════════════════════════════════════════

function buildContextOutput(config, detections, resolved, gitRoot) {
  const lines = [`Project: ${detections.type || 'unknown'}`];
  if (detections.pm) lines.push(`PM: ${detections.pm}`);
  if (detections.framework) lines.push(`Framework: ${detections.framework}`);
  lines.push(`Plan naming: ${config.plan.namingFormat}`);

  if (gitRoot && gitRoot !== process.cwd()) {
    lines.push(`Root: ${gitRoot}`);
  }

  if (resolved.path) {
    if (resolved.resolvedBy === 'session') {
      lines.push(`Plan: ${resolved.path}`);
    } else {
      lines.push(`Suggested: ${resolved.path}`);
    }
  }

  return lines.join(' | ');
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

function detectProject(options = {}) {
  const { configOverrides = {} } = options;

  return {
    type: detectProjectType(configOverrides.type),
    packageManager: detectPackageManager(configOverrides.packageManager),
    framework: detectFramework(configOverrides.framework),
    pythonVersion: getPythonVersion(),
    nodeVersion: process.version,
    gitBranch: getGitBranch(),
    gitRoot: getGitRoot(),
    gitUrl: getGitRemoteUrl(),
    osPlatform: process.platform,
    user: process.env.USERNAME || process.env.USER || process.env.LOGNAME || os.userInfo().username,
    locale: process.env.LANG || '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
}

module.exports = {
  detectProject,
  detectProjectType,
  detectPackageManager,
  detectFramework,
  getPythonVersion,
  findPythonBinary,
  getPythonPaths,
  isValidPythonPath,
  isGitRepo,
  getGitRemoteUrl,
  getGitBranch,
  getGitRoot,
  buildContextOutput,
  execSafe,
  execFileSafe
};
