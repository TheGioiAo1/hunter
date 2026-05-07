/**
 * PayPal Partner Merchant Onboarding
 *
 * Original: gbox-paypal/includes/class-gbox-api.php → create_partner_referral_link()
 *           gbox-paypal/includes/class-gbox-onboarding.php
 *           gbox-paypal/includes/class-gbox-admin.php
 * Rewritten: TypeScript service for Gbox Platform v4
 *
 * Flow (like Shopify Payments onboarding):
 * 1. Store owner clicks "Connect PayPal" in admin
 * 2. We create a Partner Referral link via PayPal API
 * 3. Owner redirects to PayPal, authorizes their account
 * 4. PayPal redirects back with merchant credentials
 * 5. We save merchant_id to the shop's payment config
 * 6. Payments now flow directly to the store owner's PayPal
 */

import type { Kysely } from "kysely";
import type { Database } from "@gbox/db";
import { getPayPalPartnerConfig } from "./config.js";
import { paypalFetch } from "./auth.js";

// ============ TYPES ============

export interface MerchantOnboardingResult {
  merchantIdInPayPal: string;
  merchantId: string;
  permissionsGranted: boolean;
  accountStatus: string;
  consentStatus: boolean;
  productIntentId: string;
  isEmailConfirmed: boolean;
}

export interface MerchantIntegrationInfo {
  merchant_id: string;
  payments_receivable: boolean;
  primary_email_confirmed: boolean;
  products: Array<{ name: string; vetting_status?: string }>;
  capabilities: string[];
  oauth_integrations?: Array<{
    integration_type: string;
    oauth_third_party: Array<{
      partner_client_id: string;
      merchant_client_id: string;
      scopes: string[];
    }>;
  }>;
}

// ============ ONBOARDING ============

/**
 * Create a PayPal Partner Referral link for a store owner
 * The owner clicks this link to connect their PayPal account
 */
export async function createPartnerReferralLink(
  shopId: string,
  returnUrl: string,
  shopEmail: string
): Promise<string> {
  const config = getPayPalPartnerConfig();

  const body = {
    tracking_id: `gbox_shop_${shopId}`,
    partner_config_override: {
      partner_logo_url: "https://gbox.co/logo.png",
      return_url: returnUrl,
      action_renewal_url: returnUrl,
    },
    operations: [
      {
        operation: "API_INTEGRATION",
        api_integration_preference: {
          rest_api_integration: {
            integration_method: "PAYPAL",
            integration_type: "THIRD_PARTY",
            third_party_details: {
              features: ["PAYMENT", "REFUND", "ACCESS_MERCHANT_INFORMATION"],
            },
          },
        },
      },
    ],
    products: ["PPCP", "PAYMENT_METHODS"],
    capabilities: ["APPLE_PAY", "GOOGLE_PAY"],
    legal_consents: [
      {
        type: "SHARE_DATA_CONSENT",
        granted: true,
      },
    ],
  };

  const res = await paypalFetch("/v2/customer/partner-referrals", {
    method: "POST",
    body,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`PayPal Partner Referral failed: ${res.status} ${error}`);
  }

  const data = (await res.json()) as {
    links: Array<{ href: string; rel: string }>;
  };

  const actionUrl = data.links.find((l) => l.rel === "action_url");
  if (!actionUrl) {
    throw new Error("PayPal did not return an onboarding action URL");
  }

  return actionUrl.href;
}

/**
 * Process the onboarding callback from PayPal
 * Save merchant credentials to the shop's payment configuration
 */
export async function processOnboardingCallback(
  db: Kysely<Database>,
  shopId: string,
  params: MerchantOnboardingResult
): Promise<void> {
  // Save PayPal merchant info to shop_settings
  const settings = {
    paypal_merchant_id: params.merchantIdInPayPal,
    paypal_internal_merchant_id: params.merchantId,
    paypal_permissions_granted: params.permissionsGranted,
    paypal_account_status: params.accountStatus,
    paypal_consent_status: params.consentStatus,
    paypal_product_intent: params.productIntentId,
    paypal_email_confirmed: params.isEmailConfirmed,
    paypal_connected: true,
    paypal_connected_at: new Date().toISOString(),
  };

  // Upsert each setting
  for (const [key, value] of Object.entries(settings)) {
    await db
      .insertInto("shop_settings")
      .values({
        shop_id: shopId,
        key: `paypal_partner.${key}`,
        value: JSON.stringify(value),
      })
      .onConflict((oc) =>
        oc.columns(["shop_id", "key"]).doUpdateSet({
          value: JSON.stringify(value),
          updated_at: new Date().toISOString(),
        })
      )
      .execute();
  }
}

/**
 * Get merchant integration info from PayPal
 * Used to verify merchant account is ready to receive payments
 *
 * Original: class-gbox-api.php → get_merchant_integration_info()
 */
export async function getMerchantIntegrationInfo(
  merchantId: string
): Promise<MerchantIntegrationInfo> {
  const config = getPayPalPartnerConfig();

  const res = await paypalFetch(
    `/v1/customer/partners/${config.partnerId}/merchant-integrations/${merchantId}`
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`PayPal merchant info failed: ${res.status} ${error}`);
  }

  return (await res.json()) as MerchantIntegrationInfo;
}

/**
 * Check if a shop's PayPal merchant account is ready to receive payments
 */
export async function isMerchantReady(
  db: Kysely<Database>,
  shopId: string
): Promise<{
  ready: boolean;
  merchantId: string | null;
  reason?: string;
}> {
  // Get merchant ID from shop settings
  const setting = await db
    .selectFrom("shop_settings")
    .where("shop_id", "=", shopId)
    .where("key", "=", "paypal_partner.paypal_merchant_id")
    .select("value")
    .executeTakeFirst();

  if (!setting) {
    return { ready: false, merchantId: null, reason: "PayPal not connected" };
  }

  // shop_settings.value is jsonb. node-pg auto-decodes jsonb to a JS value,
  // so the column lands as `unknown` in our types. Handle both cases:
  // already-decoded (most common) and a legacy string row.
  const rawValue = setting.value as unknown;
  let merchantId: string;
  if (typeof rawValue === "string") {
    try {
      merchantId = JSON.parse(rawValue) as string;
    } catch {
      merchantId = rawValue;
    }
  } else {
    merchantId = String(rawValue);
  }

  try {
    const info = await getMerchantIntegrationInfo(merchantId);

    if (!info.payments_receivable) {
      return {
        ready: false,
        merchantId,
        reason: "PayPal account cannot receive payments",
      };
    }

    if (!info.primary_email_confirmed) {
      return {
        ready: false,
        merchantId,
        reason: "PayPal email not confirmed",
      };
    }

    return { ready: true, merchantId };
  } catch (err) {
    return {
      ready: false,
      merchantId,
      reason: `PayPal verification failed: ${String(err)}`,
    };
  }
}
