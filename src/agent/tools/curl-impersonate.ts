// Shared curl-impersonate spawn primitive.
//
// Why this exists: by 2026, every non-trivial public site (DDG, Reuters via
// Akamai, MarketWatch via Cloudflare, etc.) fingerprints incoming traffic at
// the TLS handshake (JA3/JA4) and HTTP/2 SETTINGS frame BEFORE any HTTP header
// is read. Bun's native fetch cannot match Chrome's handshake (upstream issue
// #11368), so outbound requests get gated by anomaly checks regardless of
// headers, body shape, or pacing. The fix is to shell out to curl-impersonate
// (lexiforest fork), which replays Chrome's exact TLS handshake, HTTP/2
// settings, and header ordering. Pinned by the typeclaw Dockerfile at
// /usr/local/bin/curl_chrome136 — see src/init/dockerfile.ts for the version
// and SHA pin.
//
// AGENTS.md explicitly warns against adding `-H` overrides because the
// curl_chrome wrapper already sends the full Chrome header set (correct
// ordering, sec-ch-ua, sec-fetch-*, accept-encoding, etc.) and any custom
// header corrupts the impersonation. We therefore expose NO header-override
// surface from this primitive; add one only when a real caller needs it AND
// the override is something curl_chrome can't be told to send another way.

import { randomBytes } from 'node:crypto'

import { spawn } from 'bun'

import { readOomEvents, toolOomNote } from '@/container/oom-events'
import { withToolOomPriorityArgv } from '@/container/tool-oom-priority'

export const CURL_IMPERSONATE_BINARY = 'curl_chrome136'
export const DEFAULT_TIMEOUT_SECONDS = 30

let curlBinary: string = CURL_IMPERSONATE_BINARY

// Test-only seam: lets *.test.ts point the spawn at a fake `curl_chrome136`
// script in a tmpdir so we exercise the real Bun.spawn path without depending
// on a curl-impersonate install on the test host. Production code never calls
// this — the module-level default above is what production sees.
export function _setCurlBinaryForTest(binary: string | null): void {
  curlBinary = binary ?? CURL_IMPERSONATE_BINARY
}

export type CurlImpersonateRequest = {
  url: string
  method?: 'GET' | 'POST'
  // Form-urlencoded body fields for POST. Each entry is passed as a separate
  // --data-urlencode argument so curl handles the encoding. Required if
  // method is 'POST' and you want a body.
  formFields?: Array<{ name: string; value: string }>
  // Hard cap on bytes accepted from the response (passed as --max-filesize).
  // The actual buffer is still bounded by the caller; this just makes curl
  // bail early instead of streaming gigabytes.
  maxBytes?: number
  timeoutSeconds?: number
  // Read/write cookies to this jar (curl `-b`+`-c`, same path). Enables a
  // two-request sequence sharing one jar. Cookie plumbing does NOT alter the
  // TLS/HTTP-2/header-order impersonation, so it is exempt from the no-`-H`
  // doctrine above.
  cookieJarPath?: string
  signal?: AbortSignal
}

export type CurlImpersonateResponse = {
  body: string
  finalUrl: string
  httpStatus: number
  contentType: string
  bytesIn: number
  // Cookie names the server set via Set-Cookie on this response (from curl
  // %{header_json}); lets the policy layer detect a bot-manager 403 without
  // parsing the jar file format.
  setCookieNames: string[]
}

// Specific curl exit codes we map to typed errors. The full list is in
// `man curl` § "EXIT CODES"; these are the only ones we translate at the
// primitive layer. Everything else surfaces as a generic CurlImpersonateError
// with stderr attached for caller-side diagnostics.
export const CURL_EXIT_TIMEOUT = 28
export const CURL_EXIT_MAX_FILESIZE_PRECHECK = 63
// Observed empirically (and corroborated by Oracle review): curl returns
// exit 56 with stderr `Exceeded the maximum allowed file size (...)` when
// --max-filesize is hit at TRANSFER time (e.g. server omitted Content-Length
// and curl discovered the overflow mid-stream). The Linux man page lists 56
// as the more general "Failure in receiving network data," so we additionally
// gate on a stderr match to avoid mis-classifying real network drops as
// size-exceeded.
export const CURL_EXIT_RECV_FAILURE_OR_FILESIZE = 56

export class CurlImpersonateError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message)
    this.name = 'CurlImpersonateError'
  }
}

