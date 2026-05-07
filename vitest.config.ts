import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Map workspace packages to THIS worktree's source so that cross-package
// imports (e.g. `@gbox/core/modules/clone-pro/v6/...`) resolve to the
// worktree copy rather than the root npm symlink (which may lag behind
// on feature-branches that add new directories to packages/core).
const worktreeAlias = {
  '@gbox/core': path.resolve(__dirname, 'packages/core/src'),
  '@gbox/db': path.resolve(__dirname, 'packages/db/src'),
}

export default defineConfig({
  resolve: {
    alias: worktreeAlias,
  },
  test: {
    globals: true,
    include: [
      'packages/**/*.test.ts',
      'apps/storefront/**/*.test.ts',
      'apps/checkout/**/*.test.ts',
      'apps/store-admin/**/*.test.ts',
      'apps/accounts/**/*.test.ts',
      'apps/god-admin-agent/**/*.test.ts',
      'scripts/deploy/**/*.test.ts',
      'scripts/cron/**/*.test.ts',
      'scripts/ops/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    // Smoke scripts with top-level main() / assertions that require a
    // live DB/API OR run plain top-level assert() (no describe/it).
    // They use the .test.ts suffix but are NOT vitest tests — intended
    // to be run manually via `npx tsx <path>.ts`.
    // See docs/runbooks/smoke-tests.md and memory/smoke_test_runbook.md.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Live-DB smoke scripts (top-level main()):
      'tests/checkout-advisory-lock.test.ts',
      'tests/checkout-handoff-route.test.ts',
      'tests/checkout-handoff.test.ts',
      'tests/checkout-slugless-endpoints.test.ts',
      'tests/customer-auth.test.ts',
      'tests/customer-cookie-domain.test.ts',
      'tests/gateway-selector.test.ts',
      'tests/paypal-partner-cancel.test.ts',
      'tests/paypal-sdk-tag.test.ts',
      'tests/queue-webhook-delivery.test.ts',
      // Pure standalone assertion scripts (no describe/it; no DB):
      'apps/checkout/tests/current-step.test.ts',
    ],
  },
})
