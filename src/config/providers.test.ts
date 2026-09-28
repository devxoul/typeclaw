import { describe, expect, test } from 'bun:test'

import { clampThinkingLevel, getSupportedThinkingLevels, normalizeContext } from '@earendil-works/pi-ai'
import type {
  Api,
  KnownApi,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
  StreamFunction,
} from '@earendil-works/pi-ai'
import { streamSimple as streamCodexResponses } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { streamSimple as streamResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'

import {
  defaultThinkingLevelForRef,
  isKnownModelRef,
  isOpenAiFamilyRef,
  isModelRef,
  KNOWN_PROVIDER_VENDORS,
  KNOWN_PROVIDERS,
  type KnownProviderId,
  listKnownModelRefs,
  listKnownProviderVendorIds,
  providerForModelRef,
  providerIdsForVendor,
  supportsApiKey,
  supportsOAuth,
  variantLabel,
  vendorForProviderId,
} from './providers'

// Builds the request a session at `level` sends, through the real transport,
// and stops before any network I/O. Like pi-agent-core (agent.js:305), `off`
// becomes an omitted `reasoning` option.
async function captureRequest<TApi extends Api>(
  stream: StreamFunction<TApi, SimpleStreamOptions>,
  model: Model<TApi>,
  apiKey: string,
  level: ModelThinkingLevel,
): Promise<Record<string, unknown> | undefined> {
  let payload: Record<string, unknown> | undefined
  const events = stream(model, normalizeContext({ messages: [{ role: 'user', content: 'ping', timestamp: 0 }] }), {
    apiKey,
    reasoning: level === 'off' ? undefined : level,
    onPayload: (params) => {
      payload = params as Record<string, unknown>
      throw new Error('captured')
    },
  })
  for await (const _event of events) {
    if (payload !== undefined) break
  }
  return payload
}

describe('KNOWN_PROVIDERS', () => {
  test('every provider model carries a baseUrl that matches the outer provider baseUrl', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        expect(model.baseUrl, `${providerId}/${modelId} baseUrl drift`).toBe(provider.baseUrl)
      }
    }
  })

  test('every model.provider field matches its outer provider id', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        expect(model.provider, `${providerId}/${modelId} provider drift`).toBe(providerId)
      }
    }
  })

  // pi 0.87 reads these records' request shape only from catalog metadata:
  // Anthropic adaptive thinking (0.73 inferred it from the id) and the Responses
  // effort maps. Drift here is a provider 400 or a silently wrong effort.
  // Records outside this list keep their 0.73 wire behavior (pi still detects
  // their compat from the baseUrl) and are intentionally not pinned to upstream.
  test('catalog-dependent records match pi-ai compat and thinking maps', () => {
    const catalogAligned = [
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-opus-4-7',
      'anthropic/claude-opus-4-8',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-5-5',
      'anthropic/claude-fable-5',
      'openai/gpt-6-sol',
      'openai/gpt-6-luna',
      'openai-codex/gpt-6-sol',
      'openai-codex/gpt-6-luna',
      'xai/grok-4.7',
      'xai/grok-4.3',
    ]
    const checked: string[] = []
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        const ref = `${providerId}/${modelId}`
        if (!catalogAligned.includes(ref)) continue
        checked.push(ref)
        const builtin: Model<KnownApi> | undefined = getBuiltinModel(providerId as never, modelId as never)
        expect(builtin, `${ref} in pi-ai catalog`).toBeDefined()
        const upstreamCompat: Record<string, unknown> = { ...builtin?.compat }
        delete upstreamCompat.allowedFallbackModels
        delete upstreamCompat.supportsStrictTools
        expect(model.api, `${ref} API drift`).toBe(builtin?.api)
        expect('compat' in model ? model.compat : {}, `${ref} compat drift`).toEqual(upstreamCompat)
        expect('thinkingLevelMap' in model ? model.thinkingLevelMap : undefined, `${ref} thinking map drift`).toEqual(
          builtin?.thinkingLevelMap,
        )
      }
    }
    expect(checked.sort()).toEqual([...catalogAligned].sort())
  })

  // Anthropic server-side fallback (`compat.allowedFallbackModels`) makes pi
  // send `fallbacks`, so a refused request is answered and billed by another
  // model. No curated record may opt into that silently.
  test('no curated record enables server-side model fallback', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        const compat = 'compat' in model ? model.compat : undefined
        expect(compat !== undefined && 'allowedFallbackModels' in compat, `${providerId}/${modelId}`).toBe(false)
      }
    }
  })

  test('apiKeyEnv is set on every api-key-capable provider and null on oauth-only', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      if (supportsApiKey(provider)) {
        expect(provider.apiKeyEnv, `${providerId} missing apiKeyEnv`).not.toBeNull()
      } else {
        expect(provider.apiKeyEnv, `${providerId} oauth-only but has apiKeyEnv`).toBeNull()
      }
    }
  })

  test('oauthProviderId is set on every oauth-capable provider and null on api-key-only', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      if (supportsOAuth(provider)) {
        expect(provider.oauthProviderId, `${providerId} missing oauthProviderId`).not.toBeNull()
      } else {
        expect(provider.oauthProviderId, `${providerId} api-key-only but has oauthProviderId`).toBeNull()
      }
    }
  })

  test('zai (general API) is api-key only and uses the paygo endpoint', () => {
    const zai = KNOWN_PROVIDERS.zai
    expect(zai.baseUrl).toBe('https://api.z.ai/api/paas/v4')
    expect(zai.apiKeyEnv).toBe('ZAI_API_KEY')
    expect(supportsApiKey(zai)).toBe(true)
    expect(supportsOAuth(zai)).toBe(false)
  })

  test('zai-coding (Coding Plan) is api-key only and uses the coding endpoint', () => {
    const zaiCoding = KNOWN_PROVIDERS['zai-coding']
    expect(zaiCoding.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(zaiCoding.apiKeyEnv).toBe('ZAI_CODING_API_KEY')
    expect(supportsApiKey(zaiCoding)).toBe(true)
    expect(supportsOAuth(zaiCoding)).toBe(false)
  })

  test('zai and zai-coding use distinct env vars so users can hold both keys', () => {
    expect(KNOWN_PROVIDERS.zai.apiKeyEnv).not.toBe(KNOWN_PROVIDERS['zai-coding'].apiKeyEnv)
  })

  test('zai and zai-coding use distinct base URLs so paygo keys cannot accidentally hit the coding endpoint', () => {
    expect(KNOWN_PROVIDERS.zai.baseUrl).not.toBe(KNOWN_PROVIDERS['zai-coding'].baseUrl)
  })

  test('zai-coding only ships models the Coding Plan officially supports', () => {
    const codingPlanSupported = new Set(['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'])
    for (const modelId of Object.keys(KNOWN_PROVIDERS['zai-coding'].models)) {
      expect(codingPlanSupported.has(modelId), `${modelId} is not officially Coding-Plan-supported`).toBe(true)
    }
  })

  test('minimax is a single api-key provider serving both paygo and Token Plan keys', () => {
    const minimax = KNOWN_PROVIDERS.minimax
    expect(minimax.baseUrl).toBe('https://api.minimax.io/v1')
    expect(minimax.apiKeyEnv).toBe('MINIMAX_API_KEY')
    expect(supportsApiKey(minimax)).toBe(true)
    expect(supportsOAuth(minimax)).toBe(false)
  })

  test('every minimax model uses the openai-completions api so pi-ai routes correctly', () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.minimax.models)) {
      expect(model.api, `minimax/${modelId} api drift`).toBe('openai-completions')
    }
  })

  test('minimax ships the M3 flagship plus the M2 series', () => {
    const modelIds = Object.keys(KNOWN_PROVIDERS.minimax.models)
    expect(modelIds).toContain('MiniMax-M3')
    expect(modelIds).toContain('MiniMax-M2')
    expect(modelIds).toContain('MiniMax-M2.5')
  })

  test('only MiniMax-M3 accepts image input; the M2 series is text-only', () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.minimax.models)) {
      const expectsImage = modelId === 'MiniMax-M3'
      expect((model.input as ReadonlyArray<string>).includes('image'), `minimax/${modelId} vision drift`).toBe(
        expectsImage,
      )
    }
  })

  test('minimax cache rates match the published pay-as-you-go pricing table', () => {
    // ≤512K standard tier from docs/guides/pricing-paygo; M3 has no cache-write rate.
    const expectedCache: Record<string, { cacheRead: number; cacheWrite: number }> = {
      'MiniMax-M3': { cacheRead: 0.06, cacheWrite: 0 },
      'MiniMax-M2.7': { cacheRead: 0.06, cacheWrite: 0.375 },
      'MiniMax-M2.5': { cacheRead: 0.03, cacheWrite: 0.375 },
      'MiniMax-M2.1': { cacheRead: 0.03, cacheWrite: 0.375 },
      'MiniMax-M2': { cacheRead: 0.03, cacheWrite: 0.375 },
    }
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.minimax.models)) {
      const cost = model.cost as { cacheRead: number; cacheWrite: number }
      expect(cost.cacheRead, `minimax/${modelId} cacheRead drift`).toBe(expectedCache[modelId]!.cacheRead)
      expect(cost.cacheWrite, `minimax/${modelId} cacheWrite drift`).toBe(expectedCache[modelId]!.cacheWrite)
    }
  })

  test('deepseek is a single api-key provider on the bare api.deepseek.com base url', () => {
    const deepseek = KNOWN_PROVIDERS.deepseek
    expect(deepseek.baseUrl).toBe('https://api.deepseek.com')
    expect(deepseek.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
    expect(supportsApiKey(deepseek)).toBe(true)
    expect(supportsOAuth(deepseek)).toBe(false)
  })

  test('every deepseek model uses the openai-completions api so pi-ai routes correctly', () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.deepseek.models)) {
      expect(model.api, `deepseek/${modelId} api drift`).toBe('openai-completions')
    }
  })

  test('deepseek ships the V4 flash and pro models, text-only', () => {
    const models = KNOWN_PROVIDERS.deepseek.models
    expect(Object.keys(models)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    for (const [modelId, model] of Object.entries(models)) {
      expect((model.input as ReadonlyArray<string>).includes('image'), `deepseek/${modelId} should be text-only`).toBe(
        false,
      )
    }
  })

  test('deepseek input cost encodes the cache-miss rate and cacheRead the cache-hit rate', () => {
    const expected: Record<string, { input: number; output: number; cacheRead: number }> = {
      'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.0028 },
      'deepseek-v4-pro': { input: 0.435, output: 0.87, cacheRead: 0.003625 },
    }
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.deepseek.models)) {
      const cost = model.cost as { input: number; output: number; cacheRead: number; cacheWrite: number }
      expect(cost.input, `deepseek/${modelId} input drift`).toBe(expected[modelId]!.input)
      expect(cost.output, `deepseek/${modelId} output drift`).toBe(expected[modelId]!.output)
      expect(cost.cacheRead, `deepseek/${modelId} cacheRead drift`).toBe(expected[modelId]!.cacheRead)
      expect(cost.cacheWrite, `deepseek/${modelId} has no published cache-write surcharge`).toBe(0)
    }
  })

  test('upstage is a single api-key provider on the OpenAI-compatible /v1 base url', () => {
    const upstage = KNOWN_PROVIDERS.upstage
    expect(upstage.baseUrl).toBe('https://api.upstage.ai/v1')
    expect(upstage.apiKeyEnv).toBe('UPSTAGE_API_KEY')
    expect(supportsApiKey(upstage)).toBe(true)
    expect(supportsOAuth(upstage)).toBe(false)
  })

  test('every upstage model uses the openai-completions api so pi-ai routes correctly', () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.upstage.models)) {
      expect(model.api, `upstage/${modelId} api drift`).toBe('openai-completions')
    }
  })

  test('upstage ships the Solar chat lineup plus the open-weight solar-open2, text-only, syn-pro omitted', () => {
    const models = KNOWN_PROVIDERS.upstage.models
    expect(Object.keys(models)).toEqual(['solar-pro4', 'solar-open2', 'solar-pro3', 'solar-pro2', 'solar-mini'])
    expect(Object.keys(models)).not.toContain('syn-pro')
    for (const [modelId, model] of Object.entries(models)) {
      expect((model.input as ReadonlyArray<string>).includes('image'), `upstage/${modelId} should be text-only`).toBe(
        false,
      )
    }
  })

  test('solar-open2 carries no published price yet (partner-program access)', () => {
    const cost = KNOWN_PROVIDERS.upstage.models['solar-open2']!.cost as {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }
    expect(cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  test('every upstage model pins compat to Upstage\u2019s documented openai-completions surface', () => {
    // pi-ai does not auto-detect api.upstage.ai, so each model must carry compat
    // that disables the OpenAI-native fields Upstage does not document: the
    // `developer` role, `store`, `max_completion_tokens`, and streaming usage.
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.upstage.models)) {
      const compat = (model as { compat?: Record<string, unknown> }).compat
      expect(compat, `upstage/${modelId} missing compat`).toBeDefined()
      expect(compat!.supportsDeveloperRole, `upstage/${modelId} must not use the developer role`).toBe(false)
      expect(compat!.supportsStore, `upstage/${modelId} must not send store`).toBe(false)
      expect(compat!.maxTokensField, `upstage/${modelId} must send max_tokens`).toBe('max_tokens')
      expect(compat!.supportsUsageInStreaming, `upstage/${modelId} streaming usage is undocumented`).toBe(false)
      expect(compat!.supportsStrictMode, `upstage/${modelId} must not send strict on tool defs`).toBe(false)
    }
  })

  test('upstage reasoning_effort support tracks each model\u2019s documented behavior', () => {
    const models = KNOWN_PROVIDERS.upstage.models
    const compatFor = (id: keyof typeof models) =>
      (models[id] as { compat?: { supportsReasoningEffort?: boolean } }).compat
    // solar-pro4/pro3/pro2 and the solar-open2 template document reasoning_effort; solar-mini ignores it.
    expect(compatFor('solar-pro4')!.supportsReasoningEffort).toBe(true)
    expect(compatFor('solar-open2')!.supportsReasoningEffort).toBe(true)
    expect(compatFor('solar-pro3')!.supportsReasoningEffort).toBe(true)
    expect(compatFor('solar-pro2')!.supportsReasoningEffort).toBe(true)
    expect(compatFor('solar-mini')!.supportsReasoningEffort).toBe(false)
    expect(models['solar-mini']!.reasoning, 'solar-mini does not reason').toBe(false)
  })

  test('the reasoning-off-by-default models clamp pi\u2019s xhigh to their documented max reasoning_effort=high', () => {
    const models = KNOWN_PROVIDERS.upstage.models
    for (const id of ['solar-pro3', 'solar-pro2'] as const) {
      const map = (models[id] as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap
      expect(map, `upstage/${id} missing thinkingLevelMap`).toBeDefined()
      // These two only accept medium/high as reasoning-on; xhigh must not leak through
      // and minimal/low would disable reasoning, so pi's enabled levels floor at medium.
      expect(map!.xhigh, `upstage/${id} must clamp xhigh -> high`).toBe('high')
      expect(map!.off, `upstage/${id} must omit reasoning_effort when off`).toBeNull()
      expect(map!.minimal, `upstage/${id} must floor minimal at medium`).toBe('medium')
      expect(map!.low, `upstage/${id} must floor low at medium`).toBe('medium')
    }
    expect(
      (models['solar-mini'] as { thinkingLevelMap?: unknown }).thinkingLevelMap,
      'solar-mini needs no map (never sends reasoning_effort)',
    ).toBeUndefined()
  })

  test('the reasoning-on-by-default models pass xhigh through natively instead of clamping it', () => {
    for (const id of ['solar-pro4', 'solar-open2'] as const) {
      const map = (KNOWN_PROVIDERS.upstage.models[id] as { thinkingLevelMap?: Record<string, string | null> })
        .thinkingLevelMap
      expect(map, `upstage/${id} missing thinkingLevelMap`).toBeDefined()
      expect(map!.xhigh, `upstage/${id} documents xhigh, so it must not be clamped to high`).toBe('xhigh')
      // Upstage's `minimal` disables reasoning, so pi's enabled `minimal` floors at `low`.
      expect(map!.minimal, `upstage/${id} must floor minimal at the lowest reasoning-on level`).toBe('low')
      for (const level of ['low', 'medium', 'high'] as const) {
        expect(map![level], `upstage/${id} level ${level} must pass through unchanged`).toBe(level)
      }
    }
  })

  test('the reasoning-on-by-default models disable reasoning with an explicit none, not by omission', () => {
    // Upstage documents pro4 and open2 as reasoning when reasoning_effort is
    // omitted, with `none` as the off switch — inverted from pro3/pro2, where off
    // is null so pi-ai omits the field. A null here would silently reason on
    // every turn, which is a latency and billing bug rather than a hard failure.
    for (const id of ['solar-pro4', 'solar-open2'] as const) {
      const map = (KNOWN_PROVIDERS.upstage.models[id] as { thinkingLevelMap?: Record<string, string | null> })
        .thinkingLevelMap
      expect(map!.off, `upstage/${id} must send reasoning_effort=none to turn reasoning off`).toBe('none')
    }
  })

  test('anthropic supports both api-key and oauth on the same provider id', () => {
    const anthropic = KNOWN_PROVIDERS.anthropic
    expect(anthropic.baseUrl).toBe('https://api.anthropic.com')
    expect(anthropic.apiKeyEnv).toBe('ANTHROPIC_API_KEY')
    expect(anthropic.oauthProviderId).toBe('anthropic')
    expect(supportsApiKey(anthropic)).toBe(true)
    expect(supportsOAuth(anthropic)).toBe(true)
  })

  test('every anthropic model uses the anthropic-messages api so pi-ai routes correctly', () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.anthropic.models)) {
      expect(model.api, `anthropic/${modelId} api drift`).toBe('anthropic-messages')
    }
  })

  test('moonshot (Open Platform paygo) is api-key only on the OpenAI-compatible endpoint', () => {
    const moonshot = KNOWN_PROVIDERS.moonshot
    expect(moonshot.baseUrl).toBe('https://api.moonshot.ai/v1')
    expect(moonshot.apiKeyEnv).toBe('MOONSHOT_API_KEY')
    expect(supportsApiKey(moonshot)).toBe(true)
    expect(supportsOAuth(moonshot)).toBe(false)
  })

  test('moonshot-coding (Kimi Code subscription) is api-key only on the Kimi Code endpoint', () => {
    const coding = KNOWN_PROVIDERS['moonshot-coding']
    expect(coding.baseUrl).toBe('https://api.kimi.com/coding/v1')
    expect(coding.apiKeyEnv).toBe('MOONSHOT_CODING_API_KEY')
    expect(supportsApiKey(coding)).toBe(true)
    expect(supportsOAuth(coding)).toBe(false)
  })

  test('moonshot and moonshot-coding use distinct env vars so users can hold both keys', () => {
    expect(KNOWN_PROVIDERS.moonshot.apiKeyEnv).not.toBe(KNOWN_PROVIDERS['moonshot-coding'].apiKeyEnv)
  })

  test('moonshot and moonshot-coding use distinct base URLs so paygo keys cannot hit the coding endpoint', () => {
    expect(KNOWN_PROVIDERS.moonshot.baseUrl).not.toBe(KNOWN_PROVIDERS['moonshot-coding'].baseUrl)
  })

  test('every moonshot model uses the openai-completions api so pi-ai routes correctly', () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.moonshot.models)) {
      expect(model.api, `moonshot/${modelId} api drift`).toBe('openai-completions')
    }
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS['moonshot-coding'].models)) {
      expect(model.api, `moonshot-coding/${modelId} api drift`).toBe('openai-completions')
    }
  })

  test('moonshot ships the current multimodal K2 generation (deprecated k2 series omitted)', () => {
    const modelIds = Object.keys(KNOWN_PROVIDERS.moonshot.models)
    expect(modelIds).toEqual(['kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5'])
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.moonshot.models)) {
      expect((model.input as ReadonlyArray<string>).includes('image'), `moonshot/${modelId} vision drift`).toBe(true)
    }
  })

  test('moonshot omits the kimi-k2 series discontinued on 2026-05-25', () => {
    const modelIds = Object.keys(KNOWN_PROVIDERS.moonshot.models)
    expect(modelIds).not.toContain('kimi-k2-thinking')
    expect(modelIds).not.toContain('kimi-k2-0905-preview')
    expect(modelIds).not.toContain('kimi-k2-turbo-preview')
  })

  test('moonshot-coding ships only the kimi-for-coding alias billed at zero per-token', () => {
    const models = KNOWN_PROVIDERS['moonshot-coding'].models
    expect(Object.keys(models)).toEqual(['kimi-for-coding'])
    const cost = models['kimi-for-coding']!.cost as { input: number; output: number }
    expect(cost.input).toBe(0)
    expect(cost.output).toBe(0)
  })

  test('xai supports both api-key and oauth against the native x.ai endpoint', () => {
    const xai = KNOWN_PROVIDERS.xai
    expect(xai.baseUrl).toBe('https://api.x.ai/v1')
    expect(xai.apiKeyEnv).toBe('XAI_API_KEY')
    expect(xai.oauthProviderId).toBe('xai')
    expect(supportsApiKey(xai)).toBe(true)
    expect(supportsOAuth(xai)).toBe(true)
  })

  test('keeps un-cataloged xai snapshot models on the established Completions transport', () => {
    expect(KNOWN_PROVIDERS.xai.models['grok-4.7'].api).toBe('openai-responses')
    expect(KNOWN_PROVIDERS.xai.models['grok-4.3'].api).toBe('openai-responses')
    for (const id of ['grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-build-0.1'] as const) {
      expect(KNOWN_PROVIDERS.xai.models[id].api).toBe('openai-completions')
    }
  })

  test('uses pi-ai’s 30K Grok 4.3 output cap', () => {
    expect(KNOWN_PROVIDERS.xai.models['grok-4.3'].maxTokens).toBe(30000)
  })

  test('opengateway is a single api-key provider on the OpenAI-compatible gateway endpoint', () => {
    const opengateway = KNOWN_PROVIDERS.opengateway
    expect(opengateway.baseUrl).toBe('https://apis.opengateway.ai/v1')
    expect(opengateway.apiKeyEnv).toBe('OPENGATEWAY_API_KEY')
    expect(supportsApiKey(opengateway)).toBe(true)
    expect(supportsOAuth(opengateway)).toBe(false)
  })

  test('opengateway static floor is exactly one offline anchor', () => {
    expect(Object.keys(KNOWN_PROVIDERS.opengateway.models)).toEqual(['openai/gpt-5.4-nano'])
  })

  test('opengateway anchor is creator-qualified', () => {
    expect(Object.keys(KNOWN_PROVIDERS.opengateway.models)[0]).toMatch(/^[a-z0-9-]+\/.+/)
  })

  test('opengateway model refs round-trip through providerForModelRef despite the second slash', () => {
    for (const modelId of Object.keys(KNOWN_PROVIDERS.opengateway.models)) {
      const ref = `opengateway/${modelId}`
      expect(providerForModelRef(ref), `${ref} misrouted`).toBe('opengateway')
      expect(isModelRef(ref), `${ref} rejected by isModelRef`).toBe(true)
    }
  })

  test('opengateway anchor pins the gateway transport and compat', () => {
    // Without this, pi-ai's baseUrl sniffing treats apis.opengateway.ai as a
    // first-party OpenAI endpoint and sends `store`, the `developer` role,
    // `strict` tool schemas, and max_completion_tokens through to Anthropic and
    // Moonshot upstreams.
    const anchor = KNOWN_PROVIDERS.opengateway.models['openai/gpt-5.4-nano']
    const compat = anchor.compat as Record<string, unknown>
    expect(anchor.api).toBe('openai-completions')
    expect(compat.supportsStore).toBe(false)
    expect(compat.supportsDeveloperRole).toBe(false)
    expect(compat.supportsReasoningEffort).toBe(false)
    expect(compat.supportsStrictMode).toBe(false)
    expect(compat.maxTokensField).toBe('max_tokens')
    expect(compat.supportsUsageInStreaming).toBeUndefined()
  })

  test('no opengateway model declares a thinkingLevelMap', () => {
    // supportsReasoningEffort is false, so a level map would advertise a
    // control contract the gateway never receives.
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.opengateway.models)) {
      expect(
        (model as { thinkingLevelMap?: unknown }).thinkingLevelMap,
        `opengateway/${modelId} maps thinking levels it cannot send`,
      ).toBeUndefined()
    }
  })

  test('opengateway anchor cost matches the documented offline snapshot', () => {
    expect(KNOWN_PROVIDERS.opengateway.models['openai/gpt-5.4-nano'].cost).toEqual({
      input: 0.2,
      output: 1.25,
      cacheRead: 0.02,
      cacheWrite: 0,
    })
  })
})

