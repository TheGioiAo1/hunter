/**
 * Gbox Platform — Shipping Rate Seed Catalog
 *
 * Phase 9 / PR1. Public 2026 published rates for the carriers Gbox
 * supports out-of-the-box:
 *
 *   USA:
 *     USPS         — Priority Mail, Ground Advantage, First-Class Package,
 *                    Priority Mail Express, Media Mail
 *     UPS          — Ground, 3-Day Select, 2nd Day Air, Next Day Air,
 *                    Worldwide Expedited, Worldwide Saver
 *     FedEx        — Home Delivery, Ground, Express Saver, 2Day,
 *                    Standard Overnight, International Economy,
 *                    International Priority
 *
 *   Europe:
 *     DHL Express  — International (worldwide, merchandise)
 *     DHL Paket    — DE domestic parcel
 *     Royal Mail   — 1st Class, 2nd Class, Tracked 24, Tracked 48,
 *                    International Standard, International Tracked
 *     La Poste /
 *     Colissimo    — Colissimo Home (FR), Colissimo International
 *     DPD          — Classic, Express, International
 *     PostNL       — Standard, Tracked, International
 *     GLS          — BusinessParcel, EuroBusinessParcel
 *     Hermes / Evri— Standard, Next-Day
 *     Bpost        — Standard, Tracked, International
 *
 * Rates here are the merchant-visible stub — we use them when the shop
 * hasn't wired a live-API provider and Gbox is pricing the shipment
 * client-side at checkout. Values are in USD at the catalog layer; the
 * per-shop rate row stores the actual currency when the merchant seeds
 * these into their store ("copy seed into my rates" in admin).
 *
 * Rate sources (public, April 2026):
 *   USPS        usps.com/business/prices
 *   UPS         ups.com/rate-chart-2026 (zones 2-8 avg)
 *   FedEx       fedex.com/en-us/shipping/rate-tools
 *   DHL         dhl.com/global-en/home/our-divisions/express.html
 *   Royal Mail  royalmail.com/business/prices
 *   La Poste    laposte.fr/outils-et-services/tarifs-colissimo
 *   DPD         dpd.com/eu/en/prices
 *   PostNL      postnl.nl/en/business/prices
 *   GLS         gls-group.eu/DE/en/prices
 *   Hermes      evri.com/business/price-guide
 *   Bpost       bpost.be/en/parcel-prices
 *
 * The module is PURE — no DB access. The DB seed insert lives in
 * carriers.ts (`seedRateCatalog`) which reads this file and upserts into
 * `shipping_rate_seed` at migrate time (or on demand from the admin
 * "Reseed rate catalog" button).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Carrier kind — the TS discriminant for providers.
 * Extending this list is a breaking change — bump the seed catalog
 * version and write a migration before shipping a new carrier.
 */
export type CarrierKind =
  | 'usps'
  | 'ups'
  | 'fedex'
  | 'dhl_express'
  | 'dhl_paket'
  | 'royal_mail'
  | 'la_poste'
  | 'dpd'
  | 'postnl'
  | 'gls'
  | 'hermes'
  | 'bpost'

/**
 * Region code used to join a zone to a rate row.
 *
 *   US-ZONE-1..9   USPS/UPS/FedEx domestic rate zones
 *   US             generic US domestic (flat)
 *   UK             United Kingdom domestic
 *   EU-DE/FR/NL…   per-country EU domestic
 *   EU             EU-wide (cross-border)
 *   INT            international / rest-of-world
 */
export type RegionCode = string

export interface SeedRate {
  carrier_kind: CarrierKind
  service_code: string
  service_name: string
  region_code: RegionCode
  weight_min_lb: number
  weight_max_lb: number
  rate_usd: number
  transit_days_min: number | null
  transit_days_max: number | null
}

export interface CarrierMeta {
  kind: CarrierKind
  display_name: string
  /** 2-letter ISO country codes where this carrier is available out-of-the-box. */
  home_countries: string[]
  /** Human-readable description for the admin UI picker. */
  description: string
  /** URL to the carrier's website — shown as "Learn more" in admin. */
  website: string
}

// ---------------------------------------------------------------------------
// Carrier metadata (stable reference for the admin picker)
// ---------------------------------------------------------------------------

