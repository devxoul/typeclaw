import type { AgentSession } from './index'

// pi-coding-agent encodes upstream LLM failures (billing, rate limit, network,
// malformed response, etc.) in the assistant message itself rather than
// throwing — `stopReason: 'error'` with a populated `errorMessage`. Code that
// only catches throws around `session.prompt()` therefore never sees these:
// the prompt resolves normally, no text deltas were emitted, and the only
// signal is the final `message_end` event. Channels, cron, and subagents all
// have to subscribe to surface these soft errors.
//
// Hard throws (timeouts, network drops, etc.) come out of the upstream wrapper
// as exceptions and are handled by the surrounding try/catch in each caller —
// not by this helper.

export type DetectedProviderError = {
  // Raw provider text. Safe for logs and operator-only surfaces (TUI,
  // `typeclaw logs`), but NOT for channels — see `safeMessage`.
  message: string
  // Redacted, user-facing variant for public/multi-user channels. Known-safe
  // operational classes (rate/usage limit, billing/quota) map to a canonical
  // sentence; everything else (malformed-response SDK dumps, unknown failures)
  // collapses to a generic notice so provider response bodies, URLs, or tokens
  // can never leak to a channel.
  safeMessage: string
}

// Origin-neutral on purpose: an unclassified failure may come from the
// provider, the network, or TypeClaw itself, and the raw text alone can't say
// which. Naming the provider here blamed it for local bugs.
const GENERIC_SAFE_NOTICE = 'The assistant turn failed. Operators can check `typeclaw logs` for details.'

// pi-agent-core turns ANY throw inside its loop into the same
// `stopReason: 'error'` assistant message a provider failure produces, keeping
// only `errorMessage` (agent.js handleRunFailure) — the error's name, cause and
// throw site are dropped. So origin must be stamped into the message at the
// throw site: `wrapTransformContextWithLocalFailureMarker` appends this marker
// when the context-preparation step that runs before the next provider request
// throws. It covers only that request; earlier requests in the same run may
// have reached the provider. Anchored at the end so provider text echoed
// mid-message can't impersonate it. System token — English by design, like
// OBSERVER_TIMEOUT.
const LOCAL_FAILURE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const LOCAL_PRE_REQUEST_FAILURE = /\(typeclaw local failure before provider request: [A-Za-z][A-Za-z0-9_]{0,63}\)$/

type TransformContext = NonNullable<AgentSession['agent']['transformContext']>

function readOr<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

// Only an identifier-shaped `Error.name` is embedded, so a hostile or odd name
// can't inject parentheses/newlines into the marker. The raw text stays on the
// message for logs and operator surfaces; channels only ever see the fixed
// LOCAL sentence, never this text. Reading a throwing getter/`toString` must
// not replace the original failure with a new one.
function markLocalPreRequestFailure(err: unknown): Error {
  const isError = readOr(() => err instanceof Error, false)
  const text = readOr(() => String(isError ? (err as Error).message : err), 'unprintable thrown value')
  if (isError && LOCAL_PRE_REQUEST_FAILURE.test(text)) return err as Error
  const rawName = readOr(() => (isError ? (err as Error).name : undefined), undefined)
  const name = typeof rawName === 'string' && LOCAL_FAILURE_NAME.test(rawName) ? rawName : 'Error'
  return new Error(`${text} (typeclaw local failure before provider request: ${name})`, { cause: err })
}

// Wraps an agent's `transformContext` (the step pi runs right before
// `convertToLlm`/`getApiKey`/`streamFunction` on every request) so a throw from
// it — sync or async — is re-thrown with the local-origin marker. An abort is
// re-thrown untouched: it's a cancellation, and pi reports it as `aborted`.
export function wrapTransformContextWithLocalFailureMarker(inner: TransformContext | undefined): TransformContext {
  return async (messages, signal) => {
    if (!inner) return messages
    try {
      return await inner(messages, signal)
    } catch (err) {
      if (signal?.aborted) throw err
      throw markLocalPreRequestFailure(err)
    }
  }
}

