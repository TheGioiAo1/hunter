/**
 * Astro middleware entry point.
 * Resolves the shop from the request hostname and attaches it to locals.
 */
import { shopMiddleware } from './engine/shop-resolver.js';

export const onRequest = shopMiddleware();
