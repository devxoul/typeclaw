import { randomUUID } from 'node:crypto'

import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import { githubReviewerWorkKey } from '@/channels/github-repo'
import type { ChannelRouter } from '@/channels/router'
import type { PermissionService } from '@/permissions'
import type { Stream } from '@/stream'

import { type LiveSubagentRegistry, type SubagentCompletion } from '../live-subagents'
import { MAX_SUBAGENT_DEPTH, type SessionOrigin, subagentDepth } from '../session-origin'
import {
  type CreateSessionForSubagent,
  type Subagent,
  SubagentCoalescer,
  subagentCoalesceKey,
  type SubagentRegistry,
  startSubagent,
} from '../subagents'

export const SPAWN_TASK_ID_PREFIX = 'bg_'

export type SpawnSubagentToolDetails =
  | {
      ok: true
      mode: 'sync'
      subagent: string
      taskId: string
      sessionId: string | undefined
      durationMs: number
      finalMessage?: string
    }
  | {
      ok: true
      mode: 'background'
      subagent: string
      taskId: string
      sessionId: string | undefined
    }
  | {
      ok: false
      error: string
      finalMessage?: string
      recoveryData?: true
      partial?: true
      verdict?: false
    }

export type CreateSpawnSubagentToolOptions = {
  registry: SubagentRegistry
  liveRegistry: LiveSubagentRegistry
  createSessionForSubagent: CreateSessionForSubagent
  agentDir: string
  parentSessionId: string
  getOrigin: () => SessionOrigin | undefined
  getSessionFile?: () => string | undefined
  router?: Pick<ChannelRouter, 'acceptBackgroundResponse' | 'suppressUnstartedBackgroundResponse'>
  getAccountIdentity?: (
    adapter: NonNullable<Extract<SessionOrigin, { kind: 'channel' }>['adapter']>,
    workspace?: string,
  ) => Promise<string | undefined>
  permissions?: PermissionService
  stream?: Stream
  generateTaskId?: () => string
  now?: () => number
  allowBackgroundFromSubagent?: boolean
  coalescer?: SubagentCoalescer
}

