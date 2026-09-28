import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { KnownApi, Model } from '@earendil-works/pi-ai'

// Authentication mechanism a provider supports. `api-key` reads a static key
// from .env (the original path); `oauth` runs a browser flow at init time and
// stores rotating credentials in secrets.json. The CLI picker uses this to ask
// "API key or OAuth?" only when both are wired up.
export type AuthMethod = 'api-key' | 'oauth'

// `apiKeyEnv` and `oauthProviderId` are both always present on the literal
// to keep `as const satisfies` narrowing easy on the consumer side; entries
// that don't apply to a given provider are set to `null` rather than omitted.
// Consumers check `auth.includes('api-key')` / `auth.includes('oauth')` to
// decide which field to consult.
type KnownProvider = {
  id: string
  name: string
  baseUrl: string
  auth: ReadonlyArray<AuthMethod>
  apiKeyEnv: string | null
  oauthProviderId: string | null
  models: Record<string, Model<KnownApi>>
}

// Curated provider + model table. Provider ids remain the allowlist for
// `typeclaw.json` refs, while the model entries are the tested defaults and
// JSON-schema autocomplete set. The init/model pickers may surface additional
// models from models.dev as long as the provider prefix is one of these ids.
//
// Adding a new model: append it to the matching provider's `models` map. Each
// model object is the literal `Model<...>` that pi-ai consumes — keep it
// faithful to pi-ai's "Custom Providers" README section
// (https://github.com/earendil-works/pi/tree/main/packages/ai#custom-providers).
// `setRuntimeApiKey(provider, key)` keys off the `provider` field, so it MUST
// match the outer provider id.
//
// Adding a new provider: add a top-level entry. Set `auth` to the supported
// methods. For `api-key` providers, `apiKeyEnv` is the .env var typeclaw
// writes at init and reads at boot (match the upstream provider's standard,
// e.g. `OPENAI_API_KEY`). For `oauth` providers, `oauthProviderId` MUST match
// a pi-ai OAuth provider id exactly, otherwise the provider login lookup fails.
//
// Granularity rule (split vs merge): a provider id is the runtime API surface,
// not the brand. Different API call => different provider id; same API call =>
// same provider id. "Same API call" means same endpoint + same wire transport.
// So `anthropic` is ONE id because api-key and oauth hit the same
// /v1/messages endpoint (only the auth header differs), while `openai` /
// `openai-codex` and `zai` / `zai-coding` are SEPARATE ids because each pair
// targets different endpoints (and env vars). The user-facing brand grouping
// lives in `KNOWN_PROVIDER_VENDORS` below — keep it out of this decision.
// Renaming an id is a breaking change to secrets.json keys and typeclaw.json
// model refs; only do it behind a migration in a dedicated major-version PR.
export const KNOWN_PROVIDERS = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    // OpenAI's library auto-detects this from `provider: 'openai'`, but we
    // store it explicitly so the init wizard can show users which endpoint
    // their key will hit.
    baseUrl: 'https://api.openai.com/v1',
    auth: ['api-key'],
    apiKeyEnv: 'OPENAI_API_KEY',
    oauthProviderId: null,
    // Costs and context windows mirror models.dev as of 2026-05-10; the GPT-6
    // Sol/Luna records mirror OpenAI's model docs as of 2026-09-22.
    // GPT-6 bills cache writes at 1.25x input; pi 0.87's Responses transport
    // reads cache_write_tokens (openai-responses-shared.js), so that rate is
    // applied. The >272K-input 2x/1.5x tier is not expressible in TypeClaw's
    // flat cost shape, so these records use the standard rate. When
    // refreshing, also rerun `scripts/generate-schema.ts` so
    // typeclaw.schema.json picks up new enum values.
    models: {
      // Default. Cheapest tool-calling reasoning model in the family;
      // available on every paid OpenAI account tier.
      'gpt-5.4-nano': {
        id: 'gpt-5.4-nano',
        name: 'GPT-5.4 nano',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
        contextWindow: 400000,
        maxTokens: 128000,
      },
      'gpt-5.4-mini': {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 mini',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
        contextWindow: 400000,
        maxTokens: 128000,
      },
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
        contextWindow: 1050000,
        maxTokens: 128000,
      },
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
        contextWindow: 1050000,
        maxTokens: 128000,
      },
      // GPT-6 Sol and Luna use Responses because Chat Completions accepts tools
      // only at effort `none`. The full map and compat are pi-ai 0.87.1's
      // catalog values, preserving every documented effort through `max`.
      'gpt-6-sol': {
        id: 'gpt-6-sol',
        name: 'GPT-6 Sol',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        contextWindow: 1050000,
        maxTokens: 128000,
        thinkingLevelMap: {
          off: 'none',
          minimal: null,
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
        compat: {
          supportsStrictMode: true,
          supportsOpenAIGrammarTools: true,
          supportsAdditionalTools: true,
          supportsToolSearch: true,
          supportsMidConvoSystemMessages: true,
          supportsExplicitPromptCacheMode: true,
        },
      },
      'gpt-6-luna': {
        id: 'gpt-6-luna',
        name: 'GPT-6 Luna',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
        contextWindow: 1050000,
        maxTokens: 128000,
        thinkingLevelMap: {
          off: 'none',
          minimal: null,
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
        compat: {
          supportsStrictMode: true,
          supportsOpenAIGrammarTools: true,
          supportsAdditionalTools: true,
          supportsToolSearch: true,
          supportsMidConvoSystemMessages: true,
          supportsExplicitPromptCacheMode: true,
        },
      },
    },
  },
  // ChatGPT Plus/Pro subscription via the OAuth Codex backend. No API key
  // path here on purpose — the Codex backend is OAuth-only upstream.
  //
  // pi-ai's `openai-codex` bucket carries gpt-5.5 (and 5.4) against
  // chatgpt.com/backend-api. We don't rely on that catalog: we hand pi-ai a
  // freshly-constructed `Model<>` literal via resolveModel(), bypassing its
  // built-in catalog entirely (same trick we use for kimi-k2p6-turbo). So
  // these ids work end-to-end as long as the Codex backend itself accepts
  // them, which it does for ChatGPT Plus/Pro accounts as of 2026-05-10.
  //
  // Position-load-bearing: must stay adjacent to `openai`. `provider --help`'s
  // `id | id | ...` listing and the generated JSON schema's model-ref enum
  // derive their ordering from Object.keys() iteration on this literal, so
  // alphabetizing the registry would scatter `openai-codex` after `fireworks`.
  // (The init wizard's picker no longer depends on this order — it groups by
  // `KNOWN_PROVIDER_VENDORS` below.)
  'openai-codex': {
    id: 'openai-codex',
    name: 'OpenAI Codex (ChatGPT Plus/Pro)',
    baseUrl: 'https://chatgpt.com/backend-api',
    auth: ['oauth'],
    apiKeyEnv: null,
    oauthProviderId: 'openai-codex',
    models: {
      'gpt-5.4-mini': {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 mini',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 128000,
      },
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 128000,
      },
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 128000,
      },
      // GPT-6 Sol and Luna use the documented Codex backend limits. Their
      // 0.87.1 maps preserve all valid efforts through `max`; Codex floors
      // unsupported `minimal` at `low`.
      'gpt-6-sol': {
        id: 'gpt-6-sol',
        name: 'GPT-6 Sol',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        contextWindow: 272000,
        maxTokens: 128000,
        thinkingLevelMap: {
          off: 'none',
          minimal: 'low',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
        compat: {
          supportsOpenAIGrammarTools: true,
          supportsAdditionalTools: true,
          supportsToolSearch: true,
          supportsMidConvoSystemMessages: true,
        },
      },
      'gpt-6-luna': {
        id: 'gpt-6-luna',
        name: 'GPT-6 Luna',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
        contextWindow: 272000,
        maxTokens: 128000,
        thinkingLevelMap: {
          off: 'none',
          minimal: 'low',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
        compat: {
          supportsOpenAIGrammarTools: true,
          supportsAdditionalTools: true,
          supportsToolSearch: true,
          supportsMidConvoSystemMessages: true,
        },
      },
    },
  },
  // Anthropic Claude — both the Anthropic Console API (ANTHROPIC_API_KEY)
  // and Claude Pro/Max/Team/Enterprise subscriptions (OAuth) reach the same
  // /v1/messages endpoint and share one provider id. Auth path determines
  // which headers pi-ai's `anthropic-messages` transport injects: API key
  // sends a plain `x-api-key`; OAuth sends Bearer + Claude Code identity
  // (anthropic-beta: claude-code-20250219,oauth-2025-04-20 +
  // user-agent: claude-cli/<version>), which is exactly the surface a
  // subscriber's `claude setup-token` credential authorizes. The OAuth dance
  // itself is authorization-code + PKCE against `claude.ai/oauth/authorize`
  // with a localhost callback server (not device-code); the existing
  // `typeclaw-claude-code` skill documents the user-side flow for getting
  // a subscription credential onto the agent when the in-container browser
  // callback can't reach the user's machine.
  //
  // anthropic is the FIRST provider in the registry where both auth modes
  // coexist on one entry. The runtime in src/agent/auth.ts has a load-bearing
  // resolution rule: when secrets.json#providers.anthropic carries an OAuth
  // credential, `ANTHROPIC_API_KEY` in .env is IGNORED (OAuth-on-disk wins
  // because env-wins only applies to api-key-shaped credentials). For
  // api-key-only providers this is invisible; for anthropic it surfaces as
  // "I added the env var but the agent still uses OAuth." The mitigation is
  // to remove the OAuth credential explicitly (`typeclaw provider remove
  // anthropic`) before relying on the env-var path. Same rule applies to any
  // future dual-auth provider — keep the surprise in mind when expanding.
  //
  // Model lineup is the current GA tier as of 2026-07-02: Fable 5 (top,
  // released Jun 2026 — a tier above Opus), Sonnet 5 (mid, Jul 1 2026),
  // Opus 4.8 (May 2026), Opus 4.7 (Apr 16 2026), Sonnet 4.6 (Feb 5 2026),
  // Haiku 4.5 (fast, Oct 1 2025). Anthropic's own model overview lists the
  // latest Fable/Opus/Sonnet/Haiku as the current recommended set and flags
  // earlier Opus/Sonnet variants with
  // "Consider migrating to current models." Opus 4 / Sonnet 4 are deprecated
  // (retirement: Jun 15 2026); the 4.5/4.6 alternates remain Active but are
  // not the recommended path. Claude Mythos 5 (Fable 5's classifier-free
  // sibling, limited availability via Project Glasswing) is intentionally
  // NOT listed — access is gated per-org and a registry entry would fail for
  // everyone else. Opus 5.5 (Sep 22 2026) was added on its own; Claude Opus 5
  // and Fable 5.1 are not registered yet.
  //
  // ID semantics differ across the lineup and matter for forward-compat:
  //   - `claude-haiku-4-5` is a 4.5-generation CONVENIENCE ALIAS that
  //     resolves to the latest dated snapshot (currently `-20251001`). Per
  //     Anthropic's model-id docs, pre-4.6 dateless ids are evergreen
  //     pointers — Anthropic can ship a new dated snapshot under the same
  //     alias and we pick it up automatically.
  //   - `claude-sonnet-4-6` and `claude-opus-4-7` are 4.6+-generation PINNED
  //     SNAPSHOTS, not aliases. Anthropic explicitly says "the dateless ID is
  //     the canonical model ID for that release. It maps to a single, fixed
  //     model snapshot." A future Sonnet 4.6.1 (if it ever exists) would ship
  //     under a new id, NOT silently replace `claude-sonnet-4-6`.
  // Consequence for refresh discipline: bumping Haiku is a no-op (alias
  // catches the latest); bumping Sonnet/Opus to a future 4.7+ family is a
  // real edit here. Don't assume `claude-opus-4-7` will silently advance.
  //
  // Opus 4.7 specifics that affect cost accounting:
  //   - New tokenizer: same input maps to 1.0-1.3x more tokens than prior
  //     generations depending on content type. Per-token price is unchanged
  //     vs Opus 4.6, but total cost on identical workloads can rise meaningfully.
  //   - 1M token context window (vs 200k on Haiku) and 128k max output (vs
  //     64k on Sonnet/Haiku). 1M context is at standard pricing — no surcharge.
  //   - `xhigh` effort level between `high` and `max`; each record's
  //     `thinkingLevelMap` declares whether the model exposes it.
  //
  // Pricing mirrors Anthropic's official table as of 2026-05; cacheWrite is
  // the 5m-TTL rate (1.25x input). 1h TTL is ~2x input (not modeled here —
  // pi-ai's `cacheWrite` field captures the default 5m rate only).
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    auth: ['api-key', 'oauth'],
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    oauthProviderId: 'anthropic',
    models: {
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      // pi-ai 0.73 inferred adaptive thinking from the 4.6/4.7 ids; 0.87 reads
      // only `compat.forceAdaptiveThinking` (anthropic-messages.js). Without
      // these catalog fields Sonnet 4.6 and Opus 4.7 fall back to budget
      // thinking, which Anthropic deprecates on 4.6 and rejects with a 400 on
      // 4.7+ (platform.claude.com/docs/en/build-with-claude/extended-thinking).
      //
      // No Anthropic record sets `compat.supportsStrictTools`. With it, pi sends
      // its strict-preferring built-ins (read/write/edit/bash) as strict tools,
      // turning each optional param into a nullable union. Together with our
      // own enum-union tool params that exceeds Anthropic's 16-union-param
      // request cap, and every channel turn 400s. Guarded by
      // anthropic-payload.test.ts.
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 1000000,
        maxTokens: 64000,
        thinkingLevelMap: { max: 'max' },
        compat: { forceAdaptiveThinking: true },
      },
      // Sonnet 5 (Jul 1 2026) is the drop-in successor to Sonnet 4.6 with a
      // caveat set that affects consumers of this record:
      //   - New tokenizer: ~30% more tokens for the same text vs Sonnet 4.6.
      //     Per-token price is unchanged, so equivalent requests cost more.
      //   - Adaptive thinking only: manual extended thinking
      //     (`thinking: {type: "enabled"}` with `budget_tokens`) returns a
      //     400. `compat.forceAdaptiveThinking` makes pi-ai's Anthropic
      //     transport send adaptive thinking on every path, compaction included.
      //   - Cost encodes the STANDARD rate (in effect Sep 1 2026+).
      //     Introductory pricing ($2/$10, cacheRead 0.2, cacheWrite 2.5) ran
      //     through Aug 31 2026. It was chosen so the record doesn't silently
      //     go stale two months after landing.
      'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 1000000,
        maxTokens: 128000,
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
        compat: { forceAdaptiveThinking: true },
      },
      'claude-opus-4-7': {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1000000,
        maxTokens: 128000,
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
        compat: { forceAdaptiveThinking: true, supportsTemperature: false },
      },
      // Opus 4.8 was never in pi 0.73's adaptive id list, so it already got
      // budget thinking (a 400 on 4.7+) before this migration. The catalog
      // compat fixes it the same way.
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1000000,
        maxTokens: 128000,
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
        compat: {
          supportsMidConvoSystemMessages: true,
          supportsMidConvoToolChanges: true,
          forceAdaptiveThinking: true,
          supportsTemperature: false,
        },
      },
      // Opus 5.5 (Sep 22 2026) keeps adaptive thinking permanently on: both
      // manual and disabled thinking return 400, which `forceAdaptiveThinking`
      // plus `off`/`minimal: null` rule out. `supportsMidConvoEffort` routes the
      // thinking level through the mid-conversation output-config control and
      // sends `thinking-binding-controls-2026-08-01` with `drop_block`. Without
      // that, a replayed thinking block whose prefix changed (for example after
      // compaction) returns 400 on accounts created on or after 2026-08-31.
      // Forced tool use is unsupported; typeclaw never sets toolChoice.
      'claude-opus-5-5': {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
        contextWindow: 1000000,
        maxTokens: 128000,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
        compat: {
          supportsMidConvoEffort: true,
          supportsMidConvoSystemMessages: true,
          supportsMidConvoToolChanges: true,
          forceAdaptiveThinking: true,
          supportsTemperature: false,
        },
      },
      // Fable 5 (Jun 2026) is a NEW TIER above Opus — Anthropic's most
      // capable widely released model, aimed at long-horizon agentic work.
      // Ships the 5-generation tokenizer: ~1.3x token counts for the same
      // text vs pre-5 models, so equivalent requests cost more than the
      // per-token rates alone suggest. Adaptive thinking only, same as
      // Sonnet 5 above, via `compat.forceAdaptiveThinking`. Upstream's catalog
      // also sets `allowedFallbackModels` (Anthropic server-side fallback to
      // Opus 4.8 / Opus 5). That is deliberately NOT adopted: pi would send
      // `fallbacks`, and a refused request would silently be served, and
      // billed, by a different model than the one the operator configured.
      'claude-fable-5': {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        contextWindow: 1000000,
        maxTokens: 128000,
        thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
        compat: {
          supportsMidConvoSystemMessages: true,
          supportsMidConvoToolChanges: true,
          forceAdaptiveThinking: true,
        },
      },
    },
  },
  fireworks: {
    id: 'fireworks',
    name: 'Fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    auth: ['api-key'],
    apiKeyEnv: 'FIREWORKS_API_KEY',
    oauthProviderId: null,
    models: {
      // Kept available even though models.dev hasn't indexed it yet —
      // Fireworks ships this router as an alias to the latest k2.6 weights.
      'accounts/fireworks/routers/kimi-k2p6-turbo': {
        id: 'accounts/fireworks/routers/kimi-k2p6-turbo',
        name: 'Kimi K2.6 Turbo',
        api: 'openai-completions',
        provider: 'fireworks',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 256000,
      },
    },
  },
  // Z.AI (ZhipuAI / BigModel) general pay-as-you-go API. OpenAI-compatible
  // (Bearer auth + /chat/completions shape), so models go through pi-ai's
  // `openai-completions` adapter with a custom baseUrl — same trick as
  // Fireworks. Costs and context windows mirror docs.z.ai/guides/overview/
  // pricing as of 2026-05-15.
  //
  // The split with `zai-coding` below mirrors how we model `openai` /
  // `openai-codex`: same upstream vendor, two distinct billing surfaces
  // (paygo vs subscription), two distinct base URLs, two distinct env vars
  // so a user can hold both keys simultaneously without collisions.
  zai: {
    id: 'zai',
    name: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    auth: ['api-key'],
    apiKeyEnv: 'ZAI_API_KEY',
    oauthProviderId: null,
    models: {
      'glm-4.5-air': {
        id: 'glm-4.5-air',
        name: 'GLM-4.5-Air',
        api: 'openai-completions',
        provider: 'zai',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 0.2, output: 1.1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 96000,
      },
      'glm-4.6': {
        id: 'glm-4.6',
        name: 'GLM-4.6',
        api: 'openai-completions',
        provider: 'zai',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 0.6, output: 2.2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 128000,
      },
      'glm-4.7': {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        api: 'openai-completions',
        provider: 'zai',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 0.6, output: 2.2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 128000,
      },
    },
  },
  // Z.AI GLM Coding Plan subscription. Same vendor, same key format, but a
  // distinct base URL (/api/coding/paas/v4) and a separate billing surface
  // — using a Coding Plan key against the paygo endpoint returns error 1113
  // ("insufficient balance"). Distinct env var (`ZAI_CODING_API_KEY`) so a
  // user can hold both a paygo and a Coding Plan key on different accounts.
  //
  // Model lineup is exactly the five models the Coding Plan docs name as
  // "All plans support" plus GLM-5 (Pro/Max only per docs). Listing other
  // GLM models here would silently bill against the wrong surface.
  'zai-coding': {
    id: 'zai-coding',
    name: 'Z.AI (GLM Coding Plan)',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    auth: ['api-key'],
    apiKeyEnv: 'ZAI_CODING_API_KEY',
    oauthProviderId: null,
    models: {
      'glm-4.5-air': {
        id: 'glm-4.5-air',
        name: 'GLM-4.5-Air',
        api: 'openai-completions',
        provider: 'zai-coding',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 0.2, output: 1.1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 96000,
      },
      'glm-4.7': {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        api: 'openai-completions',
        provider: 'zai-coding',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 0.6, output: 2.2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 128000,
      },
      // GLM-5 access is Pro/Max tier only per docs.z.ai/devpack — Lite
      // subscribers will see a quota error. We still list it because we
      // can't introspect plan tier from the key alone.
      'glm-5': {
        id: 'glm-5',
        name: 'GLM-5',
        api: 'openai-completions',
        provider: 'zai-coding',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 1.0, output: 3.2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 128000,
      },
      'glm-5-turbo': {
        id: 'glm-5-turbo',
        name: 'GLM-5-Turbo',
        api: 'openai-completions',
        provider: 'zai-coding',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 1.2, output: 4.0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 128000,
      },
      'glm-5.1': {
        id: 'glm-5.1',
        name: 'GLM-5.1',
        api: 'openai-completions',
        provider: 'zai-coding',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 128000,
      },
    },
  },
  // xAI (Grok) is a dual-auth provider: api-key requests use XAI_API_KEY and
  // OAuth requests use the xAI OIDC credential. Grok 4.7 and 4.3 use
  // `openai-responses` with pi-ai 0.87.1's catalog metadata, as upstream's
  // built-in xAI provider does: Responses carries encrypted reasoning and the
  // documented effort values. The grok-4.20 snapshots and grok-build-0.1 are
  // not in that catalog, so they stay on `openai-completions`, where pi-ai
  // sends no xAI reasoning_effort. That is their 0.73 wire behavior, unchanged.
  // The built-in pi-ai xAI provider owns its device-code OAuth flow, including
  // refresh. An OAuth credential on disk takes precedence over XAI_API_KEY in
  // .env; remove it (`typeclaw provider remove xai`) to use the key instead.
  //
  // Costs and context windows mirror docs.x.ai/developers/models and the raw
  // /v1/models price fields as of 2026-06-08 (xAI quotes prices in cents per
  // 100M tokens; e.g. grok-4.3 prompt 12500 = $1.25/1M); grok-4.7 mirrors
  // docs.x.ai/developers/grok-4-7 and /pricing as of 2026-09-21. grok-4.7 is
  // the flagship; grok-4.3 stays first as the template record for uncurated
  // refs; grok-build-0.1 is the coding-tuned model. The
  // grok-4.20-0309 snapshots are pinned weights for reproducible runs.
  //
  // The earlier grok-4 / grok-4-fast / grok-code-fast-1 ids were RETIRED on
  // 2026-05-15 — they still resolve but silently redirect (and bill) at the
  // grok-4.3 / grok-build-0.1 rates, so they are intentionally NOT listed.
  //
  // cacheWrite is 0: xAI publishes no cache-write price (caching is implicit,
  // billed only at the cacheRead rate). Every model here also carries a
  // long-context tier (2x rates above a 200k-token request); the flat cost
  // shape can't express tiered pricing, so the standard rate is used and the
  // breakpoint is noted here. When refreshing, rerun `scripts/generate-schema.ts`.
  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    auth: ['api-key', 'oauth'],
    apiKeyEnv: 'XAI_API_KEY',
    oauthProviderId: 'xai',
    models: {
      // pi-ai 0.87.1's xAI catalog caps Grok 4.3 at 30K and maps its efforts;
      // `minimal` is not an xAI effort, so it clamps to `low`. The current
      // transport sends model.maxTokens by default, so keep that vendor-safe cap.
      'grok-4.3': {
        id: 'grok-4.3',
        name: 'Grok 4.3',
        api: 'openai-responses',
        provider: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 30000,
        thinkingLevelMap: {
          off: 'none',
          minimal: null,
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: null,
          max: null,
        },
        compat: { supportsLongCacheRetention: false },
      },
      // Responses is required for Grok 4.7's encrypted reasoning and maps
      // the documented low/medium/high/xhigh effort values on pi-ai 0.87.1.
      'grok-4.7': {
        id: 'grok-4.7',
        name: 'Grok 4.7',
        api: 'openai-responses',
        provider: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
        // xAI documents no text-output ceiling. Use the 500K context window;
        // pi-ai clamps it to remaining context before the Responses request.
        contextWindow: 500000,
        maxTokens: 500000,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: null,
        },
        compat: { supportsLongCacheRetention: false },
      },
      'grok-4.20-0309-reasoning': {
        id: 'grok-4.20-0309-reasoning',
        name: 'Grok 4.20 (Reasoning)',
        api: 'openai-completions',
        provider: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 64000,
      },
      'grok-4.20-0309-non-reasoning': {
        id: 'grok-4.20-0309-non-reasoning',
        name: 'Grok 4.20 (Non-Reasoning)',
        api: 'openai-completions',
        provider: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 64000,
      },
      'grok-build-0.1': {
        id: 'grok-build-0.1',
        name: 'Grok Build 0.1',
        api: 'openai-completions',
        provider: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.0, output: 2.0, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 64000,
      },
    },
  },
  // MiniMax (minimax.io) pay-as-you-go API. OpenAI-compatible (Bearer auth +
  // /chat/completions shape), so models go through pi-ai's `openai-completions`
  // adapter with a custom baseUrl — same trick as Fireworks and Z.AI.
  //
  // Endpoint choice: the international endpoint (api.minimax.io) is the global
  // surface; the China endpoint (api.minimaxi.com) is a regional alternative on
  // the same protocol. We pin the international one here — operators who need the
  // China gateway can front it with an OpenAI-compatible proxy.
  //
  // Model lineup mirrors the OpenAI-compatible model enum on
  // platform.minimax.io as of 2026-06-08: MiniMax-M3 (flagship, 1M context,
  // image input, controllable reasoning) plus the M2 reasoning series
  // (204,800 context, reasoning always on, text-only). The `-highspeed`
  // billing-tier variants and the native-only `M2-her` / `MiniMax-Text-01` /
  // `abab*` models are intentionally omitted — the first are duplicate weights
  // on a pricier surface, the rest don't serve the OpenAI-compatible
  // /chat/completions route this adapter speaks. Costs are USD per 1M tokens
  // from docs/guides/pricing-paygo (standard tier): M3 reflects the permanent
  // 50%-off ≤512K-input rate (input 0.30 / output 1.20 / cacheRead 0.06; M3 has
  // no separate cache-write rate). M2.7 caches at 0.06 read / 0.375 write; the
  // M2.5/M2.1/M2 series at 0.03 read / 0.375 write.
  //
  // M3 tiered pricing is NOT modeled: this single cost record only encodes the
  // ≤512K-input tier. The >512K tier (input 0.60 / output 2.40 / cacheRead 0.12)
  // is a limited-availability surcharge that pi-ai's flat per-model cost shape
  // can't represent, so long-context M3 sessions above 512K under-report cost.
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    auth: ['api-key'],
    apiKeyEnv: 'MINIMAX_API_KEY',
    oauthProviderId: null,
    models: {
      'MiniMax-M3': {
        id: 'MiniMax-M3',
        name: 'MiniMax M3',
        api: 'openai-completions',
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 524288,
      },
      'MiniMax-M2.7': {
        id: 'MiniMax-M2.7',
        name: 'MiniMax M2.7',
        api: 'openai-completions',
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
        contextWindow: 204800,
        maxTokens: 204800,
      },
      'MiniMax-M2.5': {
        id: 'MiniMax-M2.5',
        name: 'MiniMax M2.5',
        api: 'openai-completions',
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
        contextWindow: 204800,
        maxTokens: 204800,
      },
      'MiniMax-M2.1': {
        id: 'MiniMax-M2.1',
        name: 'MiniMax M2.1',
        api: 'openai-completions',
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
        contextWindow: 204800,
        maxTokens: 204800,
      },
      'MiniMax-M2': {
        id: 'MiniMax-M2',
        name: 'MiniMax M2',
        api: 'openai-completions',
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
        contextWindow: 204800,
        maxTokens: 204800,
      },
    },
  },
  // DeepSeek (api.deepseek.com) pay-as-you-go API. OpenAI-compatible (Bearer
  // auth + /chat/completions shape), so models go through pi-ai's
  // `openai-completions` adapter with a custom baseUrl — same trick as
  // Fireworks, Z.AI, and MiniMax. api-key only; DeepSeek ships no OAuth flow.
  //
  // baseUrl is bare `https://api.deepseek.com` (no `/v1` segment) — the SDK
  // appends `/chat/completions`. This mirrors Anthropic's no-`/v1` convention,
  // not the OpenAI/xAI `/v1` one; `validate-api-key.ts` probes
  // `${baseUrl}/models` accordingly.
  //
  // Model lineup is the V4 generation as listed on api-docs.deepseek.com/quick_start/pricing
  // as of 2026-06-08: deepseek-v4-flash (fast, cheap default) and
  // deepseek-v4-pro (stronger). Both default to thinking/reasoning mode (it is
  // toggleable upstream, but reasoning: true reflects the default). 1M context,
  // 384K max output, text-only — DeepSeek's API exposes no image input. The
  // legacy `deepseek-chat` / `deepseek-reasoner` aliases (deprecated 2026-07-24,
  // they redirect into v4-flash's non-thinking/thinking modes) are intentionally
  // omitted in favor of the canonical v4 ids.
  //
  // Costs are USD per 1M tokens (standard tier). DeepSeek prices input on a
  // cache-miss/cache-hit split: `input` is the cache-miss rate, `cacheRead` is
  // the cache-hit rate. There is no published cache-write surcharge, so
  // cacheWrite is 0.
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    auth: ['api-key'],
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    oauthProviderId: null,
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        api: 'openai-completions',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 384000,
      },
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        api: 'openai-completions',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
        input: ['text'],
        cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 384000,
      },
    },
  },
  // Upstage (Solar) — console.upstage.ai pay-as-you-go API. OpenAI-compatible
  // (Bearer auth + /chat/completions shape), so models go through pi-ai's
  // `openai-completions` adapter with a custom baseUrl — same trick as
  // Fireworks, Z.AI, MiniMax, DeepSeek, and Moonshot. api-key only; Upstage
  // ships no OAuth flow. Keys are prefixed `up_`.
  //
  // baseUrl is `https://api.upstage.ai/v1` (the OpenAI-style `/v1` convention,
  // like OpenAI/xAI/Moonshot — NOT the bare Anthropic/DeepSeek form). The SDK
  // appends `/chat/completions`; `validate-api-key.ts` probes `${baseUrl}/models`.
  // Some older third-party integrations (LangChain community, VoltAgent) point
  // at the legacy `https://api.upstage.ai/v1/solar` path — that is deprecated;
  // the console, the OpenAI-SDK example, and the agent docs all use bare `/v1`.
  //
  // Model lineup spans two families on the same Console API + key:
  //   * Closed chat models, per the live model pages under
  //     console.upstage.ai/docs/models — solar-pro-4, solar-pro-3,
  //     solar-pro-2, solar-mini (the slugs are hyphenated; the unhyphenated
  //     form 404s): solar-pro4 (524288 context / 131072 output, released
  //     2026-08-06, current flagship), solar-pro3 (102B MoE / 12B active,
  //     128000), solar-pro2 (31B, 65536), solar-mini (10.7B, 32768,
  //     cheap/fast). The contextWindow values below are those exact
  //     documented figures. Upstage publishes NO maximum output length for
  //     pro3/pro2/mini, so their maxTokens are deliberate conservative
  //     choices of ours rather than sourced numbers — do not "correct" them
  //     against a third-party catalog that states one. The older agent API
  //     reference (console.upstage.ai/api/docs/for-agents) is stale
  //     (self-dated 2026-03-07) and omits pro4 — its absence there is not
  //     evidence the model is unavailable.
  //   * The open-weight Solar Open family: solar-open2 (Solar Open 2), a 102B
  //     MoE / 12B active model with a 128K context. It launched on the Console
  //     API for the Solar Agent Partner program (Stage 1, from 2026-07-17) —
  //     newer than the public docs snapshot above, so it is not yet in the
  //     public model-alias table; the model id is per Upstage's partner
  //     onboarding notice (docs: console.upstage.ai/api/chat).
  // Every model here supports OpenAI-style function calling (required for agent
  // use) and is text-only (Upstage's chat API exposes no image input). The
  // `syn-pro` synthetic-data model is intentionally omitted: it does NOT
  // support function calling and is useless as an agent model. Aliases (not the
  // dated `-260323` suffixes) are used so they auto-forward to the latest
  // versioned release.
  //
  // Costs are USD per 1M tokens from upstage.ai/pricing/api (VAT-exclusive).
  // solar-pro4 is $0.30 in / $1.20 out with a $0.06 "Input(Cached)" rate.
  // solar-pro3/pro2 publish an "Input(Cached)" cache-read rate ($0.015); no
  // cache-write surcharge is published, so cacheWrite is 0. solar-mini
  // publishes a single flat $0.15 rate with no cache line, so cacheRead and
  // cacheWrite are both 0 (no published discount). solar-open2 has no published
  // price yet (partner-program access, rate-limited rather than billed), so all
  // four cost fields are 0 until Upstage publishes a Solar Open rate card.
  //
  // `compat` pins pi-ai's openai-completions adapter to Upstage's DOCUMENTED
  // request surface. pi-ai only auto-detects compat for a known set of baseUrls
  // (Cerebras, xAI, DeepSeek, …); api.upstage.ai is not among them, so without
  // this it would default to OpenAI-native fields Upstage does not document and
  // could reject. Per the Upstage Console API reference
  // (console.upstage.ai/api/docs/for-agents): messages use system/user/assistant
  // roles only (no `developer` role), output length is `max_tokens` (not
  // `max_completion_tokens`), and `store` is not a documented field — so
  // supportsDeveloperRole/supportsStore are false and maxTokensField is
  // `max_tokens`. `stream_options.include_usage` and the `strict` field on tool
  // definitions are both undocumented, so supportsUsageInStreaming and
  // supportsStrictMode are false (both conservative — pi-ai defaults them to
  // true, and Upstage only documents `strict` inside response_format.json_schema,
  // never on tool defs). `reasoning_effort` IS documented for solar-pro4,
  // solar-open2, solar-pro3 and solar-pro2, so supportsReasoningEffort stays
  // true there; solar-mini rejects it, so it is false and reasoning is off.
  //
  // Reasoning splits the lineup into two groups with OPPOSITE defaults, per
  // Upstage's reasoning table (console.upstage.ai/docs/capabilities/generate/
  // reasoning). pi adds an `xhigh` level that typeclaw's attention escalation
  // can select (src/agent/attention-escalation.ts), and pi-ai passes the pi
  // level straight through as reasoning_effort when no map is set, so each
  // group needs a different `thinkingLevelMap`:
  //
  //   * solar-pro4 and solar-open2 — omitted reasoning_effort means reasoning
  //     is ON; `none`/`minimal` turn it OFF; low/medium/high/xhigh/max turn it
  //     on. So `off` maps to the string 'none', NOT null: pi-ai emits a string
  //     off value verbatim and omits the field only when it is null, and
  //     omitting it here would silently leave reasoning enabled (and billed) on
  //     every non-reasoning turn. `xhigh` is documented, so it passes through
  //     unclamped. Upstage's `max` sits above xhigh, but pi has no level above
  //     xhigh to reach it, so `max` is intentionally unreachable.
  //   * solar-pro3 and solar-pro2 — omitted means reasoning is OFF, `minimal`
  //     and `low` ALSO turn it off, and only `medium`/`high` turn it on. So
  //     `off` maps to null (nothing sent) and xhigh clamps to high.
  //
  // Note the trap in both rows: Upstage's `minimal` is an OFF value, but pi's
  // `minimal` is an enabled level meaning "reason a little". Forwarding it
  // verbatim would silently disable reasoning on a request that asked for it.
  // Each group therefore floors pi's enabled levels at its own lowest
  // reasoning-ON value — `low` for pro4/open2, `medium` for pro3/pro2 (which is
  // why pi's `low` also maps to `medium` there). Every level pi can select thus
  // emits a value Upstage treats as reasoning-on. solar-mini needs no map: it
  // does not accept reasoning_effort at all (any value returns HTTP 400).
  upstage: {
    id: 'upstage',
    name: 'Upstage (Solar)',
    baseUrl: 'https://api.upstage.ai/v1',
    auth: ['api-key'],
    apiKeyEnv: 'UPSTAGE_API_KEY',
    oauthProviderId: null,
    models: {
      'solar-pro4': {
        id: 'solar-pro4',
        name: 'Solar Pro 4',
        api: 'openai-completions',
        provider: 'upstage',
        baseUrl: 'https://api.upstage.ai/v1',
        reasoning: true,
        // pro4 and open2 reason by DEFAULT — see the reasoning-group note above.
        thinkingLevelMap: {
          off: 'none',
          minimal: 'low',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
        },
        input: ['text'],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
        contextWindow: 524288,
        maxTokens: 131072,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          supportsUsageInStreaming: false,
          supportsStrictMode: false,
          maxTokensField: 'max_tokens',
        },
      },
      'solar-open2': {
        id: 'solar-open2',
        name: 'Solar Open 2',
        api: 'openai-completions',
        provider: 'upstage',
        baseUrl: 'https://api.upstage.ai/v1',
        reasoning: true,
        thinkingLevelMap: {
          off: 'none',
          minimal: 'low',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
        },
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          supportsUsageInStreaming: false,
          supportsStrictMode: false,
          maxTokensField: 'max_tokens',
        },
      },
      'solar-pro3': {
        id: 'solar-pro3',
        name: 'Solar Pro 3',
        api: 'openai-completions',
        provider: 'upstage',
        baseUrl: 'https://api.upstage.ai/v1',
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: 'medium',
          low: 'medium',
          medium: 'medium',
          high: 'high',
          xhigh: 'high',
        },
        input: ['text'],
        cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          supportsUsageInStreaming: false,
          supportsStrictMode: false,
          maxTokensField: 'max_tokens',
        },
      },
      'solar-pro2': {
        id: 'solar-pro2',
        name: 'Solar Pro 2',
        api: 'openai-completions',
        provider: 'upstage',
        baseUrl: 'https://api.upstage.ai/v1',
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: 'medium',
          low: 'medium',
          medium: 'medium',
          high: 'high',
          xhigh: 'high',
        },
        input: ['text'],
        cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
        contextWindow: 65536,
        maxTokens: 16000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          supportsUsageInStreaming: false,
          supportsStrictMode: false,
          maxTokensField: 'max_tokens',
        },
      },
      'solar-mini': {
        id: 'solar-mini',
        name: 'Solar Mini',
        api: 'openai-completions',
        provider: 'upstage',
        baseUrl: 'https://api.upstage.ai/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0.15, output: 0.15, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 8000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: false,
          supportsStrictMode: false,
          maxTokensField: 'max_tokens',
        },
      },
    },
  },
  // Moonshot AI (Kimi) — Open Platform pay-as-you-go API. The platform exposes
  // an OpenAI-compatible surface at api.moonshot.ai/v1 (Bearer auth +
  // /chat/completions shape), so models go through pi-ai's `openai-completions`
  // adapter with a custom baseUrl — same trick as Fireworks, Z.AI, MiniMax, and
  // DeepSeek. api-key only; the platform ships no OAuth flow.
  //
  // Moonshot also offers an Anthropic-compatible route (api.moonshot.ai/anthropic)
  // on the same key, but it rescales temperature (real = requested × 0.6) and
  // would be the FIRST `anthropic-messages` transport pointed at a non-Anthropic
  // baseUrl in this codebase. We deliberately stay on the proven OpenAI-compatible
  // path so behavior matches every other paygo provider.
  //
  // The split with `moonshot-coding` below mirrors `zai` / `zai-coding`: same
  // upstream vendor, two distinct billing surfaces (Open Platform paygo vs the
  // Kimi Code subscription) on two distinct base URLs with two distinct env
  // vars, so a user can hold both keys at once. The Open Platform key does NOT
  // work against the Kimi Code endpoint, and vice versa.
  //
  // Model lineup mirrors the OpenAI-compatible model list on platform.kimi.ai
  // as of 2026-06-14: kimi-k2.7-code (flagship coding model, always-on thinking,
  // text+image), kimi-k2.6 (general flagship, text+image), and kimi-k2.5
  // (general, text+image). All three fold reasoning in via the `thinking`
  // request parameter, so no separate "thinking" model id is needed. The whole
  // legacy kimi-k2 series (kimi-k2-thinking, k2-0905/0711/turbo previews) was
  // officially discontinued on 2026-05-25 and is intentionally omitted, as are
  // the legacy moonshot-v1-* models. Costs are USD per 1M tokens from
  // platform.kimi.ai pricing; Moonshot publishes no cache-write surcharge, so
  // cacheWrite is 0. (pi-ai's `input` array only models text/image — Moonshot's
  // video input on the K2.x models can't be expressed here, so it is omitted.)
  moonshot: {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.ai/v1',
    auth: ['api-key'],
    apiKeyEnv: 'MOONSHOT_API_KEY',
    oauthProviderId: null,
    models: {
      'kimi-k2.7-code': {
        id: 'kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        api: 'openai-completions',
        provider: 'moonshot',
        baseUrl: 'https://api.moonshot.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 64000,
      },
      'kimi-k2.6': {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        api: 'openai-completions',
        provider: 'moonshot',
        baseUrl: 'https://api.moonshot.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 64000,
      },
      'kimi-k2.5': {
        id: 'kimi-k2.5',
        name: 'Kimi K2.5',
        api: 'openai-completions',
        provider: 'moonshot',
        baseUrl: 'https://api.moonshot.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 64000,
      },
    },
  },
  // Moonshot AI Kimi Code — the Coding Plan subscription product. Distinct from
  // the Open Platform above: a separate domain (api.kimi.com/coding/v1), a
  // separate subscription key created at kimi.com/code/console, and a separate
  // env var (`MOONSHOT_CODING_API_KEY`) so a user can hold both an Open Platform
  // paygo key and a Coding Plan key without collisions. Kimi Code exposes an
  // OpenAI-compatible route (Bearer auth + /chat/completions) alongside its
  // Anthropic-compatible one; we use the OpenAI-compatible route so it threads
  // through the same `openai-completions` adapter as every other paygo provider.
  //
  // Single model alias: `kimi-for-coding` is a STABLE ALIAS that the Coding Plan
  // backend routes to the latest underlying model (currently the K2.6 family).
  // Version-pinned ids are NOT accepted on this endpoint and fail silently, so
  // the alias is the only id listed. Costs are 0 because the Coding Plan bills a
  // flat subscription quota, not per-token — there is no per-token price to
  // attribute (same convention as the Fireworks Fire Pass router above).
  'moonshot-coding': {
    id: 'moonshot-coding',
    name: 'Moonshot (Kimi Coding Plan)',
    baseUrl: 'https://api.kimi.com/coding/v1',
    auth: ['api-key'],
    apiKeyEnv: 'MOONSHOT_CODING_API_KEY',
    oauthProviderId: null,
    models: {
      'kimi-for-coding': {
        id: 'kimi-for-coding',
        name: 'Kimi for Coding',
        api: 'openai-completions',
        provider: 'moonshot-coding',
        baseUrl: 'https://api.kimi.com/coding/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 64000,
      },
    },
  },
  // OpenGateway.ai (Sionic AI) — a multi-vendor LLM GATEWAY, not a lab. One
  // OpenAI-compatible surface (Bearer + /chat/completions) fronts OpenAI,
  // Anthropic, Google, Moonshot, MiniMax, DeepSeek, Z.AI, xAI, and Qwen, so by
  // the granularity rule above it is ONE provider id: one endpoint, one wire
  // transport, one key.
  //
  // Model ids are creator-qualified (`openai/gpt-5.5`, not `gpt-5.5`) — the
  // namespace is mandatory upstream. TypeClaw refs therefore carry two slashes:
  // `opengateway/anthropic/claude-sonnet-5`. That parses fine because
  // `providerForModelRef()` matches on the registered provider prefix, the same
  // mechanism that already handles the slash-heavy Fireworks router ids.
  //
  // The live picker gets ids and modalities from OpenGateway's public catalog,
  // then best-effort joins its rate card. This registry intentionally keeps one
  // anchor only: `resolveModel()` uses `Object.keys(provider.models)[0]` as the
  // transport/limits template for every uncurated ref, so entries 2..N buy
  // nothing. An empty map would make custom refs throw, making one the true
  // floor. Nano is the cheapest conservative context/limit donor and keeps
  // `curatedOptions()` useful as the offline fallback.
  //
  // Every model carries an explicit `compat` for the same reason Upstage does:
  // pi-ai auto-detects compatibility from the baseUrl, and `apis.opengateway.ai`
  // matches none of its known hosts, so it would otherwise assume a first-party
  // OpenAI endpoint and send `store`, the `developer` role, `strict` tool
  // schemas, and `max_completion_tokens` to a gateway fronting Anthropic and
  // Moonshot. `supportsUsageInStreaming` is deliberately left unset (pi-ai
  // defaults it true) — turning it off would break token and cost reporting.
  opengateway: {
    id: 'opengateway',
    name: 'OpenGateway',
    baseUrl: 'https://apis.opengateway.ai/v1',
    auth: ['api-key'],
    apiKeyEnv: 'OPENGATEWAY_API_KEY',
    oauthProviderId: null,
    models: {
      'openai/gpt-5.4-nano': {
        id: 'openai/gpt-5.4-nano',
        name: 'GPT-5.4 nano',
        api: 'openai-completions',
        provider: 'opengateway',
        baseUrl: 'https://apis.opengateway.ai/v1',
        reasoning: true,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStrictMode: false,
          maxTokensField: 'max_tokens',
        },
        input: ['text', 'image'],
        // Offline snapshot of OpenGateway's published rate for this model, NOT
        // the upstream OpenAI list price. Every other model is priced live from
        // the rate card, so this is the one number that can go stale; it is the
        // fallback used when the card is unreachable. Re-check it against
        // https://opengateway.ai/api/model-prices if you touch it.
        cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
        contextWindow: 400000,
        maxTokens: 128000,
      },
    },
  },
} as const satisfies Record<string, KnownProvider>

