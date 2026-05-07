// PM2 ecosystem file for the god-admin AGENT sidecar.
//
// Deploy layout (server 1 / 192.168.1.13):
//   /srv/gbox-platform/apps/god-admin-agent          — this app
//   /srv/gbox-platform/.agent-killswitch             — killswitch file
//   /srv/gbox-platform/packages/agent-core/prompts/  — prompt files
//
// Port: 4326. (Master plan said :4324 but gbox-god-admin already
// owns :4324 on server 1 — see docs/infra_topology / PR 5 commit
// message for the deviation note.)
//
// Usage:
//   pm2 start ecosystem.config.js --only gbox-god-admin-agent
//   pm2 restart gbox-god-admin-agent
//   pm2 logs gbox-god-admin-agent --lines 100

module.exports = {
  apps: [
    {
      name: 'gbox-god-admin-agent',
      cwd: '/srv/gbox-platform/apps/god-admin-agent',
      script: 'src/server.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      // Keep stdout/stderr small; the sidecar is verbose during
      // hot-reload and can fill disk quickly otherwise.
      max_restarts: 10,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        AGENT_SIDECAR_PORT: '4326',
        AGENT_SIDECAR_BIND: '127.0.0.1',
        // AGENT_INTERNAL_JWT_SECRET comes from the server env file —
        // NEVER hard-code secrets here. PM2 will refuse to boot if
        // the env var is missing (see config.ts `required()` check).
        REPO_ROOT: '/srv/gbox-platform',
        AGENT_KILLSWITCH_FILE: '/srv/gbox-platform/.agent-killswitch',
        AGENT_PROMPT_FILE:
          '/srv/gbox-platform/packages/agent-core/prompts/god-admin-default.md',
        AGENT_PROMPT_NAME: 'god-admin-default',
        AGENT_MAX_CONCURRENCY: '1',
        AGENT_CB_WINDOW_MS: '60000',
        AGENT_CB_THRESHOLD: '5',
      },
      error_file: '/var/log/gbox/god-admin-agent.err.log',
      out_file: '/var/log/gbox/god-admin-agent.out.log',
      merge_logs: true,
      time: true,
    },
  ],
}
