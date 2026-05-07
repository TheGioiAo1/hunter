/**
 * Canonical → partner event name maps.
 *
 * Meta Standard Events is the canonical taxonomy (see types.ts).
 * GA4 and TikTok use slightly different vocabularies; map here so
 * the rest of the code can speak one dialect.
 */

import type { CanonicalEvent, TrackingProvider } from './types.ts'

/** GA4 recommended event names — https://support.google.com/analytics/answer/9267735 */
const GA4_MAP: Record<CanonicalEvent, string> = {
  PageView: 'page_view',
  ViewContent: 'view_item',
  Search: 'search',
  AddToCart: 'add_to_cart',
  AddToWishlist: 'add_to_wishlist',
  InitiateCheckout: 'begin_checkout',
  AddPaymentInfo: 'add_payment_info',
  Purchase: 'purchase',
  Lead: 'generate_lead',
  CompleteRegistration: 'sign_up',
  Contact: 'contact',
  Subscribe: 'subscribe',
}

/** TikTok Events API reserved names — https://business-api.tiktok.com/portal/docs?id=1741601162224642 */
const TIKTOK_MAP: Record<CanonicalEvent, string> = {
  PageView: 'Pageview',
  ViewContent: 'ViewContent',
  Search: 'Search',
  AddToCart: 'AddToCart',
  AddToWishlist: 'AddToWishlist',
  InitiateCheckout: 'InitiateCheckout',
  AddPaymentInfo: 'AddPaymentInfo',
  Purchase: 'CompletePayment',
  Lead: 'SubmitForm',
  CompleteRegistration: 'CompleteRegistration',
  Contact: 'Contact',
  Subscribe: 'Subscribe',
}

/** Resolve the partner-side event name. */
export function partnerEventName(
  provider: TrackingProvider,
  canonical: CanonicalEvent,
): string {
  switch (provider) {
    case 'meta_pixel':
      return canonical
    case 'ga4':
      return GA4_MAP[canonical]
    case 'tiktok':
      return TIKTOK_MAP[canonical]
    case 'gtm':
      // GTM fires via window.dataLayer. Use Meta's canonical name —
      // merchants typically build triggers around the Meta vocabulary.
      return canonical
  }
}
