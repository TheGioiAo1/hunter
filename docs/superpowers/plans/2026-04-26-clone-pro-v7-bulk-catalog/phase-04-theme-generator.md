# Phase 04 — Sprint 4: Theme Generator + Visual Verify

**Date:** 2026-05-07 → 2026-05-12 (5 days, sprint nặng nhất)
**Priority:** HIGH
**Branch:** `feat/v7-pr4-theme-generator`
**Depends on:** Sprint 3 merged

## Goal

Stage 15 generate Liquid theme từ DesignTokens (token-applier + component-builder).
Stage 16 visual verify side-by-side, retry max 3 nếu score <7/10.

## Architecture

```
DesignTokens (Sprint 3) ──┐
                          v
            token-applier.ts ── inject tokens vào CSS variables
                          v
            component-builder.ts ── chọn variant (e.g. header_minimal vs header_split)
                          v
            template-base/ (Liquid templates với placeholder)
                          v
            theme.zip (bundle deploy-ready)
                          v
Stage 16: deploy theme → screenshot clone → diff với source → score
                          v
        score >= 7 → done
        score < 7 → feedback từ Claude → Stage 15 retry (max 3)
```

## Files

```
packages/core/src/modules/clone-pro/v7/theme-engine/
├── template-base/                  # Liquid templates với {{ TOKEN }} placeholders
│   ├── layout/
│   │   ├── theme.liquid           # base layout
│   │   └── _header.liquid
│   ├── templates/
│   │   ├── index.liquid           # homepage
│   │   ├── product.liquid         # PDP
│   │   ├── collection.liquid      # PLP
│   │   ├── cart.liquid
│   │   └── page.liquid
│   ├── sections/
│   │   ├── hero-fullbleed.liquid
│   │   ├── hero-split.liquid
│   │   ├── product-card-classic.liquid
│   │   ├── product-card-editorial.liquid
│   │   └── ... (20+ component variants)
│   └── assets/
│       ├── theme.css.liquid       # CSS variables từ tokens
│       └── theme.js
├── token-applier.ts                # Inject DesignTokens vào theme.css.liquid
├── component-builder.ts            # Chọn variant theo tokens.components.*.variant
├── theme-renderer.ts               # LiquidJS render templates với data + tokens
├── theme-bundler.ts                # Tạo theme.zip
└── visual-verify.ts                # Stage 16 logic

packages/core/src/modules/clone-pro/v7/stages/
├── stage15-theme-generate.ts
└── stage16-visual-verify.ts

packages/db/src/migrations/
└── 101_theme_files_v7.ts           # ALTER ADD theme_id, version, is_active

scripts/
└── smoke-clone-pro-v7-pr4.ts
```

## Tasks

- [ ] **4.1** Migration 101: ALTER `theme_files`
  ```sql
  ALTER TABLE theme_files
    ADD COLUMN theme_id UUID,
    ADD COLUMN version INT NOT NULL DEFAULT 1,
    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT false;
  CREATE INDEX idx_theme_files_active ON theme_files(shop_id, is_active) WHERE is_active = true;
  ```
  Commit: `feat(v7-pr4): migration 101 — theme_files versioning`

- [ ] **4.2** Template base library (1 day)
  - 5 layout templates (Liquid) với placeholders `{{ font_primary }}`, `{{ color_primary }}`, ...
  - 20+ component variant sections (5 hero variants, 5 product card variants, 4 header variants,
    3 footer variants, 3 nav variants)
  - Mỗi variant có frontmatter metadata `{ variant: 'hero-fullbleed', tokens_required: [...] }`
  - Test: 10 cases compile Liquid templates (LiquidJS) không crash
  - Commit: `feat(v7-pr4): template-base — 5 layouts + 20 component variants Liquid`

- [ ] **4.3** Token applier
  ```typescript
  export function applyTokens(tokens: DesignTokens): { css: string; liquid_vars: Record<string, string> } {
    const css = `:root {
      --font-primary: '${tokens.fonts.primary.google_font ?? tokens.fonts.primary.family}', sans-serif;
      --color-primary: ${tokens.colors.primary};
      --color-bg: ${tokens.colors.background};
      --space-base: ${tokens.spacing.base_unit}px;
      --container-max: ${tokens.layout.container_max_width}px;
      ...
    }`
    const liquidVars = {
      font_primary: tokens.fonts.primary.google_font ?? '',
      color_primary: tokens.colors.primary,
      ...
    }
    return { css, liquid_vars: liquidVars }
  }
  ```
  Test: 6 cases (full tokens, missing optional, hex validation)
  Commit: `feat(v7-pr4): token-applier — DesignTokens → CSS variables + Liquid vars`

- [ ] **4.4** Component builder
  ```typescript
  export function selectComponents(tokens: DesignTokens): ComponentManifest {
    return {
      hero: tokens.layout.hero_pattern,  // 'fullbleed-image' → use sections/hero-fullbleed.liquid
      product_card: tokens.components.product_card.variant,  // 'classic' | 'editorial'
      header: tokens.components.header.variant,
      navigation: tokens.components.navigation.variant,
      // ... 8+ component slots
    }
  }
  ```
  Test: 8 cases mapping tokens → variants
  Commit: `feat(v7-pr4): component-builder — chọn Liquid variant theo tokens`