describe('KNOWN_PROVIDER_VENDORS', () => {
  test('every vendor references only known provider ids', () => {
    for (const vendorId of listKnownProviderVendorIds()) {
      for (const providerId of providerIdsForVendor(vendorId)) {
        expect(providerId in KNOWN_PROVIDERS, `${vendorId} references unknown provider ${providerId}`).toBe(true)
      }
    }
  })

  test('every known provider belongs to exactly one vendor (full partition)', () => {
    const assigned = new Map<KnownProviderId, number>()
    for (const vendorId of listKnownProviderVendorIds()) {
      for (const providerId of providerIdsForVendor(vendorId)) {
        assigned.set(providerId, (assigned.get(providerId) ?? 0) + 1)
      }
    }
    for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
      expect(assigned.get(providerId), `${providerId} not assigned to exactly one vendor`).toBe(1)
    }
  })

  test('vendorForProviderId is the inverse of providerIdsForVendor', () => {
    for (const vendorId of listKnownProviderVendorIds()) {
      for (const providerId of providerIdsForVendor(vendorId)) {
        expect(vendorForProviderId(providerId)).toBe(vendorId)
      }
    }
  })

  test('multi-provider vendors supply variant copy for each of their providers', () => {
    for (const vendorId of listKnownProviderVendorIds()) {
      const providers = providerIdsForVendor(vendorId)
      if (providers.length < 2) continue
      for (const providerId of providers) {
        expect(variantLabel(vendorId, providerId), `${vendorId}/${providerId} missing variant label`).not.toBe(
          KNOWN_PROVIDERS[providerId].name,
        )
      }
    }
  })

  test('OpenAI vendor splits API key (openai) from ChatGPT OAuth (openai-codex)', () => {
    expect(providerIdsForVendor('openai')).toEqual(['openai', 'openai-codex'])
    expect(variantLabel('openai', 'openai')).toBe('API key')
    expect(variantLabel('openai', 'openai-codex')).toBe('OAuth (ChatGPT Plus/Pro)')
  })

  test('Z.AI vendor splits paygo (zai) from Coding Plan (zai-coding)', () => {
    expect(providerIdsForVendor('zai')).toEqual(['zai', 'zai-coding'])
    expect(variantLabel('zai', 'zai')).toBe('Pay-as-you-go')
    expect(variantLabel('zai', 'zai-coding')).toBe('Coding Plan')
  })

  test('Anthropic, Fireworks, and xAI are single-provider vendors (no variant step)', () => {
    expect(providerIdsForVendor('anthropic')).toEqual(['anthropic'])
    expect(providerIdsForVendor('fireworks')).toEqual(['fireworks'])
    expect(providerIdsForVendor('xai')).toEqual(['xai'])
  })

  test('xAI vendor resolves to the single dual-auth xai provider', () => {
    expect(vendorForProviderId('xai')).toBe('xai')
    expect(KNOWN_PROVIDER_VENDORS.xai.name).toBe('xAI (Grok)')
  })

  test('MiniMax is a single-provider vendor: paygo and Token Plan share one provider id', () => {
    expect(providerIdsForVendor('minimax')).toEqual(['minimax'])
    expect(vendorForProviderId('minimax')).toBe('minimax')
  })

  test('DeepSeek is a single-provider vendor (no variant step)', () => {
    expect(providerIdsForVendor('deepseek')).toEqual(['deepseek'])
    expect(vendorForProviderId('deepseek')).toBe('deepseek')
  })

  test('Upstage is a single-provider vendor (no variant step)', () => {
    expect(providerIdsForVendor('upstage')).toEqual(['upstage'])
    expect(vendorForProviderId('upstage')).toBe('upstage')
  })

  test('OpenGateway is a single-provider vendor listed after the labs it proxies', () => {
    expect(providerIdsForVendor('opengateway')).toEqual(['opengateway'])
    expect(vendorForProviderId('opengateway')).toBe('opengateway')
    const vendorIds = listKnownProviderVendorIds()
    expect(vendorIds[vendorIds.length - 1]).toBe('opengateway')
  })

  test('opengateway does not join the OpenAI family even though it proxies OpenAI models', () => {
    expect(isOpenAiFamilyRef('opengateway/openai/gpt-5.5')).toBe(false)
  })

  test('Moonshot vendor splits paygo (moonshot) from Coding Plan (moonshot-coding)', () => {
    expect(providerIdsForVendor('moonshot')).toEqual(['moonshot', 'moonshot-coding'])
    expect(variantLabel('moonshot', 'moonshot')).toBe('Pay-as-you-go')
    expect(variantLabel('moonshot', 'moonshot-coding')).toBe('Coding Plan')
  })
})

