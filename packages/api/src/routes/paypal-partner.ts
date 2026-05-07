/**
 * PayPal Partner API Routes
 *
 * REST endpoints for PayPal Partner integration:
 * - Merchant onboarding (connect PayPal account)
 * - Payment creation (at checkout)
 * - Payment capture (after approval)
 * - Refunds
 * - Merchant status check
 */

import type { Kysely } from "kysely";
import type { Database } from "@gbox/db";
import {
  createPartnerReferralLink,
  processOnboardingCallback,
  getMerchantIntegrationInfo,
  isMerchantReady,
  createPayPalPartnerOrder,
  capturePayPalPartnerOrder,
  refundPayPalPartnerCapture,
} from "../../../core/src/modules/payments/paypal-partner/index.ts";
import type {
  MerchantOnboardingResult,
  CreatePayPalOrderInput,
} from "../../../core/src/modules/payments/paypal-partner/index.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return json({ errors: [{ message }] }, status);
}

// ============ ONBOARDING ============

/**
 * POST /api/2026-04/paypal/onboarding.json
 * Generate PayPal Partner referral link for store owner
 * Body: { return_url: string }
 */
export async function createOnboardingLink(
  request: Request,
  db: Kysely<Database>,
  shopId: string
): Promise<Response> {
  try {
    const body = (await request.json()) as { return_url?: string };

    // Get shop info for tracking
    const shop = await db
      .selectFrom("shops")
      .where("id", "=", shopId)
      .select(["email"])
      .executeTakeFirst();

    const returnUrl =
      body.return_url || `${new URL(request.url).origin}/api/2026-04/paypal/onboarding/callback`;

    const referralLink = await createPartnerReferralLink(
      shopId,
      returnUrl,
      shop?.email || ""
    );

    return json({ paypal_partner: { onboarding_url: referralLink } });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
}

/**
 * POST /api/2026-04/paypal/onboarding/callback.json
 * Process PayPal onboarding callback
 * Body: { merchantIdInPayPal, merchantId, permissionsGranted, ... }
 */
export async function handleOnboardingCallback(
  request: Request,
  db: Kysely<Database>,
  shopId: string
): Promise<Response> {
  try {
    const params = (await request.json()) as MerchantOnboardingResult;

    if (!params.merchantIdInPayPal) {
      return errorResponse("Missing merchantIdInPayPal");
    }

    await processOnboardingCallback(db, shopId, params);

    return json({
      paypal_partner: {
        connected: true,
        merchant_id: params.merchantIdInPayPal,
        account_status: params.accountStatus,
      },
    });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
}

// ============ MERCHANT STATUS ============

/**
 * GET /api/2026-04/paypal/status.json
 * Check if store's PayPal merchant account is ready
 */
export async function getMerchantStatus(
  request: Request,
  db: Kysely<Database>,
  shopId: string
): Promise<Response> {
  try {
    const status = await isMerchantReady(db, shopId);

    let integrationInfo = null;
    if (status.merchantId) {
      try {
        integrationInfo = await getMerchantIntegrationInfo(status.merchantId);
      } catch {
        // Merchant info fetch failed, continue with basic status
      }
    }

    return json({
      paypal_partner: {
        connected: status.ready,
        merchant_id: status.merchantId,
        reason: status.reason,
        integration: integrationInfo
          ? {
              payments_receivable: integrationInfo.payments_receivable,
              email_confirmed: integrationInfo.primary_email_confirmed,
              products: integrationInfo.products?.map((p) => p.name),
            }
          : null,
      },
    });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
}

// ============ PAYMENTS ============

/**
 * POST /api/2026-04/paypal/orders.json
 * Create a PayPal order for checkout (money goes to store owner)
 */
export async function createPayPalOrder(
  request: Request,
  db: Kysely<Database>,
  shopId: string
): Promise<Response> {
  try {
    const input = (await request.json()) as CreatePayPalOrderInput;
    const result = await createPayPalPartnerOrder(db, shopId, input);

    return json({
      paypal_order: {
        id: result.paypalOrderId,
        approval_url: result.approvalUrl,
      },
    });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
}

/**
 * POST /api/2026-04/paypal/orders/:paypal_order_id/capture.json
 * Capture PayPal order after customer approval
 */
export async function capturePayPalOrder(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  paypalOrderId: string
): Promise<Response> {
  try {
    const result = await capturePayPalPartnerOrder(paypalOrderId);

    // Save capture ID to transaction record
    // The caller (checkout service) should link this to the Gbox order

    return json({
      paypal_capture: {
        id: result.captureId,
        status: result.status,
        amount: result.amount,
      },
    });
  } catch (err) {
    const message = String(err);

    if (message.includes("INSTRUMENT_DECLINED")) {
      return json(
        {
          paypal_capture: {
            status: "INSTRUMENT_DECLINED",
            message: "Payment method declined. Customer should choose another method.",
          },
        },
        422
      );
    }

    return errorResponse(message, 500);
  }
}

/**
 * POST /api/2026-04/paypal/captures/:capture_id/refund.json
 * Refund a PayPal capture (full or partial)
 */
export async function refundPayPalCapture(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  captureId: string
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      amount?: number;
      currency?: string;
      note?: string;
    };

    const result = await refundPayPalPartnerCapture(
      db,
      shopId,
      captureId,
      body.amount,
      body.currency,
      body.note
    );

    return json({
      paypal_refund: {
        id: result.refundId,
        status: result.status,
      },
    });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
}
