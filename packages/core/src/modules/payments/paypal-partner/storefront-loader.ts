/**
 * PayPal Partner — Storefront SDK Loader (server-side helper)
 *
 * Original: gbox-paypal/paypal-gbox.php :: wp_enqueue_scripts +
 *           script_loader_tag filter (the bit that injects
 *           data-partner-attribution-id="Gbox_Ecom" onto the SDK <script>).
 *
 * Why this is its own module:
 *   1. The PayPal JS SDK MUST carry `data-partner-attribution-id` on the
 *      <script> tag itself — PayPal reads it during SDK init and uses it
 *      for partner attribution on every browser-side action (Buttons,
 *      onApprove, etc). Forgetting this is the #1 way partners lose
 *      credit on the buyer-facing path. The legacy paypal.ts fix handled
 *      the SERVER calls; this module handles the BROWSER side.
 *   2. The merchant_id query param has to be the *seller's* PayPal
 *      merchant id (not Gbox's), so the SDK needs a per-shop lookup.
 *      Centralising that here keeps the storefront thin (it just embeds
 *      whatever HTML this returns).
 *   3. Storefront work hasn't started (Decision #1 + #6). When it does,
 *      it imports `buildPayPalSdkScriptTag(shopId)` and drops the result
 *      into the checkout page <head>. Until then, the same helper is
 *      callable by the API for server-rendered checkout previews.
 *
 * Security:
 *   - Reads PAYPAL_PARTNER_CLIENT_ID from env (never plaintext in code).
 *   - Looks up the seller's merchant id from `shop_settings` (the same
 *     row processOnboardingCallback writes), NOT from a global option.
 *   - HTML-escapes the merchant id and currency before splicing into
 *     the script URL — defence-in-depth even though they're allow-listed.
 */

import type { Kysely } from "kysely";
import type { Database } from "@gbox/db";
import { getPayPalPartnerConfig } from "./config.js";
import { isMerchantReady } from "./onboarding.js";

export interface PayPalSdkScriptOptions {
  /** Shop currency code, e.g. "USD". Defaults to "USD". */
  currency?: string;
  /** Buyer country (from geo-IP, defaults to "US"). */
  buyerCountry?: string;
  /** Comma-separated funding sources to enable. Default: "venmo". */
  enableFunding?: string;
  /** Override script URL (testing only). */
  baseUrl?: string;
}

export interface PayPalSdkScript {
  /** Full <script> HTML, ready to splice into the page. */
  scriptTag: string;
  /** Plain URL (for clients that want to assemble their own tag). */
  src: string;
  /** The data-partner-attribution-id value used. */
  bnCode: string;
  /** The merchant id for this shop (PayPal seller, not Gbox). */
  merchantId: string;
}

/**
 * Build the PayPal JS SDK <script> tag for a specific shop's checkout.
 *
 * Throws if:
 *   - PayPal Partner env credentials are missing
 *   - The shop has not yet completed Partner onboarding
 *
 * Callers (storefront, checkout API) should catch and fall back to a
 * non-PayPal flow when this throws — the gateway-selector already
 * handles the "is PayPal usable?" decision upstream.
 */
export async function buildPayPalSdkScriptTag(
  db: Kysely<Database>,
  shopId: string,
  options: PayPalSdkScriptOptions = {},
): Promise<PayPalSdkScript> {
  const config = getPayPalPartnerConfig();

  // Resolve the seller's merchant id from shop_settings.
  const merchant = await isMerchantReady(db, shopId);
  if (!merchant.ready || !merchant.merchantId) {
    throw new Error(
      `PayPal SDK unavailable for shop ${shopId}: ${
        merchant.reason ?? "merchant not connected"
      }`,
    );
  }

  const currency = (options.currency ?? "USD").toUpperCase();
  const buyerCountry = (options.buyerCountry ?? "US").toUpperCase();
  const enableFunding = options.enableFunding ?? "venmo";
  const baseUrl = options.baseUrl ?? "https://www.paypal.com/sdk/js";

  // Defence-in-depth: PayPal already validates these, but we never want a
  // shop_setting injection to break out of the URL. Allow only [A-Z0-9_-].
  const safe = (s: string): string =>
    /^[A-Za-z0-9_,-]+$/.test(s) ? s : "";

  const url = new URL(baseUrl);
  url.searchParams.set("client-id", config.clientId);
  url.searchParams.set("merchant-id", safe(merchant.merchantId));
  url.searchParams.set("currency", safe(currency) || "USD");
  url.searchParams.set("buyer-country", safe(buyerCountry) || "US");
  if (enableFunding) {
    url.searchParams.set("enable-funding", safe(enableFunding) || "venmo");
  }
  // PayPal SDK requires "intent" to match the order intent (CAPTURE).
  url.searchParams.set("intent", "capture");
  // Tell SDK to use the components we actually need — slimmer payload.
  url.searchParams.set("components", "buttons,funding-eligibility");

  const src = url.toString();

  // HTML-escape the BN code (it's a static constant but escaping is cheap
  // and means a future change can't smuggle in markup).
  const bnEscaped = config.bnCode.replace(/[<>"']/g, "");
  const srcEscaped = src.replace(/"/g, "&quot;");

  // Note: data-partner-attribution-id MUST be on the <script> tag itself,
  // NOT a query param. The SDK reads it on parse.
  const scriptTag =
    `<script src="${srcEscaped}" ` +
    `data-partner-attribution-id="${bnEscaped}" ` +
    `data-namespace="paypal_gbox" ` +
    `async defer></script>`;

  return {
    scriptTag,
    src,
    bnCode: config.bnCode,
    merchantId: merchant.merchantId,
  };
}
