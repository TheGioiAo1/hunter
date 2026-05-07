/**
 * Shared utilities for claudex-kit hooks
 *
 * Config loading (cascade: DEFAULT -> global -> local), path sanitization,
 * plan resolution, naming patterns, env writing, git helpers.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOCAL_CONFIG_PATH = '.claude/.claude-config.json';
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.claude', '.claude-config.json');
const CONFIG_PATH = LOCAL_CONFIG_PATH;

const DEFAULT_CONFIG = {
  plan: {
    namingFormat: '{date}-{issue}-{slug}',
    dateFormat: 'YYMMDD-HHmm',
    issuePrefix: null,
    reportsDir: 'reports',
    resolution: {
      order: ['session', 'branch'],
      branchPattern: '(?:feat|fix|chore|refactor|docs)/(?:[^/]+/)?(.+)'
    },
    validation: {
      mode: 'prompt',
      minQuestions: 3,
      maxQuestions: 8,
      focusAreas: ['assumptions', 'risks', 'tradeoffs', 'architecture']
    }
  },
  paths: {
    docs: 'docs',
    plans: 'plans'
  },
  docs: {
    maxLoc: 800
  },
  locale: {
    thinkingLanguage: null,
    responseLanguage: null
  },
  project: {
    type: 'auto',
    packageManager: 'auto',
    framework: 'auto'
  },
  skills: {
    research: {
      useGemini: true
    }
  },
  assertions: [],
  hooks: {
    'session-init': true,
    'session-state': true,
    'descriptive-name': true,
    'privacy-block': true,
    'subagent-init': true,
    'dev-rules-reminder': true,
    'plan-format-kanban': true,
    'session-sync': true,
    'skill-telemetry': true
  }
};

/**
 * Deep merge objects (source values override target, nested objects merged recursively)
 * Arrays replaced entirely. Empty objects {} = "inherit from parent".
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  if (!target || typeof target !== 'object') return source;

  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (Array.isArray(sourceVal)) {
      result[key] = [...sourceVal];
    } else if (sourceVal !== null && typeof sourceVal === 'object' && !Array.isArray(sourceVal)) {
      if (Object.keys(sourceVal).length === 0) continue;
      result[key] = deepMerge(targetVal || {}, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

function loadConfigFromPath(configPath) {
  try {
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function getSessionTempPath(sessionId) {
  return path.join(os.tmpdir(), `ck-session-${sessionId}.json`);
}

function readSessionState(sessionId) {
  if (!sessionId) return null;
  const tempPath = getSessionTempPath(sessionId);
  try {
    if (!fs.existsSync(tempPath)) return null;
    return JSON.parse(fs.readFileSync(tempPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeSessionState(sessionId, state) {
  if (!sessionId) return false;
  const tempPath = getSessionTempPath(sessionId);
  const tmpFile = tempPath + '.' + Math.random().toString(36).slice(2);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, tempPath);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    return false;
  }
}

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f\x7f]/g;

function sanitizeSlug(slug) {
  if (!slug || typeof slug !== 'string') return '';
  return slug
    .replace(INVALID_FILENAME_CHARS, '')
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function extractSlugFromBranch(branch, pattern) {
  if (!branch) return null;
  const defaultPattern = /(?:feat|fix|chore|refactor|docs)\/(?:[^\/]+\/)?(.+)/;
  const regex = pattern ? new RegExp(pattern) : defaultPattern;
  const match = branch.match(regex);
  return match ? sanitizeSlug(match[1]) : null;
}

function findMostRecentPlan(plansDir) {
  try {
    if (!fs.existsSync(plansDir)) return null;
    const entries = fs.readdirSync(plansDir, { withFileTypes: true });
    const planDirs = entries
      .filter(e => e.isDirectory() && /^\d{6}/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse();
    return planDirs.length > 0 ? path.join(plansDir, planDirs[0]) : null;
  } catch (e) {
    return null;
  }
}

const DEFAULT_EXEC_TIMEOUT_MS = 5000;

function execSafe(cmd, options = {}) {
  const allowedCommands = [
    'git branch --show-current',
    'git rev-parse --abbrev-ref HEAD',
    'git rev-parse --show-toplevel'
  ];
  if (!allowedCommands.includes(cmd)) return null;

  const { cwd = undefined, timeout = DEFAULT_EXEC_TIMEOUT_MS } = options;
  try {
    return require('child_process')
      .execSync(cmd, {
        encoding: 'utf8',
        timeout,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      .trim();
  } catch (e) {
    return null;
  }
}

/**
 * Resolve active plan path using cascading resolution
 * 'session': explicitly set -> ACTIVE
 * 'branch': matched from git branch -> SUGGESTED (hint only)
 */
