/**
 * PayPal Partner Payment Gateway
 *
 * Original: gbox-paypal/includes/class-gbox-paypal-gateway.php
 *           gbox-paypal/includes/class-gbox-venmo-gateway.php
 *           gbox-paypal/paypal-gbox.php (capture handler)
 * Rewritten: TypeScript for Gbox Platform v4
 *
 * Supports: PayPal + Venmo (via PayPal PPCP)
 * Payments go DIRECTLY to the store owner's PayPal account
 * Gbox Platform acts as the Partner facilitating the transaction
 */

import type { Kysely } from "kysely";
import type { Database } from "@gbox/db";
import { paypalFetch } from "./auth.js";
import { isMerchantReady } from "./onboarding.js";
import { getPayPalPartnerConfig } from "./config.js";

// ============ TYPES ============

interface PayPalOrderItem {
  name: string;
  description?: string;
  sku?: string;
  quantity: string;
  unit_amount: { currency_code: string; value: string };
  category: "DIGITAL_GOODS" | "PHYSICAL_GOODS";
}

interface PayPalOrderRequest {
  intent: "CAPTURE";
  purchase_units: Array<{
    reference_id: string;
    description: string;
    invoice_id: string;
    amount: {
      currency_code: string;
      value: string;
      breakdown: {
        item_total: { currency_code: string; value: string };
        shipping?: { currency_code: string; value: string };
        tax_total?: { currency_code: string; value: string };
        discount?: { currency_code: string; value: string };
      };
    };
    payee: { merchant_id: string };
    items: PayPalOrderItem[];
    shipping?: {
      name: { full_name: string };
      address: {
        address_line_1: string;
        address_line_2?: string;
        admin_area_2: string;
        admin_area_1?: string;
        postal_code: string;
        country_code: string;
      };
    };
  }>;
  payment_source: {
    paypal?: { experience_context: PayPalExperienceContext };
    venmo?: { experience_context: PayPalExperienceContext };
  };
}

interface PayPalExperienceContext {
  brand_name: string;
  user_action: "PAY_NOW";
  payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED";
  shipping_preference: "SET_PROVIDED_ADDRESS" | "NO_SHIPPING";
  return_url: string;
  cancel_url: string;
}

export interface CreatePayPalOrderInput {
  orderId: string;
  orderNumber: string;
  currency: string;
  items: Array<{
    name: string;
    description?: string;
    sku?: string;
    quantity: number;
    price: number;
    requiresShipping: boolean;
  }>;
  subtotal: number;
  shippingTotal: number;
  taxTotal: number;
  discountTotal: number;
  total: number;
  shippingAddress?: {
    fullName: string;
    address1: string;
    address2?: string;
    city: string;
    province?: string;
    zip: string;
    countryCode: string;
  };
  returnUrl: string;
  cancelUrl: string;
  shopName: string;
  paymentMethod: "paypal" | "venmo";
}

export interface PayPalOrderResult {
  paypalOrderId: string;
  approvalUrl: string;
}

export interface PayPalCaptureResult {
  captureId: string;
  status: string;
  amount: { value: string; currency_code: string };
}

// ============ CREATE ORDER ============

/**
 * Create a PayPal order for checkout
 * Money goes directly to the store owner's PayPal account
 *
 * Original: class-gbox-paypal-gateway.php → process_payment()
 */