export const CARRIER_CATALOG: CarrierMeta[] = [
  {
    kind: 'usps',
    display_name: 'USPS',
    home_countries: ['US'],
    description: 'United States Postal Service — priority, ground, first-class.',
    website: 'https://www.usps.com/business/prices.htm',
  },
  {
    kind: 'ups',
    display_name: 'UPS',
    home_countries: ['US', 'CA', 'MX'],
    description: 'UPS ground and air across North America, plus worldwide.',
    website: 'https://www.ups.com/',
  },
  {
    kind: 'fedex',
    display_name: 'FedEx',
    home_countries: ['US', 'CA', 'MX'],
    description: 'FedEx home delivery, express, and international.',
    website: 'https://www.fedex.com/',
  },
  {
    kind: 'dhl_express',
    display_name: 'DHL Express',
    home_countries: ['US', 'DE', 'FR', 'NL', 'BE', 'GB', 'ES', 'IT'],
    description: 'DHL Express — international courier (worldwide).',
    website: 'https://www.dhl.com/global-en/home/our-divisions/express.html',
  },
  {
    kind: 'dhl_paket',
    display_name: 'DHL Paket',
    home_countries: ['DE'],
    description: 'Deutsche Post DHL Paket — Germany domestic parcel.',
    website: 'https://www.dhl.de/privatkunden',
  },
  {
    kind: 'royal_mail',
    display_name: 'Royal Mail',
    home_countries: ['GB'],
    description: 'Royal Mail — UK domestic and international.',
    website: 'https://www.royalmail.com/business',
  },
  {
    kind: 'la_poste',
    display_name: 'La Poste / Colissimo',
    home_countries: ['FR'],
    description: 'La Poste Colissimo — France domestic and international.',
    website: 'https://www.laposte.fr/professionnel',
  },
  {
    kind: 'dpd',
    display_name: 'DPD',
    home_countries: ['GB', 'FR', 'DE', 'NL', 'BE', 'IE', 'ES', 'IT'],
    description: 'DPD — pan-European classic, express, international.',
    website: 'https://www.dpd.com/',
  },
  {
    kind: 'postnl',
    display_name: 'PostNL',
    home_countries: ['NL', 'BE'],
    description: 'PostNL — Benelux domestic and international.',
    website: 'https://www.postnl.nl/en/business/',
  },
  {
    kind: 'gls',
    display_name: 'GLS',
    home_countries: ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'GB'],
    description: 'GLS — business parcel across Europe.',
    website: 'https://gls-group.eu/',
  },
  {
    kind: 'hermes',
    display_name: 'Evri (Hermes)',
    home_countries: ['GB'],
    description: 'Evri (formerly Hermes) — UK home & business parcel.',
    website: 'https://www.evri.com/business',
  },
  {
    kind: 'bpost',
    display_name: 'Bpost',
    home_countries: ['BE'],
    description: 'Bpost — Belgium domestic and international.',
    website: 'https://www.bpost.be/en/business',
  },
]

/** Map of kind → meta for O(1) lookup. */
export const CARRIERS_BY_KIND: Record<CarrierKind, CarrierMeta> =
  Object.fromEntries(CARRIER_CATALOG.map((c) => [c.kind, c])) as Record<
    CarrierKind,
    CarrierMeta
  >

// ---------------------------------------------------------------------------
// Seed rates — USPS (2026 published, approximate for stub use)
// ---------------------------------------------------------------------------

/**
 * USPS uses 9 zones for domestic. We seed averaged rates across the
 * zone spread so the stub is a reasonable default; merchants can then
 * override per zone after enabling USPS.
 */