- [ ] **4.5** Theme renderer + bundler
  ```typescript
  export async function renderTheme(tokens: DesignTokens, deps: { liquid: Liquid }): Promise<ThemeBundle> {
    const components = selectComponents(tokens)
    const { css, liquid_vars } = applyTokens(tokens)
    const files: Record<string, string> = {}

    // Render base layout
    files['layout/theme.liquid'] = await deps.liquid.parseAndRender(loadBase('layout/theme.liquid'), liquid_vars)
    // Render selected components
    for (const [slot, variant] of Object.entries(components)) {
      const path = `sections/${slot}-${variant}.liquid`
      files[path] = await deps.liquid.parseAndRender(loadBase(path), liquid_vars)
    }
    // Render templates (homepage, product, collection, cart, page)
    for (const tpl of ['index', 'product', 'collection', 'cart', 'page']) {
      files[`templates/${tpl}.liquid`] = await deps.liquid.parseAndRender(loadBase(`templates/${tpl}.liquid`), liquid_vars)
    }
    files['assets/theme.css'] = css

    return { files, version: 1, theme_id: randomUUID() }
  }

  export async function bundleTheme(bundle: ThemeBundle, s3: S3Client, shopId: string): Promise<string> {
    const zip = new JSZip()
    for (const [path, content] of Object.entries(bundle.files)) {
      zip.file(path, content)
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    const key = `${shopId}/theme/theme.zip`
    await s3.upload({ Key: key, Body: buffer })
    return key
  }
  ```
  Test: 10 cases (render success, missing variant, S3 upload error)
  Commit: `feat(v7-pr4): theme-renderer + bundler — LiquidJS + JSZip → theme.zip on S3`

- [ ] **4.6** Stage 15 orchestrator
  - Input: `{ jobId, tokens, shopId, db, s3 }`
  - Logic: render → bundle → persist `theme_files` rows + `theme.zip` key
  - Set new theme `is_active=true`, deactivate old
  - Test: 6 cases
  - Commit: `feat(v7-pr4): stage15-theme-generate orchestrator + theme_files versioning`

- [ ] **4.7** Stage 16 visual verify (most complex)
  ```typescript
  export async function visualVerify(opts: {
    sourceScreenshotS3Keys: Record<string, string>,
    cloneUrl: string,  // e.g. https://best-store-v7.gbox.co
    anthropicClient: AnthropicClient,
    s3: S3Client,
    maxRetries?: number,  // default 3
  }): Promise<{ score: number; passed: boolean; feedback: string[]; clone_screenshot_keys: Record<string, string> }> {
    // 1. Capture clone screenshots (5 page × 2 viewport)
    const cloneKeys = await captureClone(opts.cloneUrl, opts.s3)
    // 2. For each page: download source + clone, send to Claude vision với prompt diff
    const scores: number[] = []
    const feedback: string[] = []
    for (const page of ['home', 'pdp', 'plp', 'cart', 'global']) {
      const srcImg = await opts.s3.download(opts.sourceScreenshotS3Keys[page+'-desktop'])
      const cloneImg = await opts.s3.download(cloneKeys[page+'-desktop'])
      const result = await opts.anthropicClient.compareImages({
        source: srcImg, clone: cloneImg,
        prompt: VISUAL_DIFF_PROMPT,
      })
      scores.push(result.score)
      if (result.score < 7) feedback.push(...result.issues)
    }
    const avgScore = scores.reduce((a,b) => a+b, 0) / scores.length
    return { score: avgScore, passed: avgScore >= 7, feedback, clone_screenshot_keys: cloneKeys }
  }
  ```
  - Stage 15 + 16 retry loop trong v7 orchestrator: nếu score <7 + retries left, pass `feedback`
    vào Stage 15 next iteration để Claude fix.
  - Test: 8 cases (score >=7 pass, <7 retry, max retry hit, feedback parsing)
  - Commit: `feat(v7-pr4): stage16-visual-verify + retry loop max 3`

- [ ] **4.8** Live smoke
  - Script: `scripts/smoke-clone-pro-v7-pr4.ts`
  - Steps: deploy theme.zip extract vào /var/www/themes/best-store-v7/, restart storefront,
    capture clone screenshots, run Stage 16
  - Assert: avgScore >= 7 sau ≤3 retry
  - Commit: `test(v7-pr4): smoke theme generator bibliobloom score >= 7`

## Acceptance Criteria

- [ ] Stage 15 generate theme.zip → S3 + theme_files rows
- [ ] Stage 16 score ≥ 7/10 trong ≤3 retry
- [ ] best-store-v7.gbox.co render với theme mới
- [ ] Anh đối chiếu visual side-by-side: bibliobloom vs clone

## Risk

- Generic theme generator → "không 1:1": template variants quá ít → Sprint 4.2 có 20+ variants
  + Sprint 4.4 component-builder match tokens chính xác
- Visual verify score subjective: Claude vision phán đoán có thể không match Thai's eye.
  Mitigation: dùng pixelmatch (deterministic) làm sanity check + Claude vision làm semantic
  diff
- Retry loop tốn $5+ AI cost mỗi job nếu không converge. Mitigation: cap 3 retry, log warning,
  ship best-attempt + manual override option

## Next: Sprint 5 storefront wire + E2E
