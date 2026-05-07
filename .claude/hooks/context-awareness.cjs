#!/usr/bin/env node
/**
 * context-awareness.cjs — UserPromptSubmit + PostToolUse hook
 *
 * Fetches Claude Code usage limits from Anthropic OAuth API, caches, and
 * injects a <context-awareness> tag so the agent can self-regulate and
 * trigger compaction before quality degrades.
 *
 * Self-contained: no /lib deps. Fail-open on any error — never block.
 *
 * Thresholds:
 *   <90%  OK        — normal operation
 *   >=90% WARNING   — compact, offload to files, keep replies concise
 *   >=98% CRITICAL  — snapshot state, stop chain, ask for /compact
 *
 * Cache: /tmp/claudex-kit-usage-cache.json (TTL 60s for prompts, 5min for tools)
 */

try {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const { execSync } = require("child_process");

  const CACHE_FILE = path.join(os.tmpdir(), "claudex-kit-usage-cache.json");
  const TTL_PROMPT_MS = 60_000;      // 1 min
  const TTL_TOOL_MS = 300_000;       // 5 min

  function getAccessToken() {
    // macOS: Keychain first
    if (os.platform() === "darwin") {
      try {
        const out = execSync(
          'security find-generic-password -s "Claude Code-credentials" -w',
          { timeout: 3000, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
        ).trim();
        const parsed = JSON.parse(out);
        if (parsed?.claudeAiOauth?.accessToken) return parsed.claudeAiOauth.accessToken;
      } catch {}
    }
    // File-based (Linux/Windows + macOS fallback)
    try {
      const p = path.join(os.homedir(), ".claude", ".credentials.json");
      const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
      return parsed?.claudeAiOauth?.accessToken ?? null;
    } catch {
      return null;
    }
  }

  function readCache(ttl) {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      if (Date.now() - c.timestamp < ttl) return c;
    } catch {}
    return null;
  }

  function writeCache(data) {
    const tmp = `${CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ timestamp: Date.now(), data }));
      fs.renameSync(tmp, CACHE_FILE);
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  async function fetchUsage() {
    const token = getAccessToken();
    if (!token) return null;
    try {
      const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claudex-kit/1.0"
        }
      });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  function toPct(v) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    // API returns integer percents (19, 59, 1, 0). Older/alt shapes may use
    // 0–1 fractions (0.19). Integer → already percent; non-integer ≤1 → fraction.
    // Previous heuristic `v > 1` broke at v=1 → reported 100% instead of 1%.
    const pct = Number.isInteger(v) ? v : (v <= 1 ? v * 100 : v);
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  function pickQuotaPct(usage) {
    if (!usage) return { h5: null, d7: null };
    // Response shape varies across API revisions — best-effort extraction.
    const fiveHour =
      usage?.five_hour?.utilization ??
      usage?.fiveHour?.utilization ??
      usage?.["5h"]?.percent_used ??
      usage?.five_hour_limit?.percent_used ?? null;
    const sevenDay =
      usage?.seven_day?.utilization ??
      usage?.sevenDay?.utilization ??
      usage?.["7d"]?.percent_used ??
      usage?.seven_day_limit?.percent_used ?? null;
    return { h5: toPct(fiveHour), d7: toPct(sevenDay) };
  }

  // Context window: read last assistant message's usage from the transcript JSONL.
  // Auto-detect model from transcript → map to correct context window size.
  // effective input = input + cache_read + cache_create.
  const MODEL_CONTEXT_WINDOWS = {
    opus: 1_000_000,    // 1M tokens
    default: 200_000,   // 200K tokens (sonnet, haiku, etc.)
  };

  function detectContextWindow(model) {
    if (typeof model === "string" && model.includes("opus")) return MODEL_CONTEXT_WINDOWS.opus;
    return MODEL_CONTEXT_WINDOWS.default;
  }

  function readContextPct(transcriptPath) {
    if (!transcriptPath) return { pct: null, tokens: null, contextWindow: MODEL_CONTEXT_WINDOWS.default };
    try {
      if (!fs.existsSync(transcriptPath)) return { pct: null, tokens: null, contextWindow: MODEL_CONTEXT_WINDOWS.default };
      const content = fs.readFileSync(transcriptPath, "utf-8");
      const lines = content.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const msg = JSON.parse(lines[i]);
          const model = msg?.message?.model;
          const usage = msg?.message?.usage ?? msg?.usage;
          if (usage && typeof usage.input_tokens === "number") {
            const contextWindow = detectContextWindow(model);
            const tokens = (usage.input_tokens || 0)
              + (usage.cache_read_input_tokens || 0)
              + (usage.cache_creation_input_tokens || 0);
            const pct = Math.round((tokens / contextWindow) * 100);
            return { pct, tokens, contextWindow };
          }
        } catch {}
      }
    } catch {}
    return { pct: null, tokens: null, contextWindow: MODEL_CONTEXT_WINDOWS.default };
  }

  function fmtK(n) {
    if (n == null) return "?";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
  }

  function buildContext(ctx, quota) {
    const windowLabel = ctx.contextWindow >= 1_000_000
      ? `${(ctx.contextWindow / 1_000_000).toFixed(0)}M`
      : `${(ctx.contextWindow / 1_000).toFixed(0)}K`;
    const ctxLine = ctx.pct != null
      ? `Conversation: ${ctx.pct}% (${fmtK(ctx.tokens)}/${windowLabel})`
      : "Conversation: unavailable";

    const quotaParts = [];
    if (quota.h5 != null) quotaParts.push(`5h=${quota.h5}%`);
    if (quota.d7 != null) quotaParts.push(`7d=${quota.d7}%`);
    const quotaLine = `Usage limits: ${quotaParts.length ? quotaParts.join(", ") : "unavailable"}`;

    // Status = MAX across conversation + quotas. Conversation % is the primary
    // "Claude getting dumber" signal; 5h/7d are secondary (quota exhaustion).
    const max = Math.max(ctx.pct ?? 0, quota.h5 ?? 0, quota.d7 ?? 0);
    const status = max >= 98 ? "CRITICAL" : max >= 90 ? "WARNING" : "OK";

    const guidance =
      status === "CRITICAL"
        ? "Stop in-flight chain. Snapshot state to plans/reports/context-snapshot-YYMMDD-HHmm.md, then ask user to run /compact."
        : status === "WARNING"
        ? "Compact now: offload large outputs to files (plans/reports/), prefer grep/offset reads over full reads, cut preamble, delegate heavy context to subagents."
        : "Normal. No special handling.";

    return `<context-awareness>
${ctxLine}
${quotaLine}
Status: ${status}
Guidance: ${guidance}
</context-awareness>`;
  }

  async function main() {
    let inputStr = "";
    try { inputStr = fs.readFileSync(0, "utf-8"); } catch {}
    const input = JSON.parse(inputStr || "{}");
    const isPrompt = typeof input.prompt === "string";
    const eventName = input.hook_event_name
      || (isPrompt ? "UserPromptSubmit" : "PostToolUse");

    const ttl = isPrompt ? TTL_PROMPT_MS : TTL_TOOL_MS;
    let cached = readCache(ttl);
    let usage = cached?.data ?? null;
    if (!cached) {
      usage = await fetchUsage();
      writeCache(usage);
    }

    // Only inject on UserPromptSubmit — PostToolUse just refreshes the cache.
    if (!isPrompt) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const quota = pickQuotaPct(usage);
    const ctx = readContextPct(input.transcript_path);
    const additionalContext = buildContext(ctx, quota);

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext
      }
    }));
  }

  main().catch(() => {
    // Fail-open — never block the user's prompt
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  });
} catch {
  // Outer crash wrapper — fail-open
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}
