/**
 * Gbox Platform - Shop Resolver Middleware
 *
 * Maps incoming request hostname to a shop_id by querying the API.
 * Sets shop context that all pages can access.
 */

import { apiClient, type Shop } from './api-client.js';

export interface ShopContext {
  shop: Shop;
  shopId: string;
}

/**
 * Resolve the shop from the incoming request hostname.
 *
 * Resolution order:
 *   1. Custom domain exact match (e.g., mystore.com)
 *   2. Subdomain match (e.g., mystore.gbox.co)
 *   3. Fallback: slug match from first subdomain segment
 */
export async function resolveShop(request: Request): Promise<ShopContext | null> {
  const url = new URL(request.url);
  const hostname = url.hostname;

  // During local dev, allow ?shop= query param override
  const shopOverride = url.searchParams.get('shop');
  if (shopOverride) {
    try {
      const shop = await apiClient.getShop(shopOverride);
      if (shop) {
        return { shop, shopId: shop.id };
      }
    } catch {
      // Fall through to hostname resolution
    }
  }

  // Skip resolution for localhost without override
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return null;
  }

  try {
    // Try resolving by full hostname (custom domain or *.gbox.co)
    const shop = await apiClient.getShopByDomain(hostname);
    if (shop) {
      return { shop, shopId: shop.id };
    }
  } catch {
    // Shop not found
  }

  return null;
}

/**
 * Astro middleware that attaches shop context to locals.
 */
export function shopMiddleware() {
  return async (context: any, next: () => Promise<Response>): Promise<Response> => {
    const shopContext = await resolveShop(context.request);

    if (!shopContext) {
      // Return a 404 page if shop cannot be resolved
      return new Response(
        `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Store Not Found</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#111}
.box{text-align:center;padding:3rem}.box h1{font-size:2rem;margin-bottom:1rem}.box p{color:#666}</style>
</head>
<body><div class="box"><h1>Store Not Found</h1><p>The store you are looking for does not exist or is no longer available.</p></div></body>
</html>`,
        { status: 404, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // Attach shop context to Astro locals
    context.locals.shop = shopContext.shop;
    context.locals.shopId = shopContext.shopId;

    return next();
  };
}