const USPS_RATES: SeedRate[] = [
  // Priority Mail — flat rate tiers (2026 pub rates avg across zones 1-5)
  ...flatWeightTiers('usps', 'priority_mail', 'Priority Mail', 'US', [
    { min: 0, max: 1, rate: 9.95, days: [1, 3] },
    { min: 1, max: 2, rate: 11.85, days: [1, 3] },
    { min: 2, max: 5, rate: 15.9, days: [1, 3] },
    { min: 5, max: 10, rate: 24.5, days: [1, 3] },
    { min: 10, max: 20, rate: 38.0, days: [1, 3] },
    { min: 20, max: 50, rate: 72.0, days: [1, 3] },
    { min: 50, max: 70, rate: 98.0, days: [1, 3] },
  ]),
  // Ground Advantage (replaces First Class Package + Retail Ground)
  ...flatWeightTiers('usps', 'ground_advantage', 'Ground Advantage', 'US', [
    { min: 0, max: 1, rate: 5.5, days: [2, 5] },
    { min: 1, max: 2, rate: 7.45, days: [2, 5] },
    { min: 2, max: 5, rate: 11.2, days: [2, 5] },
    { min: 5, max: 10, rate: 17.9, days: [2, 5] },
    { min: 10, max: 20, rate: 28.0, days: [2, 5] },
    { min: 20, max: 50, rate: 55.0, days: [2, 5] },
    { min: 50, max: 70, rate: 78.0, days: [2, 5] },
  ]),
  // First-Class Package (letters < 1lb only)
  {
    carrier_kind: 'usps',
    service_code: 'first_class_package',
    service_name: 'First-Class Package',
    region_code: 'US',
    weight_min_lb: 0,
    weight_max_lb: 1,
    rate_usd: 4.5,
    transit_days_min: 2,
    transit_days_max: 5,
  },
  // Priority Mail Express (overnight)
  ...flatWeightTiers('usps', 'priority_mail_express', 'Priority Mail Express', 'US', [
    { min: 0, max: 1, rate: 31.5, days: [1, 2] },
    { min: 1, max: 2, rate: 38.5, days: [1, 2] },
    { min: 2, max: 5, rate: 55.0, days: [1, 2] },
    { min: 5, max: 10, rate: 82.0, days: [1, 2] },
    { min: 10, max: 20, rate: 122.0, days: [1, 2] },
    { min: 20, max: 50, rate: 205.0, days: [1, 2] },
    { min: 50, max: 70, rate: 265.0, days: [1, 2] },
  ]),
  // Media Mail (books / DVDs)
  ...flatWeightTiers('usps', 'media_mail', 'Media Mail', 'US', [
    { min: 0, max: 1, rate: 3.95, days: [2, 8] },
    { min: 1, max: 2, rate: 4.55, days: [2, 8] },
    { min: 2, max: 5, rate: 5.9, days: [2, 8] },
    { min: 5, max: 10, rate: 9.1, days: [2, 8] },
    { min: 10, max: 20, rate: 14.5, days: [2, 8] },
    { min: 20, max: 50, rate: 28.0, days: [2, 8] },
    { min: 50, max: 70, rate: 38.0, days: [2, 8] },
  ]),
  // International — USPS Priority Mail International (Canada only for simplicity)
  ...flatWeightTiers('usps', 'priority_mail_international', 'Priority Mail International', 'INT', [
    { min: 0, max: 1, rate: 28.5, days: [6, 10] },
    { min: 1, max: 4, rate: 45.0, days: [6, 10] },
    { min: 4, max: 10, rate: 85.0, days: [6, 10] },
    { min: 10, max: 20, rate: 140.0, days: [6, 10] },
    { min: 20, max: 44, rate: 235.0, days: [6, 10] },
  ]),
]

// ---------------------------------------------------------------------------
// Seed rates — UPS
// ---------------------------------------------------------------------------

