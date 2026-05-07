/**
 * Build the `<script>` block that the storefront injector pastes
 * into the `<head>` of every rendered page.
 *
 * The snippet:
 *   1. Loads each provider's library (fbq / gtag / ttq) exactly once
 *      even if the merchant has multiple pixels from the same provider.
 *   2. Calls `fbq('init', id)` / `gtag('config', id)` / `ttq.load(id)`
 *      once per pixel.
 *   3. Fires PageView automatically for every pixel that enables it.
 *   4. Exposes `window.gboxTrack(canonicalEvent, customData)` — the
 *      hook that product pages, the cart drawer, and the thank-you
 *      page call for ViewContent / AddToCart / Purchase / etc.
 *   5. Every `gboxTrack()` fire generates a fresh event_id, dispatches
 *      to every pixel client-side, AND POSTs to `/api/track` so the
 *      server can dispatch via CAPI/MP/Events API with the SAME
 *      event_id (providers dedupe automatically).
 *
 * IMPORTANT: this snippet runs in the browser, so no secrets (tokens)
 * ever appear. Only pixel IDs are public by design.
 */

import type { TrackingPixelPublic, CanonicalEvent } from './types.ts'

export interface BuildSnippetInput {
  pixels: TrackingPixelPublic[]
  /** Endpoint on the platform API that receives `/api/track` POSTs. */
  trackEndpoint: string
  /** Shop identifier echoed to the server in every fire. */
  shopId: string
}

/**
 * Returns the raw JS body (no surrounding `<script>` tag) so the
 * injector can decide on placement / nonce / CSP wrapping.
 */