export function createSpawnSubagentTool(options: CreateSpawnSubagentToolOptions) {
  const {
    registry,
    liveRegistry,
    createSessionForSubagent,
    agentDir,
    parentSessionId,
    getOrigin,
    permissions,
    stream,
    generateTaskId = () => `${SPAWN_TASK_ID_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    now = () => Date.now(),
    allowBackgroundFromSubagent,
    coalescer = new SubagentCoalescer(),
  } = options

  return defineTool({
    name: 'spawn_subagent',
    label: 'Spawn Subagent',
    description: spawnSubagentDescription(registry),
    parameters: Type.Object({
      subagent_type: Type.String({
        description:
          'Name of the subagent to spawn. Must be a public subagent registered with this agent. See the system prompt section "Subagent orchestration" for the available list.',
      }),
      prompt: Type.String({
        description:
          'The full task description for the subagent. Use the [CONTEXT]/[GOAL]/[REQUEST] structure described in the system prompt. The subagent does not see the parent conversation; everything it needs must be in this string.',
      }),
      description: Type.Optional(
        Type.String({
          description: '3-5 word label for this spawn, used for logs and the status_summary. Optional.',
        }),
      ),
      run_in_foreground: Type.Optional(
        Type.Boolean({
          description:
            'Request a FOREGROUND (synchronous) spawn: the tool blocks until the subagent finishes and returns its final message inline. ' +
            'When omitted (the default) from a top-level session, the spawn runs in the BACKGROUND — it returns a task_id immediately and a system-reminder arrives when it completes; do NOT poll subagent_output. ' +
            'The runtime may override your request and always states which mode it used and why in the tool result: ' +
            'a deep-profile subagent spawned from a top-level session is forced to the background (a foreground run would freeze this session while it works), ' +
            'and a background spawn requested from a subagent session that cannot drain child results is degraded to foreground so the result still reaches you. ' +
            'From a subagent session the default is foreground — which is what you need to fold a delegated result into your own output; ' +
            'for PARALLEL fan-out, emit several foreground spawns in a SINGLE turn and their results return together.',
        }),
      ),
      profile: Type.Optional(
        Type.String({
          description:
            'Model profile to run this spawn on, overriding the subagent\'s default tier for this one task. Use "deep" for hard work that needs stronger reasoning (gnarly bugs, non-obvious refactors, failures that resisted a quick fix); omit (or "default") for routine work. Resolves against the configured model profiles; an unknown name falls back to default. Most useful on `operator` — leave it off unless the task clearly warrants a heavier model.',
        }),
      ),
      review_identity: Type.Optional(
        Type.Object(
          {
            repo: Type.String({ description: 'Canonical owner/repo name.' }),
            pull_request: Type.Integer({ minimum: 1, description: 'Pull request number.' }),
            head_sha: Type.String({
              pattern: '^[0-9a-fA-F]{40}$',
              description: 'Exact 40-character PR head commit SHA being reviewed.',
            }),
            base_sha: Type.String({
              pattern: '^[0-9a-fA-F]{40}$',
              description: 'Exact 40-character PR base commit OID being reviewed against.',
            }),
            review_kind: Type.Union([Type.Literal('review'), Type.Literal('re-review')], {
              description: 'Canonical PR review class.',
            }),
          },
          {
            description:
              'Typed identity for a reviewer PR job. Identical repo/PR/head/base/kind jobs coalesce while in flight. Valid only when subagent_type="reviewer"; omit for general reviews and all other subagents.',
          },
        ),
      ),
    }),

    async execute(_toolCallId, params, signal): Promise<ToolReturn> {
      const origin = getOrigin()
      const subagent = lookupPublicSubagent(registry, params.subagent_type)
      if (subagent === null) {
        return errorResult(formatUnknownSubagentError(registry, params.subagent_type))
      }
      if (!hasPermissionForSubagent(permissions, origin, params.subagent_type, subagent)) {
        return errorResult('subagent.spawn denied: insufficient permissions')
      }
      // Ordered AFTER the permission check on purpose: this message reports which
      // sibling session holds the round, so an unauthorized caller must be turned
      // away as unauthorized rather than told anything about the PR's round state.
      if (
        params.subagent_type === 'reviewer' &&
        origin?.kind === 'channel' &&
        origin.adapter === 'github' &&
        /^pr:\d+$/.test(origin.chat) &&
        origin.githubReviewRound !== undefined &&
        origin.thread !== origin.githubReviewRound.carrierThread
      ) {
        return errorResult(
          "reviewer spawn denied: another session of this PR is the designated carrier for this review round and will post the review. Do not reply now: call `skip_response`. Once the verdict lands, close out only this session's thread with the technical outcome; never mention sessions, carriers, or review rounds on the PR.",
        )
      }
      // Fail closed past the chain-length ceiling. The tool is present on
      // subagent sessions (operator/reviewer can delegate), but a session
      // already at MAX_SUBAGENT_DEPTH cannot spawn a deeper one — this is the
      // execute-time guard against runaway recursion, robust to tool-surface
      // drift and serialized-origin resumes.
      if (subagentDepth(origin) >= MAX_SUBAGENT_DEPTH) {
        return errorResult(
          `subagent.spawn denied: maximum delegation depth (${MAX_SUBAGENT_DEPTH}) reached; a subagent at this depth cannot spawn further subagents`,
        )
      }
      const subagentName = params.subagent_type
      const { background, overrideNote } = resolveSpawnMode({
        foreground: params.run_in_foreground,
        fromSubagent: origin?.kind === 'subagent',
        // Deep-profile spawns run for minutes; forcing them background from a
        // top-level session keeps a foreground run from freezing the message
        // loop. Per-spawn override wins over the declared profile.
        isDeepProfile: (params.profile ?? subagent.profile) === 'deep',
        canBackgroundFromSubagent: allowBackgroundFromSubagent === true,
        subagentName,
      })

      const taskId = generateTaskId()
      const payload: Record<string, unknown> = { requestId: taskId, prompt: params.prompt }
      if (params.description !== undefined) payload.description = params.description
      if (params.profile !== undefined) payload.profile = params.profile
      if (params.review_identity !== undefined) {
        if (subagentName !== 'reviewer') {
          return errorResult('review_identity is only valid for reviewer subagents')
        }
        payload.reviewIdentity = {
          repo: params.review_identity.repo,
          pullRequest: params.review_identity.pull_request,
          headSha: params.review_identity.head_sha,
          baseSha: params.review_identity.base_sha,
          reviewKind: params.review_identity.review_kind,
        }
      }
      const workKey =
        params.review_identity === undefined
          ? undefined
          : githubReviewerWorkKey(params.review_identity.repo, params.review_identity.pull_request)

      const coalesceKey = subagentCoalesceKey({
        parentSessionId,
        subagentName,
        payload,
        fallbackKey: taskId,
        ...(subagent.inFlightKey !== undefined ? { inFlightKey: subagent.inFlightKey } : {}),
      })
      if (!coalescer.tryAcquire(coalesceKey)) {
        return errorResult(`subagent ${coalesceKey}: an identical job is already in progress`)
      }
      let coalesceKeyHeld = true
      const releaseCoalesceKey = () => {
        if (!coalesceKeyHeld) return
        coalesceKeyHeld = false
        coalescer.release(coalesceKey)
      }
      const pendingWorkKeyRegistration =
        workKey === undefined ? undefined : liveRegistry.beginWorkKeyRegistration(workKey)

      const startedAt = now()
      const spawnedByRole = permissions?.resolveRole(origin)
      let capturedFinalMessage: string | undefined
      const channelKey =
        origin?.kind === 'channel'
          ? { adapter: origin.adapter, workspace: origin.workspace, chat: origin.chat, thread: origin.thread }
          : undefined
      let backgroundResponse: { obligationId: string; generation: number } | undefined
      if (background && origin?.kind === 'channel') {
        if (options.router === undefined) {
          if (pendingWorkKeyRegistration !== undefined) {
            liveRegistry.abandonWorkKeyRegistration(pendingWorkKeyRegistration)
          }
          releaseCoalesceKey()
          return errorResult('failed to persist background response: channel router unavailable')
        }
        try {
          const { parentChat, lastInboundAuthorId } = origin
          let parentSessionFile: string | undefined
          try {
            parentSessionFile = options.getSessionFile?.()
          } catch {
            // Recovery notices do not need the parent transcript to launch work.
          }
          let accountIdentity: string | undefined
          try {
            accountIdentity = await options.getAccountIdentity?.(origin.adapter, origin.workspace)
          } catch {
            // Recovery identity must not add a prerequisite to healthy launches.
          }
          backgroundResponse = await options.router.acceptBackgroundResponse({
            parentSessionId,
            parentSessionFile,
            key: channelKey!,
            taskId,
            subagentName,
            startedAt,
            accountIdentity: accountIdentity ?? 'unbound-legacy',
            ...(parentChat !== undefined ? { parentChat } : {}),
            ...(lastInboundAuthorId !== undefined ? { triggeringAuthorId: lastInboundAuthorId } : {}),
          })
        } catch (error) {
          if (pendingWorkKeyRegistration !== undefined) {
            liveRegistry.abandonWorkKeyRegistration(pendingWorkKeyRegistration)
          }
          releaseCoalesceKey()
          return errorResult(
            `failed to persist background response: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        // An aborted parent must not launch work after the durability await.
        if (signal?.aborted) {
          try {
            await options.router.suppressUnstartedBackgroundResponse(
              backgroundResponse,
              'background launch cancelled before execution',
            )
          } finally {
            if (pendingWorkKeyRegistration !== undefined) {
              liveRegistry.abandonWorkKeyRegistration(pendingWorkKeyRegistration)
            }
            releaseCoalesceKey()
          }
          return errorResult('background launch cancelled before execution')
        }
      }
      const { handle, completion } = startSubagent(subagentName, {
        registry,
        createSessionForSubagent,
        agentDir,
        userPrompt: params.prompt,
        payload: subagent.payloadSchema ? payload : undefined,
        parentSessionId,
        ...(spawnedByRole !== undefined ? { spawnedByRole } : {}),
        ...(origin !== undefined ? { spawnedByOrigin: origin } : {}),
        taskId,
        onFinalMessageCaptured: (message) => {
          capturedFinalMessage = message
          liveRegistry.recordCapturedFinalMessageIfRunning(taskId, message)
        },
      })

      let resolvedHandle: { taskId: string; sessionId: string | undefined; abort: () => Promise<void> } | undefined
      try {
        resolvedHandle = await handle
      } catch (err) {
        if (pendingWorkKeyRegistration !== undefined) {
          liveRegistry.abandonWorkKeyRegistration(pendingWorkKeyRegistration)
        }
        releaseCoalesceKey()
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`failed to spawn ${subagentName}: ${message}`)
      }

      const live = {
        taskId,
        sessionId: resolvedHandle.sessionId ?? '<pending>',
        subagentName,
        parentSessionId,
        ...(spawnedByRole !== undefined ? { spawnedByRole } : {}),
        background,
        // Drafting a PR invalidates every reviewer job for it, regardless of
        // commit or review kind. This is intentionally broader than the
        // reviewer's head/base/kind-aware coalescing key.
        ...(workKey !== undefined ? { workKey } : {}),
        startedAt,
        status: 'running' as const,
        abort: resolvedHandle.abort,
        releaseCoalesceKey,
      }
      let registered: boolean
      try {
        registered =
          pendingWorkKeyRegistration === undefined
            ? (liveRegistry.register(live), true)
            : liveRegistry.registerIfWorkKeyActive(live, pendingWorkKeyRegistration)
      } catch (error) {
        if (pendingWorkKeyRegistration !== undefined) {
          liveRegistry.abandonWorkKeyRegistration(pendingWorkKeyRegistration)
        }
        try {
          await resolvedHandle.abort()
        } catch {
          // Execution may already have started. Its response remains owed.
        }
        void completion.then(releaseCoalesceKey)
        releaseCoalesceKey()
        return errorResult(
          `failed to register ${subagentName}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      let delayedCancellationError: string | undefined
      if (!registered) {
        void completion.then(releaseCoalesceKey)
        try {
          await resolvedHandle.abort()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // The child is still live. Register it so later cancellation, status
          // inspection, and completion settlement can still reach it.
          try {
            liveRegistry.register(live)
          } catch (registrationError) {
            releaseCoalesceKey()
            return errorResult(
              `failed to register ${subagentName} after cancellation failed: ${registrationError instanceof Error ? registrationError.message : String(registrationError)}`,
            )
          }
          delayedCancellationError = `reviewer cancellation failed before registration: ${message}`
        }
        if (delayedCancellationError === undefined) {
          releaseCoalesceKey()
          return errorResult('reviewer cancelled before registration: pull request converted to draft')
        }
      }
      if (capturedFinalMessage !== undefined) {
        liveRegistry.recordCapturedFinalMessageIfRunning(taskId, capturedFinalMessage)
      }

      void completion.then((c) => {
        releaseCoalesceKey()
        const durationMs = now() - startedAt
        // First-writer-wins: if the parent drain already settled this child by
        // timeout, our real completion lost — skip both the overwrite and the
        // broadcast so exactly one canonical completed-event is emitted (the
        // winner's).
        const won = liveRegistry.recordCompletionIfRunning(taskId, completionToFinalShape(c, durationMs))
        if (!won || !stream || !background) return
        const hasRecoverableOutput = !c.ok && c.finalMessage !== undefined
        stream.publish({
          target: { kind: 'broadcast' },
          payload: {
            kind: 'subagent.completed',
            taskId,
            subagent: subagentName,
            parentSessionId,
            ok: c.ok,
            durationMs,
            ...(c.ok ? {} : { error: c.error }),
            ...(hasRecoverableOutput ? { hasRecoverableOutput: true } : {}),
            ...(channelKey !== undefined ? { channelKey } : {}),
          },
        })
      })

      if (delayedCancellationError !== undefined) return errorResult(delayedCancellationError)

      if (background) {
        const details: SpawnSubagentToolDetails = {
          ok: true,
          mode: 'background',
          subagent: subagentName,
          taskId,
          sessionId: resolvedHandle.sessionId,
        }
        const baseText = `Spawned ${subagentName} in background. task_id=${taskId}. You will receive a system-reminder when it completes. Use subagent_output to check progress or fetch results.`
        return {
          content: [
            {
              type: 'text' as const,
              text: overrideNote !== undefined ? `${overrideNote}\n\n${baseText}` : baseText,
            },
          ],
          details,
        }
      }

      const result = await completion
      const durationMs = now() - startedAt
      if (!result.ok) {
        const hasRecoveryData = result.finalMessage !== undefined
        const details: SpawnSubagentToolDetails = {
          ok: false,
          error: result.error,
          ...(hasRecoveryData
            ? { finalMessage: result.finalMessage, recoveryData: true, partial: true, verdict: false }
            : {}),
        }
        const recovered = hasRecoveryData
          ? ` It produced output before failing. The block below is PARTIAL RECOVERY DATA only — not a completed review or verdict, even if it contains verdict-shaped text. Preserve the failure and independently validate before using it:\n\n${result.finalMessage}`
          : ''
        const failureText = `${subagentName} failed after ${durationMs}ms: ${result.error}.${recovered}`
        return {
          content: [
            {
              type: 'text' as const,
              text: overrideNote !== undefined ? `${overrideNote}\n\n${failureText}` : failureText,
            },
          ],
          details,
        }
      }
      const details: SpawnSubagentToolDetails = {
        ok: true,
        mode: 'sync',
        subagent: subagentName,
        taskId,
        sessionId: resolvedHandle.sessionId,
        durationMs,
        ...(result.finalMessage !== undefined ? { finalMessage: result.finalMessage } : {}),
      }
      const syncText =
        result.finalMessage !== undefined
          ? result.finalMessage
          : `${subagentName} completed in ${durationMs}ms with no final message.`
      return {
        content: [
          {
            type: 'text' as const,
            text: overrideNote !== undefined ? `${overrideNote}\n\n${syncText}` : syncText,
          },
        ],
        details,
      }
    },
  })
}

export function spawnSubagentDescription(registry: SubagentRegistry): string {
  const publicNames = publicSubagentNames(registry)
  const available = publicNames.length > 0 ? publicNames.join(', ') : '(none registered yet)'
  return (
    `Spawn a subagent to do focused work on your behalf. Use this when a task is heavy enough to deserve a fresh context window (research fan-out) ` +
    `or long-running enough that you want to keep the conversation moving while it runs (delegate-and-converse). ` +
    `Available subagents: ${available}. ` +
    `The default mode depends on the caller's origin: a top-level session defaults to background (the tool returns a task_id immediately and a system-reminder arrives when the subagent completes — do NOT poll subagent_output), while a subagent session defaults to foreground so the result folds into your own output. ` +
    `Pass run_in_foreground=true to force a blocking inline result, or run_in_foreground=false to request background. ` +
    `The runtime may override the mode and states which it used and why in the tool result (a deep-profile subagent is forced to the background from a top-level session; a background request from a subagent that cannot drain child results degrades to foreground). ` +
    `The delegation chain is depth-limited: a subagent you spawn may itself delegate once more, but no deeper — ` +
    `keep your delegation tree shallow.`
  )
}