const UPS_RATES: SeedRate[] = [
  ...flatWeightTiers('ups', 'ground', 'UPS Ground', 'US', [
    { min: 0, max: 1, rate: 10.5, days: [1, 5] },
    { min: 1, max: 5, rate: 14.9, days: [1, 5] },
    { min: 5, max: 10, rate: 21.5, days: [1, 5] },
    { min: 10, max: 25, rate: 38.0, days: [1, 5] },
    { min: 25, max: 50, rate: 62.0, days: [1, 5] },
    { min: 50, max: 70, rate: 88.0, days: [1, 5] },
    { min: 70, max: 150, rate: 168.0, days: [1, 5] },
  ]),
  ...flatWeightTiers('ups', '3_day_select', '3-Day Select', 'US', [
    { min: 0, max: 1, rate: 18.0, days: [3, 3] },
    { min: 1, max: 5, rate: 25.0, days: [3, 3] },
    { min: 5, max: 10, rate: 38.0, days: [3, 3] },
    { min: 10, max: 25, rate: 62.0, days: [3, 3] },
    { min: 25, max: 50, rate: 105.0, days: [3, 3] },
    { min: 50, max: 70, rate: 155.0, days: [3, 3] },
  ]),
  ...flatWeightTiers('ups', '2nd_day_air', '2nd Day Air', 'US', [
    { min: 0, max: 1, rate: 22.5, days: [2, 2] },
    { min: 1, max: 5, rate: 32.0, days: [2, 2] },
    { min: 5, max: 10, rate: 48.0, days: [2, 2] },
    { min: 10, max: 25, rate: 78.0, days: [2, 2] },
    { min: 25, max: 50, rate: 135.0, days: [2, 2] },
    { min: 50, max: 70, rate: 190.0, days: [2, 2] },
  ]),
  ...flatWeightTiers('ups', 'next_day_air', 'Next Day Air', 'US', [
    { min: 0, max: 1, rate: 42.0, days: [1, 1] },
    { min: 1, max: 5, rate: 58.0, days: [1, 1] },
    { min: 5, max: 10, rate: 88.0, days: [1, 1] },
    { min: 10, max: 25, rate: 145.0, days: [1, 1] },
    { min: 25, max: 50, rate: 248.0, days: [1, 1] },
    { min: 50, max: 70, rate: 335.0, days: [1, 1] },
  ]),
  // International
  ...flatWeightTiers('ups', 'worldwide_expedited', 'Worldwide Expedited', 'INT', [
    { min: 0, max: 1, rate: 55.0, days: [3, 5] },
    { min: 1, max: 5, rate: 85.0, days: [3, 5] },
    { min: 5, max: 10, rate: 140.0, days: [3, 5] },
    { min: 10, max: 25, rate: 245.0, days: [3, 5] },
    { min: 25, max: 50, rate: 445.0, days: [3, 5] },
    { min: 50, max: 70, rate: 620.0, days: [3, 5] },
  ]),
  ...flatWeightTiers('ups', 'worldwide_saver', 'Worldwide Saver', 'INT', [
    { min: 0, max: 1, rate: 68.0, days: [1, 3] },
    { min: 1, max: 5, rate: 98.0, days: [1, 3] },
    { min: 5, max: 10, rate: 168.0, days: [1, 3] },
    { min: 10, max: 25, rate: 285.0, days: [1, 3] },
    { min: 25, max: 50, rate: 525.0, days: [1, 3] },
    { min: 50, max: 70, rate: 740.0, days: [1, 3] },
  ]),
]

// ---------------------------------------------------------------------------
// Seed rates — FedEx
// ---------------------------------------------------------------------------

const FEDEX_RATES: SeedRate[] = [
  ...flatWeightTiers('fedex', 'home_delivery', 'FedEx Home Delivery', 'US', [
    { min: 0, max: 1, rate: 11.25, days: [1, 5] },
    { min: 1, max: 5, rate: 15.75, days: [1, 5] },
    { min: 5, max: 10, rate: 22.5, days: [1, 5] },
    { min: 10, max: 25, rate: 39.0, days: [1, 5] },
    { min: 25, max: 50, rate: 64.0, days: [1, 5] },
    { min: 50, max: 70, rate: 92.0, days: [1, 5] },
  ]),
  ...flatWeightTiers('fedex', 'ground', 'FedEx Ground', 'US', [
    { min: 0, max: 1, rate: 10.95, days: [1, 5] },
    { min: 1, max: 5, rate: 15.2, days: [1, 5] },
    { min: 5, max: 10, rate: 21.9, days: [1, 5] },
    { min: 10, max: 25, rate: 38.5, days: [1, 5] },
    { min: 25, max: 50, rate: 63.0, days: [1, 5] },
    { min: 50, max: 70, rate: 89.0, days: [1, 5] },
    { min: 70, max: 150, rate: 175.0, days: [1, 5] },
  ]),
  ...flatWeightTiers('fedex', 'express_saver', 'FedEx Express Saver', 'US', [
    { min: 0, max: 1, rate: 19.5, days: [3, 3] },
    { min: 1, max: 5, rate: 28.0, days: [3, 3] },
    { min: 5, max: 10, rate: 41.0, days: [3, 3] },
    { min: 10, max: 25, rate: 68.0, days: [3, 3] },
    { min: 25, max: 50, rate: 112.0, days: [3, 3] },
    { min: 50, max: 70, rate: 160.0, days: [3, 3] },
  ]),
  ...flatWeightTiers('fedex', '2_day', 'FedEx 2Day', 'US', [
    { min: 0, max: 1, rate: 24.5, days: [2, 2] },
    { min: 1, max: 5, rate: 34.5, days: [2, 2] },
    { min: 5, max: 10, rate: 52.0, days: [2, 2] },
    { min: 10, max: 25, rate: 82.0, days: [2, 2] },
    { min: 25, max: 50, rate: 140.0, days: [2, 2] },
    { min: 50, max: 70, rate: 198.0, days: [2, 2] },
  ]),
  ...flatWeightTiers('fedex', 'standard_overnight', 'Standard Overnight', 'US', [
    { min: 0, max: 1, rate: 45.0, days: [1, 1] },
    { min: 1, max: 5, rate: 62.0, days: [1, 1] },
    { min: 5, max: 10, rate: 92.0, days: [1, 1] },
    { min: 10, max: 25, rate: 152.0, days: [1, 1] },
    { min: 25, max: 50, rate: 258.0, days: [1, 1] },
    { min: 50, max: 70, rate: 345.0, days: [1, 1] },
  ]),
  ...flatWeightTiers('fedex', 'international_economy', 'International Economy', 'INT', [
    { min: 0, max: 1, rate: 58.0, days: [4, 6] },
    { min: 1, max: 5, rate: 92.0, days: [4, 6] },
    { min: 5, max: 10, rate: 152.0, days: [4, 6] },
    { min: 10, max: 25, rate: 268.0, days: [4, 6] },
    { min: 25, max: 50, rate: 475.0, days: [4, 6] },
    { min: 50, max: 70, rate: 660.0, days: [4, 6] },
  ]),
  ...flatWeightTiers('fedex', 'international_priority', 'International Priority', 'INT', [
    { min: 0, max: 1, rate: 72.0, days: [1, 3] },
    { min: 1, max: 5, rate: 105.0, days: [1, 3] },
    { min: 5, max: 10, rate: 178.0, days: [1, 3] },
    { min: 10, max: 25, rate: 305.0, days: [1, 3] },
    { min: 25, max: 50, rate: 558.0, days: [1, 3] },
    { min: 50, max: 70, rate: 775.0, days: [1, 3] },
  ]),
]