export function buildClientSnippet(input: BuildSnippetInput): string {
  const metaPixels = input.pixels.filter((p) => p.provider === 'meta_pixel')
  const ga4Pixels = input.pixels.filter((p) => p.provider === 'ga4')
  const tiktokPixels = input.pixels.filter((p) => p.provider === 'tiktok')
  const gtmPixels = input.pixels.filter((p) => p.provider === 'gtm')

  const parts: string[] = []
  parts.push(HEADER_COMMENT)
  parts.push(`var __GBOX_TRACK_ENDPOINT=${JSON.stringify(input.trackEndpoint)};`)
  parts.push(`var __GBOX_SHOP_ID=${JSON.stringify(input.shopId)};`)
  parts.push(
    `var __GBOX_PIXELS=${JSON.stringify(
      input.pixels.map((p) => ({
        id: p.id,
        provider: p.provider,
        pixelId: p.pixelId,
        events: p.eventsEnabled,
      })),
    )};`,
  )

  if (metaPixels.length > 0) parts.push(metaLoader(metaPixels))
  if (ga4Pixels.length > 0) parts.push(ga4Loader(ga4Pixels))
  if (tiktokPixels.length > 0) parts.push(tiktokLoader(tiktokPixels))
  if (gtmPixels.length > 0) parts.push(gtmLoader(gtmPixels))

  parts.push(GBOX_TRACK_FN)

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Provider loaders (string templates)
// ---------------------------------------------------------------------------

const HEADER_COMMENT = `/* Gbox Multi-Pixel Tracker — do not edit, auto-generated */`

function metaLoader(pixels: TrackingPixelPublic[]): string {
  const initCalls = pixels.map((p) => `fbq('init', ${JSON.stringify(p.pixelId)});`).join('\n')
  const firePageViews = pixels
    .filter((p) => p.eventsEnabled.includes('PageView'))
    .map((p) => `fbq('trackSingle', ${JSON.stringify(p.pixelId)}, 'PageView');`)
    .join('\n')
  return `
/* Meta Pixel bootstrap */
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
${initCalls}
${firePageViews}
`.trim()
}

function ga4Loader(pixels: TrackingPixelPublic[]): string {
  // gtag.js loads once, then `config` is called per pixel.
  const firstId = pixels[0]!.pixelId
  const configs = pixels.map((p) => `gtag('config', ${JSON.stringify(p.pixelId)});`).join('\n')
  return `
/* GA4 gtag.js bootstrap */
(function(){var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=${firstId}';document.head.appendChild(s);})();
window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;
gtag('js', new Date());
${configs}
`.trim()
}

function tiktokLoader(pixels: TrackingPixelPublic[]): string {
  const loads = pixels.map((p) => `ttq.load(${JSON.stringify(p.pixelId)});`).join('\n')
  const pageviews = pixels
    .filter((p) => p.eventsEnabled.includes('PageView'))
    .map(() => `ttq.page();`)
    .join('\n')
  return `
/* TikTok Pixel bootstrap */
!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e};ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=i;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};var o=document.createElement("script");o.type="text/javascript";o.async=!0;o.src=i+"?sdkid="+e+"&lib="+t;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};}(window,document,'ttq');
${loads}
${pageviews}
`.trim()
}

function gtmLoader(pixels: TrackingPixelPublic[]): string {
  // Each GTM container injects its own `<script>`. Most merchants only
  // have one; we loop just in case.
  return pixels
    .map(
      (p) => `
/* Google Tag Manager: ${p.pixelId} */
(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${JSON.stringify(p.pixelId)});
`.trim(),
    )
    .join('\n')
}

// ---------------------------------------------------------------------------
// window.gboxTrack — the single hook every page calls
// ---------------------------------------------------------------------------
//
// Internal mini-mapper from canonical → partner event name. Kept in
// sync with `event-map.ts`. It's duplicated here because this string
// runs in the browser where we can't import the TS module.

const GBOX_TRACK_FN = String.raw`
/* window.gboxTrack(canonicalEvent, customData) */
(function(){
  var GA4_MAP = ${JSON.stringify({
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
  })};
  var TIKTOK_MAP = ${JSON.stringify({
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
  })};
  function uuid(){
    if(window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){var r=Math.random()*16|0;return (c=='x'?r:(r&0x3|0x8)).toString(16);});
  }
  window.gboxTrack = function(canonicalEvent, customData){
    try {
      var eventId = uuid();
      customData = customData || {};
      var pixels = (window.__GBOX_PIXELS || []);
      for (var i=0;i<pixels.length;i++) {
        var p = pixels[i];
        if (p.events.indexOf(canonicalEvent) === -1) continue;
        try {
          if (p.provider === 'meta_pixel' && window.fbq) {
            window.fbq('trackSingle', p.pixelId, canonicalEvent, customData, { eventID: eventId });
          } else if (p.provider === 'ga4' && window.gtag) {
            window.gtag('event', GA4_MAP[canonicalEvent] || canonicalEvent, Object.assign({
              send_to: p.pixelId, event_id: eventId
            }, customData));
          } else if (p.provider === 'tiktok' && window.ttq) {
            window.ttq.instance(p.pixelId).track(TIKTOK_MAP[canonicalEvent] || canonicalEvent, Object.assign({ event_id: eventId }, customData));
          } else if (p.provider === 'gtm' && window.dataLayer) {
            window.dataLayer.push(Object.assign({ event: canonicalEvent, event_id: eventId }, customData));
          }
        } catch(e){ /* swallow, keep dispatching */ }
      }
      // Server-side fan-out (CAPI / MP / TikTok Events API)
      try {
        if (window.__GBOX_TRACK_ENDPOINT && window.fetch) {
          window.fetch(window.__GBOX_TRACK_ENDPOINT, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              shop_id: window.__GBOX_SHOP_ID,
              event_id: eventId,
              canonical_event: canonicalEvent,
              event_time_ms: Date.now(),
              source_url: window.location.href,
              custom_data: customData
            }),
            keepalive: true
          }).catch(function(){});
        }
      } catch(e){ /* swallow */ }
      return eventId;
    } catch(e){ return null; }
  };
})();
`.trim()