export type KnownProviderId = keyof typeof KNOWN_PROVIDERS

// UX-only grouping of provider ids under one vendor for the init/`provider
// add` pickers. Deliberately does NOT touch the runtime contract:
// `KnownProviderId`, `KnownModelRef`, secrets.json keys, auth resolution, and
// the generated schema all stay keyed on the flat ids in `KNOWN_PROVIDERS`.
// The follow-up "variant" prompt resolves a concrete provider id, then
// `pickAuthMethod` runs as before; it is auto-resolved for single-provider
// vendors (Fireworks, Anthropic). `variants` copy lets the prompt read as an
// auth choice for OpenAI but a plan choice for Z.AI (both api-key, different
// billing surfaces).
type KnownProviderVendor = {
  id: string
  name: string
  providers: ReadonlyArray<KnownProviderId>
  variants?: Partial<Record<KnownProviderId, { label: string; hint?: string }>>
}

// Ordered by product priority for the picker — independent of the
// `KNOWN_PROVIDERS` declaration order (which stays load-bearing for the schema
// enum and `provider --help` listing). Every provider id below MUST appear in
// exactly one vendor; `providers.test.ts` enforces the partition.
export const KNOWN_PROVIDER_VENDORS = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    providers: ['openai', 'openai-codex'],
    variants: {
      openai: { label: 'API key', hint: 'OpenAI API platform' },
      'openai-codex': { label: 'OAuth (ChatGPT Plus/Pro)', hint: 'ChatGPT subscription' },
    },
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    providers: ['anthropic'],
  },
  fireworks: {
    id: 'fireworks',
    name: 'Fireworks',
    providers: ['fireworks'],
  },
  zai: {
    id: 'zai',
    name: 'Z.AI',
    providers: ['zai', 'zai-coding'],
    variants: {
      zai: { label: 'Pay-as-you-go', hint: 'standard API billing' },
      'zai-coding': { label: 'Coding Plan', hint: 'GLM Coding Plan subscription' },
    },
  },
  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    providers: ['xai'],
  },
  // Single-provider vendor: pay-as-you-go and Token Plan are the SAME provider
  // id (same /v1 endpoint, same Bearer transport — only the key prefix differs),
  // so per the granularity rule above MiniMax is one id like Anthropic, not a
  // zai-style split. The picker shows one row and skips the variant prompt; the
  // pay-as-you-go-vs-Token-Plan dashboard hint is handled in the key-entry step.
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    providers: ['minimax'],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    providers: ['deepseek'],
  },
  upstage: {
    id: 'upstage',
    name: 'Upstage (Solar)',
    providers: ['upstage'],
  },
  moonshot: {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    providers: ['moonshot', 'moonshot-coding'],
    variants: {
      moonshot: { label: 'Pay-as-you-go', hint: 'Moonshot Open Platform API billing' },
      'moonshot-coding': { label: 'Coding Plan', hint: 'Kimi Code subscription' },
    },
  },
  // Listed last because it is a reseller, not a lab: a user who knows they want
  // Anthropic should land on the Anthropic row, not the gateway that proxies it.
  opengateway: {
    id: 'opengateway',
    name: 'OpenGateway',
    providers: ['opengateway'],
  },
} as const satisfies Record<string, KnownProviderVendor>

