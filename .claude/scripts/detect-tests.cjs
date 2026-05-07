#!/usr/bin/env node
/**
 * Detect test framework(s) in a project or monorepo / multi-stack repo.
 *
 * Supports single-project (1 manifest at root) AND multi-project layouts
 * (e.g. apps/api = NestJS + Jest, backend = Go, apps/web = Next + Vitest).
 *
 * Usage:
 *   node .claude/scripts/detect-tests.cjs                  # scan cwd (auto multi)
 *   node .claude/scripts/detect-tests.cjs ./my-repo        # scan path
 *   node .claude/scripts/detect-tests.cjs --path apps/api  # force single-project scope
 *   node .claude/scripts/detect-tests.cjs --max-depth 5    # deeper scan (default 3)
 *
 * Output (JSON to stdout):
 *   {
 *     hasTests: boolean,
 *     projectCount: number,
 *     projects: [
 *       {
 *         path: string,                 // relative to ROOT, "." for root
 *         language: "node"|"go"|"python"|"php"|"ruby"|"unknown",
 *         manifest: string|null,        // e.g. "package.json"
 *         framework: string|null,       // jest|vitest|pytest|go-test|phpunit|pest|...
 *         testDirs: string[],           // paths relative to ROOT
 *         configFile: string|null,      // filename (within project dir)
 *         manifestHasTestRunner: boolean,
 *         testFileCount: number,
 *         hasTests: boolean,
 *         reasons: string[]
 *       }
 *     ],
 *     // Aggregate / backward-compat fields (first project + sums):
 *     framework, testDirs, configFile, manifestHasTestRunner, testFileCount, reasons
 *   }
 *
 * Exit: 0 always (non-blocking).
 */

const fs = require('fs');
const path = require('path');

// ===== Args =====
const args = process.argv.slice(2);
let ROOT = process.cwd();
let SCOPE_PATH = null;
let MAX_DEPTH = 3;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--path' && args[i + 1]) SCOPE_PATH = args[++i];
  else if (a === '--max-depth' && args[i + 1]) MAX_DEPTH = parseInt(args[++i], 10);
  else if (!a.startsWith('--')) ROOT = a;
}
ROOT = path.resolve(ROOT);

// ===== Constants =====
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out',
  'coverage', '.venv', 'venv', '__pycache__', 'target', 'vendor',
  '.turbo', '.cache', '.parcel-cache', '.idea', '.vscode', 'bin', 'obj',
]);

const MANIFESTS = {
  'package.json': 'node',
  'go.mod': 'go',
  'pyproject.toml': 'python',
  'setup.py': 'python',
  'setup.cfg': 'python',
  'composer.json': 'php',
  'Gemfile': 'ruby',
};
const MANIFEST_PRIORITY = [
  'package.json', 'go.mod', 'pyproject.toml', 'composer.json',
  'Gemfile', 'setup.py', 'setup.cfg',
];

const CONFIG_PATTERNS = {
  jest: /^jest\.config\.(js|cjs|mjs|ts)$/,
  vitest: /^vitest\.config\.(js|cjs|mjs|ts)$/,
  playwright: /^playwright\.config\.(js|cjs|mjs|ts)$/,
  cypress: /^cypress\.config\.(js|cjs|mjs|ts)$/,
  karma: /^karma\.conf\.(js|cjs|mjs|ts)$/,
  pytest: /^(pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini)$/,
  phpunit: /^phpunit\.xml(\.dist)?$/,
  pest: /^pest\.xml(\.dist)?$/,
  rspec: /^\.rspec$/,
};

const TEST_DIR_NAMES = new Set([
  '__tests__', 'test', 'tests', 'spec', 'specs', 'e2e',
  'cypress', 'playwright', 'Tests', // Laravel convention
]);

const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$/,
  /\.test\.py$/,
  /^test_.+\.py$/,
  /_test\.go$/,
  /_spec\.rb$/,
  /Test\.php$/,
];

// Node test deps → framework (null = just proves "has test runner", no specific framework)
const TEST_DEPS = {
  jest: 'jest',
  vitest: 'vitest',
  mocha: 'mocha',
  ava: 'ava',
  tape: 'tape',
  jasmine: 'jasmine',
  playwright: 'playwright',
  '@playwright/test': 'playwright',
  cypress: 'cypress',
  puppeteer: null,
  supertest: null,
  chai: null,
  sinon: null,
  '@testing-library/react': null,
  '@testing-library/vue': null,
  '@testing-library/dom': null,
  '@testing-library/jest-dom': null,
  '@testing-library/react-native': null,
};

