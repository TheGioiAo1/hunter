/**
 * Gbox Platform — Multi-Pixel Tracking: shared types.
 *
 * The canonical event taxonomy is Meta Standard Events (the richest
 * and most widely understood). Every other provider is reached via a
 * name map in `event-map.ts`.
 */

export type TrackingProvider = 'meta_pixel' | 'ga4' | 'gtm' | 'tiktok'

export const TRACKING_PROVIDERS: readonly TrackingProvider[] = [
  'meta_pixel',
  'ga4',
  'gtm',
  'tiktok',
] as const

/** Human-readable label for each provider (used in admin UI). */
export const PROVIDER_LABELS: Record<TrackingProvider, string> = {
  meta_pixel: 'Facebook / Meta Pixel',
  ga4: 'Google Analytics 4',
  gtm: 'Google Tag Manager',
  tiktok: 'TikTok Pixel',
}

/** Which providers accept an API token (GTM doesn't). */
export function providerNeedsToken(p: TrackingProvider): boolean {
  return p !== 'gtm'
}

/**
 * Canonical event names — Meta Standard Events. Storefront and
 * backend both use these, so the same event_id deduplicates across
 * all providers.
 */
export type CanonicalEvent =
  | 'PageView'
  | 'ViewContent'
  | 'Search'
  | 'AddToCart'
  | 'AddToWishlist'
  | 'InitiateCheckout'
  | 'AddPaymentInfo'
  | 'Purchase'
  | 'Lead'
  | 'CompleteRegistration'
  | 'Contact'
  | 'Subscribe'

export const CANONICAL_EVENTS: readonly CanonicalEvent[] = [
  'PageView',
  'ViewContent',
  'Search',
  'AddToCart',
  'AddToWishlist',
  'InitiateCheckout',
  'AddPaymentInfo',
  'Purchase',
  'Lead',
  'CompleteRegistration',
  'Contact',
  'Subscribe',
] as const

/** Which events we auto-enable when merchant first connects a pixel. */
export const DEFAULT_ENABLED_EVENTS: readonly CanonicalEvent[] = [
  'PageView',
  'ViewContent',
  'AddToCart',
  'InitiateCheckout',
  'Purchase',
] as const

// ---------------------------------------------------------------------------
// Public row shapes
// ---------------------------------------------------------------------------

/**
 * Merchant-facing view of a pixel row. NEVER includes the decrypted
 * token — the admin UI shows a boolean "hasApiToken" flag instead.
 */
export interface TrackingPixelPublic {
  id: string
  shopId: string
  provider: TrackingProvider
  label: string
  pixelId: string
  hasApiToken: boolean
  eventsEnabled: CanonicalEvent[]
  testEventCode: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** Server-only shape with the decrypted token attached. */
export interface TrackingPixelWithToken extends TrackingPixelPublic {
  apiToken: string | null
}

// ---------------------------------------------------------------------------
// CRUD inputs
// ---------------------------------------------------------------------------

export interface CreateTrackingPixelInput {
  shopId: string
  provider: TrackingProvider
  label: string
  pixelId: string
  /** plaintext — encrypted before INSERT; null for GTM */
  apiToken?: string | null
  eventsEnabled?: CanonicalEvent[]
  testEventCode?: string | null
  isActive?: boolean
  createdBy?: string | null
}

export interface UpdateTrackingPixelInput {
  label?: string
  pixelId?: string
  /** undefined = don't touch; null = clear; string = replace */
  apiToken?: string | null
  eventsEnabled?: CanonicalEvent[]
  testEventCode?: string | null
  isActive?: boolean
}

// ---------------------------------------------------------------------------
// Event payload (consumed by client-snippet + dispatch-server)
// ---------------------------------------------------------------------------

/** A single user action that should fan out to all configured pixels. */
export interface TrackingEventPayload {
  /** Meta Standard Event name — mapped to partner-side names internally. */
  canonicalEvent: CanonicalEvent
  /** Client-generated UUID. Must be identical across client-side + server-side fires for dedupe. */
  eventId: string
  /** ms since epoch — will be converted to seconds for Meta, micros for GA4. */
  eventTimeMs: number
  sourceUrl: string
  userAgent?: string | null
  clientIp?: string | null
  /** Raw email — hashed SHA-256 before sending to providers (Meta requirement). */
  userEmail?: string | null
  userPhone?: string | null
  userExternalId?: string | null
  /** Meta browser-id cookie (_fbp) and click-id cookie (_fbc). */
  fbp?: string | null
  fbc?: string | null
  /** GA4 client_id (from the `_ga` cookie). */
  ga4ClientId?: string | null
  /** TikTok click-id (from ?ttclid URL param). */
  ttclid?: string | null
  /** Per-event extras: content_ids, value, currency, num_items, etc. */
  customData?: Record<string, unknown>
}