describe('providerForModelRef', () => {
  test('routes glm-5.1 to zai-coding (not zai)', () => {
    expect(providerForModelRef('zai-coding/glm-5.1')).toBe('zai-coding')
  })

  test('routes zai/glm-4.6 to zai (not zai-coding)', () => {
    expect(providerForModelRef('zai/glm-4.6')).toBe('zai')
  })

  test('distinguishes zai from zai-coding by the slash-prefixed match (not substring)', () => {
    expect(providerForModelRef('zai-coding/glm-5')).toBe('zai-coding')
    expect(providerForModelRef('zai/glm-4.6')).toBe('zai')
  })

  test('distinguishes moonshot from moonshot-coding by the slash-prefixed match (not substring)', () => {
    expect(providerForModelRef('moonshot-coding/kimi-for-coding')).toBe('moonshot-coding')
    expect(providerForModelRef('moonshot/kimi-k2.6')).toBe('moonshot')
  })
})

describe('model ref predicates', () => {
  test('isKnownModelRef accepts curated refs only', () => {
    expect(isKnownModelRef('openai/gpt-5.4-nano')).toBe(true)
    expect(isKnownModelRef('openai/gpt-6-live')).toBe(false)
  })

  test('isModelRef accepts custom refs for known providers', () => {
    expect(isModelRef('openai/gpt-6-live')).toBe(true)
    expect(isModelRef('fireworks/accounts/fireworks/models/qwen3-next')).toBe(true)
  })

  test('isModelRef rejects unknown providers and malformed refs', () => {
    expect(isModelRef('unknown/gpt-6-live')).toBe(false)
    expect(isModelRef('openai/')).toBe(false)
    expect(isModelRef('OpenAI/gpt-6-live')).toBe(false)
    expect(isModelRef('openai/gpt 6')).toBe(false)
  })
})