export async function createPayPalPartnerOrder(
  db: Kysely<Database>,
  shopId: string,
  input: CreatePayPalOrderInput
): Promise<PayPalOrderResult> {
  // Verify merchant is ready
  const merchant = await isMerchantReady(db, shopId);
  if (!merchant.ready || !merchant.merchantId) {
    throw new Error(
      `PayPal not available: ${merchant.reason || "Merchant not connected"}`
    );
  }

  const fmt = (n: number) => n.toFixed(2);

  // Build items
  const items: PayPalOrderItem[] = input.items.map((item) => ({
    name: item.name.substring(0, 127),
    description: item.description?.substring(0, 127),
    sku: item.sku,
    quantity: String(item.quantity),
    unit_amount: {
      currency_code: input.currency,
      value: fmt(item.price),
    },
    category: item.requiresShipping ? "PHYSICAL_GOODS" : "DIGITAL_GOODS",
  }));

  // Build amount breakdown
  const breakdown: PayPalOrderRequest["purchase_units"][0]["amount"]["breakdown"] = {
    item_total: { currency_code: input.currency, value: fmt(input.subtotal) },
  };

  if (input.shippingTotal > 0) {
    breakdown.shipping = {
      currency_code: input.currency,
      value: fmt(input.shippingTotal),
    };
  }

  if (input.taxTotal > 0) {
    breakdown.tax_total = {
      currency_code: input.currency,
      value: fmt(input.taxTotal),
    };
  }

  if (input.discountTotal > 0) {
    breakdown.discount = {
      currency_code: input.currency,
      value: fmt(input.discountTotal),
    };
  }

  // Build purchase unit
  const purchaseUnit: PayPalOrderRequest["purchase_units"][0] = {
    reference_id: input.orderId,
    description: `Order #${input.orderNumber}`,
    invoice_id: `INV-${input.orderNumber}`,
    amount: {
      currency_code: input.currency,
      value: fmt(input.total),
      breakdown,
    },
    payee: { merchant_id: merchant.merchantId },
    items,
  };

  // Add shipping address if present
  if (input.shippingAddress) {
    purchaseUnit.shipping = {
      name: { full_name: input.shippingAddress.fullName },
      address: {
        address_line_1: input.shippingAddress.address1,
        address_line_2: input.shippingAddress.address2,
        admin_area_2: input.shippingAddress.city,
        admin_area_1: input.shippingAddress.province,
        postal_code: input.shippingAddress.zip,
        country_code: input.shippingAddress.countryCode,
      },
    };
  }

  // Build experience context
  const experienceContext: PayPalExperienceContext = {
    brand_name: input.shopName,
    user_action: "PAY_NOW",
    payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
    shipping_preference: input.shippingAddress
      ? "SET_PROVIDED_ADDRESS"
      : "NO_SHIPPING",
    return_url: input.returnUrl,
    cancel_url: input.cancelUrl,
  };

  // Build payment source based on method (PayPal or Venmo)
  const paymentSource: PayPalOrderRequest["payment_source"] =
    input.paymentMethod === "venmo"
      ? { venmo: { experience_context: experienceContext } }
      : { paypal: { experience_context: experienceContext } };

  // Create PayPal order
  const orderRequest: PayPalOrderRequest = {
    intent: "CAPTURE",
    purchase_units: [purchaseUnit],
    payment_source: paymentSource,
  };

  const res = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    body: orderRequest,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`PayPal order creation failed: ${res.status} ${error}`);
  }

  const data = (await res.json()) as {
    id: string;
    status: string;
    links: Array<{ href: string; rel: string }>;
  };

  // Find approval URL
  const approvalLink = data.links.find(
    (l) => l.rel === "payer-action" || l.rel === "approve"
  );

  if (!approvalLink) {
    throw new Error("PayPal did not return an approval URL");
  }

  return {
    paypalOrderId: data.id,
    approvalUrl: approvalLink.href,
  };
}

// ============ CAPTURE ============

/**
 * Capture a PayPal order after customer approval
 *
 * Original: paypal-gbox.php → gbox_paypal_success handler
 */
export async function capturePayPalPartnerOrder(
  paypalOrderId: string
): Promise<PayPalCaptureResult> {
  const res = await paypalFetch(
    `/v2/checkout/orders/${paypalOrderId}/capture`,
    { method: "POST" }
  );

  if (!res.ok) {
    const error = await res.text();

    // Handle INSTRUMENT_DECLINED (customer needs to choose different payment)
    if (error.includes("INSTRUMENT_DECLINED")) {
      throw new Error("INSTRUMENT_DECLINED");
    }

    throw new Error(`PayPal capture failed: ${res.status} ${error}`);
  }

  const data = (await res.json()) as {
    id: string;
    status: string;
    purchase_units: Array<{
      payments: {
        captures: Array<{
          id: string;
          status: string;
          amount: { value: string; currency_code: string };
        }>;
      };
    }>;
  };

  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) {
    throw new Error("PayPal capture response missing capture details");
  }

  return {
    captureId: capture.id,
    status: capture.status,
    amount: capture.amount,
  };
}

