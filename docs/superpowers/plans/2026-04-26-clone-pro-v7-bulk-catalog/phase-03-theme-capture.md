# Phase 03 — Sprint 3: Theme Capture + Design Token Extract

**Date:** 2026-05-04 → 2026-05-07 (3 days)
**Priority:** HIGH — foundation cho theme generator
**Branch:** `feat/v7-pr3-theme-capture-tokens`
**Depends on:** Sprint 1+2 merged

## Goal

Stage 13: chụp screenshot 5 page core (home/PLP/PDP/cart/page) desktop + mobile, lưu S3.
Stage 14: Claude vision phân tích từng ảnh extract design tokens (font, color, spacing,
component patterns), lưu `shop_theme_tokens` table + S3 manifest.

## Files

```
packages/core/src/modules/clone-pro/v7/stages/
├── stage13-screenshot.ts          # Puppeteer chụp + upload S3
└── stage14-design-extract.ts      # Claude vision describe → tokens

packages/core/src/modules/clone-pro/v7/theme-engine/
├── token-schema.ts                # DesignTokens interface (Zod schema)
└── claude-vision-prompts.ts       # Prompt templates cho design extraction

packages/db/src/migrations/
└── 102_shop_theme_tokens_v7.ts    # ALTER ADD screenshots_s3_keys, extracted_by, score

scripts/
└── smoke-clone-pro-v7-pr3.ts
```

## Tasks

- [ ] **3.1** Migration 102: ALTER `shop_theme_tokens`
  ```sql
  ALTER TABLE shop_theme_tokens
    ADD COLUMN screenshots_s3_keys JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN extracted_by TEXT DEFAULT 'claude_vision',
    ADD COLUMN score NUMERIC(3,1),
    ADD COLUMN extracted_at TIMESTAMPTZ;
  ```
  Commit: `feat(v7-pr3): migration 102 — shop_theme_tokens v7 columns`

- [ ] **3.2** Stage 13 screenshot capture
  - Input: `{ jobId, sourceUrl, urlsToCapture, s3Client }`
  - Logic:
    1. Reuse Playwright từ v6 stage3-render
    2. Capture 5+ URL với 2 viewport (desktop 1440×900, mobile 390×844)
    3. Save PNG → upload S3 `<shop>/theme/screenshots/source/<page>-<viewport>.png`
    4. Return `{ s3_keys: { 'home-desktop': 'key1', 'home-mobile': 'key2', ... } }`
  - Test: 6 cases (capture success, viewport difference, retry on fail, etc.)
  - Commit: `feat(v7-pr3): stage13-screenshot — Puppeteer capture 5 pages × 2 viewport → S3`

- [ ] **3.3** DesignTokens schema
  ```typescript
  export const DesignTokensSchema = z.object({
    fonts: z.object({
      primary: z.object({ family: z.string(), google_font: z.string().nullable(), weights: z.array(z.number()) }),
      secondary: z.object({ family: z.string(), google_font: z.string().nullable(), weights: z.array(z.number()) }).nullable(),
    }),
    colors: z.object({
      primary: z.string().regex(/^#[0-9a-f]{6}$/i),
      secondary: z.string().regex(/^#[0-9a-f]{6}$/i),
      accent: z.string().regex(/^#[0-9a-f]{6}$/i).nullable(),
      background: z.string(),
      foreground: z.string(),
      muted: z.string().nullable(),
    }),
    spacing: z.object({
      base_unit: z.number(),  // px
      scale: z.array(z.number()),  // [4, 8, 16, 24, ...]
    }),
    breakpoints: z.object({
      mobile: z.number(), tablet: z.number(), desktop: z.number(), wide: z.number(),
    }),
    components: z.object({
      header: z.object({ height: z.number(), background: z.string(), variant: z.string() }),
      product_card: z.object({ aspect_ratio: z.string(), border_radius: z.number(), variant: z.string() }),
      button: z.object({ border_radius: z.number(), padding_x: z.number(), padding_y: z.number(), variant: z.string() }),
      navigation: z.object({ variant: z.string(), placement: z.string() }),
    }),
    layout: z.object({
      container_max_width: z.number(),
      grid_columns: z.number(),
      hero_pattern: z.string(),  // 'fullbleed-image' | 'split-text-image' | 'video-bg' | ...
    }),
    style_keywords: z.array(z.string()),  // ['minimal', 'editorial', 'warm', 'serif-typography', ...]
    aesthetic_score: z.number().min(0).max(10),
  })
  ```
  Commit: `feat(v7-pr3): DesignTokensSchema (Zod) + 12-section coverage`

- [ ] **3.4** Claude vision prompt templates
  - File: `claude-vision-prompts.ts`
  - 5 prompt: `describe_homepage`, `describe_pdp`, `describe_plp`, `describe_global`, `consolidate_tokens`
  - Each prompt instruct Claude:
    - Use exact hex codes (no approximation)
    - Predict Google Font name (specific, not "Inter" default)
    - Identify component variants từ library (header_minimal, header_split, ...)
    - Output JSON match DesignTokensSchema
  - Commit: `feat(v7-pr3): Claude vision prompts cho design extraction`

- [ ] **3.5** Stage 14 design extract orchestrator
  - Input: `{ jobId, screenshotS3Keys, anthropicClient, db }`
  - Logic:
    1. Download mỗi screenshot từ S3 → base64
    2. Call Claude (vision API) với prompt + image cho mỗi page
    3. Get partial tokens từ mỗi page (homepage gives header+hero+colors, PDP gives product card, etc.)
    4. Call Claude consolidate: merge partial tokens → final DesignTokens
    5. Validate qua DesignTokensSchema
    6. Persist vào `shop_theme_tokens` table với `score = aesthetic_score`
    7. Upload manifest.json + design-tokens.json lên S3
  - Test: 8+ cases (mock Claude responses, schema validation fail, consolidate logic)
  - Commit: `feat(v7-pr3): stage14-design-extract — Claude vision → DesignTokens`

- [ ] **3.6** Live smoke test
  - Script: `scripts/smoke-clone-pro-v7-pr3.ts`
  - Steps:
    1. Reuse best-store-v7 từ Sprint 2
    2. Trigger Stage 13 → 14 (5 pages × 2 viewport = 10 screenshots)
    3. Assert: design-tokens.json có font.primary.google_font ≠ null + ≠ 'Inter'
    4. Assert: colors.primary là hex valid
    5. Assert: components.product_card.variant ∈ known variants
    6. Assert: aesthetic_score ≥ 6 (vì bibliobloom là site polished)
  - Commit: `test(v7-pr3): smoke design extraction bibliobloom — fonts + colors + score`

## Acceptance Criteria

- [ ] Migration 102 applied
- [ ] Stage 13 capture 10 screenshots → S3 + lưu key vào DB
- [ ] Stage 14 extract DesignTokens valid + persist
- [ ] Smoke pass với bibliobloom: font predicted (e.g. 'Cormorant Garamond' nếu serif),
  primary color đúng (hex matches eyeballed bibliobloom palette)
- [ ] manifest.json + design-tokens.json on S3
- [ ] PR merged

## Risk

- Claude vision describe sai font (e.g. predict "Inter" cho serif site). Mitigation:
  prompt explicit "DO NOT default to Inter/Roboto. If unsure, list 3 candidates."
- Hex color extraction lệch ±10. Mitigation: prompt "use exact hex from image, sample
  multiple regions". Fallback: ImageMagick histogram.
- 10 Claude vision calls cost ~$0.50-1.00 / clone job. Acceptable.

## Next: Sprint 4 — theme generator
