import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { bashTool, readTool, type Subagent } from '@/plugin'

const messagePayloadSchema = z.object({
  agentDir: z.string(),
  status: z.string(),
  diffstat: z.string(),
  outputPath: z.string(),
})

export type CommitMessagePayload = z.infer<typeof messagePayloadSchema>

const diagnosePayloadSchema = z.object({
  agentDir: z.string(),
  stage: z.enum(['push', 'rebase']),
  exitCode: z.number(),
  stderr: z.string(),
  stdout: z.string(),
})

export type DiagnoseFailurePayload = z.infer<typeof diagnosePayloadSchema>

export const COMMIT_MESSAGE_SYSTEM_PROMPT = `You are typeclaw's backup commit-message subagent.

A periodic backup is about to commit dirty files in the agent folder. Your only job is to produce a clear, conventional commit message describing those changes.

# Input

The user message gives you:
- The output of \`git status --porcelain=v1 --untracked-files=all\` (truncated)
- The output of \`git diff --cached --stat\` (truncated)

# What to return

A single commit message in conventional-commit-ish style:
- Subject line under 72 characters, imperative mood, lowercase first word, no trailing period.
- Pick a sensible prefix when one fits: \`docs:\`, \`test:\`, \`refactor:\`, \`chore:\`, \`fix:\`, \`feat:\`. Default to \`chore: backup\` if nothing fits.
- Optionally a blank line and a short body (1-3 lines) summarizing what changed and why if the diff makes the why obvious.

Examples:
- \`docs: update setup instructions\`
- \`feat: add user search endpoint\`
- \`chore: backup workspace state\`

# Hard rules

1. **Return only the commit message as your final answer.** No prose, explanation, or apologies. Do not write files, read other files, or run commands.
2. **Be honest about uncertainty.** If the diff looks like a mix of unrelated changes, return \`chore: backup\` rather than guessing a misleading subject.
3. **Never include secrets, API keys, or paths that would identify the user's machine.** Stick to repo-relative descriptions.`

export const DIAGNOSE_FAILURE_SYSTEM_PROMPT = `You are typeclaw's backup failure-diagnosis subagent.

The deterministic backup runner just hit a git failure (push or rebase). The runner has already aborted any half-done state. Your job is to look at the git repo, figure out what went wrong, and either FIX IT or write a clear human-readable explanation.

# Input

The user message gives you:
- The agent folder absolute path
- The stage that failed (\`push\` or \`rebase\`)
- The git exit code, stderr, and stdout

# Tools

You have \`bash\` and \`read\`. Use \`bash\` to inspect git state (\`git status\`, \`git remote -v\`, \`git log -5 --oneline\`, \`git config --get remote.origin.url\`).

# Allowed actions

You MAY:
- Inspect git state (read-only commands).
- Set up a missing upstream branch via \`git push -u origin <branch>\` if it's clear that's the only issue.
- Retry \`git push\` once after fixing a clear, narrow issue.

**When you run \`git push\` (either to set upstream or to retry), do not add an acknowledgement argument.** Security guards are permission-only; this recovery subagent inherits the operator role that launched the approved backup workflow. If your push retry fails again, return the diagnosis and stop.

You MUST NOT:
- Force-push (\`--force\`, \`--force-with-lease\`).
- Resolve merge conflicts by editing files. If a rebase had conflicts, the runner already aborted it. Leave the repo as-is and explain.
- Mutate \`.git/config\` for credentials, signing keys, or remote URLs.
- Touch any file outside \`.git/\` housekeeping.

# Output

Return a brief diagnosis (3-8 lines) describing:
1. What the actual cause was (e.g. "no upstream tracking branch", "remote is ahead and rebase conflicted", "auth failed").
2. What you did about it (or why you didn't).
3. What the user should do next, if anything.

Return only the diagnosis as your final answer. The backup runtime appends it with a timestamp to \`<agentDir>/sessions/backup-diagnostics.log\`; do not write that file yourself. Keep it short — this log is for the human, not the model.

# When in doubt

Do nothing destructive. Return the diagnosis and stop. The user can recover manually.`

