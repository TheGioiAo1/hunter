/**
 * PayPal Partner Configuration
 *
 * Original: gbox-paypal/includes/helpers.php (PHP constants)
 * Rewritten: Environment variables (no hardcoded credentials)
 *
 * This module enables Gbox Platform as a PayPal Partner Platform,
 * allowing each store owner to connect their own PayPal account
 * and receive payments directly (like Shopify Payments).
 */

export interface PayPalPartnerConfig {
  clientId: string;
  clientSecret: string;
  partnerId: string;       // PayPal Partner Merchant ID
  bnCode: string;          // Partner Attribution Code (BN Code)
  apiBase: string;         // https://api.paypal.com or https://api.sandbox.paypal.com
  webhookId?: string;
}

export function getPayPalPartnerConfig(): PayPalPartnerConfig {
  const clientId = process.env.PAYPAL_PARTNER_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_PARTNER_SECRET;
  const partnerId = process.env.PAYPAL_PARTNER_ID;

  if (!clientId || !clientSecret || !partnerId) {
    throw new Error(
      "Missing PayPal Partner credentials. Set PAYPAL_PARTNER_CLIENT_ID, PAYPAL_PARTNER_SECRET, PAYPAL_PARTNER_ID in .env"
    );
  }

  return {
    clientId,
    clientSecret,
    partnerId,
    bnCode: process.env.PAYPAL_PARTNER_BN_CODE || "Gbox_Ecom",
    apiBase: process.env.PAYPAL_SANDBOX === "true"
      ? "https://api-m.sandbox.paypal.com"
      : "https://api-m.paypal.com",
    webhookId: process.env.PAYPAL_WEBHOOK_ID,
  };
}
