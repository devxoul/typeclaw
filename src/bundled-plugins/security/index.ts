import { getConfig } from '@/config'
import { definePlugin, type PluginContext, type PluginLogger, type ToolBeforeEvent } from '@/plugin'
import { resolveHiddenPaths } from '@/sandbox'

import { analyzeGitCommand, createSessionTmpGitResolvers } from '../github-cli-auth/git-command'
import { recordGrantedPush, resolveGrantedPush } from '../github-cli-auth/granted-push'
import { HIGH_TIER_PER_GUARD_PERMISSIONS, SECURITY_PERMISSIONS, SEVERITY_PERMISSION } from './permissions'
import type { SecurityPermission, SecuritySeverity } from './permissions'
import { GUARD_CRON_PROMOTION_SEVERITY, checkCronPromotionGuard } from './policies/cron-promotion'
import {
  GUARD_GIT_EXFIL_SEVERITY,
  GUARD_GIT_REMOTE_TAINTED_SEVERITY,
  checkGitExfilGuard,
  checkGitRemoteTaintedGuard,
  isPushOnlyGitExfilMatch,
  recordGitRemoteTaintIfAny,
} from './policies/git-exfil'
import { GUARD_OUTBOUND_SECRET_SEVERITY, checkOutboundSecretGuard } from './policies/outbound-secret-scan'
import { GUARD_PLUGIN_ADDITION_SEVERITY, checkPluginAdditionGuard } from './policies/plugin-addition'
import { checkPrivateSurfaceReadGuard } from './policies/private-surface-read'
import { applyPromptInjectionDefense } from './policies/prompt-injection'
import { clearSessionTaints } from './policies/remote-taint-state'
import { GUARD_ROLE_PROMOTION_SEVERITY, checkRolePromotionGuard } from './policies/role-promotion'
import { GUARD_SECRET_EXFIL_BASH_SEVERITY, checkSecretExfilBashGuard } from './policies/secret-exfil-bash'
import { GUARD_SECRET_EXFIL_READ_SEVERITY, checkSecretExfilReadGuard } from './policies/secret-exfil-read'
import {
  GUARD_SESSION_SEARCH_SECRETS_SEVERITY,
  checkSessionSearchSecretsGuard,
} from './policies/session-search-secrets'
import { GUARD_SSRF_SEVERITY, checkSsrfGuard } from './policies/ssrf'
import { GUARD_SYSTEM_PROMPT_LEAK_SEVERITY, checkSystemPromptLeakGuard } from './policies/system-prompt-leak'
import type { SecurityBlock } from './policy'

export {
  HIGH_TIER_PER_GUARD_PERMISSIONS,
  SECURITY_PERMISSIONS,
  type SecurityPermission,
  type SecuritySeverity,
  SEVERITY_PERMISSION,
} from './permissions'

// Per-guard permission strings only — tier strings are deliberately
// absent. Block messages name the per-guard permission AND the tier
// permission separately (see withPermissionHint); the per-guard hint
// table answers "which roles carry THIS specific bypass by default."
type PerGuardSecurityPermission = Exclude<
  SecurityPermission,
  | typeof SECURITY_PERMISSIONS.bypassLow
  | typeof SECURITY_PERMISSIONS.bypassMedium
  | typeof SECURITY_PERMISSIONS.bypassHigh
>

