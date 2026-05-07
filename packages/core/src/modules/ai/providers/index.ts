/**
 * Gbox Platform — AI provider factory
 *
 * Single entrypoint: give it a `ProviderCredential`, get back an
 * `AIProvider` ready to call. The router is the only thing that
 * should construct providers directly — callers go through the
 * router so they get fallback + cost tracking.
 */

import type { AIProvider } from './base.js'
import type { AIProviderId, ProviderCredential } from '../types.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAIProvider } from './openai.js'
import { GoogleProvider } from './google.js'
import { GroqProvider } from './groq.js'

export type { AIProvider } from './base.js'
export { AnthropicProvider } from './anthropic.js'
export { OpenAIProvider } from './openai.js'
export { GoogleProvider } from './google.js'
export { GroqProvider } from './groq.js'

/**
 * Build a concrete provider from a credential. Throws if the provider
 * id is `'none'` — callers should filter that out before calling.
 */
export function createProvider(credential: ProviderCredential): AIProvider {
  switch (credential.provider) {
    case 'anthropic':
      return new AnthropicProvider(credential)
    case 'openai':
      return new OpenAIProvider(credential)
    case 'google':
      return new GoogleProvider(credential)
    case 'groq':
      return new GroqProvider(credential)
    case 'none':
      throw new Error(
        'createProvider called with provider=none. ' +
          "Filter 'none' out before building a provider.",
      )
    default: {
      const _exhaustive: never = credential.provider
      throw new Error(`Unknown provider: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Whether this runtime knows how to build a provider for the given id.
 * Callers use this to decide whether a credential is worth trying.
 */
export function isKnownProvider(id: AIProviderId): id is Exclude<AIProviderId, 'none'> {
  return id === 'anthropic' || id === 'openai' || id === 'google' || id === 'groq'
}
