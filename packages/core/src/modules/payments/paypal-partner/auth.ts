/**
 * PayPal OAuth 2.0 Token Management
 *
 * Original: gbox-paypal/includes/class-gbox-api.php → get_access_token()
 * Rewritten: TypeScript with token caching
 */

import { getPayPalPartnerConfig } from "./config.js";

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

/**
 * Get PayPal OAuth access token (cached until expiry)
 */
export async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }

  const config = getPayPalPartnerConfig();
  const credentials = Buffer.from(
    `${config.clientId}:${config.clientSecret}`
  ).toString("base64");

  const res = await fetch(`${config.apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`PayPal OAuth failed: ${res.status} ${error}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return tokenCache.accessToken;
}

/**
 * Generate PayPal Auth Assertion header for merchant-context operations (refunds)
 *
 * Original: gbox-paypal/includes/class-gbox-api.php → generate_auth_assertion()
 * This is an unsigned JWT used by PayPal for partner→merchant delegation
 */
export function generateAuthAssertion(merchantId: string): string {
  const config = getPayPalPartnerConfig();

  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: config.clientId,
      payer_id: merchantId,
    })
  ).toString("base64url");

  return `${header}.${payload}.`;
}

/**
 * Make authenticated PayPal API call with Partner Attribution
 */
export async function paypalFetch(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    merchantId?: string;
  } = {}
): Promise<Response> {
  const config = getPayPalPartnerConfig();
  const token = await getAccessToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "PayPal-Partner-Attribution-Id": config.bnCode,
  };

  // Add auth assertion for merchant-context operations
  if (options.merchantId) {
    headers["PayPal-Auth-Assertion"] = generateAuthAssertion(options.merchantId);
  }

  return fetch(`${config.apiBase}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}