// The satisfies clause forces exhaustive coverage of per-guard
// permissions at compile time — adding a new SECURITY_PERMISSIONS entry
// (other than a new tier string) without a hint here is a type error,
// not a silent fallback.
const BYPASS_ROLE_HINT = {
  [SECURITY_PERMISSIONS.bypassSecretExfilBash]:
    'owner and trusted have it by default (medium tier); member and guest do not. Operators can grant `security.bypass.secretExfilBash` explicitly in roles.<role>.permissions[] to widen.',
  [SECURITY_PERMISSIONS.bypassGitExfil]:
    'owner and trusted have it by default (medium tier); member and guest do not. The audience-leak surface for git lives in `gitRemoteTainted` (high tier, owner-only) — pushing to an attacker-retargeted remote is still blocked for trusted by the two-step taint defense.',
  [SECURITY_PERMISSIONS.bypassGitRemoteTainted]:
    'only owner has it by default (high tier). The two-step taint defense (recorder + checker) still fires whenever the actor lacks `security.bypass.gitRemoteTainted`, including across owner-granted gitExfil bypasses.',
  [SECURITY_PERMISSIONS.bypassSecretExfilRead]:
    'owner and trusted have it by default (medium tier); member and guest do not.',
  [SECURITY_PERMISSIONS.bypassSsrf]: 'owner and trusted have it by default (medium tier); member and guest do not.',
  [SECURITY_PERMISSIONS.bypassSessionSearchSecrets]:
    'owner and trusted have it by default (medium tier); member and guest do not.',
  [SECURITY_PERMISSIONS.bypassSystemPromptLeak]: 'only owner has it by default (high tier).',
  [SECURITY_PERMISSIONS.bypassOutboundSecret]:
    'only owner has it by default (high tier). The audience-leak risk: an owner-permissioned channel author can silently include credentials in outbound messages. Operators who match owner to a channel author should narrow that match or remove owner from `roles.owner.permissions[]` for those origins.',
  [SECURITY_PERMISSIONS.bypassRolePromotion]:
    'owner and trusted have it by default (medium tier); member and guest do not. The privilege-escalation defense for trusted now depends on operator review of `typeclaw.json` backup commits — `roles` is restart-required, so the operator has wall-clock time to revert before the new role table takes effect. Operators who do not review can re-tighten by replacing `roles.trusted.permissions[]` with an explicit list that omits `security.bypass.medium`.',
  [SECURITY_PERMISSIONS.bypassCronPromotion]:
    'owner and trusted have it by default (medium tier); member and guest do not. Same shape as rolePromotion but deferred: a new cron job (or a changed scheduledByRole) fires at schedule-time as the stamped role. The operator-review window between write and execution is the trusted-tier defense.',
  [SECURITY_PERMISSIONS.bypassPluginAddition]:
    'owner and trusted have it by default (medium tier); member and guest do not. Same shape as cronPromotion but for host-side install: a new (or version-bumped) plugins[] entry is materialized into package.json and installed by the next host `typeclaw start`, running npm lifecycle scripts as the operator. The operator-review window between the typeclaw.json write and the next start is the trusted-tier defense.',
} as const satisfies Record<PerGuardSecurityPermission, string>

function withPermissionHint(
  result: SecurityBlock | undefined,
  permission: PerGuardSecurityPermission,
  severity: SecuritySeverity,
): SecurityBlock | undefined {
  if (!result) return result
  const perGuardHint = BYPASS_ROLE_HINT[permission]
  const tierPerm = SEVERITY_PERMISSION[severity]
  return {
    block: true,
    reason: `${result.reason} Or run as a role carrying \`${permission}\` (${perGuardHint}) or the tier permission \`${tierPerm}\`; see the \`typeclaw-permissions\` skill.`,
  }
}

type PushGrantOutcome = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'not-configured' }

// Only consulted for a command whose sole gitExfil finding is `git push`. The
// destination is decided from the broker's resolved remote identity, never
// from the command string or working-directory path; on allow, the resolved
// destination is handed to github-cli-auth, which refuses to fund any other.
async function evaluatePushGrant(
  event: ToolBeforeEvent,
  ctx: Pick<PluginContext, 'agentDir' | 'github'>,
): Promise<PushGrantOutcome> {
  const command = event.args.command
  if (typeof command !== 'string' || !isPushOnlyGitExfilMatch(command)) return { kind: 'not-configured' }
  const github = getConfig().channels?.github
  if (github === undefined || github.repos.length === 0) return { kind: 'not-configured' }
  if (!ctx.github.hasAppTokenResolver()) {
    return {
      kind: 'deny',
      reason: 'pushing to channels.github.repos without the bypass requires GitHub App auth for the github channel',
    }
  }
  const resolvers = createSessionTmpGitResolvers(ctx.agentDir, event.sessionId)
  const decision = await analyzeGitCommand(command, { cwd: ctx.agentDir, resolvers })
  const verdict = await resolveGrantedPush(decision, { repos: github.repos }, resolvers)
  if (verdict.kind === 'deny') return verdict
  recordGrantedPush(event.callId, verdict.push)
  return { kind: 'allow' }
}

function withPushGrantHint(result: SecurityBlock, outcome: PushGrantOutcome): SecurityBlock {
  if (outcome.kind === 'deny') {
    return {
      block: true,
      reason: `${result.reason} Pushing to a configured channels.github.repos repo did not apply: ${outcome.reason}.`,
    }
  }
  return {
    block: true,
    reason: `${result.reason} Branch pushes are allowed without the bypass to repos listed in channels.github.repos when the github channel uses App auth.`,
  }
}

const INTERNAL_SECURITY_GUARD_REASON =
  'The tool call was blocked because an internal security guard error prevented safe evaluation.'

function reportInternalGuardError(logger: PluginLogger, guard: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? ` code=${error.code}` : ''
  logger.error(`internal security guard error guard=${guard}${code}: ${detail}`)
}

