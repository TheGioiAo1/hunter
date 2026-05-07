/**
 * Gbox Platform — Theme marketplace manifest validator (Stage 5.3)
 *
 * Every theme listed on the Theme Marketplace ships a `theme.json`
 * manifest at the bundle root. This module is the ONLY place
 * upstream code decides whether a manifest is acceptable. The
 * admin install API calls it before touching the database, and
 * the CLI theme-packager calls it before writing a `.gbox-theme`
 * bundle.
 *
 * Input forms:
 *
 *   parseMarketplaceManifest(obj)           // already parsed JSON
 *   parseMarketplaceManifest(jsonString)    // raw theme.json text
 *
 * Result:
 *
 *   { ok: true,  manifest: MarketplaceManifest }
 *   { ok: false, errors:   MarketplaceManifestError[] }
 *
 * Why so much validation for a static file? Because every install
 * adds rows to the database, and a silent typo in `schema_version`
 * four years from now becomes a support nightmare. Locking it
 * down once here is cheap insurance.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const SUPPORTED_MARKETPLACE_SCHEMA_VERSION = 1

/**
 * Features a theme can declare it needs. New entries must be added
 * deliberately — an unknown feature at validation time fails the
 * install rather than quietly passing through.
 */
export const KNOWN_THEME_FEATURES = [
  'sections',
  'json_templates',
  'blocks',
  'metaobjects',
  'metafields',
  'customer_accounts',
  'checkout_extensions',
  'translation_bundles',
  'cart_ajax',
  'section_rendering_api',
] as const

export type ThemeFeature = (typeof KNOWN_THEME_FEATURES)[number]

export interface MarketplaceManifest {
  schema_version: number
  name: string
  slug: string
  version: string
  author: string
  preview: string
  supported_locales: string[]
  required_features: ThemeFeature[]
  description?: string
  license?: string
}

export type MarketplaceManifestErrorCode =
  | 'invalid_payload'
  | 'invalid_json'
  | 'unsupported_version'
  | 'required'
  | 'invalid_version'
  | 'invalid_url'
  | 'invalid_slug'
  | 'invalid_locale'
  | 'unknown_feature'

export interface MarketplaceManifestError {
  path: string
  code: MarketplaceManifestErrorCode
  message: string
}

