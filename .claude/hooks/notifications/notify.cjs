#!/usr/bin/env node
/**
 * Notification Hook - sends notification on session Stop
 * Supports: Telegram, Discord, Slack (auto-detected from .env)
 *
 * Usage: echo '{"hook_event_name":"Stop"}' | node notify.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./lib/env-loader.cjs');

// Read JSON from stdin
function readStdin() {
  try {
    if (process.stdin.isTTY) return {};
    const data = fs.readFileSync(0, 'utf-8').trim();
    return data ? JSON.parse(data) : {};
  } catch { return {}; }
}

// Detect active provider from env vars (priority: telegram > discord > slack)
function detectProvider(env) {
  const providers = [
    { name: 'telegram', file: 'telegram.cjs' },
    { name: 'discord', file: 'discord.cjs' },
    { name: 'slack', file: 'slack.cjs' },
  ];

  for (const p of providers) {
    const providerPath = path.join(__dirname, 'providers', p.file);
    if (!fs.existsSync(providerPath)) continue;

    const provider = require(providerPath);
    if (provider.isEnabled(env)) {
      return provider;
    }
  }
  return null;
}

async function main() {
  // 1. Load env with cascade (process.env < ~/.claude/.env < .claude/.env)
  const env = loadEnv();

  // 2. Check ENABLE_NOTIFY flag (default: true for backward compat)
  const enableNotify = (env.ENABLE_NOTIFY ?? 'true').toLowerCase();
  if (enableNotify === 'false' || enableNotify === '0') process.exit(0);

  const provider = detectProvider(env);
  if (!provider) process.exit(0);

  // 3. Read input and send
  const input = readStdin();

  try {
    const result = await provider.send(input, env);
    if (result.success) {
      console.error(`[notify] ${provider.name}: sent`);
    } else if (result.throttled) {
      console.error(`[notify] ${provider.name}: throttled`);
    } else {
      console.error(`[notify] ${provider.name}: failed - ${result.error}`);
    }
  } catch (err) {
    console.error(`[notify] ${provider.name} error: ${err.message}`);
  }

  process.exit(0);
}

main();