// ============ CANCEL ============

export interface PayPalCancelResult {
  paypalOrderId: string;
  paypalStatus: string;        // CREATED | SAVED | APPROVED | VOIDED | COMPLETED | PAYER_ACTION_REQUIRED
  cancellable: boolean;        // false if PayPal already captured the order
  alreadyCaptured: boolean;
}

/**
 * Cancel an in-flight PayPal Partner order.
 *
 * Original: paypal-gbox.php → `gbox_paypal_cancel` GET handler.
 *
 * PayPal v2/checkout/orders has NO explicit cancel endpoint — the order
 * naturally expires server-side after the buyer abandons the approval.
 * The PHP plugin therefore just (1) marks the local Woo order as cancelled
 * and (2) redirects the buyer back to checkout. We mirror that here:
 *
 *   1. GET /v2/checkout/orders/{id} to find out the *current* status.
 *   2. If status is COMPLETED → refuse to cancel (caller must refund).
 *   3. If status is APPROVED  → buyer already approved on PayPal but
 *      we never captured. Returning {cancellable:true, alreadyCaptured:false}
 *      lets the route remove the local checkout session safely.
 *   4. Otherwise (CREATED/PAYER_ACTION_REQUIRED/SAVED/VOIDED) → cancellable.
 *
 * The function does NOT touch the local checkout session itself —
 * the route handler does, after a successful return. Keeping the side
 * effects in the route makes the gateway helper trivially testable.
 */
export async function cancelPayPalPartnerOrder(
  paypalOrderId: string,
): Promise<PayPalCancelResult> {
  const res = await paypalFetch(`/v2/checkout/orders/${paypalOrderId}`, {
    method: "GET",
  });

  // PayPal returns 404 once the order has fully expired (~3 hours after
  // creation, depending on flow). Treat that as cancellable — the order
  // is already gone on PayPal's side, so we just clean up locally.
  if (res.status === 404) {
    return {
      paypalOrderId,
      paypalStatus: "EXPIRED",
      cancellable: true,
      alreadyCaptured: false,
    };
  }

  if (!res.ok) {
    const error = await res.text();
    throw new Error(
      `PayPal order lookup failed: ${res.status} ${error}`,
    );
  }

  const data = (await res.json()) as { id: string; status: string };

  const alreadyCaptured = data.status === "COMPLETED";

  return {
    paypalOrderId: data.id,
    paypalStatus: data.status,
    cancellable: !alreadyCaptured,
    alreadyCaptured,
  };
}

// ============ REFUND ============

/**
 * Refund a PayPal capture (full or partial)
 * Uses auth assertion to act on behalf of the merchant
 *
 * Original: class-gbox-paypal-gateway.php → process_refund()
 */
export async function refundPayPalPartnerCapture(
  db: Kysely<Database>,
  shopId: string,
  captureId: string,
  amount?: number,
  currency?: string,
  note?: string
): Promise<{ refundId: string; status: string }> {
  // Get merchant ID for auth assertion
  const merchant = await isMerchantReady(db, shopId);
  if (!merchant.merchantId) {
    throw new Error("PayPal merchant not connected for this shop");
  }

  const body: Record<string, unknown> = {};
  if (amount !== undefined && currency) {
    body.amount = {
      value: amount.toFixed(2),
      currency_code: currency,
    };
  }
  if (note) {
    body.note_to_payer = note;
  }

  const res = await paypalFetch(
    `/v2/payments/captures/${captureId}/refund`,
    {
      method: "POST",
      body: Object.keys(body).length > 0 ? body : undefined,
      merchantId: merchant.merchantId,
    }
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`PayPal refund failed: ${res.status} ${error}`);
  }

  const data = (await res.json()) as { id: string; status: string };

  return {
    refundId: data.id,
    status: data.status,
  };
}