describe('listKnownModelRefs', () => {
  test('includes both zai and zai-coding models', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('zai/glm-4.6')
    expect(refs).toContain('zai-coding/glm-5.1')
  })

  test('includes GPT-6 Sol and Luna for API-key and Codex OAuth routing', () => {
    const refs = listKnownModelRefs()
    const expected = [
      ['openai/gpt-6-sol', 'openai'],
      ['openai/gpt-6-luna', 'openai'],
      ['openai-codex/gpt-6-sol', 'openai-codex'],
      ['openai-codex/gpt-6-luna', 'openai-codex'],
    ] as const
    for (const [ref, providerId] of expected) {
      expect(refs).toContain(ref)
      expect(providerForModelRef(ref)).toBe(providerId)
    }
  })

  test('includes minimax model refs', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('minimax/MiniMax-M3')
    expect(refs).toContain('minimax/MiniMax-M2')
  })

  test('includes deepseek model refs', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('deepseek/deepseek-v4-flash')
    expect(refs).toContain('deepseek/deepseek-v4-pro')
  })

  test('includes upstage Solar model refs', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('upstage/solar-pro4')
    expect(refs).toContain('upstage/solar-open2')
    expect(refs).toContain('upstage/solar-pro3')
    expect(refs).toContain('upstage/solar-pro2')
    expect(refs).toContain('upstage/solar-mini')
  })

  test('includes both moonshot and moonshot-coding model refs', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('moonshot/kimi-k2.7-code')
    expect(refs).toContain('moonshot/kimi-k2.5')
    expect(refs).toContain('moonshot-coding/kimi-for-coding')
  })

  test('includes the current Anthropic GA tier (Haiku 4.5 / Sonnet 4.6 / Sonnet 5 / Opus 4.7 / Opus 4.8 / Fable 5)', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('anthropic/claude-haiku-4-5')
    expect(refs).toContain('anthropic/claude-sonnet-4-6')
    expect(refs).toContain('anthropic/claude-sonnet-5')
    expect(refs).toContain('anthropic/claude-opus-4-7')
    expect(refs).toContain('anthropic/claude-opus-4-8')
    expect(refs).toContain('anthropic/claude-fable-5')
  })

  test('maps Opus 5.5 to its supported adaptive efforts and never to disabled thinking', () => {
    const model = KNOWN_PROVIDERS.anthropic.models['claude-opus-5-5']
    expect(clampThinkingLevel(model, 'off')).not.toBe('off')
    expect(getSupportedThinkingLevels(model)).toContain('max')
    expect(clampThinkingLevel(model, 'max')).toBe('max')
  })

  test('sends every offered GPT-6 effort on the wire, off as none, through max', async () => {
    for (const model of [KNOWN_PROVIDERS.openai.models['gpt-6-sol'], KNOWN_PROVIDERS.openai.models['gpt-6-luna']]) {
      expect(getSupportedThinkingLevels(model)).toContain('off')
      expect(getSupportedThinkingLevels(model)).not.toContain('minimal')
      expect(getSupportedThinkingLevels(model)).toContain('max')
      expect(clampThinkingLevel(model, 'minimal')).toBe('low')
      expect(clampThinkingLevel(model, 'max')).toBe('max')
      for (const level of getSupportedThinkingLevels(model)) {
        const payload = await captureRequest(streamResponses, model, 'sk-test', level)
        expect(payload?.reasoning).toMatchObject({ effort: level === 'off' ? 'none' : level })
      }
    }
    for (const model of [
      KNOWN_PROVIDERS['openai-codex'].models['gpt-6-sol'],
      KNOWN_PROVIDERS['openai-codex'].models['gpt-6-luna'],
    ]) {
      expect(model.thinkingLevelMap?.minimal).toBe('low')
      expect(model.thinkingLevelMap?.max).toBe('max')
    }
  })

  // pi 0.87's Codex transport sends `off` as effort none (pi 0.73.1 dropped
  // the field and ran the backend default), so every level reaches the wire.
  test('sends every Codex GPT-6 level as an explicit reasoning effort', async () => {
    const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } }
    const apiKey = `e30.${btoa(JSON.stringify(claims))}.sig`
    for (const id of ['gpt-6-sol', 'gpt-6-luna'] as const) {
      const model = KNOWN_PROVIDERS['openai-codex'].models[id]
      expect(getSupportedThinkingLevels(model)).toContain('off')
      for (const level of getSupportedThinkingLevels(model)) {
        const payload = await captureRequest(streamCodexResponses, model, apiKey, level)
        expect(payload?.model).toBe(id)
        expect(payload?.reasoning).toMatchObject({ effort: model.thinkingLevelMap?.[level] })
      }
    }
  })

  // On pi 0.87 Grok 4.7 runs on Responses, which carries reasoning.effort.
  // `off`, `minimal` and `max` are not xAI efforts, so they clamp onto real levels.
  test('sends Grok 4.7 efforts through Responses reasoning.effort', async () => {
    const model = KNOWN_PROVIDERS.xai.models['grok-4.7']
    expect(getSupportedThinkingLevels(model)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(clampThinkingLevel(model, 'off')).toBe('low')
    expect(clampThinkingLevel(model, 'minimal')).toBe('low')
    expect(clampThinkingLevel(model, 'max')).toBe('xhigh')
    for (const level of getSupportedThinkingLevels(model)) {
      const payload = await captureRequest(streamResponses, model, 'xai-test', level)
      expect(payload?.model).toBe('grok-4.7')
      expect(payload?.reasoning).toMatchObject({ effort: level })
    }
  })

  test('does not list the limited-availability claude-mythos-5', () => {
    const refs = listKnownModelRefs()
    expect(refs).not.toContain('anthropic/claude-mythos-5')
  })

  test('includes the current xai Grok models', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('xai/grok-4.3')
    expect(refs).toContain('xai/grok-4.7')
    expect(refs).toContain('xai/grok-4.20-0309-reasoning')
    expect(refs).toContain('xai/grok-4.20-0309-non-reasoning')
    expect(refs).toContain('xai/grok-build-0.1')
  })

  test('does not list xai models retired on 2026-05-15', () => {
    const refs = listKnownModelRefs()
    expect(refs).not.toContain('xai/grok-4-fast')
    expect(refs).not.toContain('xai/grok-4')
    expect(refs).not.toContain('xai/grok-code-fast-1')
  })
})