function publicSubagentNames(registry: SubagentRegistry): string[] {
  return Object.entries(registry)
    .filter(([, sub]) => isPublicSubagent(sub))
    .map(([name]) => name)
    .sort()
}

// Render the "## Subagent orchestration" roster from the registry so it can
// never drift from the actually-registered public subagents (the bug that left
// `researcher`/`planner` unlisted). Same filter+sort as `publicSubagentNames`,
// so this roster and the `spawn_subagent` tool description agree by
// construction. Throws if a public subagent lacks `rosterDescription` — a
// fail-loud contract that turns "silently missing from the prompt" into a build
// error caught by the drift-guard test.
export function renderPublicSubagentRoster(registry: SubagentRegistry): string {
  return publicSubagentNames(registry)
    .map((name) => {
      const description = registry[name]?.rosterDescription?.trim()
      if (description === undefined || description === '') {
        throw new Error(
          `public subagent "${name}" is missing rosterDescription (required for the orchestration roster)`,
        )
      }
      return `\`${name}\` (${description})`
    })
    .join(', ')
}

function isPublicSubagent(sub: Subagent<unknown>): boolean {
  return sub.visibility === 'public'
}

function lookupPublicSubagent(registry: SubagentRegistry, name: string): Subagent<unknown> | null {
  const sub = registry[name]
  if (sub === undefined) return null
  if (!isPublicSubagent(sub)) return null
  return sub
}