// The fetch observer (`llm-fetch-observer`) aborts a stalled provider stream
// with a message ending in this marker (TTFB / idle / overall deadline). Such a
// stall is a hard throw, not a `stopReason: 'error'` soft error, so it never
// reaches `detectProviderError`; the marker lets the hard-throw path recognize
// and surface it. The literal is the system's own token — English by design.
const OBSERVER_TIMEOUT = /\(typeclaw observer timeout\)/i
const OBSERVER_TTFB_TIMEOUT = /timed out before response headers/i

// Transport-layer failure: the request died at the connection/session before a
// usable response — an expired live session, a WebSocket upgrade that never
// reached `101 Switching Protocols`, or a dropped transport. Unlike an
// account-wide auth/billing fault, this is transient AND ref-specific: a
// different ref opens its own session, so failing OVER can succeed. Observed from
// Codex/ChatGPT (`provider_transport_failure`, expired ChatGPT session, a
// `wss://…/codex/responses` non-101 upgrade). Provider protocol tokens — English
// by design (the system-token exception to the multi-language rule).
const TRANSPORT_FAILURE =
  /provider[_ -]?transport[_ -]?failure|(?:websocket|ws)(?: connection)?(?:(?: was| is)? closed|.*failed)|expected 101|session expired/i

// Auth failure: the provider rejected our credentials (bad/expired/missing API
// key or token, 401/403, failed authentication). Account-wide — a different ref shares the
// same credential problem — so this is BOTH a redacted safe-message class (a
// 401 body can carry a Bearer token) AND a NON_FAILOVER_FAULT reason. Shared as
// one constant so the two uses can never drift: previously the safe-message copy
// matched `api key ... expired` but the failover copy didn't, letting
// `session expired: api key expired` wrongly fail over past the auth guard.
const AUTH_FAULT =
  /\b(401|403|unauthori[sz]ed|forbidden|access denied|invalid[_ -]?api[_ -]?key|api key.*(?:invalid|expired|missing)|(?:access|session)[_ -]?token(?:(?:[_ -]+)(?:has|is))?[_ -]+expired|authentication(?: failed|[_ -]?error)|invalid bearer)\b/i

