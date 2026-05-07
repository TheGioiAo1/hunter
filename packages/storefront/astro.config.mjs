/**
 * Gbox Platform — Astro Storefront Configuration
 *
 * Supports BOTH Cloudflare Workers (for preview/edge deployments)
 * AND Node.js standalone (for VPS production deployments).
 *
 * Adapter is selected based on environment:
 *   - CF_PAGES or CLOUDFLARE env var → Cloudflare adapter
 *   - Otherwise → Node.js standalone adapter
 */

import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// ---------------------------------------------------------------------------
// Dynamic adapter selection
// ---------------------------------------------------------------------------

async function resolveAdapter() {
  if (process.env.CF_PAGES || process.env.CLOUDFLARE) {
    const { default: cloudflare } = await import('@astrojs/cloudflare');
    return cloudflare({
      platformProxy: {
        enabled: true,
      },
      routes: {
        strategy: 'auto',
      },
    });
  }

  const { default: node } = await import('@astrojs/node');
  return node({ mode: 'standalone' });
}

const adapter = await resolveAdapter();

// ---------------------------------------------------------------------------
// Astro config
// ---------------------------------------------------------------------------

export default defineConfig({
  output: 'server',
  adapter,
  integrations: [react()],

  vite: {
    ssr: {
      // Packages that should be bundled for SSR (not externalized)
      noExternal: [],
    },
    build: {
      // Smaller chunks for Cloudflare Workers size limits
      rollupOptions: {
        output: {
          manualChunks: undefined,
        },
      },
    },
    define: {
      // Make the deployment target available at build time
      'import.meta.env.DEPLOY_TARGET': JSON.stringify(
        process.env.CF_PAGES ? 'cloudflare' : 'node',
      ),
    },
  },

  // Image optimization — use Cloudflare Images when on CF, sharp on Node
  image: {
    service: process.env.CF_PAGES
      ? { entrypoint: 'astro/assets/services/noop' }
      : { entrypoint: 'astro/assets/services/sharp' },
  },

  // Dev server options
  server: {
    port: parseInt(process.env.PORT ?? '4321', 10),
    host: process.env.HOST ?? 'localhost',
  },

  // Security headers
  security: {
    checkOrigin: true,
  },
});
