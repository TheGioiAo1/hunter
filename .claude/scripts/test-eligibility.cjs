#!/usr/bin/env node
/**
 * Score a plan directory for TDD eligibility.
 * Reads plan.md + phase-*.md files, applies signal table, returns JSON.
 *
 * Usage:
 *   node .claude/scripts/test-eligibility.cjs <plan-dir>
 *
 * Output (JSON to stdout):
 *   {
 *     eligible: boolean,
 *     score: number,
 *     threshold: number,
 *     reasons: string[],         // which signals matched with +points
 *     excluded: string|null,     // reason for hard exclusion if any
 *     mode: string|null          // if plan.md records --fast, we return mode:"fast" so caller can skip fork
 *   }
 *
 * Scoring (see .claude/skills/plan/SKILL.md for full spec):
 *   +3  auth / security / permissions / RBAC / JWT
 *   +3  payment / billing / money / invoice / stripe / refund
 *   +3  data migration / schema change / backfill
 *   +2  new public API contract (route / endpoint / SDK export)
 *   +2  business logic / service / domain / use-case layer
 *   +2  pure function / algorithm / parser / validator / calculator
 *   +1  phase priority: critical|high
 *   +1  phase with >= 5 implementation steps
 *
 * Hard exclude (force eligible:false regardless of score):
 *   - Plan file list is 100% CSS / style / layout files  → "ui-only"
 *   - Plan file list is 100% config / env / yaml / md / docker → "no-behavior"
 *   - Plan has 1 file modified + <3 steps total                → "trivial"
 *   - plan.md mode line contains "fast"                        → "fast-mode"
 *
 * Threshold: score >= 3 AND not excluded → eligible.
 * Exit: 0 always.
 */

const fs = require('fs');
const path = require('path');

const PLAN_DIR = path.resolve(process.argv[2] || '.');
const THRESHOLD = 3;

const out = {
  eligible: false,
  score: 0,
  threshold: THRESHOLD,
  reasons: [],
  excluded: null,
  mode: null,
};

function fail(msg) {
  out.excluded = msg;
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

if (!fs.existsSync(PLAN_DIR) || !fs.statSync(PLAN_DIR).isDirectory()) {
  fail(`plan dir not found: ${PLAN_DIR}`);
}

function readAllPlanFiles() {
  const files = {};
  for (const name of fs.readdirSync(PLAN_DIR)) {
    if (!/\.md$/.test(name)) continue;
    if (!/^plan\.md$|^phase-\d+/.test(name)) continue;
    try { files[name] = fs.readFileSync(path.join(PLAN_DIR, name), 'utf8'); }
    catch { /* skip */ }
  }
  return files;
}

const planFiles = readAllPlanFiles();
if (Object.keys(planFiles).length === 0) fail('no plan.md or phase-*.md files found');

const combined = Object.values(planFiles).join('\n').toLowerCase();

// --- Mode detection (plan.md only) ---
if (planFiles['plan.md']) {
  const m = planFiles['plan.md'].match(/mode:\s*(\w+)/i);
  if (m) out.mode = m[1].toLowerCase();
  if (out.mode === 'fast') fail('fast-mode (user requested speed)');
}

// --- Hard exclude: pure UI / config-only / trivial ---
function collectFiles() {
  const lines = combined.split('\n');
  const files = new Set();
  // Look inside "related code files" / "modify" / "create" blocks
  let inCodeFiles = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s*related code files/i.test(line)) { inCodeFiles = true; continue; }
    if (/^##\s*/.test(line)) inCodeFiles = false;
    if (!inCodeFiles) continue;
    // match bulleted filenames or paths
    const matches = line.match(/[\w./\-@]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|php|java|kt|rs|swift|css|scss|sass|less|html|yml|yaml|json|toml|md|dockerfile|env)/g);
    if (matches) matches.forEach((f) => files.add(f));
  }
  return [...files];
}

const planFiles_ = collectFiles();
if (planFiles_.length > 0) {
  const isStyle = (f) => /\.(css|scss|sass|less)$/.test(f) || /\.(html|vue)$/.test(f);
  const isConfig = (f) => /\.(yml|yaml|json|toml|env|md|dockerfile)$/i.test(f) || /^\.?env/.test(f);
  const isDoc = (f) => /\.md$/.test(f);
  if (planFiles_.every(isStyle)) fail('ui-only (all files are style/markup)');
  if (planFiles_.every((f) => isConfig(f) || isDoc(f))) fail('no-behavior (all files are config/docs)');
}

// Trivial check: plan.md says "1 file touched" + <3 steps
const stepsCount = (combined.match(/^\s*\d+\.\s/gm) || []).length +
  (combined.match(/^\s*-\s+\[/gm) || []).length;
if (planFiles_.length <= 1 && stepsCount < 3) fail('trivial (single file + <3 steps)');

// --- Signal scoring ---
const SIGNALS = [
  { pts: 3, regex: /\b(auth|oauth|jwt|permission|rbac|role[- ]based|security|credential|session|login|logout|password|csrf|cors|xss)\b/i, label: 'auth/security/permissions' },
  { pts: 3, regex: /\b(payment|billing|invoice|stripe|paypal|refund|subscription|checkout|charge|pricing)\b/i, label: 'payment/billing' },
  { pts: 3, regex: /\b(migration|schema change|backfill|data migration|prisma migrate|alembic|drizzle migrate)\b/i, label: 'data migration/schema' },
  { pts: 2, regex: /\b(api|endpoint|route|controller|rest|graphql|sdk|public interface)\b/i, label: 'public API contract' },
  { pts: 2, regex: /\b(service|domain|use[- ]case|business logic|repository)\b/i, label: 'business logic / service layer' },
  { pts: 2, regex: /\b(validator|parser|calculator|transformer|serializer|pure function|algorithm|utility|util|helper)\b/i, label: 'pure function / algorithm' },
];

for (const sig of SIGNALS) {
  if (sig.regex.test(combined)) {
    out.score += sig.pts;
    out.reasons.push(`+${sig.pts} ${sig.label}`);
  }
}

// Priority bonus (+1) and step-complexity bonus (+1), per phase file
let priorityHit = false;
let stepsHit = false;
for (const [name, content] of Object.entries(planFiles)) {
  if (!/^phase-/.test(name)) continue;
  if (!priorityHit && /priority:\s*(critical|high)/i.test(content)) {
    priorityHit = true;
    out.score += 1;
    out.reasons.push('+1 phase priority: critical/high');
  }
  if (!stepsHit) {
    const phaseSteps = (content.match(/^\s*\d+\.\s/gm) || []).length;
    if (phaseSteps >= 5) {
      stepsHit = true;
      out.score += 1;
      out.reasons.push(`+1 phase has ${phaseSteps} implementation steps`);
    }
  }
}

out.eligible = out.score >= THRESHOLD;
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.exit(0);