export function isCurlExitFilesizeExceeded(error: CurlImpersonateError): boolean {
  if (error.exitCode === CURL_EXIT_MAX_FILESIZE_PRECHECK) return true
  if (error.exitCode === CURL_EXIT_RECV_FAILURE_OR_FILESIZE && /maximum.{0,30}file size/i.test(error.stderr)) {
    return true
  }
  return false
}

export function isCurlExitTimeout(error: CurlImpersonateError): boolean {
  return error.exitCode === CURL_EXIT_TIMEOUT
}

export async function curlImpersonate(req: CurlImpersonateRequest): Promise<CurlImpersonateResponse> {
  const timeoutSeconds = req.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  const method = req.method ?? 'GET'

  // Per-request random sentinel + UTF-8-safe parsing. The static sentinel
  // approach (previous revision) had a hardening hole: web_fetch reads
  // attacker-controlled pages, and a static sentinel is a public, fixed
  // string. A page could include the sentinel byte sequence plus fabricated
  // metadata before the real write-out tail and `indexOf` would split at
  // the attacker-controlled occurrence. Per-request randomness (96 bits)
  // removes the attacker's ability to predict the sentinel, and the parser
  // anchors on the LAST occurrence (curl writes `-w` after the body, so the
  // real metadata block is always last). Both defenses are needed: random
  // alone fails if the attacker can read the sentinel from a previous
  // response and replay it; last-match alone fails if the attacker can
  // append text after curl's write-out (they can't, but defense in depth).
  const sentinel = generateSentinel()
  // %{header_json} is the LAST field so the existing status/url/type/size
  // positions stay byte-compatible with the old parser. It is a single-line
  // JSON object of response headers; we read only Set-Cookie names from it.
  const writeOutTemplate = `${sentinel}%{http_code}\n%{url_effective}\n%{content_type}\n%{size_download}\n%{header_json}\n`

  const cmd: string[] = [
    curlBinary,
    // `--disable` (alias -q) MUST be the first argument to suppress reading
    // ~/.curlrc and /etc/curlrc. Without it, a user or attacker-controlled
    // curlrc could inject --proxy, --header, --resolve, --no-location, etc.,
    // silently subverting both the Chrome impersonation contract and the
    // protocol restrictions below. Order is load-bearing: curl ignores
    // --disable if it appears after any other flag.
    '--disable',
    '--silent',
    '--show-error',
    // Protocol allowlist. curl-impersonate supports many protocols by default
    // (ftp, file, dict, etc.). normalizeUrl() already rejects non-http(s) at
    // the call-site, but redirects are followed by curl after that gate fires
    // and a 301/302 to ftp://... would otherwise be silently honored. The
    // `=http,https` syntax means "ONLY these two" rather than "add these to
    // defaults." --proto-redir governs the redirect chain specifically.
    '--proto',
    '=http,https',
    '--proto-redir',
    '=http,https',
    // `--fail-with-body` would make curl exit non-zero on >=400 but still
    // write the body. We intentionally DO NOT pass it: callers (web_fetch,
    // ddg) want to inspect httpStatus themselves and decide. Curl exits 0
    // on a 404-with-body in this mode, which matches our contract.
    '--compressed',
    '--location',
    '--max-redirs',
    '10',
    '--max-time',
    String(timeoutSeconds),
    '-w',
    writeOutTemplate,
    '-X',
    method,
  ]

  if (req.maxBytes !== undefined) {
    cmd.push('--max-filesize', String(req.maxBytes))
  }

  if (req.cookieJarPath !== undefined) {
    cmd.push('-b', req.cookieJarPath, '-c', req.cookieJarPath)
  }

  if (req.formFields) {
    for (const field of req.formFields) {
      cmd.push('--data-urlencode', `${field.name}=${field.value}`)
    }
  }

  // `--` terminates option parsing so a URL beginning with `-` (e.g. an
  // attacker-supplied "-K /etc/passwd" sneaking through normalizeUrl as
  // "https://-K /etc/passwd") cannot be reinterpreted as a curl option.
  cmd.push('--', req.url)

  // Spawn detached so the child becomes the leader of its own process group.
  // The curl-impersonate wrappers (curl_chrome136 et al.) are bash scripts
  // that call the real curl-impersonate binary WITHOUT `exec` — meaning the
  // wrapper is the parent and curl-impersonate is its child. On a plain
  // SIGKILL to the wrapper PID, the curl child becomes orphaned and keeps
  // the stdout pipe open until --max-time fires, turning a 50ms abort into
  // a 30s hang. process.kill(-pid) addresses the negative PID, which signals
  // the entire process group, killing both atomically. detached: true makes
  // the child the pgid leader so -pid is well-defined.
  const oomBefore = readOomEvents()
  const proc = spawn({
    cmd: withToolOomPriorityArgv(cmd),
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })

  const onAbort = () => {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }
  req.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const [stdoutBuf, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (req.signal?.aborted) {
      throw new CurlImpersonateError('aborted', exitCode, stderr)
    }

    const oomNote = toolOomNote(oomBefore, exitCode, 'web search', { log: (line) => console.warn(line) })
    if (exitCode !== 0) {
      const detail = stderr.trim() || 'no stderr'
      throw new CurlImpersonateError(
        `curl-impersonate exited ${exitCode}: ${detail}${oomNote === null ? '' : `\n${oomNote}`}`,
        exitCode,
        stderr,
      )
    }

    return parseCurlOutput(stdoutBuf, sentinel, stderr)
  } finally {
    req.signal?.removeEventListener('abort', onAbort)
  }
}

