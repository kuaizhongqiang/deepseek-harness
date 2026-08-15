/**
 * Harness-declared builtin providers the installed pi-ai catalog does not
 * ship. The pi-ai catalog owns its own providers; this table is the harness's
 * answer for the routes its product needs and pi-ai has not caught up with —
 * today that is one route, Xiaomi MiMo, the vision model the desktop/VSCode/
 * web clients attach images to.
 *
 * A harness builtin is exactly as first-class as a pi-ai catalog entry: it
 * appears in `catalogProviderIds()` (the settings Models page offers it with a
 * key field), `catalogModels()` serves its models as route defaults, and
 * `buildProvider` reuses it the way it reuses a pi-ai catalog provider. The
 * only difference is provenance: the endpoint, protocol, and model facts below
 * are maintained here instead of upstream.
 *
 * @module dsh-llm-pi-ai/builtin
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, ApiKeyAuth, Model, ModelCost, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

/**
 * Pricing for a harness-declared model. The harness never reads pi-ai's cost
 * metadata — `replay.ts` zeroes it and no consumer reports spend — so this is
 * the absence of a fact, not a configurable rate. Shared with the catalog
 * materialization (`catalog.ts`), which needs the same absence for models
 * neither the catalog nor configuration sizes.
 */
export const NO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** The Xiaomi MiMo OpenAI-compatible endpoint. */
export const MIMO_BASE_URL = 'https://api.xiaomimimo.com/v1'

/**
 * Api-key auth for a route the harness authenticates itself. `Models` calls
 * this after the adapter has already resolved the route's credential, so a
 * missing key here is not this layer's failure: a named-but-unresolvable
 * reference has already failed the request with `MISSING_CREDENTIAL`, and a
 * route naming no credential at all is deliberately unauthenticated. Reporting
 * it as configured hands the decision to the protocol, which is where the
 * requirement actually lives — pi-ai's OpenAI-compatible implementation, for
 * one, still insists on a key or an `Authorization` header of its own.
 * @param name - display name used as the resolution's status label.
 * @returns the api-key auth for a harness-authenticated route.
 */
export function harnessApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

/**
 * MiMo thinking-level wire spellings, verified against the endpoint
 * (2026-08): `low`/`medium`/`high` are accepted and take effect, `minimal` is
 * refused with 400. `off` maps to `low` so an explicit "off" selection never
 * sends the bare string `off`, and the no-effort default (deepseek dispatch
 * reads `off !== null`) sends `thinking: { type: 'disabled' }` — the verified
 * fast path, since MiMo otherwise thinks by default.
 */
const MIMO_THINKING_LEVEL_MAP = {
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
} as const

/** The MiMo-V2.5 models the harness ships: the vision model and its text sibling. */
const mimoModels: readonly Model<Api>[] = [
  {
    id: 'mimo-v2.5',
    name: 'MiMo-V2.5',
    api: 'openai-completions',
    provider: 'mimo',
    baseUrl: MIMO_BASE_URL,
    reasoning: true,
    thinkingLevelMap: { ...MIMO_THINKING_LEVEL_MAP },
    // MiMo answers DeepSeek-style reasoning wire (`reasoning_content` +
    // `thinking`/`reasoning_effort`), so the deepseek dispatch is named
    // explicitly rather than left to baseURL auto-detection, which would not
    // recognize the xiaomimimo host.
    compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
    input: ['text', 'image'],
    cost: NO_COST,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: 'mimo-v2.5-pro',
    name: 'MiMo-V2.5-Pro',
    api: 'openai-completions',
    provider: 'mimo',
    baseUrl: MIMO_BASE_URL,
    reasoning: true,
    thinkingLevelMap: { ...MIMO_THINKING_LEVEL_MAP },
    compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
    input: ['text'],
    cost: NO_COST,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
]

const harnessProviders: readonly Provider[] = [
  createProvider({
    id: 'mimo',
    name: 'Xiaomi MiMo',
    baseUrl: MIMO_BASE_URL,
    auth: { apiKey: harnessApiKeyAuth('Xiaomi MiMo') },
    models: mimoModels,
    api: openAICompletionsApi(),
  }),
]

/**
 * Every harness-declared builtin provider.
 * @returns the harness builtin providers, in declaration order.
 */
export function harnessBuiltinProviders(): readonly Provider[] {
  return harnessProviders
}

/**
 * The harness-declared models for one route.
 * @param provider - provider route key.
 * @returns the harness builtin models, or `undefined` for a route this table
 * does not own (the caller then reads the pi-ai catalog).
 */
export function harnessBuiltinModels(provider: string): readonly Model<Api>[] | undefined {
  if (provider !== 'mimo') return undefined
  return mimoModels
}
