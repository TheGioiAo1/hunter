#!/usr/bin/env node
/**
 * evals/run.cjs — CLI for the eval suite
 *
 * Subcommands:
 *   list                    — List all eval files with name, skill, description
 *   validate                — Validate every eval's JSON schema + required fields
 *   show <name>             — Print one eval's full definition
 *   show <skill>/<name>     — Disambiguate when names collide across skills
 *
 * This runner is the MVP — it does NOT execute evals (no headless Claude Code
 * driver here yet). Its job:
 *   1. Catch malformed eval JSON (missing fields, wrong types) before a human
 *      runs them.
 *   2. Give a quick-scan view so you can pick which eval to run manually.
 *   3. Be a stable target the eventual runner (local-runner.cjs) can extend.
 *
 * Usage:
 *   node .claude/evals/run.cjs list
 *   node .claude/evals/run.cjs validate
 *   node .claude/evals/run.cjs show surgical-discipline
 *   node .claude/evals/run.cjs show cook/reuse-first-check
 *
 * Exit codes:
 *   0 — all OK
 *   1 — validation failure or eval not found
 *   2 — usage error (bad subcommand / missing arg)
 */

const fs = require('fs');
const path = require('path');

const EVALS_ROOT = __dirname;
const SMOKE_DIR = path.join(EVALS_ROOT, 'smoke');

const REQUIRED_FIELDS = ['name', 'skill', 'description', 'prompt', 'assert'];

function walkEvals(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
    }
  }
  return out.sort();
}

function loadEval(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  const data = JSON.parse(raw);
  return { file, data };
}

function validateEval({ file, data }) {
  const errors = [];
  for (const f of REQUIRED_FIELDS) {
    if (!(f in data)) errors.push(`missing field: ${f}`);
  }
  if (data.name && typeof data.name !== 'string') errors.push('name must be string');
  if (data.skill && typeof data.skill !== 'string') errors.push('skill must be string');
  if (data.assert && typeof data.assert !== 'object') errors.push('assert must be object');
  if (data.assert && Object.keys(data.assert).length === 0) errors.push('assert is empty — eval has no checks');
  // Name must match filename (minus .json)
  if (data.name) {
    const base = path.basename(file, '.json').replace(/^\d+-/, '');
    if (data.name !== base) errors.push(`name "${data.name}" does not match filename "${base}"`);
  }
  // Skill must match parent dir
  if (data.skill) {
    const parentDir = path.basename(path.dirname(file));
    if (data.skill !== parentDir) errors.push(`skill "${data.skill}" does not match parent dir "${parentDir}"`);
  }
  return errors;
}

function cmdList() {
  const files = walkEvals(SMOKE_DIR);
  if (files.length === 0) {
    console.log('No evals found under', SMOKE_DIR);
    return 0;
  }
  console.log(`Found ${files.length} eval(s):\n`);
  for (const file of files) {
    try {
      const { data } = loadEval(file);
      const rel = path.relative(EVALS_ROOT, file);
      console.log(`  [${data.skill}] ${data.name}`);
      console.log(`    file: ${rel}`);
      console.log(`    desc: ${data.description}`);
      console.log('');
    } catch (e) {
      console.log(`  [ERROR] ${path.relative(EVALS_ROOT, file)}: ${e.message}`);
    }
  }
  return 0;
}

function cmdValidate() {
  const files = walkEvals(SMOKE_DIR);
  if (files.length === 0) {
    console.log('No evals found under', SMOKE_DIR);
    return 0;
  }
  let failed = 0;
  for (const file of files) {
    const rel = path.relative(EVALS_ROOT, file);
    try {
      const loaded = loadEval(file);
      const errors = validateEval(loaded);
      if (errors.length) {
        failed++;
        console.log(`FAIL  ${rel}`);
        for (const e of errors) console.log(`        - ${e}`);
      } else {
        console.log(`OK    ${rel}`);
      }
    } catch (e) {
      failed++;
      console.log(`FAIL  ${rel}  (parse error: ${e.message})`);
    }
  }
  console.log('');
  console.log(`${files.length - failed}/${files.length} passed`);
  return failed === 0 ? 0 : 1;
}

function cmdShow(arg) {
  if (!arg) {
    console.error('Usage: run.cjs show <name> | <skill>/<name>');
    return 2;
  }
  const [skillFilter, nameFilter] = arg.includes('/') ? arg.split('/') : [null, arg];
  const files = walkEvals(SMOKE_DIR);
  const matches = [];
  for (const file of files) {
    try {
      const { data } = loadEval(file);
      if (data.name === nameFilter && (!skillFilter || data.skill === skillFilter)) {
        matches.push({ file, data });
      }
    } catch {}
  }
  if (matches.length === 0) {
    console.error(`No eval found: ${arg}`);
    return 1;
  }
  if (matches.length > 1) {
    console.error(`Ambiguous — multiple evals named "${nameFilter}":`);
    for (const m of matches) console.error(`  - ${m.data.skill}/${m.data.name} (${path.relative(EVALS_ROOT, m.file)})`);
    console.error('Disambiguate with: show <skill>/<name>');
    return 1;
  }
  const { file, data } = matches[0];
  console.log(`file: ${path.relative(EVALS_ROOT, file)}`);
  console.log('');
  console.log(JSON.stringify(data, null, 2));
  return 0;
}

function main() {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case 'list': return cmdList();
    case 'validate': return cmdValidate();
    case 'show': return cmdShow(args[0]);
    case undefined:
    case '-h':
    case '--help':
      console.log('Usage:');
      console.log('  node .claude/evals/run.cjs list');
      console.log('  node .claude/evals/run.cjs validate');
      console.log('  node .claude/evals/run.cjs show <name>');
      console.log('  node .claude/evals/run.cjs show <skill>/<name>');
      return cmd ? 0 : 2;
    default:
      console.error(`Unknown subcommand: ${cmd}`);
      return 2;
  }
}

process.exit(main());
