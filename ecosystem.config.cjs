/**
 * Gbox Platform — PM2 Ecosystem Configuration
 *
 * All TypeScript services run in fork mode with NODE_OPTIONS='--import tsx'.
 * PM2 6.x node_args doesn't reliably pass --import to the child process,
 * so we use NODE_OPTIONS env var instead (proven stable).
 *
 * For horizontal scaling, run multiple fork instances on different
 * ports behind Nginx upstream load balancing.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart all
 *   pm2 logs
 *   pm2 monit
 */

const DB_URL = 'postgresql://gbox:GboxPlatform2026@localhost:5432/gbox_platform'

// Log rotation: install with `pm2 install pm2-logrotate`
// pm2 set pm2-logrotate:max_size 50M
// pm2 set pm2-logrotate:retain 14
// pm2 set pm2-logrotate:compress true
// pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
// pm2 set pm2-logrotate:rotateInterval '0 0 * * *'

module.exports = {
  apps: [
    // ====================================================================
    // Platform API (Main) — Port 4321
    // Handles: All REST APIs, webhooks, checkout, payments
    // Traffic: ~80% of total — needs max scaling
    // ====================================================================
    {
      name: 'gbox-api',
      script: 'start.mjs',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1G',
      interpreter: 'node',

      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--import tsx --max-old-space-size=1024',
        PORT: 4321,
        DATABASE_URL: DB_URL,
      },

      kill_timeout: 10000,
      listen_timeout: 5000,
      shutdown_with_message: true,
      max_restarts: 10,
      restart_delay: 1000,
      autorestart: true,

      error_file: '/var/log/gbox/api-error.log',
      out_file: '/var/log/gbox/api-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ====================================================================
    // Storefront Server — Port 4326
    // Handles: Public storefront pages (SSR HTML)
    // Traffic: ~60% of read traffic from customers
    // ====================================================================
    {
      name: 'gbox-storefront',
      script: 'storefront-start.mjs',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '768M',

      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--import tsx',
        PORT: 4326,
        DATABASE_URL: DB_URL,
      },

      kill_timeout: 5000,
      listen_timeout: 5000,
      max_restarts: 10,
      restart_delay: 1000,
      autorestart: true,

      error_file: '/var/log/gbox/storefront-error.log',
      out_file: '/var/log/gbox/storefront-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ====================================================================
    // Store Admin — Port 4325
    // Handles: Merchant dashboards (products, orders, customers)
    // Traffic: ~8% — multiple merchants active simultaneously
    // ====================================================================
    {
      name: 'gbox-store-admin',
      script: 'apps/store-admin/src/server.ts',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',

      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--import tsx',
        PORT: 4325,
        DATABASE_URL: DB_URL,
      },

      kill_timeout: 5000,
      listen_timeout: 5000,
      max_restarts: 10,
      restart_delay: 1000,
      autorestart: true,

      error_file: '/var/log/gbox/store-admin-error.log',
      out_file: '/var/log/gbox/store-admin-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ====================================================================
    // Accounts Portal — Port 4323
    // Handles: Login, signup, password reset, store management
    // Traffic: ~3% — only during auth flows
    // ====================================================================
    {
      name: 'gbox-accounts',
      script: 'apps/accounts/src/server.ts',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',

      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--import tsx',
        PORT: 4323,
        DATABASE_URL: DB_URL,
      },

      kill_timeout: 5000,
      listen_timeout: 5000,
      max_restarts: 10,
      restart_delay: 1000,
      autorestart: true,

      error_file: '/var/log/gbox/accounts-error.log',
      out_file: '/var/log/gbox/accounts-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ====================================================================
    // God Admin — Port 4324
    // Handles: Platform-wide admin (1 user: Thai)
    // Traffic: <1% — single admin user
    // ====================================================================
    {
      name: 'gbox-god-admin',
      script: 'apps/god-admin/src/server.ts',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',

      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--import tsx',
        PORT: 4324,
        DATABASE_URL: DB_URL,
      },

      kill_timeout: 5000,
      listen_timeout: 5000,
      max_restarts: 10,
      restart_delay: 1000,
      autorestart: true,

      error_file: '/var/log/gbox/god-admin-error.log',
      out_file: '/var/log/gbox/god-admin-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ====================================================================
    // Checkout — Port 4327
    // Handles: Hosted checkout flow (cart → payment → thank you)
    // Traffic: ~5% — conversion-critical, must stay snappy
    // Runs on Server 1 (192.168.1.13), reachable via nginx at /checkout/*
    // ====================================================================
    {
      name: 'gbox-checkout',
      script: 'apps/checkout/src/server.ts',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',

      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--import tsx',
        PORT: 4327,
        DATABASE_URL: DB_URL,
      },

      kill_timeout: 5000,
      listen_timeout: 5000,
      max_restarts: 10,
      restart_delay: 1000,
      autorestart: true,

      error_file: '/var/log/gbox/checkout-error.log',
      out_file: '/var/log/gbox/checkout-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ====================================================================
    // Supporter — Port 4328
    // Handles: Internal support agent portal (supporter.gbox.co)
    // Traffic: ~1% — a handful of support agents online at once
    // Phase 12.5 PR3: shipped 2026-04-22 (inbox + ticket + invite + staff)
    // ====================================================================
    {
      name: 'gbox-supporter',
      script: 'apps/supporter/start.mjs',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',

      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--import tsx',
        SUPPORTER_PORT: 4328,
        DATABASE_URL: DB_URL,
      },

      kill_timeout: 5000,
      listen_timeout: 5000,
      max_restarts: 10,
      restart_delay: 1000,
      autorestart: true,

      error_file: '/var/log/gbox/supporter-error.log',
      out_file: '/var/log/gbox/supporter-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
}
