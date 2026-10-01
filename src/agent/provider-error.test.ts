import { describe, expect, test } from 'bun:test'

import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai'
import { AgentSession as PiAgentSession, SettingsManager } from '@earendil-works/pi-coding-agent'

import type { AgentSession } from './index'
import {
  detectHardProviderError,
  detectProviderError,
  isFailoverWorthy,
  isRetryableSameRef,
  isObserverTtfbTimeout,
  isThrottleOrOverload,
  subscribeProviderErrors,
  wrapTransformContextWithLocalFailureMarker,
} from './provider-error'

function softNotice(errorMessage: string): string {
  return detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage })!.safeMessage
}

// The notice for text no class recognizes. Tests compare against it by class
// rather than pinning its wording.
const GENERIC_NOTICE = softNotice('an unclassified failure')

describe('detectProviderError', () => {
  test('preserves the raw errorMessage on `message` for operator surfaces (logs/TUI)', () => {
    const result = detectProviderError({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Your account is not active, please check your billing details on our website.',
    })

    expect(result?.message).toBe('Your account is not active, please check your billing details on our website.')
  })

  test('falls back to a generic raw message when stopReason=error has no errorMessage', () => {
    const result = detectProviderError({ role: 'assistant', stopReason: 'error' })

    expect(result?.message).toBe('LLM call failed')
  })

  test('falls back to a generic raw message when errorMessage is an empty string', () => {
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: '' })

    expect(result?.message).toBe('LLM call failed')
  })

  test('returns null for stopReason=aborted (user-initiated, not a provider failure)', () => {
    const result = detectProviderError({ role: 'assistant', stopReason: 'aborted', errorMessage: 'cancelled' })

    expect(result).toBeNull()
  })

  test('returns null for stopReason=stop (normal completion)', () => {
    const result = detectProviderError({ role: 'assistant', stopReason: 'stop' })

    expect(result).toBeNull()
  })

  test('returns null for non-assistant roles (user/toolResult)', () => {
    expect(detectProviderError({ role: 'user', stopReason: 'error' })).toBeNull()
    expect(detectProviderError({ role: 'toolResult', stopReason: 'error' })).toBeNull()
  })

  test('returns null for null, undefined, primitives, or arrays', () => {
    expect(detectProviderError(null)).toBeNull()
    expect(detectProviderError(undefined)).toBeNull()
    expect(detectProviderError('string')).toBeNull()
    expect(detectProviderError(42)).toBeNull()
    expect(detectProviderError([])).toBeNull()
  })

  test('returns null when errorMessage is present but stopReason is something other than error', () => {
    const result = detectProviderError({
      role: 'assistant',
      stopReason: 'tool_calls',
      errorMessage: 'should not surface',
    })

    expect(result).toBeNull()
  })
})

