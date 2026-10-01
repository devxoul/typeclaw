// Minimal structural view of the pieces of pi's AgentSession this module
// touches. Declared locally (not imported) so the pure nudge logic stays
// testable with a hand-rolled fake and does not drag in the full session type.
export type NudgeableSession = {
  subscribe: (listener: (event: unknown) => void) => () => void
  steer: (text: string) => Promise<unknown>
}

const NOT_FOUND_RE = /^Tool (.+?) not found$/

// Levenshtein distance ceiling for a name to count as "did you mean". A typo
// like websearch -> web_search is distance 1 (one '_' inserted); read_file ->
// read is larger but still a clear prefix relationship. Keeping the ceiling
// small avoids suggesting an unrelated tool for a genuinely unknown name.
const MAX_SUGGESTION_DISTANCE = 4

export function extractNotFoundToolName(resultText: string): string | null {
  const match = NOT_FOUND_RE.exec(resultText.trim())
  return match?.[1] ?? null
}

export function closestToolName(requested: string, known: readonly string[]): string | null {
  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of known) {
    if (candidate === requested) return candidate
    const distance = boundedLevenshtein(requested, candidate, MAX_SUGGESTION_DISTANCE)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return bestDistance <= MAX_SUGGESTION_DISTANCE ? best : null
}

export function renderToolNotFoundNudge(requested: string, suggestion: string): string {
  return (
    `<system-reminder>\n` +
    `You called the tool \`${requested}\`, which does not exist. ` +
    `Did you mean \`${suggestion}\`? Re-issue the call using the exact name \`${suggestion}\`.\n` +
    `</system-reminder>`
  )
}

export function buildToolNotFoundNudge(resultText: string, known: readonly string[]): string | null {
  const requested = extractNotFoundToolName(resultText)
  if (requested === null) return null
  const suggestion = closestToolName(requested, known)
  if (suggestion === null || suggestion === requested) return null
  return renderToolNotFoundNudge(requested, suggestion)
}

function firstTextChunk(result: unknown): string | null {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return null
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') return text
    }
  }
  return null
}

// Watches a session's tool-execution events and, when the model calls a tool
// name that does not exist but is a near-miss of a real one, steers a
// "did you mean" reminder into the running turn so the model self-corrects.
//
// This lives here, on the session event stream, because pi-agent-core's
// `prepareToolCall` returns the `Tool X not found` result BEFORE any
// `beforeToolCall`/`afterToolCall` hook runs — so TypeClaw's tool.before/after
// buses never see an unknown tool name. The emitted `tool_execution_end` event
// is the only seam reachable without forking pi. `steer` (not `followUp`)
// delivers the reminder after the current assistant turn's tool calls settle,
// which is exactly when the model is ready to retry.
//
// The model re-issues the call under the suggested (canonical) name, so every
// security guard, budget, and loop-guard keyed on that real name applies
// normally — unlike a silent alias, this rescue path cannot bypass policy.
export function attachToolNotFoundNudge(session: NudgeableSession, knownToolNames: readonly string[]): () => void {
  const known = [...new Set(knownToolNames)]
  // A wedged model re-calls the same wrong name every turn; each steer
  // spawns a fresh assistant turn that clobbers the subagent's captured
  // final message (see attachFinalMessageCapture). One reminder per mistake.
  const nudged = new Set<string>()
  return session.subscribe((event) => {
    const e = event as { type?: unknown; isError?: unknown; result?: unknown }
    if (e?.type !== 'tool_execution_end' || e.isError !== true) return
    const text = firstTextChunk(e.result)
    if (text === null) return
    const requested = extractNotFoundToolName(text)
    if (requested === null || nudged.has(requested)) return
    const nudge = buildToolNotFoundNudge(text, known)
    if (nudge === null) return
    nudged.add(requested)
    void session.steer(nudge)
  })
}

// Wagner–Fischer with an early bail-out once every cell in a row exceeds the
// ceiling: a name far from every candidate never produces a suggestion, and
// the bound keeps the scan cheap when the known-tool list is large.
function boundedLevenshtein(a: string, b: string, ceiling: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = Array.from({ length: b.length + 1 }, () => 0)

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const deletion = (prev[j] ?? 0) + 1
      const insertion = (curr[j - 1] ?? 0) + 1
      const substitution = (prev[j - 1] ?? 0) + cost
      const cell = Math.min(deletion, insertion, substitution)
      curr[j] = cell
      if (cell < rowMin) rowMin = cell
    }
    if (rowMin > ceiling) return ceiling + 1
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length] ?? ceiling + 1
}