function resolvePlanPath(sessionId, config) {
  const plansDir = config?.paths?.plans || 'plans';
  const resolution = config?.plan?.resolution || {};
  const order = resolution.order || ['session', 'branch'];
  const branchPattern = resolution.branchPattern;

  for (const method of order) {
    switch (method) {
      case 'session': {
        const state = readSessionState(sessionId);
        if (state?.activePlan) {
          let resolvedPath = state.activePlan;
          if (!path.isAbsolute(resolvedPath) && state.sessionOrigin) {
            resolvedPath = path.join(state.sessionOrigin, resolvedPath);
          }
          return { path: resolvedPath, resolvedBy: 'session' };
        }
        break;
      }
      case 'branch': {
        try {
          const branch = execSafe('git branch --show-current');
          const slug = extractSlugFromBranch(branch, branchPattern);
          if (slug && fs.existsSync(plansDir)) {
            const entries = fs.readdirSync(plansDir, { withFileTypes: true })
              .filter(e => e.isDirectory() && e.name.includes(slug));
            if (entries.length > 0) {
              return {
                path: path.join(plansDir, entries[entries.length - 1].name),
                resolvedBy: 'branch'
              };
            }
          }
        } catch (e) {}
        break;
      }
    }
  }
  return { path: null, resolvedBy: null };
}

function normalizePath(pathValue) {
  if (!pathValue || typeof pathValue !== 'string') return null;
  let normalized = pathValue.trim();
  if (!normalized) return null;
  normalized = normalized.replace(/[/\\]+$/, '');
  if (!normalized) return null;
  return normalized;
}

function isAbsolutePath(pathValue) {
  if (!pathValue) return false;
  return path.isAbsolute(pathValue);
}

function sanitizePath(pathValue, projectRoot) {
  const normalized = normalizePath(pathValue);
  if (!normalized) return null;
  if (/[\x00]/.test(normalized)) return null;
  if (isAbsolutePath(normalized)) return normalized;

  const resolved = path.resolve(projectRoot, normalized);
  if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
    return null;
  }
  return normalized;
}

function sanitizeConfig(config, projectRoot) {
  const result = { ...config };

  if (result.plan) {
    result.plan = { ...result.plan };
    if (!sanitizePath(result.plan.reportsDir, projectRoot)) {
      result.plan.reportsDir = DEFAULT_CONFIG.plan.reportsDir;
    }
    result.plan.resolution = { ...DEFAULT_CONFIG.plan.resolution, ...result.plan.resolution };
    result.plan.validation = { ...DEFAULT_CONFIG.plan.validation, ...result.plan.validation };
  }

  if (result.paths) {
    result.paths = { ...result.paths };
    if (!sanitizePath(result.paths.docs, projectRoot)) {
      result.paths.docs = DEFAULT_CONFIG.paths.docs;
    }
    if (!sanitizePath(result.paths.plans, projectRoot)) {
      result.paths.plans = DEFAULT_CONFIG.paths.plans;
    }
  }

  return result;
}

/**
 * Load config with cascading: DEFAULT -> global -> local
 */