// ---------------------------------------------------------------------------
// Seed rates — DHL Express (international worldwide)
// ---------------------------------------------------------------------------

const DHL_EXPRESS_RATES: SeedRate[] = [
  ...flatWeightTiers('dhl_express', 'international_express', 'DHL Express Worldwide', 'INT', [
    { min: 0, max: 1, rate: 62.0, days: [1, 3] },
    { min: 1, max: 5, rate: 95.0, days: [1, 3] },
    { min: 5, max: 10, rate: 165.0, days: [1, 3] },
    { min: 10, max: 25, rate: 285.0, days: [1, 3] },
    { min: 25, max: 50, rate: 520.0, days: [1, 3] },
    { min: 50, max: 70, rate: 730.0, days: [1, 3] },
  ]),
  // EU-wide express (UK, Germany, France, etc.)
  ...flatWeightTiers('dhl_express', 'eu_express', 'DHL Express Europe', 'EU', [
    { min: 0, max: 1, rate: 22.0, days: [1, 2] },
    { min: 1, max: 5, rate: 32.5, days: [1, 2] },
    { min: 5, max: 10, rate: 52.0, days: [1, 2] },
    { min: 10, max: 25, rate: 92.0, days: [1, 2] },
    { min: 25, max: 50, rate: 168.0, days: [1, 2] },
    { min: 50, max: 70, rate: 235.0, days: [1, 2] },
  ]),
]

// ---------------------------------------------------------------------------
// Seed rates — DHL Paket (Germany domestic)
// ---------------------------------------------------------------------------

const DHL_PAKET_RATES: SeedRate[] = [
  ...flatWeightTiers('dhl_paket', 'paket', 'DHL Paket', 'EU-DE', [
    { min: 0, max: 4.4, rate: 6.85, days: [1, 2] },   // up to 2kg
    { min: 4.4, max: 11, rate: 9.49, days: [1, 2] },  // up to 5kg
    { min: 11, max: 22, rate: 12.95, days: [1, 2] },  // up to 10kg
    { min: 22, max: 68, rate: 19.99, days: [1, 2] },  // up to 31.5kg
  ]),
]

// ---------------------------------------------------------------------------
// Seed rates — Royal Mail (UK)
// ---------------------------------------------------------------------------

