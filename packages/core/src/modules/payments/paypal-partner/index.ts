/**
 * PayPal Partner Integration for Gbox Platform
 *
 * Rewrites gbox-paypal (PHP/WooCommerce) → TypeScript for Gbox Platform v4
 *
 * Architecture:
 * - Each store owner connects their own PayPal account (Partner Onboarding)
 * - Payments go DIRECTLY to the store owner's PayPal (not Gbox's)
 * - Gbox acts as the Partner Platform facilitating transactions
 * - Supports: PayPal + Venmo via PPCP (PayPal Commerce Platform)
 *
 * Usage in checkout:
 *   import { createPayPalPartnerOrder, capturePayPalPartnerOrder } from './paypal-partner'
 *   const { paypalOrderId, approvalUrl } = await createPayPalPartnerOrder(db, shopId, orderData)
 *   // redirect customer to approvalUrl
 *   // on return:
 *   const capture = await capturePayPalPartnerOrder(paypalOrderId)
 */

// Config
export { getPayPalPartnerConfig } from "./config.js";
export type { PayPalPartnerConfig } from "./config.js";

// Auth
export { getAccessToken, generateAuthAssertion, paypalFetch } from "./auth.js";

// Onboarding
export {
  createPartnerReferralLink,
  processOnboardingCallback,
  getMerchantIntegrationInfo,
  isMerchantReady,
} from "./onboarding.js";
export type { MerchantOnboardingResult, MerchantIntegrationInfo } from "./onboarding.js";

// Storefront SDK loader
export { buildPayPalSdkScriptTag } from "./storefront-loader.js";
export type {
  PayPalSdkScript,
  PayPalSdkScriptOptions,
} from "./storefront-loader.js";

// Payment Gateway
export {
  createPayPalPartnerOrder,
  capturePayPalPartnerOrder,
  cancelPayPalPartnerOrder,
  refundPayPalPartnerCapture,
} from "./gateway.js";
export type {
  CreatePayPalOrderInput,
  PayPalOrderResult,
  PayPalCaptureResult,
  PayPalCancelResult,
} from "./gateway.js";