const PHP_TEST_DEPS = {
  'phpunit/phpunit': 'phpunit',
  'pestphp/pest': 'pest',
  'mockery/mockery': null,
  'fakerphp/faker': null,
  'phpspec/phpspec': 'phpspec',
};

// ===== Helpers =====
function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function inferFrameworkFromTestFile(name) {
  if (/_test\.go$/.test(name)) return 'go-test';
  if (/^test_.+\.py$|\.test\.py$/.test(name)) return 'pytest';
  if (/_spec\.rb$/.test(name)) return 'rspec';
  if (/Test\.php$/.test(name)) return 'phpunit';
  return null;
}

function findManifests(rootDir) {
  // BFS up to MAX_DEPTH; collect every dir that has a known manifest.
  // A dir may contain multiple manifests — pick the highest-priority one.
  const found = new Map(); // absolute dir → manifest filename
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    const entries = listDir(dir);
    const manifestsHere = entries
      .filter(e => e.isFile() && MANIFESTS[e.name])
      .map(e => e.name)
      .sort((a, b) => MANIFEST_PRIORITY.indexOf(a) - MANIFEST_PRIORITY.indexOf(b));
    if (manifestsHere.length > 0 && !found.has(dir)) {
      found.set(dir, manifestsHere[0]);
    }
    if (depth >= MAX_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return found;
}

function detectProject(projectDir, manifestName, allProjectDirs) {
  const result = {
    path: path.relative(ROOT, projectDir) || '.',
    language: manifestName ? MANIFESTS[manifestName] : 'unknown',
    manifest: manifestName,
    framework: null,
    testDirs: [],
    configFile: null,
    manifestHasTestRunner: false,
    testFileCount: 0,
    hasTests: false,
    reasons: [],
  };
  const setFramework = (fw, reason) => {
    if (!result.framework) { result.framework = fw; result.reasons.push(reason); }
    else result.reasons.push(reason);
  };

  // ---- Configs in projectDir ----
  const entries = listDir(projectDir);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    for (const [fw, pattern] of Object.entries(CONFIG_PATTERNS)) {
      if (!pattern.test(entry.name)) continue;
      if (fw === 'pytest' && entry.name !== 'pytest.ini') {
        // Ambiguous: verify pytest section exists
        let content;
        try { content = fs.readFileSync(path.join(projectDir, entry.name), 'utf8'); } catch { continue; }
        if (!/\[tool\.pytest/.test(content) && !/\[pytest\]/.test(content)) continue;
      }
      if (!result.configFile) result.configFile = entry.name;
      setFramework(fw, `config: ${entry.name} (${fw})`);
    }
  }

  // ---- package.json ----
  if (manifestName === 'package.json') {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const dep of Object.keys(deps)) {
        if (!(dep in TEST_DEPS)) continue;
        result.manifestHasTestRunner = true;
        result.reasons.push(`dep: ${dep}`);
        const fw = TEST_DEPS[dep];
        if (fw) setFramework(fw, `inferred from dep: ${dep}`);
      }
      for (const [key, val] of Object.entries(pkg.scripts || {})) {
        if (!/^test(:|$)/.test(key)) continue;
        const v = String(val).trim();
        if (/^echo.*\bno\s*tests?\b/i.test(v)) continue;
        if (v === 'true' || v === 'exit 0' || v === '') continue;
        result.manifestHasTestRunner = true;
        result.reasons.push(`script: ${key}`);
      }
    } catch {}
  }

  // ---- composer.json (PHP) ----
  if (manifestName === 'composer.json') {
    try {
      const comp = JSON.parse(fs.readFileSync(path.join(projectDir, 'composer.json'), 'utf8'));
      const deps = { ...(comp.require || {}), ...(comp['require-dev'] || {}) };
      for (const dep of Object.keys(deps)) {
        if (!(dep in PHP_TEST_DEPS)) continue;
        result.manifestHasTestRunner = true;
        result.reasons.push(`composer dep: ${dep}`);
        const fw = PHP_TEST_DEPS[dep];
        if (fw) setFramework(fw, `inferred from dep: ${dep}`);
      }
      if (comp.scripts && comp.scripts.test) {
        result.manifestHasTestRunner = true;
        result.reasons.push('composer script: test');
      }
    } catch {}
  }

  // ---- pyproject.toml secondary check ----
  if (manifestName === 'pyproject.toml' && !result.framework) {
    try {
      const content = fs.readFileSync(path.join(projectDir, 'pyproject.toml'), 'utf8');
      if (/pytest/i.test(content)) {
        result.manifestHasTestRunner = true;
        setFramework('pytest', 'pytest mentioned in pyproject.toml');
      }
    } catch {}
  }

  // ---- Walk projectDir, excluding sibling/descendant project dirs.
  // Ancestors (e.g. monorepo root when detecting apps/api) must NOT be excluded
  // or we'd refuse to walk into our own dir.
  const otherProjects = Array.from(allProjectDirs).filter(d => {
    if (d === projectDir) return false;
    if (projectDir.startsWith(d + path.sep)) return false; // d is ancestor
    return true;
  });
  function walk(dir, depth = 0, maxDepth = 8) {
    if (depth > maxDepth) return;
    if (otherProjects.some(d => dir === d || dir.startsWith(d + path.sep))) return;
    const ents = listDir(dir);
    for (const entry of ents) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        if (otherProjects.includes(fp)) continue;
        if (TEST_DIR_NAMES.has(entry.name)) {
          result.testDirs.push(path.relative(ROOT, fp));
        }
        walk(fp, depth + 1, maxDepth);
      } else if (entry.isFile()) {
        for (const pattern of TEST_FILE_PATTERNS) {
          if (!pattern.test(entry.name)) continue;
          result.testFileCount++;
          const inferred = inferFrameworkFromTestFile(entry.name);
          if (inferred && !result.framework) {
            setFramework(inferred, `inferred from ${entry.name}`);
          }
          break;
        }
      }
    }
  }
  walk(projectDir);

  result.hasTests = !!(
    result.configFile || result.manifestHasTestRunner || result.testFileCount > 0
  );
  if (result.testFileCount > 0) result.reasons.push(`${result.testFileCount} test file(s)`);
  if (result.testDirs.length > 0) {
    result.reasons.push(`test dirs: ${result.testDirs.slice(0, 5).join(', ')}`);
  }
  return result;
}