const ROYAL_MAIL_RATES: SeedRate[] = [
  // 1st Class (domestic letter / parcel)
  ...flatWeightTiers('royal_mail', 'first_class', '1st Class', 'UK', [
    { min: 0, max: 0.22, rate: 2.4, days: [1, 2] },    // up to 100g
    { min: 0.22, max: 0.55, rate: 3.9, days: [1, 2] }, // up to 250g
    { min: 0.55, max: 1.1, rate: 5.75, days: [1, 2] }, // up to 500g
    { min: 1.1, max: 2.2, rate: 8.5, days: [1, 2] },   // up to 1kg
    { min: 2.2, max: 4.4, rate: 11.25, days: [1, 2] }, // up to 2kg
  ]),
  ...flatWeightTiers('royal_mail', 'second_class', '2nd Class', 'UK', [
    { min: 0, max: 0.22, rate: 1.9, days: [2, 3] },
    { min: 0.22, max: 0.55, rate: 3.1, days: [2, 3] },
    { min: 0.55, max: 1.1, rate: 4.55, days: [2, 3] },
    { min: 1.1, max: 2.2, rate: 6.95, days: [2, 3] },
    { min: 2.2, max: 4.4, rate: 9.25, days: [2, 3] },
  ]),
  ...flatWeightTiers('royal_mail', 'tracked_24', 'Tracked 24', 'UK', [
    { min: 0, max: 2.2, rate: 5.5, days: [1, 1] },
    { min: 2.2, max: 4.4, rate: 7.8, days: [1, 1] },
    { min: 4.4, max: 11, rate: 10.9, days: [1, 1] },
    { min: 11, max: 44, rate: 18.5, days: [1, 1] },
  ]),
  ...flatWeightTiers('royal_mail', 'tracked_48', 'Tracked 48', 'UK', [
    { min: 0, max: 2.2, rate: 4.2, days: [2, 2] },
    { min: 2.2, max: 4.4, rate: 6.1, days: [2, 2] },
    { min: 4.4, max: 11, rate: 8.8, days: [2, 2] },
    { min: 11, max: 44, rate: 15.2, days: [2, 2] },
  ]),
  ...flatWeightTiers('royal_mail', 'international_standard', 'International Standard', 'INT', [
    { min: 0, max: 0.22, rate: 5.2, days: [3, 7] },
    { min: 0.22, max: 0.55, rate: 8.5, days: [3, 7] },
    { min: 0.55, max: 1.1, rate: 13.5, days: [3, 7] },
    { min: 1.1, max: 2.2, rate: 22.0, days: [3, 7] },
  ]),
  ...flatWeightTiers('royal_mail', 'international_tracked', 'International Tracked', 'INT', [
    { min: 0, max: 0.22, rate: 9.5, days: [2, 5] },
    { min: 0.22, max: 0.55, rate: 13.8, days: [2, 5] },
    { min: 0.55, max: 1.1, rate: 19.5, days: [2, 5] },
    { min: 1.1, max: 2.2, rate: 29.0, days: [2, 5] },
    { min: 2.2, max: 4.4, rate: 42.0, days: [2, 5] },
  ]),
]

// ---------------------------------------------------------------------------
// Seed rates — La Poste / Colissimo (France)
// ---------------------------------------------------------------------------

const LA_POSTE_RATES: SeedRate[] = [
  ...flatWeightTiers('la_poste', 'colissimo_home', 'Colissimo Domicile', 'EU-FR', [
    { min: 0, max: 0.55, rate: 5.55, days: [2, 3] },
    { min: 0.55, max: 1.1, rate: 7.7, days: [2, 3] },
    { min: 1.1, max: 4.4, rate: 9.55, days: [2, 3] },
    { min: 4.4, max: 11, rate: 14.55, days: [2, 3] },
    { min: 11, max: 22, rate: 22.45, days: [2, 3] },
    { min: 22, max: 66, rate: 29.35, days: [2, 3] },
  ]),
  ...flatWeightTiers('la_poste', 'colissimo_international', 'Colissimo International', 'INT', [
    { min: 0, max: 0.55, rate: 14.8, days: [3, 8] },
    { min: 0.55, max: 2.2, rate: 23.6, days: [3, 8] },
    { min: 2.2, max: 4.4, rate: 38.5, days: [3, 8] },
    { min: 4.4, max: 11, rate: 62.0, days: [3, 8] },
    { min: 11, max: 22, rate: 95.0, days: [3, 8] },
  ]),
]

// ---------------------------------------------------------------------------
// Seed rates — DPD (pan-European)
// ---------------------------------------------------------------------------

