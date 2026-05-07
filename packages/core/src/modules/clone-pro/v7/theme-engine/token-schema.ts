/**
 * Clone Pro v7 — DesignTokens schema
 *
 * The single source of truth for what Stage 14 produces and what the
 * theme generator (Sprint 4) consumes. Strict Zod-validated so a
 * malformed Claude response can never reach the persister.
 *
 * Field semantics summary:
 *
 *   • fonts        — primary required, secondary optional. We force
 *                    google_font to be either a non-empty string OR
 *                    explicit null so callers can't smuggle '' through.
 *   • colors       — primary/secondary/background/foreground always
 *                    present. accent + muted nullable (some sites
 *                    only use 2-3 colors). All hexes 6-digit so the
 *                    storefront renderer can rely on slice math.
 *   • spacing      — base_unit + scale array (≥1 entry). Storefront
 *                    builds its own scale from the array; we don't
 *                    enforce specific lengths here.
 *   • breakpoints  — 4 fixed names (mobile/tablet/desktop/wide). No
 *                    ordering enforced — Claude occasionally returns
 *                    quirky values which we want to surface, not block.
 *   • components   — 4 fixed names (header/product_card/button/
 *                    navigation). Each has a `variant` string that
 *                    Sprint 4 will key into a component library.
 *   • layout       — container + grid + hero pattern. hero_pattern
 *                    is free-form so designs can have their own
 *                    fingerprint without us hard-coding an enum.
 *   • style_keywords — free-form array (sellers will see these in
 *                    the theme report). Empty array allowed.
 *   • aesthetic_score — 0-10, decimals OK. Stored as numeric(3,1)
 *                    so we round to one decimal at persist time.
 */

import { z } from 'zod'

const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be 6-digit hex (e.g. #aabbcc)')

const FontDescriptor = z.object({
  family: z.string().min(1),
  /** Google Fonts family name; null when the site uses a custom/system font. */
  google_font: z.string().min(1).nullable(),
  /** At least one weight required (400 minimum for body text). */
  weights: z.array(z.number().int().positive()).min(1),
})

const HeaderComponent = z.object({
  height: z.number().nonnegative(),
  background: z.string().min(1),
  variant: z.string().min(1),
})

const ProductCardComponent = z.object({
  /** Free-form so '3/4', '1:1', '4/5' all pass; Sprint 4 normalises. */
  aspect_ratio: z.string().min(1),
  border_radius: z.number().nonnegative(),
  variant: z.string().min(1),
})

const ButtonComponent = z.object({
  border_radius: z.number().nonnegative(),
  padding_x: z.number().nonnegative(),
  padding_y: z.number().nonnegative(),
  variant: z.string().min(1),
})

const NavigationComponent = z.object({
  variant: z.string().min(1),
  /** 'top' | 'side' | 'bottom' | 'overlay' — kept as string for forward compat. */
  placement: z.string().min(1),
})

export const DesignTokensSchema = z.object({
  fonts: z.object({
    primary: FontDescriptor,
    secondary: FontDescriptor.nullable(),
  }),
  colors: z.object({
    primary: HexColor,
    secondary: HexColor,
    accent: HexColor.nullable(),
    /** Background + foreground accept named/hex/rgba so dark themes can use 'rgb(0 0 0 / 0)' tricks. */
    background: z.string().min(1),
    foreground: z.string().min(1),
    muted: z.string().nullable(),
  }),
  spacing: z.object({
    base_unit: z.number().positive(),
    scale: z.array(z.number().positive()).min(1),
  }),
  breakpoints: z.object({
    mobile: z.number().positive(),
    tablet: z.number().positive(),
    desktop: z.number().positive(),
    wide: z.number().positive(),
  }),
  components: z.object({
    header: HeaderComponent,
    product_card: ProductCardComponent,
    button: ButtonComponent,
    navigation: NavigationComponent,
  }),
  layout: z.object({
    container_max_width: z.number().positive(),
    grid_columns: z.number().int().positive(),
    /** Free-form: 'fullbleed-image' | 'split-text-image' | 'video-bg' | 'editorial' | etc. */
    hero_pattern: z.string().min(1),
  }),
  style_keywords: z.array(z.string()),
  aesthetic_score: z.number().min(0).max(10),
})

export type DesignTokens = z.infer<typeof DesignTokensSchema>