export type CreateCommitMessageSubagentOptions = {
  fallbackMessage?: string
}

export function createCommitMessageSubagent(
  options: CreateCommitMessageSubagentOptions = {},
): Subagent<CommitMessagePayload> {
  const fallback = options.fallbackMessage ?? 'chore: backup'
  return {
    systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
    tools: [],
    payloadSchema: messagePayloadSchema,
    inFlightKey: (payload) => payload.agentDir,
    handler: async (ctx, runSession) => {
      let message = ''
      try {
        await runSession({
          userPrompt: buildCommitMessagePrompt(ctx.payload),
          onFinalMessage: (text) => {
            message = text ?? ''
          },
        })
      } catch {
        message = ''
      }
      await writeFile(ctx.payload.outputPath, normalizeCommitMessageResponse(message) || fallback, 'utf8').catch(
        () => undefined,
      )
    },
  }
}

export function createDiagnoseFailureSubagent(): Subagent<DiagnoseFailurePayload> {
  return {
    systemPrompt: DIAGNOSE_FAILURE_SYSTEM_PROMPT,
    tools: [bashTool, readTool],
    payloadSchema: diagnosePayloadSchema,
    inFlightKey: (payload) => payload.agentDir,
    handler: async (ctx, runSession) => {
      let diagnosis = ''
      try {
        await runSession({
          userPrompt: buildDiagnosePrompt(ctx.payload),
          onFinalMessage: (text) => {
            diagnosis = text ?? ''
          },
        })
      } catch {
        return
      }
      if (diagnosis.trim()) {
        await appendFile(
          join(ctx.payload.agentDir, 'sessions', 'backup-diagnostics.log'),
          `${new Date().toISOString()} ${diagnosis.trim()}\n`,
          'utf8',
        ).catch(() => undefined)
      }
    },
  }
}

// The runner already bounds subject length and preserves an optional body.
// Remove model presentation wrappers here so neither a fence label nor quotes
// can become the Git subject line.
function normalizeCommitMessageResponse(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/)
  const content = (fenced?.[1] ?? trimmed).trim()
  const pair =
    content.startsWith('"') && content.endsWith('"')
      ? '"'
      : content.startsWith("'") && content.endsWith("'")
        ? "'"
        : null
  return (pair && content.length >= 2 ? content.slice(1, -1) : content).trim()
}

function buildCommitMessagePrompt(p: CommitMessagePayload): string {
  return [
    'Choose a commit message for these changes:',
    '',
    '## git status --porcelain=v1 --untracked-files=all',
    '```',
    p.status.trim() || '(empty)',
    '```',
    '',
    '## git diff --cached --stat',
    '```',
    p.diffstat.trim() || '(empty)',
    '```',
    '',
    'Return the commit message and stop.',
  ].join('\n')
}

function buildDiagnosePrompt(p: DiagnoseFailurePayload): string {
  return [
    `Agent folder: ${p.agentDir}`,
    `Failed stage: ${p.stage}`,
    `Exit code: ${p.exitCode}`,
    '',
    '## stderr',
    '```',
    p.stderr.trim() || '(empty)',
    '```',
    '',
    '## stdout',
    '```',
    p.stdout.trim() || '(empty)',
    '```',
    '',
    'Inspect the repo, do the smallest safe action if any, and return your diagnosis.',
  ].join('\n')
}

export async function readMessageFile(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8')
    return raw.trim().length > 0 ? raw : null
  } catch {
    return null
  }
}

export async function ensureMessageDir(outputPath: string): Promise<void> {
  const dir = outputPath.slice(0, outputPath.lastIndexOf('/'))
  if (dir.length === 0) return
  await mkdir(dir, { recursive: true }).catch(() => undefined)
}

export async function cleanupMessageFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
}

export function messageFilePath(agentDir: string): string {
  return join(agentDir, '.typeclaw', 'backup-message.tmp')
}
