import { callAIProvider, type CallAIInput } from './adapter.js'

export async function callSchemaMappingAI(
  systemPrompt: string,
  userPrompt: string,
  cfg: Pick<CallAIInput, 'provider' | 'apiKey' | 'model'>,
): Promise<string> {
  const r = await callAIProvider({ ...cfg, systemPrompt, userPrompt, maxTokens: 4096 })
  return r.text
}