export type KnownProviderVendorId = keyof typeof KNOWN_PROVIDER_VENDORS

export function listKnownProviderVendorIds(): KnownProviderVendorId[] {
  return Object.keys(KNOWN_PROVIDER_VENDORS) as KnownProviderVendorId[]
}

export function providerIdsForVendor(vendorId: KnownProviderVendorId): ReadonlyArray<KnownProviderId> {
  return KNOWN_PROVIDER_VENDORS[vendorId].providers
}

export function vendorForProviderId(providerId: KnownProviderId): KnownProviderVendorId {
  for (const vendorId of listKnownProviderVendorIds()) {
    if ((KNOWN_PROVIDER_VENDORS[vendorId].providers as ReadonlyArray<KnownProviderId>).includes(providerId)) {
      return vendorId
    }
  }
  throw new Error(`Provider ${providerId} is not assigned to any vendor in KNOWN_PROVIDER_VENDORS`)
}

function variantCopy(
  vendorId: KnownProviderVendorId,
  providerId: KnownProviderId,
): { label: string; hint?: string } | undefined {
  const vendor: KnownProviderVendor = KNOWN_PROVIDER_VENDORS[vendorId]
  return vendor.variants?.[providerId]
}

// Falls back to the provider's own name when a vendor supplies no variant copy
// (single-provider vendors never render this prompt, so the fallback only
// guards against an incomplete `variants` map on a multi-provider vendor).
export function variantLabel(vendorId: KnownProviderVendorId, providerId: KnownProviderId): string {
  return variantCopy(vendorId, providerId)?.label ?? KNOWN_PROVIDERS[providerId].name
}

