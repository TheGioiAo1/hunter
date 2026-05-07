/**
 * Gbox Platform — i18n `t` filter
 *
 * Decision #1 Step 1.4 — Wires the `I18nService` three-tier fallback
 * into a LiquidJS filter so templates can write:
 *
 *     {{ 'general.cart.title' | t }}
 *     {{ 'cart.line_count' | t: count: cart.item_count }}
 *     {{ 'cart.line_count' | t: count: 3 }}
 *
 * Shopify compatibility notes:
 *   - The filter name is exactly `t` (matches Shopify docs).
 *   - Named arguments after the key become interpolation vars —
 *     e.g. `| t: count: 3, name: 'Thai'` binds `{{ count }}` → 3
 *     and `{{ name }}` → 'Thai' in the translation value.
 *   - Shop / locale context is pulled from the render environment's
 *     `globals` (`shop.id`, `shop.default_locale`, `request.locale`)
 *     so the same filter works across every shop without per-call
 *     wiring from the template author.
 *   - Missing keys render as the key itself (Shopify default); no
 *     throw even with `strictFilters: true` because `strictFilters`
 *     only catches unknown filter NAMES, not missing data inside a
 *     known filter.
 *
 * Why an async filter?
 *   The `I18nService.t()` contract is async (DB-backed loader with
 *   in-process cache dedup). LiquidJS natively supports returning a
 *   Promise from a filter in its async render path, and the engine
 *   factory runs every template through `parseAndRender` (async), so
 *   the microtask hop is free.
 *
 * Why pull `shop_id` + `shopDefaultLocale` from globals instead of
 * requiring the template to pass them?
 *   Because no Shopify theme in the world passes `shop.id` as an
 *   argument to `| t`. Templates write `{{ 'key' | t }}` and expect
 *   the engine to know which shop is rendering. We inspect
 *   `liquidScope.get(['shop'])` and `['request', 'locale']` at filter
 *   call time.
 */

import type { Liquid } from 'liquidjs'
import type { I18nService, InterpolationVars } from '../../../i18n/index.js'

export function registerI18nFilters(liquid: Liquid, i18n: I18nService): void {
  // The `this` inside a registered filter is the Liquid `Context`
  // instance when the filter opts in via the 3-arg form. liquidjs
  // exposes `this.context` (the render context) on the filter impl
  // object when registered via registerFilter with a function that
  // relies on dynamic `this`.
  //
  // Simpler path: use liquid.registerFilter's function context —
  // liquidjs passes the full context to filters registered with a
  // `{ handler, raw: true }` wrapper via the FilterImpl metadata, but
  // the public API doesn't expose that. So we use a closure-less
  // approach: read globals from `this.context.getSync(['shop'])`.
  //
  // LiquidJS lets filter fns access `this.context.environments` (the
  // merged globals + locals). We go through the context accessor to
  // cleanly handle the three-tier chain.

  liquid.registerFilter('t', async function tFilter(
    this: any,
    key: unknown,
    ...restArgs: unknown[]
  ): Promise<string> {
    const k = typeof key === 'string' ? key : String(key ?? '')
    if (!k) return ''

    // Extract shop + locale from the render context. `this.context`
    // is the LiquidJS Context inside a filter invocation. Access is
    // defensive because a test harness may call the filter with a
    // stub context.
    const ctx = (this && this.context) || null
    let shopId = ''
    let locale: string | undefined
    let shopDefaultLocale: string | undefined

    if (ctx) {
      try {
        const shop = await ctx.get(['shop'])
        if (shop && typeof shop === 'object') {
          shopId = String((shop as any).id ?? '')
          shopDefaultLocale =
            (shop as any).default_locale ?? (shop as any).defaultLocale ?? undefined
        }
        const req = await ctx.get(['request'])
        if (req && typeof req === 'object') {
          locale = (req as any).locale
        }
      } catch {
        // Ignore — fall through with whatever we captured.
      }
    }

    // Collect named arguments. LiquidJS passes named filter args as
    // 2-element `[name, value]` tuple arrays in the filter's restArgs
    // (see Filter.render() in liquidjs — args with `isKeyValuePair`
    // are pushed as `[key, val]`). We extract them and treat every
    // tuple as an interpolation var. Positional args after the key
    // (plain strings/numbers) are ignored — the `t` filter only
    // accepts the key + kwargs.
    const vars: InterpolationVars = {}
    for (const a of restArgs) {
      if (
        Array.isArray(a) &&
        a.length === 2 &&
        typeof a[0] === 'string'
      ) {
        vars[a[0]] = a[1] as any
      } else if (a && typeof a === 'object' && !Array.isArray(a)) {
        // Defensive fallback: some future liquidjs release could
        // pass a plain object; handle that too.
        for (const [name, value] of Object.entries(a)) {
          vars[name] = value as any
        }
      }
    }

    if (!shopId) {
      // Without a shop context we can't look anything up; fall back
      // to the key (same sentinel as I18nService.t would do at tier 4).
      return k
    }

    return i18n.t(shopId, k, {
      locale,
      shopDefaultLocale,
      vars,
    })
  })
}