// Unsupported-or-misspelled MODEL id specifically. Codex returns
// `{"type":"invalid_request_error","message":"The 'gpt-5.6' model is not
// supported when using Codex with a ChatGPT account."}` for a model that isn't
// in the account's catalog. This is account/config-wide: retrying or failing
// over to another ref can't fix a bad `models` entry, so it is BOTH a redacted
// safe-message class (an actionable "check your model config" notice, not the
// generic one) AND a NON_FAILOVER_FAULT reason. Shared as one constant so the
// two uses can't drift (mirrors AUTH_FAULT). Matched against the raw JSON body:
// pi-ai's Codex adapter can't lift the nested `error.message` and stringifies
// the whole event, so the text is the raw payload.
//
// This is deliberately NARROWER than "any invalid_request_error": OpenAI's
// `BadRequestError`/`invalid_request_error` also covers missing parameters,
// out-of-range values, and encoding/format/size problems — none of which are a
// model-config issue. Requiring model-specific evidence (`model_not_found`, or
// a `… model … not supported` / `model = …` phrasing) keeps the model notice
// from misdiagnosing those. Bare invalid requests are handled by
// `INVALID_REQUEST` below.
const INVALID_MODEL =
  /\bmodel_not_found\b|\bmodel\b[^"]*\bnot supported\b|\bnot supported\b[^"]*\bmodel\b|\bunsupported\b[^"]*\bmodel\b|\bunknown model\b|\binvalid model\b/i

// Any OTHER provider-side invalid request: a malformed body, a missing/invalid
// parameter, a bad value, or an encoding/format/size problem. Still not fixable
// by retrying or failing over the SAME payload to another ref, so it stays a
// NON_FAILOVER_FAULT reason — but it gets a GENERIC invalid-request message, not
// the model-config notice, so a non-model 400 is never misattributed to the
// `models` setting. Anchored on the provider's own `invalid_request_error`
// token so it doesn't match natural-language prose.
const INVALID_REQUEST = /\binvalid_request_error\b/i

// Each entry pairs a narrow matcher against the raw provider text with the
// canonical, leak-free sentence shown in channels. Matchers are intentionally
// specific: a miss falls through to GENERIC_SAFE_NOTICE rather than echoing raw
// text, so adding a new class is opt-in and never widens what we expose.
const SAFE_CLASSES: ReadonlyArray<{ match: RegExp; safe: string }> = [
  {
    // First, so provider-looking text inside a local error (a `401` or `429`
    // echoed by a tool, a `quota` word) can't pull it into a provider class.
    match: LOCAL_PRE_REQUEST_FAILURE,
    safe: 'TypeClaw could not prepare the conversation for the LLM request. Operators can check `typeclaw logs` for details.',
  },
  {
    // Matched before billing because a 401 body can also mention "account",
    // which would otherwise fall into the billing class below.
    match: AUTH_FAULT,
    safe: 'The upstream LLM provider rejected the request as unauthorized. Operators should check the provider API key configuration and `typeclaw logs`.',
  },
  {
    // Content-policy refusal: OpenAI Codex flags a prompt under its cybersecurity
    // policy (`code: "cyber_policy"`) and rejects the whole turn with
    // `invalid_request`. Retrying or failing over to another Codex ref can't help
    // — it's the same account-wide policy — so this must surface with the operator
    // action (get the account authorized) rather than collapse to the generic
    // notice. Common for security-focused PR reviews, where the diff content trips
    // the filter. The URL is OpenAI's own published enrollment page, safe to echo.
    match: /\bcyber_policy\b/i,
    safe: 'The upstream LLM provider (OpenAI Codex) refused the request under its cybersecurity content policy. Operators must enroll the account in OpenAI Trusted Access for Cyber at https://chatgpt.com/cyber, or switch the configured model.',
  },
  {
    // Model-specific invalid request — an unsupported or misspelled model id.
    // Placed AFTER cyber_policy so a policy refusal keeps its more specific
    // notice, and BEFORE the generic INVALID_REQUEST below so a model error gets
    // the actionable `models`-setting hint rather than the generic invalid-request
    // sentence. Requires model evidence, so a non-model 400 falls through here.
    match: INVALID_MODEL,
    safe: 'The upstream LLM provider rejected the request as invalid — the configured model is likely unsupported or misspelled. Operators should check the `models` setting in typeclaw.json and `typeclaw logs`.',
  },
  {
    // Any other provider-side invalid request (malformed body, missing/invalid
    // parameter, size/format problem). Distinct GENERIC wording — it is NOT
    // attributed to the model config, since the evidence above didn't match.
    match: INVALID_REQUEST,
    safe: 'The upstream LLM provider rejected the request as invalid. Operators can check `typeclaw logs` for details.',
  },
  {
    match: /\b(usage limit|rate limit|rate.?limited|too many requests|429)\b/i,
    safe: 'The upstream LLM provider is rate-limited (usage limit reached). Try again shortly.',
  },
  {
    match: /\b(billing|quota|insufficient.*(credit|fund|balance)|payment|account is not active)\b/i,
    safe: 'The upstream LLM provider rejected the request for a billing/quota reason. Operators can check `typeclaw logs` for details.',
  },
  {
    match: OBSERVER_TIMEOUT,
    safe: 'The upstream LLM provider stopped responding and the request timed out. Try again shortly.',
  },
  {
    match: TRANSPORT_FAILURE,
    safe: 'The connection to the upstream LLM provider dropped (session/transport failure). Try again shortly.',
  },
]

function toSafeMessage(raw: string): string {
  for (const { match, safe } of SAFE_CLASSES) {
    if (match.test(raw)) return safe
  }
  return GENERIC_SAFE_NOTICE
}

// Capacity/rate signals worth failing OVER to another model ref (vs. retrying
// the same one). English-only is correct — these are provider protocol tokens,
// the explicit system-token exception to the multi-language rule. `\b` anchors
// `429`/`503` so they don't match digit runs in prose (token counts,
// elapsed-ms); `\b` is ASCII-safe because these are ASCII-only codes.
const THROTTLE_OR_OVERLOAD =
  /overloaded|server_is_overloaded|service.?unavailable|rate.?limit|rate.?limited|too many requests|\b(?:429|503)\b/i

// Account-wide faults that must SURFACE, never fail over: switching refs can't
// help (same account) and would mask a config error the operator must fix. This
// is checked BEFORE the throttle match because providers often pair a `429`
// status with a quota/billing/auth reason (e.g. `429 insufficient quota`) — the
// status code alone must not force a pointless failover. The auth arm reuses the
// shared `AUTH_FAULT` source so it stays in lockstep with the safe-message class.
// A local pre-request failure is in the same bucket: preparing the context is
// model-independent, so every ref (and a same-ref replay) would fail the same
// way — and it must never count as provider throttling.
const NON_FAILOVER_FAULT = new RegExp(
  `${LOCAL_PRE_REQUEST_FAILURE.source}|${INVALID_MODEL.source}|${INVALID_REQUEST.source}|\\bcyber_policy\\b|insufficient.*(?:quota|credit|fund|balance)|\\bquota\\b|billing|payment|account is not active|${AUTH_FAULT.source}`,
  'i',
)

// Context-window exhaustion belongs to the SDK compaction/error path, never
// transport recovery. Keep this to provider protocol forms rather than matching
// natural-language user text.
const CONTEXT_OVERFLOW = /\bcontext[_ -]?length[_ -]?exceeded\b/i

export function isThrottleOrOverload(raw: string): boolean {
  if (NON_FAILOVER_FAULT.test(raw)) return false
  return THROTTLE_OR_OVERLOAD.test(raw)
}

// A local pre-request failure can carry observer text it merely echoes; the
// request it was preparing was never sent, so it must not count toward the
// no-progress envelope or trip the codex provider circuit.
export function isObserverTtfbTimeout(raw: string): boolean {
  if (LOCAL_PRE_REQUEST_FAILURE.test(raw)) return false
  return OBSERVER_TIMEOUT.test(raw) && OBSERVER_TTFB_TIMEOUT.test(raw)
}

// Failover predicate for turn-drivers' `shouldFailover`: rotate to the next model
// ref on a transient capacity signal (throttle/overload), an observer stall
// timeout, or a transport/session failure. A stall or a dropped session is as
// transient as an overload and another ref (its own session/transport) may well
// succeed, so it must fail OVER before the caller surfaces a failure notice.
// Account-wide faults (billing/quota/auth) are excluded up front — a different
// ref shares the same account problem, so switching can't help.
export function isFailoverWorthy(raw: string): boolean {
  if (CONTEXT_OVERFLOW.test(raw)) return false
  if (NON_FAILOVER_FAULT.test(raw)) return false
  return isThrottleOrOverload(raw) || OBSERVER_TIMEOUT.test(raw) || TRANSPORT_FAILURE.test(raw)
}

// Transient network / upstream 5xx signals that a same-model replay may clear.
// Distinct from THROTTLE_OR_OVERLOAD (429/503/overload) on purpose: an overload
// means the model is out of capacity NOW, so the right move is to fail OVER to a
// different ref, not hammer the same one — whereas a socket hang-up or a 500 is a
// one-off blip a replay against the SAME ref often fixes. `\b` anchors the 5xx
// codes so they don't match digit runs in prose. Provider protocol tokens —
// English by design (the system-token exception to the multi-language rule).
const NETWORK_OR_5XX =
  /econnreset|econnrefused|etimedout|enetunreach|socket hang up|network.?error|connection.?(?:error|refused|reset|lost)|fetch failed|other side closed|reset before headers|http2 request did not get a response|\b(?:500|502|504)\b/i

// Retry predicate for typeclaw-owned SAME-REF retry: replay the SAME model ref
// before advancing the chain. Deliberately NARROWER than `isFailoverWorthy` —
// only transient failures a same-model replay can plausibly clear: transport/
// session drops, observer stalls, and network/5xx blips. It intentionally EXCLUDES
// throttle/overload (429/503) — those mean "this ref is out of capacity now", so
// they should fail OVER to another ref rather than burn same-ref retries — and
// account-wide faults (auth/billing/quota/cyber_policy), which must surface.
// NOTE the overload exclusion assumes a ref to fail over to EXISTS. When one does
// not (last usable ref, or a single-ref chain), the callers apply their own
// capacity backoff on top of this predicate rather than widening it — see
// overloadRetryBudget in retry-same-ref.ts. Widening it here instead would make
// every ref in a healthy chain burn retries before failing over. It
// does NOT match context-overflow: that stays on the SDK compaction path and must
// never be treated as a retryable provider failure.
export function isRetryableSameRef(raw: string): boolean {
  if (CONTEXT_OVERFLOW.test(raw)) return false
  if (NON_FAILOVER_FAULT.test(raw)) return false
  if (isThrottleOrOverload(raw)) return false
  return TRANSPORT_FAILURE.test(raw) || OBSERVER_TIMEOUT.test(raw) || NETWORK_OR_5XX.test(raw)
}

export function detectProviderError(message: unknown): DetectedProviderError | null {
  if (typeof message !== 'object' || message === null) return null
  const m = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown }
  if (m.role !== 'assistant') return null
  // 'aborted' is fired when the user hits Escape — not a provider failure,
  // and the TUI shows its own abort feedback elsewhere. Channels/cron just
  // ignore aborts (no surface to render them on).
  if (m.stopReason !== 'error') return null
  const text = typeof m.errorMessage === 'string' && m.errorMessage.length > 0 ? m.errorMessage : 'LLM call failed'
  return { message: text, safeMessage: toSafeMessage(text) }
}