describe('providerForModelRef anthropic', () => {
  test('routes claude-sonnet-4-6 to anthropic', () => {
    expect(providerForModelRef('anthropic/claude-sonnet-4-6')).toBe('anthropic')
  })

  test('routes claude-opus-4-7 to anthropic', () => {
    expect(providerForModelRef('anthropic/claude-opus-4-7')).toBe('anthropic')
  })

  test('routes claude-opus-4-8 to anthropic', () => {
    expect(providerForModelRef('anthropic/claude-opus-4-8')).toBe('anthropic')
  })

  test('routes claude-sonnet-5 to anthropic', () => {
    expect(providerForModelRef('anthropic/claude-sonnet-5')).toBe('anthropic')
  })

  test('routes claude-fable-5 to anthropic', () => {
    expect(providerForModelRef('anthropic/claude-fable-5')).toBe('anthropic')
  })
})

describe('isOpenAiFamilyRef', () => {
  test('tracks every provider in the OpenAI vendor family', () => {
    expect(isOpenAiFamilyRef('openai/gpt-5.4-nano')).toBe(true)
    expect(isOpenAiFamilyRef('openai-codex/gpt-5.5')).toBe(true)
    expect(isOpenAiFamilyRef('anthropic/claude-opus-4-7')).toBe(false)
  })
})