function formatUnknownSubagentError(registry: SubagentRegistry, requested: string): string {
  const names = publicSubagentNames(registry)
  const available = names.length > 0 ? names.join(', ') : '(none)'
  return `Unknown subagent: ${requested}. Available: ${available}.`
}

function hasPermissionForSubagent(
  permissions: PermissionService | undefined,
  origin: SessionOrigin | undefined,
  subagentName: string,
  subagent: Subagent<unknown>,
): boolean {
  if (permissions === undefined) return true
  const specific = `subagent.spawn.${subagentName}`
  if (subagent.requiresSpecificPermission === true) {
    return permissions.has(origin, specific)
  }
  if (permissions.has(origin, specific)) return true
  return permissions.has(origin, 'subagent.spawn')
}

function completionToFinalShape(
  c: { ok: true; finalMessage?: string } | { ok: false; error: string; finalMessage?: string },
  durationMs: number,
): SubagentCompletion {
  if (c.ok) {
    return { ok: true, durationMs, ...(c.finalMessage !== undefined ? { finalMessage: c.finalMessage } : {}) }
  }
  return {
    ok: false,
    error: c.error,
    durationMs,
    ...(c.finalMessage !== undefined ? { finalMessage: c.finalMessage } : {}),
  }
}

type ToolReturn = {
  content: { type: 'text'; text: string }[]
  details: SpawnSubagentToolDetails
}