export function variantHint(vendorId: KnownProviderVendorId, providerId: KnownProviderId): string | undefined {
  return variantCopy(vendorId, providerId)?.hint
}

export type KnownModelRef = {
  [P in KnownProviderId]: `${P}/${Extract<keyof (typeof KNOWN_PROVIDERS)[P]['models'], string>}`
}[KnownProviderId]

export type ModelRef = string & { readonly __modelRef: unique symbol }

export function listKnownModelRefs(): KnownModelRef[] {
  const refs: string[] = []
  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    for (const modelId of Object.keys(KNOWN_PROVIDERS[providerId].models)) {
      refs.push(`${providerId}/${modelId}`)
    }
  }
  return refs as KnownModelRef[]
}

export function isKnownModelRef(value: string): value is KnownModelRef {
  return (listKnownModelRefs() as ReadonlyArray<string>).includes(value)
}

export function isModelRef(value: string): value is ModelRef {
  return /^[a-z0-9][a-z0-9-]*\/[^\s/][^\s]*$/.test(value) && knownProviderForModelRef(value) !== null
}

// The default we hand to scaffolded `typeclaw.json` and the schema's
// `model.default`. Lives here (next to the provider table) so adding a model
// can't drift from the field default — both come from the same module.
export const DEFAULT_MODEL_REF: KnownModelRef = 'openai/gpt-5.4-nano'