describe('defaultThinkingLevelForRef', () => {
  test('OpenAI-family models no longer pin low; they defer to the SDK default', () => {
    expect(defaultThinkingLevelForRef('openai/gpt-5.4-nano')).toBeUndefined()
    expect(defaultThinkingLevelForRef('openai/gpt-5.5')).toBeUndefined()
    expect(defaultThinkingLevelForRef('openai-codex/gpt-5.4')).toBeUndefined()
    expect(defaultThinkingLevelForRef('openai-codex/gpt-5.5')).toBeUndefined()
  })

  test('non-OpenAI providers defer to the SDK default (returns undefined)', () => {
    expect(defaultThinkingLevelForRef('anthropic/claude-opus-4-8')).toBeUndefined()
    expect(defaultThinkingLevelForRef('anthropic/claude-sonnet-5')).toBeUndefined()
    expect(defaultThinkingLevelForRef('anthropic/claude-fable-5')).toBeUndefined()
    expect(defaultThinkingLevelForRef('zai/glm-4.6')).toBeUndefined()
    expect(defaultThinkingLevelForRef('moonshot/kimi-k2.5')).toBeUndefined()
  })

  test('every known model ref defers to the SDK default (no family is pinned)', () => {
    for (const ref of listKnownModelRefs()) {
      expect(defaultThinkingLevelForRef(ref), `${ref} should defer to the SDK default`).toBeUndefined()
    }
  })
})