function errorResult(message: string): ToolReturn {
  const details: SpawnSubagentToolDetails = { ok: false, error: message }
  return {
    content: [{ type: 'text', text: message }],
    details,
  }
}

export type SpawnModeResolution = {
  background: boolean
  overrideNote: string | undefined
}

// Resolve foreground vs background for a spawn, with the runtime free to
// override the caller's request and report why. Two axes decide it: whether the
// caller is a top-level session (its turn services the live message loop) or a
// subagent (its turn does not), and whether the child runs on the deep profile.
// `foreground` is the tri-state tool param: undefined means the caller did not
// choose, so the origin default applies.
//
// - Top-level default is background: a long child must not block the loop.
//   Deep-profile children are forced background even when foreground is asked.
// - Subagent default is foreground: the sync result folds into the caller's own
//   output (e.g. planner -> reviewer). A subagent can still opt into background
//   with foreground=false, but only when the runtime can drain child
//   completions; otherwise that request degrades to foreground so the result is
//   not lost.
export function resolveSpawnMode(input: {
  foreground: boolean | undefined
  fromSubagent: boolean
  isDeepProfile: boolean
  canBackgroundFromSubagent: boolean
  subagentName: string
}): SpawnModeResolution {
  const { foreground, fromSubagent, isDeepProfile, canBackgroundFromSubagent, subagentName } = input

  if (fromSubagent) {
    const wantsBackground = foreground === false
    if (wantsBackground && !canBackgroundFromSubagent) {
      return {
        background: false,
        overrideNote: `\`${subagentName}\` was spawned in the FOREGROUND: a subagent session cannot drain background children after its turn ends, so a foreground run is the only way its result reaches you.`,
      }
    }
    return { background: wantsBackground, overrideNote: undefined }
  }

  if (isDeepProfile && foreground === true) {
    return {
      background: true,
      overrideNote: `\`${subagentName}\` was spawned in the BACKGROUND despite the foreground request: it runs on the deep profile (minutes of work), and a foreground run would freeze this session until it finished. A completion reminder will arrive when it is done.`,
    }
  }

  return { background: foreground !== true, overrideNote: undefined }
}