const DPD_RATES: SeedRate[] = [
  ...flatWeightTiers('dpd', 'classic', 'DPD Classic', 'EU', [
    { min: 0, max: 4.4, rate: 8.9, days: [2, 4] },
    { min: 4.4, max: 11, rate: 12.5, days: [2, 4] },
    { min: 11, max: 22, rate: 17.8, days: [2, 4] },
    { min: 22, max: 44, rate: 25.9, days: [2, 4] },
    { min: 44, max: 66, rate: 36.5, days: [2, 4] },
  ]),
  ...flatWeightTiers('dpd', 'express', 'DPD Express', 'EU', [
    { min: 0, max: 4.4, rate: 16.5, days: [1, 2] },
    { min: 4.4, max: 11, rate: 22.8, days: [1, 2] },
    { min: 11, max: 22, rate: 32.0, days: [1, 2] },
    { min: 22, max: 44, rate: 46.5, days: [1, 2] },
    { min: 44, max: 66, rate: 65.0, days: [1, 2] },
  ]),
  ...flatWeightTiers('dpd', 'international', 'DPD International', 'INT', [
    { min: 0, max: 4.4, rate: 18.9, days: [3, 5] },
    { min: 4.4, max: 11, rate: 26.5, days: [3, 5] },
    { min: 11, max: 22, rate: 38.0, days: [3, 5] },
    { min: 22, max: 44, rate: 55.0, days: [3, 5] },
    { min: 44, max: 66, rate: 78.0, days: [3, 5] },
  ]),
]

// ---------------------------------------------------------------------------
// Seed rates — PostNL (Netherlands + Belgium)
// ---------------------------------------------------------------------------

const POSTNL_RATES: SeedRate[] = [
  ...flatWeightTiers('postnl', 'standard', 'PostNL Standard', 'EU-NL', [
    { min: 0, max: 4.4, rate: 7.25, days: [1, 2] },
    { min: 4.4, max: 22, rate: 11.85, days: [1, 2] },
    { min: 22, max: 44, rate: 18.9, days: [1, 2] },
  ]),
  ...flatWeightTiers('postnl', 'tracked', 'PostNL Tracked', 'EU-NL', [
    { min: 0, max: 4.4, rate: 8.95, days: [1, 2] },
    { min: 4.4, max: 22, rate: 13.95, days: [1, 2] },
    { min: 22, max: 44, rate: 21.5, days: [1, 2] },
  ]),
  ...flatWeightTiers('postnl', 'international', 'PostNL International', 'INT', [
    { min: 0, max: 4.4, rate: 15.5, days: [3, 7] },
    { min: 4.4, max: 22, rate: 26.0, days: [3, 7] },
    { min: 22, max: 44, rate: 45.0, days: [3, 7] },
  ]),
]

// ---------------------------------------------------------------------------
// Seed rates — GLS (Europe)
// ---------------------------------------------------------------------------

const GLS_RATES: SeedRate[] = [
  ...flatWeightTiers('gls', 'business_parcel', 'GLS BusinessParcel', 'EU', [
    { min: 0, max: 4.4, rate: 7.9, days: [1, 2] },
    { min: 4.4, max: 22, rate: 12.5, days: [1, 2] },
    { min: 22, max: 44, rate: 18.9, days: [1, 2] },
    { min: 44, max: 88, rate: 28.5, days: [1, 2] },
  ]),
  ...flatWeightTiers('gls', 'euro_business_parcel', 'GLS EuroBusinessParcel', 'EU', [
    { min: 0, max: 4.4, rate: 13.5, days: [2, 4] },
    { min: 4.4, max: 22, rate: 19.9, days: [2, 4] },
    { min: 22, max: 44, rate: 28.9, days: [2, 4] },
    { min: 44, max: 88, rate: 42.5, days: [2, 4] },
  ]),
]

// ---------------------------------------------------------------------------
// Seed rates — Hermes / Evri (UK)
// ---------------------------------------------------------------------------

const HERMES_RATES: SeedRate[] = [
  ...flatWeightTiers('hermes', 'standard', 'Evri Standard', 'UK', [
    { min: 0, max: 2.2, rate: 3.2, days: [2, 3] },
    { min: 2.2, max: 4.4, rate: 4.5, days: [2, 3] },
    { min: 4.4, max: 11, rate: 6.8, days: [2, 3] },
    { min: 11, max: 33, rate: 11.5, days: [2, 3] },
  ]),
  ...flatWeightTiers('hermes', 'next_day', 'Evri Next Day', 'UK', [
    { min: 0, max: 2.2, rate: 5.9, days: [1, 1] },
    { min: 2.2, max: 4.4, rate: 7.5, days: [1, 1] },
    { min: 4.4, max: 11, rate: 10.5, days: [1, 1] },
    { min: 11, max: 33, rate: 16.9, days: [1, 1] },
  ]),
]

