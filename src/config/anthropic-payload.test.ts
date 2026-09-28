import { describe, expect, test } from 'bun:test'

import { normalizeContext, type Context, type Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/anthropic-messages'

import { resolveModel } from './config'
import { KNOWN_PROVIDERS } from './providers'

// End-to-end payload guard for the curated Anthropic models, driving pi-ai's
// real anthropic-messages adapter and capturing the body via `onPayload`
// (throwing there short-circuits before any network I/O).
//
// pi 0.87's built-in read/write/edit/bash tools opt into strict sampling
// (`constrainedSampling: { type: 'json_schema', strict: 'prefer' }`). With
// `compat.supportsStrictTools` on, pi sends `strict: true` and rewrites every
// optional parameter as a nullable union. Anthropic caps a request at 16
// union-typed parameters, and those rewrites plus typeclaw's own enum-union
// tool params pushed real channel sessions to 17 — every turn failed with a
// 400 "Schemas contains too many parameters with union types".

type CapturedPayload = Record<string, unknown>

async function buildAnthropicPayload(model: Model<'anthropic-messages'>): Promise<CapturedPayload> {
  const context: Context = {
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    tools: [
      {
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
          required: ['path'],
        },
        constrainedSampling: { type: 'json_schema', strict: 'prefer' },
      },
    ],
  }

  let captured: CapturedPayload | undefined
  const stopMarker = new Error('payload-captured')

  const s = streamSimple(model, normalizeContext(context), {
    apiKey: 'sk-ant-api03-test-key',
    onPayload: (payload) => {
      captured = payload as CapturedPayload
      throw stopMarker
    },
  })

  for await (const _event of s) {
    if (captured !== undefined) break
  }

  if (captured === undefined) throw new Error('onPayload never fired — adapter path changed')
  return captured
}

// Dated aliases resolve through pi's catalog compat, which itself sets
// `supportsStrictTools`, so they need the same guarantee as curated records.
const DATED_ALIASES = ['anthropic/claude-sonnet-5-20260701', 'anthropic/claude-opus-5-5-20260922'] as const

function anthropicModels(): Array<[string, Model<'anthropic-messages'>]> {
  return [
    ...Object.entries(KNOWN_PROVIDERS.anthropic.models).map(
      ([id, model]) =>
        [`anthropic/${id}`, model as Model<'anthropic-messages'>] as [string, Model<'anthropic-messages'>],
    ),
    ...DATED_ALIASES.map(
      (ref) => [ref, resolveModel(ref) as Model<'anthropic-messages'>] as [string, Model<'anthropic-messages'>],
    ),
  ]
}

describe('anthropic messages payload', () => {
  test('never sends strict tool schemas, even for tools that prefer strict sampling', async () => {
    for (const [ref, model] of anthropicModels()) {
      // given a pi built-in style tool that prefers strict sampling
      // when the payload for this model is built
      const payload = await buildAnthropicPayload(model)

      // then the tool ships as a plain schema: no strict flag, optionals stay non-union
      const tools = (payload.tools ?? []) as Array<{
        name: string
        strict?: unknown
        input_schema: Record<string, unknown>
      }>
      const read = tools.find((t) => t.name === 'read' || t.name === 'Read')
      expect(read, `${ref} dropped the tool`).toBeDefined()
      expect(read!.strict, `${ref} must not send strict tool schemas`).toBeUndefined()
      expect(read!.input_schema.required, `${ref} must not force optionals into required`).toEqual(['path'])
    }
  })
})
