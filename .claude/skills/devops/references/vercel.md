# Vercel provisioning

Uses `vercel` CLI (`npm i -g vercel`). Auth: `vercel login` (email or OAuth).

## Project create + link

```bash
# In project root:
vercel link
# Prompts: scope (team), project name, existing or new
# Creates .vercel/project.json with orgId + projectId
# Commit .vercel/project.json? NO — add to .gitignore. Team members each link separately.

# Alternative: create via API / dashboard, then link
vercel projects add <name>
vercel link --project <name>
```

## Env vars

Never pass values via CLI arg — use interactive prompt or upload from file:

```bash
# Interactive per-env
vercel env add <KEY> production
vercel env add <KEY> preview
vercel env add <KEY> development

# From file (one KEY=VALUE per line)
vercel env pull .env.local          # download current
# Edit locally
cat .env.local | while read line; do
  K=$(echo $line | cut -d= -f1)
  V=$(echo $line | cut -d= -f2-)
  echo "$V" | vercel env add "$K" production
done

# Remove
vercel env rm <KEY> production
```

Encrypted at rest. Not visible in dashboard after save (only masked preview).

## Domain

```bash
# Add a custom domain
vercel domains add <example.com>
# (follow DNS instructions — A/CNAME/TXT)

# Assign to project
vercel alias <deployment-url> <example.com>
# OR in dashboard → Project → Settings → Domains
```

SSL auto-issued via Let's Encrypt.

## Framework detection

Vercel auto-detects: Next.js, Remix, Astro, SvelteKit, Nuxt, Vue, React (CRA/Vite), Angular, plain static.

Override via `vercel.json`:

```json
{
  "framework": "nextjs",
  "buildCommand": "yarn build",
  "outputDirectory": "dist",
  "installCommand": "yarn install --frozen-lockfile",
  "devCommand": "yarn dev"
}
```

## Deploy hooks (for CI that's not GitHub)

```bash
# Create via dashboard → Project → Settings → Git → Deploy Hooks
# Result: URL like https://api.vercel.com/v1/integrations/deploy/prj_xxx/xxx
# POST to it to trigger a redeploy:
curl -X POST "$VERCEL_DEPLOY_HOOK_URL"
```

## CI env vars needed

For GH Actions deploys (via `amondnet/vercel-action` or `vercel --prod` in yml):

- `VERCEL_TOKEN` — create at https://vercel.com/account/tokens (scope: specific team or personal)
- `VERCEL_ORG_ID` — from `.vercel/project.json` after `vercel link`
- `VERCEL_PROJECT_ID` — same file

Add to GH repo secrets. Never commit.

## Common gotchas

- Preview deploys use separate env vars from production. Set BOTH or the preview breaks.
- `vercel dev` starts a local emulator but serverless function cold starts still happen; for fast iteration use the framework's own dev (`next dev`).
- Build output size limit: 250 MB total (free tier). Watch `node_modules` bloat.
- `.vercel/` should be in `.gitignore`. Committing it leaks org/project IDs (not secrets but noisy) and overrides teammate links.
- Deleting the Vercel project in dashboard orphans the domain — re-add via another project before deletion.