describe('detectProviderError safeMessage redaction', () => {
  test('maps a 401/unauthorized error to the auth-safe sentence without leaking a bearer token', () => {
    const raw = '401 Unauthorized: invalid api key (Authorization: Bearer sk-live-LEAK)'
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })

    expect(result?.safeMessage).toMatch(/unauthorized/i)
    expect(result?.safeMessage).toMatch(/API key/i)
    expect(result?.safeMessage).not.toContain('sk-live-LEAK')
    expect(result?.safeMessage).not.toContain('Bearer')
  })

  test('the bare "401 Unauthorized" shape (the production incident) maps to the auth class, not the generic notice', () => {
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: '401 Unauthorized' })

    expect(result?.safeMessage).toMatch(/unauthorized/i)
    expect(result?.safeMessage).not.toBe(GENERIC_NOTICE)
  })

  test('maps rate/usage-limit errors to a canonical channel-safe sentence', () => {
    const raw = 'You have hit your ChatGPT usage limit (team plan). Try again in ~40 min.'
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })

    expect(result?.safeMessage).toMatch(/rate-limited/i)
    expect(result?.safeMessage).not.toContain('team plan')
  })

  test('maps billing/quota errors to a billing-safe sentence without echoing the raw text', () => {
    const raw =
      'Your account is not active, please check your billing details on our website https://x.test/acct/secret-123.'
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })

    expect(result?.safeMessage).toMatch(/billing\/quota/i)
    expect(result?.safeMessage).not.toContain('secret-123')
    expect(result?.safeMessage).not.toContain('https://')
  })

  test('maps the Codex cyber_policy refusal to a specific notice naming the chatgpt.com/cyber path', () => {
    // given: the exact body Codex returns when its cybersecurity content policy fires
    const raw =
      'Codex error: {"type":"error","error":{"type":"invalid_request","code":"cyber_policy","message":"This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber","param":null},"sequence_number":3}'
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })

    expect(result?.safeMessage).toMatch(/content policy/i)
    expect(result?.safeMessage).toContain('https://chatgpt.com/cyber')
    expect(result?.safeMessage).not.toBe(GENERIC_NOTICE)
  })

  test('maps a Codex unsupported/misspelled-model 400 to an actionable model-config notice, not the generic one', () => {
    // given: the exact body Codex returns for a model id absent from the account catalog
    const raw =
      'Codex error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6\' model is not supported when using Codex with a ChatGPT account."}}'
    // when
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })
    // then: the operator sees a model-config hint instead of the generic notice, and the raw model id is not echoed to the channel
    expect(result?.safeMessage).toMatch(/unsupported or misspelled/i)
    expect(result?.safeMessage).not.toBe(GENERIC_NOTICE)
    expect(result?.safeMessage).not.toContain('gpt-5.6')
  })

  test('maps a NON-model invalid_request_error to the generic invalid-request notice, not the model-config one', () => {
    // given: an invalid_request_error that is NOT about the model (a missing param)
    const raw =
      'Codex error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Missing required parameter: \'input\'."}}'
    // when
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })
    // then: it is classified as invalid, but NOT blamed on the models setting
    expect(result?.safeMessage).toMatch(/rejected the request as invalid/i)
    expect(result?.safeMessage).not.toMatch(/unsupported or misspelled/i)
    expect(result?.safeMessage).not.toMatch(/models` setting/i)
  })

  test('maps a transport/session failure to a transport-safe sentence without echoing the wss URL', () => {
    const raw =
      "WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: Expected 101 status code"
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })

    expect(result?.safeMessage).toMatch(/session\/transport failure|dropped/i)
    expect(result?.safeMessage).not.toContain('wss://')
    expect(result?.safeMessage).not.toContain('chatgpt.com')
    expect(result?.safeMessage).not.toBe(GENERIC_NOTICE)
  })

  test('collapses unknown / malformed-response failures to a generic notice (no raw leak)', () => {
    const raw = 'malformed response: {"id":"resp_abc","debug":"Bearer sk-live-LEAK","body":"<html>500</html>"}'
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })

    expect(result?.safeMessage).toBe(GENERIC_NOTICE)
    expect(result?.safeMessage).not.toContain('sk-live-LEAK')
    expect(result?.safeMessage).not.toContain('resp_abc')
  })

  test('the generic notice does not blame the provider (an unclassified failure may be local)', () => {
    // given: unclassified text that could come from TypeClaw, the network or the provider
    for (const raw of ['The object can not be cloned.', 'Cannot read properties of undefined', '대화 준비 실패']) {
      // then: it collapses to the generic class, which names no origin
      expect(softNotice(raw)).toBe(GENERIC_NOTICE)
    }
    expect(GENERIC_NOTICE).not.toMatch(/upstream|provider/i)
  })

  test('still exposes the raw text on `message` even when `safeMessage` is redacted', () => {
    const raw = 'malformed response: Bearer sk-live-LEAK'
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })

    expect(result?.message).toBe(raw)
    expect(result?.safeMessage).not.toBe(raw)
  })
})

describe('detectHardProviderError', () => {
  test('maps an observer stall timeout to the timeout-safe sentence (not the generic notice)', () => {
    const raw = 'anthropic SSE body idle for 120000ms (typeclaw observer timeout)'
    const result = detectHardProviderError(new Error(raw))

    expect(result?.safeMessage).toMatch(/stopped responding|timed out/i)
    expect(result?.safeMessage).not.toBe(GENERIC_NOTICE)
    expect(result?.message).toBe(raw)
  })

  test('classifies rate-limit, billing/quota, and auth hard throws as provider failures', () => {
    expect(detectHardProviderError(new Error('429 All tokens rate limited'))?.safeMessage).toMatch(/rate-limited/i)
    expect(detectHardProviderError(new Error('insufficient quota'))?.safeMessage).toMatch(/billing\/quota/i)
    expect(detectHardProviderError(new Error('401 Unauthorized'))?.safeMessage).toMatch(/unauthorized/i)
  })

  test('maps a transport/session hard throw to the transport-safe sentence (the cron-report incident)', () => {
    const raw =
      "WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: Expected 101 status code (provider_transport_failure). Your ChatGPT session expired before this request finished."
    const result = detectHardProviderError(new Error(raw))

    expect(result?.safeMessage).toMatch(/session\/transport failure|dropped/i)
    expect(result?.safeMessage).not.toContain('chatgpt.com')
    expect(result?.message).toBe(raw)
  })

  test('returns null for internal / network errors so the caller stays silent-with-log', () => {
    expect(detectHardProviderError(new Error('network unreachable'))).toBeNull()
    expect(detectHardProviderError(new Error('Cannot read properties of undefined'))).toBeNull()
    expect(detectHardProviderError(new Error('ENOENT: no such file or directory'))).toBeNull()
  })

  test('accepts a non-Error throw by stringifying it', () => {
    expect(detectHardProviderError('503 Service Unavailable')?.safeMessage).toMatch(/timed out|rate-limited|failed/i)
    expect(detectHardProviderError('just a plain string')).toBeNull()
  })

  test('does not leak raw provider text through the safe message', () => {
    const raw = '429 rate limited (Authorization: Bearer sk-live-LEAK)'
    const result = detectHardProviderError(new Error(raw))

    expect(result?.safeMessage).not.toContain('sk-live-LEAK')
    expect(result?.safeMessage).not.toContain('Bearer')
  })
})

describe('isThrottleOrOverload', () => {
  test('matches the Codex `server_is_overloaded` shape (the production incident)', () => {
    // given: the exact body Codex returns under per-account 503 throttling
    const raw =
      'Codex error: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}}'

    expect(isThrottleOrOverload(raw)).toBe(true)
  })

  test('matches generic overload / capacity signals across providers', () => {
    expect(isThrottleOrOverload('the model is currently overloaded')).toBe(true)
    expect(isThrottleOrOverload('503 Service Unavailable')).toBe(true)
    expect(isThrottleOrOverload('service_unavailable_error')).toBe(true)
  })

  test('matches rate-limit / 429 signals', () => {
    expect(isThrottleOrOverload('rate limit exceeded')).toBe(true)
    expect(isThrottleOrOverload('You are being rate-limited')).toBe(true)
    expect(isThrottleOrOverload('HTTP 429 Too Many Requests')).toBe(true)
    expect(isThrottleOrOverload('too many requests, slow down')).toBe(true)
  })

  test('is case-insensitive', () => {
    expect(isThrottleOrOverload('SERVER_IS_OVERLOADED')).toBe(true)
    expect(isThrottleOrOverload('Rate Limit')).toBe(true)
  })

  test('does NOT match auth failures (401 must surface, not fail over)', () => {
    expect(isThrottleOrOverload('401 Unauthorized')).toBe(false)
    expect(isThrottleOrOverload('invalid api key')).toBe(false)
    expect(isThrottleOrOverload('authentication failed')).toBe(false)
  })

  test('does NOT match billing / quota failures (a different ref shares the same account problem)', () => {
    expect(isThrottleOrOverload('insufficient quota')).toBe(false)
    expect(isThrottleOrOverload('Your account is not active, please check your billing details')).toBe(false)
    expect(isThrottleOrOverload('payment required')).toBe(false)
  })

  test('does NOT match generic / unrelated failures', () => {
    expect(isThrottleOrOverload('malformed response')).toBe(false)
    expect(isThrottleOrOverload('LLM call failed')).toBe(false)
    expect(isThrottleOrOverload('context length exceeded')).toBe(false)
    expect(isThrottleOrOverload('')).toBe(false)
  })

  test('does NOT match the cyber_policy refusal (a content-policy block surfaces, never fails over)', () => {
    const raw =
      'Codex error: {"type":"error","error":{"type":"invalid_request","code":"cyber_policy","message":"This content was flagged for possible cybersecurity risk."}}'
    expect(isThrottleOrOverload(raw)).toBe(false)
  })

  test('does NOT false-positive on the substring "529" or unrelated digit runs (anchored codes only)', () => {
    // 429/503 are the throttle codes; an arbitrary number in prose must not match
    expect(isThrottleOrOverload('processed 4290 tokens')).toBe(false)
    expect(isThrottleOrOverload('elapsed 5030ms')).toBe(false)
  })

  test('a 429 carrying a quota/billing reason is NOT failover-worthy (denylist wins over the status code)', () => {
    expect(isThrottleOrOverload('Error code: 429 - insufficient quota')).toBe(false)
    expect(isThrottleOrOverload('429 payment required')).toBe(false)
    expect(isThrottleOrOverload('429 You exceeded your current quota, please check your billing')).toBe(false)
  })

  test('a 401/auth error carrying a status code is NOT failover-worthy', () => {
    expect(isThrottleOrOverload('429 unauthorized: invalid api key')).toBe(false)
  })

  test('a plain 429/503 with no quota/billing/auth reason still IS failover-worthy', () => {
    expect(isThrottleOrOverload('Error code: 429 - too many requests')).toBe(true)
    expect(isThrottleOrOverload('429 rate limit exceeded')).toBe(true)
    expect(isThrottleOrOverload('503 Service Unavailable')).toBe(true)
  })
})

describe('isFailoverWorthy', () => {
  test('an observer stall timeout IS failover-worthy (so a stall rotates to the next ref)', () => {
    expect(isFailoverWorthy('anthropic SSE body idle for 120000ms (typeclaw observer timeout)')).toBe(true)
    expect(
      isFailoverWorthy('codex fetch timed out before response headers after 15000ms (typeclaw observer timeout)'),
    ).toBe(true)
  })

  test('still fails over on throttle/overload (superset of isThrottleOrOverload)', () => {
    expect(isFailoverWorthy('server_is_overloaded')).toBe(true)
    expect(isFailoverWorthy('429 too many requests')).toBe(true)
  })

  test('does NOT fail over on account-wide faults (billing/quota/auth) or generic errors', () => {
    expect(isFailoverWorthy('insufficient quota')).toBe(false)
    expect(isFailoverWorthy('401 Unauthorized')).toBe(false)
    expect(isFailoverWorthy('network unreachable')).toBe(false)
  })

  test('does NOT fail over an unsupported/misspelled model (invalid_request_error) — a config error, not a transient one', () => {
    expect(
      isFailoverWorthy(
        'Codex error: {"error":{"type":"invalid_request_error","message":"The \'gpt-5.6\' model is not supported when using Codex with a ChatGPT account."}}',
      ),
    ).toBe(false)
  })

  test('does NOT fail over context overflow even when transport text is also present', () => {
    expect(isFailoverWorthy('context length exceeded')).toBe(false)
    expect(isFailoverWorthy('WebSocket closed 1000: context length exceeded')).toBe(false)
  })

  test('a provider transport / expired-session failure IS failover-worthy (the cron-report incident)', () => {
    expect(isFailoverWorthy('provider_transport_failure')).toBe(true)
    expect(
      isFailoverWorthy(
        "WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: Expected 101 status code",
      ),
    ).toBe(true)
    expect(isFailoverWorthy('Your ChatGPT session expired before this request finished.')).toBe(true)
  })

  test('a transport failure carrying an auth reason still surfaces (auth exclusion wins)', () => {
    expect(isFailoverWorthy('session expired: 401 unauthorized, invalid api key')).toBe(false)
  })

  test('a `session expired` message carrying an api-key fault does NOT fail over (shared AUTH_FAULT source)', () => {
    // The transport matcher matches "session expired", but an expired/invalid/missing
    // API key is an account-wide auth fault — a different ref shares it, so it must
    // surface, not rotate. Regression: NON_FAILOVER_FAULT once omitted the
    // `api key ... expired` shape the safe-message auth class matched.
    expect(isFailoverWorthy('session expired: api key expired')).toBe(false)
    expect(isFailoverWorthy('session expired - api key invalid')).toBe(false)
    expect(isFailoverWorthy('session expired, api key missing')).toBe(false)
  })

  test('the api-key-fault-carrying transport error redacts to the auth safe sentence, not the transport one', () => {
    const result = detectHardProviderError(new Error('session expired: api key expired'))
    expect(result?.safeMessage).toMatch(/unauthorized|API key/i)
    expect(result?.safeMessage).not.toMatch(/session\/transport failure|dropped/i)
  })
})

describe('isRetryableSameRef', () => {
  test('retries transport/session, observer-stall, and network/5xx blips (same-model replay)', () => {
    expect(isRetryableSameRef('provider_transport_failure')).toBe(true)
    expect(isRetryableSameRef('Your ChatGPT session expired before this request finished.')).toBe(true)
    expect(isRetryableSameRef('anthropic SSE body idle for 120000ms (typeclaw observer timeout)')).toBe(true)
    expect(isRetryableSameRef('socket hang up')).toBe(true)
    expect(isRetryableSameRef('ECONNRESET')).toBe(true)
    expect(isRetryableSameRef('fetch failed')).toBe(true)
    expect(isRetryableSameRef('500 Internal Server Error')).toBe(true)
    expect(isRetryableSameRef('WebSocket closed 1000')).toBe(true)
    expect(isRetryableSameRef('websocket connection was closed normally')).toBe(true)
  })

  test('does NOT same-ref retry throttle/overload — those fail OVER to another ref', () => {
    expect(isRetryableSameRef('server_is_overloaded')).toBe(false)
    expect(isRetryableSameRef('429 too many requests')).toBe(false)
    expect(isRetryableSameRef('503 Service Unavailable')).toBe(false)
  })

  test('does NOT same-ref retry an unsupported model / invalid_request_error — replaying the same bad model can never clear it', () => {
    expect(
      isRetryableSameRef(
        'Codex error: {"error":{"type":"invalid_request_error","message":"The \'gpt-5.6\' model is not supported when using Codex with a ChatGPT account."}}',
      ),
    ).toBe(false)
  })

  test('does NOT same-ref retry account-wide faults (auth/billing/quota) — those surface', () => {
    expect(isRetryableSameRef('401 Unauthorized')).toBe(false)
    expect(isRetryableSameRef('insufficient quota')).toBe(false)
    expect(isRetryableSameRef('session expired: api key expired')).toBe(false)
    expect(isRetryableSameRef('WebSocket closed 1000: 401 Unauthorized')).toBe(false)
    expect(isRetryableSameRef('WebSocket closed 1000: 403 Forbidden')).toBe(false)
    expect(isRetryableSameRef('WebSocket closed 1000: access denied')).toBe(false)
    expect(isRetryableSameRef('WebSocket closed 1000: access token expired')).toBe(false)
    expect(isRetryableSameRef('WebSocket closed 1000: session token has expired')).toBe(false)
    expect(isRetryableSameRef('WebSocket closed 1000: authentication_error')).toBe(false)
    expect(isRetryableSameRef('websocket connection closed: billing quota exhausted')).toBe(false)
  })

  test('does NOT same-ref retry context-overflow or generic errors (compaction / surface own it)', () => {
    expect(isRetryableSameRef('context length exceeded')).toBe(false)
    expect(isRetryableSameRef('WebSocket closed 1000: context length exceeded')).toBe(false)
    expect(isRetryableSameRef('malformed response')).toBe(false)
  })
})

type FakeListener = (event: { type: string; message?: unknown }) => void

function fakeSession(): {
  session: AgentSession
  abortRetryCalls: string[]
  emit: (event: { type: string; message?: unknown }) => void
} {
  const listeners = new Set<FakeListener>()
  const abortRetryCalls: string[] = []
  const session = {
    subscribe: (cb: FakeListener) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    abortRetry: () => abortRetryCalls.push('abortRetry'),
  } as unknown as AgentSession
  return {
    session,
    abortRetryCalls,
    emit: (event) => {
      for (const cb of listeners) cb(event)
    },
  }
}

describe('SDK retry contract smoke', () => {
  test('pi AgentSession exposes retry controls used by provider-error failover', () => {
    expect(typeof PiAgentSession.prototype.abortRetry).toBe('function')
    expect(typeof PiAgentSession.prototype.setAutoRetryEnabled).toBe('function')
    expect(typeof SettingsManager.prototype.getRetrySettings).toBe('function')
  })
})

describe('subscribeProviderErrors', () => {
  test('invokes onError exactly once per detected provider error', () => {
    const { session, emit } = fakeSession()
    const calls: string[] = []
    subscribeProviderErrors(session, (err) => calls.push(err.message))

    emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'rate limited' },
    })
    emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'billing fail' },
    })

    expect(calls).toEqual(['rate limited', 'billing fail'])
  })

  test('ignores non-message_end events even if they carry an error-looking payload', () => {
    const { session, emit } = fakeSession()
    const calls: string[] = []
    subscribeProviderErrors(session, (err) => calls.push(err.message))

    emit({ type: 'message_update', message: { role: 'assistant', stopReason: 'error' } })
    emit({ type: 'tool_execution_start', message: { role: 'assistant', stopReason: 'error' } })

    expect(calls).toEqual([])
  })

  test('ignores message_end events with stopReason=stop / aborted / non-assistant roles', () => {
    const { session, emit } = fakeSession()
    const calls: string[] = []
    subscribeProviderErrors(session, (err) => calls.push(err.message))

    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } })
    emit({ type: 'message_end', message: { role: 'user', stopReason: 'error' } })

    expect(calls).toEqual([])
  })

  test('returns an unsubscribe handle that detaches the listener', () => {
    const { session, emit } = fakeSession()
    const calls: string[] = []
    const unsub = subscribeProviderErrors(session, (err) => calls.push(err.message))

    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'first' } })
    unsub()
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'second' } })

    expect(calls).toEqual(['first'])
  })

  test('aborts the SDK retry loop exactly once for a throttle-classified provider error', () => {
    const { session, emit, abortRetryCalls } = fakeSession()
    subscribeProviderErrors(session, () => {})

    emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'server_is_overloaded' },
    })

    expect(abortRetryCalls).toEqual(['abortRetry'])
  })

  test('keeps SDK retry running for a non-throttle provider error', () => {
    const { session, emit, abortRetryCalls } = fakeSession()
    subscribeProviderErrors(session, () => {})

    emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'malformed response' },
    })

    expect(abortRetryCalls).toEqual([])
  })
})

type TransformContext = NonNullable<Parameters<typeof wrapTransformContextWithLocalFailureMarker>[0]>

// Throws `thrown` from a transformContext wrapped the way sessions wrap theirs
// and returns what reaches pi (whose `.message` becomes the turn's errorMessage).
async function failPreparation(
  thrown: unknown,
  options: { sync?: boolean; signal?: AbortSignal; wraps?: number } = {},
): Promise<Error> {
  let transform: TransformContext = options.sync
    ? () => {
        throw thrown
      }
    : async () => {
        throw thrown
      }
  for (let i = 0; i < (options.wraps ?? 1); i++) transform = wrapTransformContextWithLocalFailureMarker(transform)
  try {
    await transform([], options.signal)
  } catch (err) {
    return err as Error
  }
  throw new Error('expected the wrapped transformContext to reject')
}

async function localErrorMessage(raw: string): Promise<string> {
  return (await failPreparation(new Error(raw))).message
}

const LOCAL_NOTICE = softNotice(await localErrorMessage('placeholder preparation failure'))

describe('local pre-request failures', () => {
  test('get their own notice, ahead of provider-looking text the local error carries', async () => {
    expect(LOCAL_NOTICE).not.toBe(GENERIC_NOTICE)
    // given: local errors whose text alone would land in a provider class
    const raws = [
      '401 Unauthorized (Authorization: Bearer sk-live-LEAK)',
      'HTTP 429 Too Many Requests',
      'Error code: 429 - insufficient_quota',
      'see billing details at https://x.test/acct/secret-123',
      '도구 결과에 401 인증 오류가 있음',
    ]
    for (const raw of raws) {
      const notice = softNotice(await localErrorMessage(raw))
      // then: the local class wins and none of the raw text reaches the notice
      expect(softNotice(raw)).not.toBe(LOCAL_NOTICE)
      expect(notice).toBe(LOCAL_NOTICE)
      for (const leak of ['sk-live-LEAK', 'Bearer', 'secret-123', 'https://', '도구']) {
        expect(notice).not.toContain(leak)
      }
    }
  })

  test('are never retried on the same ref, failed over, or treated as throttling or a TTFB stall', async () => {
    // given: local errors whose text alone would retry, fail over, throttle or count as a stall
    const raws = [
      '500 Internal Server Error',
      'socket hang up',
      '503 overloaded',
      '429 rate limit exceeded',
      'provider_transport_failure',
      'idle for 120000ms (typeclaw observer timeout)',
      'codex fetch timed out before response headers after 15000ms (typeclaw observer timeout)',
    ]
    for (const raw of raws) {
      expect(isFailoverWorthy(raw) || isRetryableSameRef(raw)).toBe(true)
      const marked = await localErrorMessage(raw)
      expect(isFailoverWorthy(marked)).toBe(false)
      expect(isRetryableSameRef(marked)).toBe(false)
      expect(isThrottleOrOverload(marked)).toBe(false)
      expect(isObserverTtfbTimeout(marked)).toBe(false)
    }
    expect(
      isObserverTtfbTimeout('codex fetch timed out before response headers after 15000ms (typeclaw observer timeout)'),
    ).toBe(true)
  })

  test('do not abort the SDK retry loop the way a throttle does', async () => {
    const { session, emit, abortRetryCalls } = fakeSession()
    const notices: string[] = []
    subscribeProviderErrors(session, (err) => notices.push(err.safeMessage))

    emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: await localErrorMessage('503 overloaded') },
    })

    expect(notices).toEqual([LOCAL_NOTICE])
    expect(abortRetryCalls).toEqual([])
  })

  test('a marked hard throw surfaces the local notice; an unmarked internal throw stays silent', async () => {
    const marked = await failPreparation(new TypeError('The object can not be cloned.'))
    const hard = detectHardProviderError(marked)

    expect(hard?.safeMessage).toBe(LOCAL_NOTICE)
    expect(hard?.message).toBe(marked.message)
    expect(detectHardProviderError(new TypeError('The object can not be cloned.'))).toBeNull()
    expect(detectHardProviderError(new Error('Cannot read properties of undefined'))).toBeNull()
  })

  test('unmarked failures are not attributed to TypeClaw, whatever their text', () => {
    for (const raw of ['The object can not be cloned.', 'Cannot read properties of undefined', '503 overloaded']) {
      expect(softNotice(raw)).not.toBe(LOCAL_NOTICE)
    }
  })

  test('only a marker ending the message counts, so echoed text cannot claim local origin', async () => {
    const spoofed = `${await localErrorMessage('placeholder')} then 503 overloaded`

    expect(softNotice(spoofed)).not.toBe(LOCAL_NOTICE)
    expect(isThrottleOrOverload(spoofed)).toBe(true)
  })
})

describe('wrapTransformContextWithLocalFailureMarker', () => {
  test('marks sync and async throws, keeping the original as cause and its text for operators', async () => {
    for (const sync of [false, true]) {
      const original = new RangeError('cannot prepare /private/placeholder/path')
      const err = await failPreparation(original, { sync })

      expect(err).toBeInstanceOf(Error)
      expect(err.cause).toBe(original)
      expect(err.message).toContain('cannot prepare /private/placeholder/path')
      expect(softNotice(err.message)).toBe(LOCAL_NOTICE)
      expect(softNotice(err.message)).not.toContain('/private/')
    }
  })

  test('non-Error throws and hostile names cannot break or leak through the marker', async () => {
    const badName = Object.assign(new Error('boom'), { name: 'Bad)\n(name' })
    const unprintable = {
      toString() {
        throw new Error('toString exploded')
      },
    }

    for (const thrown of [badName, unprintable, 'Bearer sk-live-LEAK', 42, null]) {
      const err = await failPreparation(thrown)

      expect(err).toBeInstanceOf(Error)
      expect(err.cause).toBe(thrown)
      expect(err.message).not.toContain('\n')
      expect(softNotice(err.message)).toBe(LOCAL_NOTICE)
      expect(softNotice(err.message)).not.toContain('sk-live-LEAK')
    }
  })

  test('an already-marked failure is not marked again by an outer wrapper', async () => {
    const original = new Error('placeholder')
    const err = await failPreparation(original, { wraps: 2 })

    expect(err.cause).toBe(original)
    expect(softNotice(err.message)).toBe(LOCAL_NOTICE)
  })

  test('a throw after the signal aborted is rethrown untouched (a cancellation, not a failure)', async () => {
    const controller = new AbortController()
    controller.abort()
    const original = new Error('placeholder cancel')

    expect(await failPreparation(original, { signal: controller.signal })).toBe(original)
  })
})

describe('local pre-request failures through a real pi Agent', () => {
  function agentWithFauxProvider(transformContext: TransformContext) {
    const faux = fauxProvider({ provider: 'provider-error-local-test' })
    const models = createModels()
    models.setProvider(faux.provider)
    const agent = new Agent({
      initialState: { model: faux.getModel() },
      streamFn: models.streamSimple.bind(models),
      transformContext: wrapTransformContextWithLocalFailureMarker(transformContext),
    })
    const ended: unknown[] = []
    agent.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') ended.push(event.message)
    })
    return { agent, faux, ended }
  }

  test('a context-preparation throw ends the turn with the local notice before any provider call', async () => {
    // given: preparation clones a message whose details hold a function (DataCloneError)
    const handlerDetail = { role: 'custom', details: { handler: async () => {} } } as unknown as AgentMessage
    const { agent, faux, ended } = agentWithFauxProvider(async (messages) =>
      structuredClone([...messages, handlerDetail]),
    )

    await agent.prompt('hi')

    expect(faux.state.callCount).toBe(0)
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ stopReason: 'error' })
    expect(detectProviderError(ended[0])?.safeMessage).toBe(LOCAL_NOTICE)
  })

  test('aborting during preparation stays an unmarked abort with no notice', async () => {
    const started = Promise.withResolvers<void>()
    const { agent, faux, ended } = agentWithFauxProvider((_messages, signal) => {
      const prepared = Promise.withResolvers<AgentMessage[]>()
      signal?.addEventListener('abort', () => prepared.reject(new Error('preparation cancelled')), { once: true })
      started.resolve()
      return prepared.promise
    })

    const run = agent.prompt('hi')
    await started.promise
    agent.abort()
    await run

    expect(faux.state.callCount).toBe(0)
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ stopReason: 'aborted', errorMessage: 'preparation cancelled' })
    expect(detectProviderError(ended[0])).toBeNull()
  })

  test('a real provider error after preparation keeps its provider class', async () => {
    const { agent, faux, ended } = agentWithFauxProvider(async (messages) => messages)
    faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 Unauthorized' })])

    await agent.prompt('hi')

    expect(faux.state.callCount).toBe(1)
    expect(ended[0]).toMatchObject({ stopReason: 'error', errorMessage: '401 Unauthorized' })
    expect(detectProviderError(ended[0])?.safeMessage).toBe(softNotice('401 Unauthorized'))
    expect(detectProviderError(ended[0])?.safeMessage).not.toBe(LOCAL_NOTICE)
  })
})