export type ParseMarketplaceManifestResult =
  | { ok: true; manifest: MarketplaceManifest }
  | { ok: false; errors: MarketplaceManifestError[] }

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** BCP-47 lite: `en`, `en-US`, `zh-Hant-TW`. Two to three subtags. */
const LOCALE_RE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,4}){0,2}$/

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseMarketplaceManifest(
  input: unknown,
): ParseMarketplaceManifestResult {
  let raw: unknown = input

  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch (err) {
      return {
        ok: false,
        errors: [
          {
            path: '',
            code: 'invalid_json',
            message:
              err instanceof Error ? err.message : 'failed to parse JSON',
          },
        ],
      }
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          path: '',
          code: 'invalid_payload',
          message: 'manifest must be a JSON object',
        },
      ],
    }
  }

  const errors: MarketplaceManifestError[] = []
  const src = raw as Record<string, unknown>

  // schema_version
  if (src.schema_version !== SUPPORTED_MARKETPLACE_SCHEMA_VERSION) {
    errors.push({
      path: 'schema_version',
      code:
        src.schema_version === undefined ? 'required' : 'unsupported_version',
      message: `expected schema_version ${SUPPORTED_MARKETPLACE_SCHEMA_VERSION}, got ${String(
        src.schema_version,
      )}`,
    })
  }

  // name / author — required strings, trimmed
  const name = requireNonEmptyString(src.name, 'name', errors)
  const author = requireNonEmptyString(src.author, 'author', errors)

  // slug — required, must match SLUG_RE
  let slug: string | null = null
  if (typeof src.slug !== 'string' || src.slug.trim() === '') {
    errors.push({
      path: 'slug',
      code: 'required',
      message: 'slug is required',
    })
  } else {
    const candidate = src.slug.trim()
    if (!SLUG_RE.test(candidate)) {
      errors.push({
        path: 'slug',
        code: 'invalid_slug',
        message: `slug must be lowercase kebab-case, got ${candidate}`,
      })
    } else {
      slug = candidate
    }
  }

  // version — required, semver
  let version: string | null = null
  if (typeof src.version !== 'string' || src.version.trim() === '') {
    errors.push({
      path: 'version',
      code: 'required',
      message: 'version is required',
    })
  } else if (!SEMVER_RE.test(src.version.trim())) {
    errors.push({
      path: 'version',
      code: 'invalid_version',
      message: `version must be semver x.y.z, got ${src.version}`,
    })
  } else {
    version = src.version.trim()
  }

  // preview — required, http(s) URL
  let preview: string | null = null
  if (typeof src.preview !== 'string' || src.preview.trim() === '') {
    errors.push({
      path: 'preview',
      code: 'required',
      message: 'preview URL is required',
    })
  } else {
    const candidate = src.preview.trim()
    try {
      const url = new URL(candidate)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        errors.push({
          path: 'preview',
          code: 'invalid_url',
          message: `preview URL must be http(s), got ${url.protocol}`,
        })
      } else {
        preview = url.toString()
      }
    } catch {
      errors.push({
        path: 'preview',
        code: 'invalid_url',
        message: `preview URL is not a valid URL: ${candidate}`,
      })
    }
  }

  // supported_locales — required, BCP-47
  const supportedLocales: string[] = []
  if (!Array.isArray(src.supported_locales) || src.supported_locales.length === 0) {
    errors.push({
      path: 'supported_locales',
      code: 'required',
      message: 'supported_locales must be a non-empty array',
    })
  } else {
    for (const loc of src.supported_locales) {
      if (typeof loc !== 'string' || !LOCALE_RE.test(loc)) {
        errors.push({
          path: 'supported_locales',
          code: 'invalid_locale',
          message: `${String(loc)} is not a valid BCP-47 locale tag`,
        })
      } else {
        supportedLocales.push(loc)
      }
    }
  }

  // required_features — must all be KNOWN_THEME_FEATURES
  const requiredFeatures: ThemeFeature[] = []
  if (!Array.isArray(src.required_features)) {
    errors.push({
      path: 'required_features',
      code: 'required',
      message: 'required_features must be an array (possibly empty)',
    })
  } else {
    for (const feat of src.required_features) {
      if (
        typeof feat !== 'string' ||
        !KNOWN_THEME_FEATURES.includes(feat as ThemeFeature)
      ) {
        errors.push({
          path: 'required_features',
          code: 'unknown_feature',
          message: `${String(feat)} is not a known theme feature`,
        })
      } else {
        requiredFeatures.push(feat as ThemeFeature)
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  const description =
    typeof src.description === 'string' ? src.description.trim() : undefined
  const license =
    typeof src.license === 'string' ? src.license.trim() : undefined

  return {
    ok: true,
    manifest: {
      schema_version: SUPPORTED_MARKETPLACE_SCHEMA_VERSION,
      name: name!,
      slug: slug!,
      version: version!,
      author: author!,
      preview: preview!,
      supported_locales: uniqueSorted(supportedLocales),
      required_features: uniqueSorted(requiredFeatures) as ThemeFeature[],
      ...(description ? { description } : {}),
      ...(license ? { license } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireNonEmptyString(
  raw: unknown,
  path: string,
  errors: MarketplaceManifestError[],
): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.push({
      path,
      code: 'required',
      message: `${path} is required`,
    })
    return null
  }
  return raw.trim()
}

function uniqueSorted<T extends string>(items: T[]): T[] {
  return [...new Set(items)].sort() as T[]
}