function loadConfig(options = {}) {
  const { includeProject = true, includeAssertions = true, includeLocale = true } = options;
  const projectRoot = process.cwd();

  const globalConfig = loadConfigFromPath(GLOBAL_CONFIG_PATH);
  const localConfig = loadConfigFromPath(LOCAL_CONFIG_PATH);

  if (!globalConfig && !localConfig) {
    return getDefaultConfig(includeProject, includeAssertions, includeLocale);
  }

  try {
    let merged = deepMerge({}, DEFAULT_CONFIG);
    if (globalConfig) merged = deepMerge(merged, globalConfig);
    if (localConfig) merged = deepMerge(merged, localConfig);

    const result = {
      plan: merged.plan || DEFAULT_CONFIG.plan,
      paths: merged.paths || DEFAULT_CONFIG.paths,
      docs: merged.docs || DEFAULT_CONFIG.docs,
      skills: merged.skills || DEFAULT_CONFIG.skills,
      hooks: merged.hooks || DEFAULT_CONFIG.hooks
    };

    if (includeLocale) result.locale = merged.locale || DEFAULT_CONFIG.locale;
    if (includeProject) result.project = merged.project || DEFAULT_CONFIG.project;
    if (includeAssertions) result.assertions = merged.assertions || [];
    // Coding level (0-3): Intern, Junior, Mid, Senior+
    if (merged.codingLevel != null) result.codingLevel = merged.codingLevel;

    return sanitizeConfig(result, projectRoot);
  } catch (e) {
    return getDefaultConfig(includeProject, includeAssertions, includeLocale);
  }
}

function getDefaultConfig(includeProject = true, includeAssertions = true, includeLocale = true) {
  const result = {
    plan: { ...DEFAULT_CONFIG.plan },
    paths: { ...DEFAULT_CONFIG.paths },
    docs: { ...DEFAULT_CONFIG.docs },
    skills: { ...DEFAULT_CONFIG.skills },
    hooks: { ...DEFAULT_CONFIG.hooks }
  };
  if (includeLocale) result.locale = { ...DEFAULT_CONFIG.locale };
  if (includeProject) result.project = { ...DEFAULT_CONFIG.project };
  if (includeAssertions) result.assertions = [];
  return result;
}

function escapeShellValue(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
}

function writeEnv(envFile, key, value) {
  if (envFile && value !== null && value !== undefined) {
    const escaped = escapeShellValue(String(value));
    fs.appendFileSync(envFile, `export ${key}="${escaped}"\n`);
  }
}

function getReportsPath(planPath, resolvedBy, planConfig, pathsConfig, baseDir = null) {
  const reportsDir = normalizePath(planConfig?.reportsDir) || 'reports';
  const plansDir = normalizePath(pathsConfig?.plans) || 'plans';

  let reportPath;
  const normalizedPlanPath = planPath && resolvedBy === 'session' ? normalizePath(planPath) : null;
  if (normalizedPlanPath) {
    reportPath = `${normalizedPlanPath}/${reportsDir}`;
  } else {
    reportPath = `${plansDir}/${reportsDir}`;
  }

  if (baseDir) {
    return path.isAbsolute(reportPath) ? reportPath : path.join(baseDir, reportPath);
  }
  return reportPath + '/';
}

function formatIssueId(issueId, planConfig) {
  if (!issueId) return null;
  return planConfig.issuePrefix ? `${planConfig.issuePrefix}${issueId}` : `#${issueId}`;
}

