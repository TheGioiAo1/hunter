#!/usr/bin/env node
/**
 * SessionStart Hook - Initializes session environment with project detection
 *
 * Fires: Once per session (startup, resume, clear, compact)
 * Purpose: Load config, detect project info, persist to env vars, output context
 *
 * Exit Codes:
 *   0 - Always (fail-open, non-blocking)
 */

// Crash wrapper
try {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const {
    loadConfig,
    writeEnv,
    writeSessionState,
    resolvePlanPath,
    getReportsPath,
    resolveNamingPattern,
    extractTaskListId,
    isHookEnabled
  } = require('./lib/config-utils.cjs');
  const { createHookTimer, logHookCrash } = require('./lib/hook-logger.cjs');

  // Early exit if hook disabled in config
  if (!isHookEnabled('session-init')) {
    process.exit(0);
  }

  const {
    detectProjectType,
    detectPackageManager,
    detectFramework,
    getPythonVersion,
    getGitRemoteUrl,
    getGitBranch,
    getGitRoot,
    buildContextOutput
  } = require('./lib/project-detector.cjs');

  async function main() {
    const timer = createHookTimer('session-init', { event: 'SessionStart' });
    try {
      const stdin = fs.readFileSync(0, 'utf-8').trim();
      const data = stdin ? JSON.parse(stdin) : {};
      const envFile = process.env.CLAUDE_ENV_FILE;
      const source = data.source || 'unknown';
      const sessionId = data.session_id || null;

      const config = loadConfig();

      const detections = {
        type: detectProjectType(config.project?.type),
        pm: detectPackageManager(config.project?.packageManager),
        framework: detectFramework(config.project?.framework)
      };

      // Resolve plan - returns { path, resolvedBy }
      const resolved = resolvePlanPath(null, config);

      // Only persist explicitly-set plans to session state
      if (sessionId) {
        writeSessionState(sessionId, {
          sessionOrigin: process.cwd(),
          activePlan: resolved.resolvedBy === 'session' ? resolved.path : null,
          suggestedPlan: resolved.resolvedBy === 'branch' ? resolved.path : null,
          timestamp: Date.now(),
          source
        });
      }

      // Reports path only uses active plans, not suggested ones
      const reportsPath = getReportsPath(resolved.path, resolved.resolvedBy, config.plan, config.paths);

      // Task list ID for Claude Code Tasks coordination
      const taskListId = extractTaskListId(resolved);

      // Static environment info (computed once per session)
      const staticEnv = {
        nodeVersion: process.version,
        pythonVersion: getPythonVersion(),
        osPlatform: process.platform,
        gitUrl: getGitRemoteUrl(),
        gitBranch: getGitBranch(),
        gitRoot: getGitRoot(),
        user: process.env.USERNAME || process.env.USER || process.env.LOGNAME || os.userInfo().username,
        locale: process.env.LANG || '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        claudeSettingsDir: path.resolve(__dirname, '..')
      };

      const baseDir = process.cwd();
      const namePattern = resolveNamingPattern(config.plan, staticEnv.gitBranch);

      if (envFile) {
        // Session & plan config
        writeEnv(envFile, 'CK_SESSION_ID', sessionId || '');
        writeEnv(envFile, 'CK_PLAN_NAMING_FORMAT', config.plan.namingFormat);
        writeEnv(envFile, 'CK_PLAN_DATE_FORMAT', config.plan.dateFormat);
        writeEnv(envFile, 'CK_PLAN_ISSUE_PREFIX', config.plan.issuePrefix || '');
        writeEnv(envFile, 'CK_PLAN_REPORTS_DIR', config.plan.reportsDir);

        // Resolved naming pattern for DRY file naming
        writeEnv(envFile, 'CK_NAME_PATTERN', namePattern);

        // Plan resolution
        writeEnv(envFile, 'CK_ACTIVE_PLAN', resolved.resolvedBy === 'session' ? resolved.path : '');
        writeEnv(envFile, 'CK_SUGGESTED_PLAN', resolved.resolvedBy === 'branch' ? resolved.path : '');

        // Task list ID for multi-session coordination
        if (taskListId) {
          writeEnv(envFile, 'CLAUDE_CODE_TASK_LIST_ID', taskListId);
        }

        // Paths (absolute based on CWD)
        writeEnv(envFile, 'CK_GIT_ROOT', staticEnv.gitRoot || '');
        writeEnv(envFile, 'CK_REPORTS_PATH', path.join(baseDir, reportsPath));
        writeEnv(envFile, 'CK_DOCS_PATH', path.join(baseDir, config.paths.docs));
        writeEnv(envFile, 'CK_PLANS_PATH', path.join(baseDir, config.paths.plans));
        writeEnv(envFile, 'CK_PROJECT_ROOT', process.cwd());

        // Project detection
        writeEnv(envFile, 'CK_PROJECT_TYPE', detections.type || '');
        writeEnv(envFile, 'CK_PACKAGE_MANAGER', detections.pm || '');
        writeEnv(envFile, 'CK_FRAMEWORK', detections.framework || '');

        // Static environment info
        writeEnv(envFile, 'CK_NODE_VERSION', staticEnv.nodeVersion);
        writeEnv(envFile, 'CK_PYTHON_VERSION', staticEnv.pythonVersion || '');
        writeEnv(envFile, 'CK_OS_PLATFORM', staticEnv.osPlatform);
        writeEnv(envFile, 'CK_GIT_URL', staticEnv.gitUrl || '');
        writeEnv(envFile, 'CK_GIT_BRANCH', staticEnv.gitBranch || '');
        writeEnv(envFile, 'CK_USER', staticEnv.user);
        writeEnv(envFile, 'CK_LOCALE', staticEnv.locale);
        writeEnv(envFile, 'CK_TIMEZONE', staticEnv.timezone);
        writeEnv(envFile, 'CK_CLAUDE_SETTINGS_DIR', staticEnv.claudeSettingsDir);

        // Locale config
        if (config.locale?.thinkingLanguage) {
          writeEnv(envFile, 'CK_THINKING_LANGUAGE', config.locale.thinkingLanguage);
        }
        if (config.locale?.responseLanguage) {
          writeEnv(envFile, 'CK_RESPONSE_LANGUAGE', config.locale.responseLanguage);
        }

        // Plan validation config
        const validation = config.plan?.validation || {};
        writeEnv(envFile, 'CK_VALIDATION_MODE', validation.mode || 'prompt');
        writeEnv(envFile, 'CK_VALIDATION_MIN_QUESTIONS', validation.minQuestions || 3);
        writeEnv(envFile, 'CK_VALIDATION_MAX_QUESTIONS', validation.maxQuestions || 8);
        writeEnv(envFile, 'CK_VALIDATION_FOCUS_AREAS', (validation.focusAreas || ['assumptions', 'risks', 'tradeoffs', 'architecture']).join(','));
      }

      // Console output
      console.log(`Session ${source}. ${buildContextOutput(config, detections, resolved, staticEnv.gitRoot)}`);

      // Subdirectory mode info
      if (staticEnv.gitRoot && staticEnv.gitRoot !== process.cwd()) {
        console.log(`Subdirectory mode: Plans/docs will be created in current directory`);
        console.log(`   Git root: ${staticEnv.gitRoot}`);
      }

      // Compact warning: verify pending approvals
      if (source === 'compact') {
        console.log(`\nCONTEXT COMPACTED - APPROVAL STATE CHECK:`);
        console.log(`If you were waiting for user approval via AskUserQuestion,`);
        console.log(`you MUST re-confirm with the user before proceeding.`);
      }

      // User assertions
      if (config.assertions?.length > 0) {
        console.log(`\nUser Assertions:`);
        config.assertions.forEach((assertion, i) => {
          console.log(`  ${i + 1}. ${assertion}`);
        });
      }

      // Coding level injection (env > config > default 2)
      const codingLevelGuidelines = {
        0: `Coding Level: 0 (Intern)\nGiải thích mọi thuật ngữ bắt buộc trong 1-2 dòng (VD: "API = cổng giao tiếp giữa 2 phần mềm"). Tránh jargon khi có thể thay bằng tiếng thường. Comment code nhiều. Giải thích WHY trước HOW. Cảnh báo lỗi hay gặp.`,
        1: `Coding Level: 1 (Junior)\nGiải thích pattern/concept khi lần đầu xuất hiện, không giải thích syntax cơ bản. Gợi ý best practices. Cảnh báo anti-patterns. Link docs khi relevant.`,
        2: `Coding Level: 2 (Mid)\nChỉ giải thích khi logic phức tạp hoặc trade-off không rõ ràng. Focus architecture decisions, edge cases, performance. Comment code vừa đủ.`,
        3: `Coding Level: 3 (Senior+)\nTối giản lời. Code + trade-off ngắn gọn. Không giải thích pattern đã biết. Focus scalability, security, business impact, risk.`
      };
      const envLevel = process.env.CODING_LEVEL;
      const rawLevel = envLevel != null ? Number(envLevel) : (config.codingLevel ?? 2);
      const level = Math.max(0, Math.min(3, Math.round(rawLevel)));
      console.log(`\n${codingLevelGuidelines[level]}`);
      if (envFile) {
        writeEnv(envFile, 'CK_CODING_LEVEL', String(level));
      }

      timer.end({ status: 'ok', exit: 0, note: source || 'session-start' });
      process.exit(0);
    } catch (error) {
      console.error(`SessionStart hook error: ${error.message}`);
      logHookCrash('session-init', error, { event: 'SessionStart' });
      process.exit(0);
    }
  }

  main();
} catch (e) {
  try {
    const { logHookCrash } = require('./lib/hook-logger.cjs');
    logHookCrash('session-init', e, { event: 'SessionStart' });
  } catch (_) {}
  process.exit(0); // fail-open
}