export function providerForModelRef(ref: KnownModelRef | ModelRef | string): KnownProviderId {
  // KnownModelRef is `${provider}/${modelId}`, but provider IDs themselves can
  // contain '-' and model IDs can contain '/' (Fireworks). We split on the
  // first slash that follows a registered provider id.
  const providerId = knownProviderForModelRef(ref)
  if (providerId !== null) return providerId
  throw new Error(`Unknown provider in model ref: ${ref}`)
}

function knownProviderForModelRef(ref: string): KnownProviderId | null {
  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    if (ref.startsWith(`${providerId}/`)) return providerId
  }
  return null
}

export function isOpenAiFamilyRef(ref: KnownModelRef | ModelRef | string): boolean {
  return vendorForProviderId(providerForModelRef(ref)) === 'openai'
}

// Returning `undefined` defers to pi-coding-agent's SDK default (`medium`);
// returning a level pins it at session-creation time. No family is pinned: the
// prior OpenAI `low` pin was dropped so GPT-5.x reasons at SDK strength like
// every other vendor.
export function defaultThinkingLevelForRef(_ref: KnownModelRef | ModelRef | string): ThinkingLevel | undefined {
  return undefined
}

// `as const satisfies` narrows each entry's `auth` to a tuple of its specific
// literal values, which makes `provider.auth.includes('oauth')` fail to
// compile on api-key-only entries (because TS thinks the array can never
// contain 'oauth'). These accessors widen the membership check back to
// AuthMethod so consumers can branch without per-provider casts.
export function supportsApiKey(provider: { auth: ReadonlyArray<AuthMethod> }): boolean {
  return (provider.auth as ReadonlyArray<AuthMethod>).includes('api-key')
}

export function supportsOAuth(provider: { auth: ReadonlyArray<AuthMethod> }): boolean {
  return (provider.auth as ReadonlyArray<AuthMethod>).includes('oauth')
}