// ---------------------------------------------------------------------------
// Seed rates — Bpost (Belgium)
// ---------------------------------------------------------------------------

const BPOST_RATES: SeedRate[] = [
  ...flatWeightTiers('bpost', 'standard', 'Bpost Standard', 'EU-BE', [
    { min: 0, max: 4.4, rate: 6.65, days: [1, 2] },
    { min: 4.4, max: 11, rate: 9.85, days: [1, 2] },
    { min: 11, max: 22, rate: 13.95, days: [1, 2] },
  ]),
  ...flatWeightTiers('bpost', 'tracked', 'Bpost Tracked', 'EU-BE', [
    { min: 0, max: 4.4, rate: 8.25, days: [1, 2] },
    { min: 4.4, max: 11, rate: 11.95, days: [1, 2] },
    { min: 11, max: 22, rate: 16.85, days: [1, 2] },
  ]),
  ...flatWeightTiers('bpost', 'international', 'Bpost International', 'INT', [
    { min: 0, max: 4.4, rate: 18.5, days: [3, 7] },
    { min: 4.4, max: 11, rate: 28.5, days: [3, 7] },
    { min: 11, max: 22, rate: 45.0, days: [3, 7] },
  ]),
]

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

/**
 * Everything the migration / admin needs to seed is exposed here.
 * Test suites use this constant directly to assert coverage (e.g.
 * "every carrier has at least one service").
 */
export const RATE_CATALOG: SeedRate[] = [
  ...USPS_RATES,
  ...UPS_RATES,
  ...FEDEX_RATES,
  ...DHL_EXPRESS_RATES,
  ...DHL_PAKET_RATES,
  ...ROYAL_MAIL_RATES,
  ...LA_POSTE_RATES,
  ...DPD_RATES,
  ...POSTNL_RATES,
  ...GLS_RATES,
  ...HERMES_RATES,
  ...BPOST_RATES,
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TierSpec {
  min: number
  max: number
  rate: number
  days: [number, number]
}

/**
 * Expand a compact bracket list into SeedRate rows. Keeps the rate file
 * readable — otherwise every row would be 8 lines of boilerplate.
 */
function flatWeightTiers(
  kind: CarrierKind,
  serviceCode: string,
  serviceName: string,
  region: RegionCode,
  tiers: TierSpec[],
): SeedRate[] {
  return tiers.map((t) => ({
    carrier_kind: kind,
    service_code: serviceCode,
    service_name: serviceName,
    region_code: region,
    weight_min_lb: t.min,
    weight_max_lb: t.max,
    rate_usd: t.rate,
    transit_days_min: t.days[0],
    transit_days_max: t.days[1],
  }))
}

/**
 * Filter the catalog for a specific carrier. Admin "enable carrier"
 * button uses this to know which services to seed into a shop's rate
 * table.
 */
export function rateCatalogForCarrier(kind: CarrierKind): SeedRate[] {
  return RATE_CATALOG.filter((r) => r.carrier_kind === kind)
}

/**
 * List of unique service codes for a carrier. Handy for admin
 * grouping + unit tests.
 */
export function servicesForCarrier(kind: CarrierKind): string[] {
  const seen = new Set<string>()
  for (const row of RATE_CATALOG) {
    if (row.carrier_kind === kind) seen.add(row.service_code)
  }
  return Array.from(seen)
}

/**
 * Pick the seed rate that best matches a (carrier, service, region,
 * weight) lookup. Returns the bracket containing `weightLb`; returns
 * null if no bracket covers this weight (caller should treat as
 * "not serviced").
 *
 * Tie-breaker: narrower bracket first (so a specialised 2-5lb rate
 * wins over a generic 0-10lb).
 */
export function pickSeedRate(
  kind: CarrierKind,
  serviceCode: string,
  region: RegionCode,
  weightLb: number,
): SeedRate | null {
  const candidates = RATE_CATALOG.filter(
    (r) =>
      r.carrier_kind === kind &&
      r.service_code === serviceCode &&
      r.region_code === region &&
      weightLb >= r.weight_min_lb &&
      weightLb <= r.weight_max_lb,
  )
  if (candidates.length === 0) return null
  // Narrowest bracket wins
  candidates.sort(
    (a, b) =>
      a.weight_max_lb - a.weight_min_lb - (b.weight_max_lb - b.weight_min_lb),
  )
  return candidates[0]
}