export default definePlugin({
  permissions: Object.values(SECURITY_PERMISSIONS),
  // No wildcard exclusions: owner bypasses every security tier by default
  // under the role-tower model. `BUILTIN_ROLES.owner.permissions` carries
  // `security.bypass.{low,medium,high}` explicitly; the wildcard sentinel
  // additionally fans out to every per-guard string (including high-tier
  // ones). The owner-in-public-channel defense now lives in
  // `roles.owner.match[]` discipline, not in the language defaults.
  ownerWildcardExclusions: [],
  plugin: async (ctx) => ({
    hooks: {
      'session.prompt': async (event) => {
        applyPromptInjectionDefense(event)
      },
      'tool.before': async (event) => {
        try {
          const can = (perm: string) => ctx.permissions.has(event.origin, perm)
          const canBypass = (severity: SecuritySeverity, perGuardPerm: string): boolean =>
            can(SEVERITY_PERMISSION[severity]) || can(perGuardPerm)

          // The cron guard blocks deferred work that fires as a role granting
          // permissions the caller lacks. Capability dominance — target's
          // permission set must be a SUBSET of the caller's — not the coarse
          // `compareRoleSeverity` tower: every configured custom role ranks
          // equal there, so rank `>= 0` would let one custom role schedule as a
          // different custom role (or `trusted` schedule as a custom role with
          // an extra grant), laundering permissions the caller never had. Unknown
          // caller/target role => undefined permissions => fail closed.
          const callerRole = ctx.permissions.resolveRole(event.origin)
          const canScheduleAs = (targetRole: string | undefined): boolean => {
            if (targetRole === undefined) return false
            const callerPermissions = ctx.permissions.permissionsForRole(callerRole)
            const targetPermissions = ctx.permissions.permissionsForRole(targetRole)
            if (callerPermissions === undefined || targetPermissions === undefined) return false
            const callerSet = new Set(callerPermissions)
            return targetPermissions.every((permission) => callerSet.has(permission))
          }

          const rolePromotionResult = canBypass(GUARD_ROLE_PROMOTION_SEVERITY, SECURITY_PERMISSIONS.bypassRolePromotion)
            ? undefined
            : withPermissionHint(
                await checkRolePromotionGuard({ tool: event.tool, args: event.args, agentDir: ctx.agentDir }),
                SECURITY_PERMISSIONS.bypassRolePromotion,
                GUARD_ROLE_PROMOTION_SEVERITY,
              )
          if (rolePromotionResult) return rolePromotionResult

          const cronPromotionResult = canBypass(GUARD_CRON_PROMOTION_SEVERITY, SECURITY_PERMISSIONS.bypassCronPromotion)
            ? undefined
            : withPermissionHint(
                await checkCronPromotionGuard({
                  tool: event.tool,
                  args: event.args,
                  agentDir: ctx.agentDir,
                  canScheduleAs,
                }),
                SECURITY_PERMISSIONS.bypassCronPromotion,
                GUARD_CRON_PROMOTION_SEVERITY,
              )
          if (cronPromotionResult) return cronPromotionResult

          const pluginAdditionResult = canBypass(
            GUARD_PLUGIN_ADDITION_SEVERITY,
            SECURITY_PERMISSIONS.bypassPluginAddition,
          )
            ? undefined
            : withPermissionHint(
                await checkPluginAdditionGuard({ tool: event.tool, args: event.args, agentDir: ctx.agentDir }),
                SECURITY_PERMISSIONS.bypassPluginAddition,
                GUARD_PLUGIN_ADDITION_SEVERITY,
              )
          if (pluginAdditionResult) return pluginAdditionResult

          // Taint-recording runs FIRST, independently of the gitExfil guard.
          // The gitRemoteTainted defense depends on it. We pass through
          // `permittedBypass` for actors who can skip gitExfil (via either the
          // per-guard permission or the medium-tier permission) so the
          // recorder still fires for them — an acked or permission-bypassed
          // command will actually run, so its remote change must be remembered.
          recordGitRemoteTaintIfAny({
            tool: event.tool,
            args: event.args,
            sessionId: event.sessionId,
            permittedBypass: canBypass(GUARD_GIT_EXFIL_SEVERITY, SECURITY_PERMISSIONS.bypassGitExfil),
          })

          const gitRemoteTaintedResult = canBypass(
            GUARD_GIT_REMOTE_TAINTED_SEVERITY,
            SECURITY_PERMISSIONS.bypassGitRemoteTainted,
          )
            ? undefined
            : withPermissionHint(
                checkGitRemoteTaintedGuard({ tool: event.tool, args: event.args, sessionId: event.sessionId }),
                SECURITY_PERMISSIONS.bypassGitRemoteTainted,
                GUARD_GIT_REMOTE_TAINTED_SEVERITY,
              )
          if (gitRemoteTaintedResult) return gitRemoteTaintedResult

          const secretExfilBashResult = canBypass(
            GUARD_SECRET_EXFIL_BASH_SEVERITY,
            SECURITY_PERMISSIONS.bypassSecretExfilBash,
          )
            ? undefined
            : withPermissionHint(
                checkSecretExfilBashGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSecretExfilBash,
                GUARD_SECRET_EXFIL_BASH_SEVERITY,
              )
          if (secretExfilBashResult) return secretExfilBashResult

          const gitExfilResult = canBypass(GUARD_GIT_EXFIL_SEVERITY, SECURITY_PERMISSIONS.bypassGitExfil)
            ? undefined
            : withPermissionHint(
                checkGitExfilGuard({ tool: event.tool, args: event.args, sessionId: event.sessionId }),
                SECURITY_PERMISSIONS.bypassGitExfil,
                GUARD_GIT_EXFIL_SEVERITY,
              )
          if (gitExfilResult) {
            const pushGrant = await evaluatePushGrant(event, ctx)
            if (pushGrant.kind !== 'allow') return withPushGrantHint(gitExfilResult, pushGrant)
          }

          const secretExfilReadResult = canBypass(
            GUARD_SECRET_EXFIL_READ_SEVERITY,
            SECURITY_PERMISSIONS.bypassSecretExfilRead,
          )
            ? undefined
            : withPermissionHint(
                checkSecretExfilReadGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSecretExfilRead,
                GUARD_SECRET_EXFIL_READ_SEVERITY,
              )
          if (secretExfilReadResult) return secretExfilReadResult

          // Not severity-bypassed: private directories remain role-derived,
          // while canonical credential-store denial is unconditional. Mirrors
          // the bash masks onto every non-bash path-bearing tool.
          const privateSurfaceReadResult = checkPrivateSurfaceReadGuard(
            {
              tool: event.tool,
              args: event.args,
              agentDir: ctx.agentDir,
              hidden: resolveHiddenPaths(ctx.permissions, event.origin, ctx.agentDir),
              toolProvenance: event.toolProvenance,
              ...(event.fileOperands !== undefined ? { fileOperands: event.fileOperands } : {}),
            },
            {
              onInternalError: (error) => reportInternalGuardError(ctx.logger, 'privateSurfaceRead', error),
            },
          )
          if (privateSurfaceReadResult) return privateSurfaceReadResult

          const ssrfResult = canBypass(GUARD_SSRF_SEVERITY, SECURITY_PERMISSIONS.bypassSsrf)
            ? undefined
            : withPermissionHint(
                checkSsrfGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSsrf,
                GUARD_SSRF_SEVERITY,
              )
          if (ssrfResult) return ssrfResult

          const sessionSearchSecretsResult = canBypass(
            GUARD_SESSION_SEARCH_SECRETS_SEVERITY,
            SECURITY_PERMISSIONS.bypassSessionSearchSecrets,
          )
            ? undefined
            : withPermissionHint(
                checkSessionSearchSecretsGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSessionSearchSecrets,
                GUARD_SESSION_SEARCH_SECRETS_SEVERITY,
              )
          if (sessionSearchSecretsResult) return sessionSearchSecretsResult

          const systemPromptLeakResult = canBypass(
            GUARD_SYSTEM_PROMPT_LEAK_SEVERITY,
            SECURITY_PERMISSIONS.bypassSystemPromptLeak,
          )
            ? undefined
            : withPermissionHint(
                checkSystemPromptLeakGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSystemPromptLeak,
                GUARD_SYSTEM_PROMPT_LEAK_SEVERITY,
              )
          if (systemPromptLeakResult) return systemPromptLeakResult

          const outboundSecretResult = canBypass(
            GUARD_OUTBOUND_SECRET_SEVERITY,
            SECURITY_PERMISSIONS.bypassOutboundSecret,
          )
            ? undefined
            : withPermissionHint(
                checkOutboundSecretGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassOutboundSecret,
                GUARD_OUTBOUND_SECRET_SEVERITY,
              )
          if (outboundSecretResult) return outboundSecretResult

          return undefined
        } catch (error) {
          reportInternalGuardError(ctx.logger, 'tool.before', error)
          return { block: true, reason: INTERNAL_SECURITY_GUARD_REASON }
        }
      },
      'session.end': async (event) => {
        clearSessionTaints(event.sessionId)
      },
    },
  }),
})