function extractIssueFromBranch(branch) {
  if (!branch) return null;
  const patterns = [
    /(?:issue|gh|fix|feat|bug)[/-]?(\d+)/i,
    /[/-](\d+)[/-]/,
    /#(\d+)/
  ];
  for (const pattern of patterns) {
    const match = branch.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function formatDate(format) {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const tokens = {
    'YYYY': now.getFullYear(),
    'YY': String(now.getFullYear()).slice(-2),
    'MM': pad(now.getMonth() + 1),
    'DD': pad(now.getDate()),
    'HH': pad(now.getHours()),
    'mm': pad(now.getMinutes()),
    'ss': pad(now.getSeconds())
  };
  let result = format;
  for (const [token, value] of Object.entries(tokens)) {
    result = result.replace(token, value);
  }
  return result;
}

function validateNamingPattern(pattern) {
  if (!pattern || typeof pattern !== 'string') {
    return { valid: false, error: 'Pattern is empty or not a string' };
  }
  const withoutSlug = pattern.replace(/\{slug\}/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!withoutSlug) {
    return { valid: false, error: 'Pattern resolves to empty after removing {slug}' };
  }
  const unresolvedMatch = withoutSlug.match(/\{[^}]+\}/);
  if (unresolvedMatch) {
    return { valid: false, error: `Unresolved placeholder: ${unresolvedMatch[0]}` };
  }
  if (!pattern.includes('{slug}')) {
    return { valid: false, error: 'Pattern must contain {slug} placeholder' };
  }
  return { valid: true };
}

function resolveNamingPattern(planConfig, gitBranch) {
  const { namingFormat, dateFormat, issuePrefix } = planConfig;
  const formattedDate = formatDate(dateFormat);
  const issueId = extractIssueFromBranch(gitBranch);
  const fullIssue = issueId && issuePrefix ? `${issuePrefix}${issueId}` : null;

  let pattern = namingFormat;
  pattern = pattern.replace('{date}', formattedDate);

  if (fullIssue) {
    pattern = pattern.replace('{issue}', fullIssue);
  } else {
    pattern = pattern.replace(/-?\{issue\}-?/, '-').replace(/--+/g, '-');
  }

  pattern = pattern
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-+(\{slug\})/g, '-$1')
    .replace(/(\{slug\})-+/g, '$1-')
    .replace(/--+/g, '-');

  return pattern;
}

function getGitBranch(cwd = null) {
  return execSafe('git branch --show-current', { cwd: cwd || undefined });
}

function getGitRoot(cwd = null) {
  return execSafe('git rev-parse --show-toplevel', { cwd: cwd || undefined });
}

/**
 * Resolve project root from any cwd (handles monorepos / nested sub-projects).
 *
 * Priority:
 *   1. `git rev-parse --show-toplevel` (walks up to the Git repo root).
 *   2. Walk up until a `.claude/.claude-config.json` marker is found (CK-specific).
 *   3. Walk up until a `.git` folder is found manually (fallback when git CLI missing).
 *   4. Fallback to the original cwd.
 *
 * Prevents bugs where hooks operating from a sub-project (e.g. `repo/frontend/`)
 * would write session-state / reports into the sub-project's own `.claude/`
 * instead of the real project root.
 */
function resolveProjectRoot(cwd) {
  const start = cwd ? path.resolve(cwd) : process.cwd();

  // Priority 1: git toplevel
  const gitRoot = getGitRoot(start);
  if (gitRoot) return gitRoot;

  const { root } = path.parse(start);

  // Priority 2: walk up for CK config marker
  let dir = start;
  while (dir && dir !== root) {
    if (fs.existsSync(path.join(dir, '.claude', '.claude-config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Priority 3: walk up for .git (folder or file, the latter for worktrees / submodules)
  dir = start;
  while (dir && dir !== root) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback
  return start;
}

function extractTaskListId(resolved) {
  if (!resolved || resolved.resolvedBy !== 'session' || !resolved.path) {
    return null;
  }
  return path.basename(resolved.path);
}

function isHookEnabled(hookName) {
  const config = loadConfig({ includeProject: false, includeAssertions: false, includeLocale: false });
  const hooks = config.hooks || {};
  return hooks[hookName] !== false;
}

module.exports = {
  CONFIG_PATH,
  LOCAL_CONFIG_PATH,
  GLOBAL_CONFIG_PATH,
  DEFAULT_CONFIG,
  INVALID_FILENAME_CHARS,
  deepMerge,
  loadConfigFromPath,
  loadConfig,
  normalizePath,
  isAbsolutePath,
  sanitizePath,
  sanitizeSlug,
  sanitizeConfig,
  escapeShellValue,
  writeEnv,
  getSessionTempPath,
  readSessionState,
  writeSessionState,
  resolvePlanPath,
  extractSlugFromBranch,
  findMostRecentPlan,
  getReportsPath,
  formatIssueId,
  extractIssueFromBranch,
  formatDate,
  validateNamingPattern,
  resolveNamingPattern,
  getGitBranch,
  getGitRoot,
  resolveProjectRoot,
  extractTaskListId,
  isHookEnabled
};