// Classifies a HARD-thrown error (an exception out of `session.prompt()`, after
// model fallback is exhausted) into a user-facing notice — the throw counterpart
// to `detectProviderError`'s soft-error path. Returns `null` for errors that are
// NOT an operator-actionable provider failure (internal bugs, network blips),
// so the caller stays silent-with-log rather than spamming channels. The three
// recognized classes are: failover-worthy throttle/overload, account-wide faults
// (billing/quota/auth) that must surface, and observer stall timeouts. A throw
// carrying the local pre-request marker surfaces too (via NON_FAILOVER_FAULT)
// with the LOCAL notice; an unmarked internal error still returns `null`.
export function detectHardProviderError(err: unknown): DetectedProviderError | null {
  const message = err instanceof Error ? err.message : String(err)
  const isProviderFailure =
    isThrottleOrOverload(message) ||
    NON_FAILOVER_FAULT.test(message) ||
    OBSERVER_TIMEOUT.test(message) ||
    TRANSPORT_FAILURE.test(message)
  if (!isProviderFailure) return null
  return { message, safeMessage: toSafeMessage(message) }
}

export type ProviderErrorListener = (error: DetectedProviderError) => void
export type Unsubscribe = () => void

// Subscribes to `message_end` events on `session` and invokes `onError` once
// per detected provider error. Returns the unsubscribe handle from the
// underlying `session.subscribe`. Callers MUST unsubscribe when the session
// is disposed to avoid leaks across sessions.
export function subscribeProviderErrors(session: AgentSession, onError: ProviderErrorListener): Unsubscribe {
  return session.subscribe((event) => {
    if (event.type !== 'message_end') return
    const detected = detectProviderError(event.message)
    if (detected === null) return
    const abortRetry = (session as { abortRetry?: unknown }).abortRetry
    if (isThrottleOrOverload(detected.message) && typeof abortRetry === 'function') abortRetry.call(session)
    onError(detected)
  })
}