// ===== Main =====
let projects = [];

if (SCOPE_PATH) {
  // Scoped single-project mode
  const scopeDir = path.resolve(ROOT, SCOPE_PATH);
  let manifest = null;
  for (const m of MANIFEST_PRIORITY) {
    if (fs.existsSync(path.join(scopeDir, m))) { manifest = m; break; }
  }
  projects.push(detectProject(scopeDir, manifest, new Set([scopeDir])));
} else {
  // Auto multi-project discovery
  const manifestMap = findManifests(ROOT);
  if (manifestMap.size === 0) {
    // No manifest — treat ROOT as a single "unknown" project (orphan tests)
    projects.push(detectProject(ROOT, null, new Set([ROOT])));
  } else {
    const projectDirs = new Set(manifestMap.keys());
    for (const [dir, manifestName] of manifestMap) {
      projects.push(detectProject(dir, manifestName, projectDirs));
    }
  }
}

// If multiple projects found AND at least one has tests, drop empty ones.
// (Root monorepo manifests without tests are noise.)
const anyHasTests = projects.some(p => p.hasTests);
if (projects.length > 1 && anyHasTests) {
  projects = projects.filter(p => p.hasTests);
}

// Sort: shallowest first, then alpha.
projects.sort((a, b) => {
  const ad = a.path === '.' ? 0 : a.path.split(path.sep).length;
  const bd = b.path === '.' ? 0 : b.path.split(path.sep).length;
  if (ad !== bd) return ad - bd;
  return a.path.localeCompare(b.path);
});

const primary = projects[0] || {
  framework: null, testDirs: [], configFile: null,
  manifestHasTestRunner: false, testFileCount: 0, reasons: [],
};

const output = {
  hasTests: anyHasTests,
  projectCount: projects.length,
  projects,
  // Backward-compat top-level fields
  framework: primary.framework,
  testDirs: projects.flatMap(p => p.testDirs),
  configFile: primary.configFile,
  manifestHasTestRunner: projects.some(p => p.manifestHasTestRunner),
  testFileCount: projects.reduce((s, p) => s + p.testFileCount, 0),
  reasons: projects.flatMap(p =>
    p.reasons.map(r => (projects.length > 1 ? `[${p.path}] ${r}` : r))
  ),
};

process.stdout.write(JSON.stringify(output, null, 2) + '\n');
process.exit(0);