// Generates a per-request sentinel. Format: `\n--TYPECLAW-CURL-META-<hex>--\n`.
// 24 hex chars = 96 bits of entropy, plenty to defeat any attempt by an
// attacker-controlled response body to inject a colliding marker. ASCII-only
// + leading/trailing newlines means it's unambiguous in textual responses
// and free of NUL bytes (Bun's spawn rejects NULs in argv).
function generateSentinel(): string {
  const hex = randomBytes(12).toString('hex')
  return `\n--TYPECLAW-CURL-META-${hex}--\n`
}

function parseCurlOutput(buf: ArrayBuffer, sentinel: string, stderr: string): CurlImpersonateResponse {
  const sentinelBytes = new TextEncoder().encode(sentinel)
  const bytes = new Uint8Array(buf)

  // Anchor on the LAST occurrence (defense in depth alongside the random
  // sentinel). curl writes the `-w` output strictly AFTER the body, so the
  // real metadata block is always the trailing one.
  const sentinelIndex = lastIndexOfBytes(bytes, sentinelBytes)
  if (sentinelIndex < 0) {
    throw new CurlImpersonateError(
      'curl-impersonate produced no metadata block (sentinel missing). Wrapper or output corruption suspected.',
      0,
      stderr,
    )
  }

  const bodyBytes = bytes.subarray(0, sentinelIndex)
  const metaBytes = bytes.subarray(sentinelIndex + sentinelBytes.byteLength)
  const meta = new TextDecoder('utf-8', { fatal: false }).decode(metaBytes).split('\n')

  const httpStatus = Number(meta[0]?.trim() ?? '0') || 0
  const finalUrl = (meta[1] ?? '').trim()
  const contentType = (meta[2] ?? '').trim().toLowerCase()
  const declaredBytes = Number(meta[3]?.trim() ?? '0') || bodyBytes.byteLength
  const setCookieNames = parseSetCookieNames(meta[4] ?? '')

  const body = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes)

  return {
    body,
    finalUrl,
    httpStatus,
    contentType,
    bytesIn: declaredBytes,
    setCookieNames,
  }
}

function parseSetCookieNames(headerJson: string): string[] {
  const trimmed = headerJson.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const setCookie = (parsed as Record<string, unknown>)['set-cookie']
  const values = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie]
  const names: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const name = value.split('=', 1)[0]?.trim()
    if (name) names.push(name)
  }
  return names
}

function lastIndexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.byteLength === 0) return haystack.byteLength
  for (let i = haystack.byteLength - needle.byteLength; i >= 0; i--) {
    let matched = true
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false
        break
      }
    }
    if (matched) return i
  }
  return -1
}

// Detect whether curl-impersonate is available on PATH. Used by fetch.ts to
// decide between the impersonating transport (production: container has the
// binary pinned in the image) and a Bun.fetch fallback (test/dev: no binary
// installed). The check is best-effort and cheap — we spawn `--version`
// and look at exit code. Cached per-process: the binary doesn't appear or
// disappear at runtime.
let availabilityCache: boolean | undefined

export async function isCurlImpersonateAvailable(): Promise<boolean> {
  if (availabilityCache !== undefined) return availabilityCache
  try {
    const proc = spawn({ cmd: [curlBinary, '--version'], stdout: 'ignore', stderr: 'ignore' })
    const code = await proc.exited
    availabilityCache = code === 0
  } catch {
    availabilityCache = false
  }
  return availabilityCache
}

export function _resetAvailabilityCacheForTest(): void {
  availabilityCache = undefined
}
