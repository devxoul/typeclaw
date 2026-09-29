import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'
import { invokeSubagent } from '@/agent/subagents'

import { createCommitMessageSubagent, createDiagnoseFailureSubagent, messageFilePath } from './subagents'

describe('backup subagents', () => {
  test('uses the assistant response without asking the model to write a guarded file', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-backup-message-'))
    try {
      const outputPath = messageFilePath(agentDir)
      await mkdir(join(agentDir, '.typeclaw'))
      const subagent = createCommitMessageSubagent()
      expect(subagent.tools ?? []).toEqual([])
      const payload = {
        agentDir,
        outputPath,
        status: ' M packages/app/src/index.ts',
        diffstat: ' packages/app/src/index.ts | 2 ++',
      }
      await subagent.handler!({ agentDir, payload, userPrompt: '' }, async (override) => {
        override?.onFinalMessage?.('fix: repair application entry point')
      })
      expect(await readFile(outputPath, 'utf8')).toBe('fix: repair application entry point')
      const fallbackPath = join(agentDir, '.typeclaw', 'empty-message.tmp')
      await subagent.handler!(
        { agentDir, payload: { ...payload, outputPath: fallbackPath }, userPrompt: '' },
        async (override) => {
          override?.onFinalMessage?.(null)
        },
      )
      expect(await readFile(fallbackPath, 'utf8')).toBe('chore: backup')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })
  test('falls back after partial assistant text followed by a soft provider failure', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-backup-soft-failure-'))
    try {
      await mkdir(join(agentDir, '.typeclaw'))
      const listeners = new Set<(event: unknown) => void>()
      let leafMessage: unknown
      const session = {
        subscribe: (listener: (event: unknown) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        prompt: async () => {
          for (const listener of listeners) {
            listener({ type: 'message_end', message: { role: 'assistant', content: 'feat: stale output' } })
            leafMessage = {
              role: 'assistant',
              content: 'feat: incomplete',
              stopReason: 'error',
              errorMessage: 'provider failed',
            }
            listener({ type: 'message_end', message: leafMessage })
          }
        },
        sessionManager: { getLeafEntry: () => ({ type: 'message', message: leafMessage }) },
        dispose: () => {},
      } as unknown as AgentSession
      await invokeSubagent('backup-message', {
        // backup-message declares no tools, so dropping the plugin-only tool fields yields the runtime shape.
        registry: {
          'backup-message': (({ tools: _tools, customTools: _customTools, ...runtime }) => runtime)(
            createCommitMessageSubagent(),
          ),
        },
        createSessionForSubagent: async () => session,
        agentDir,
        userPrompt: '',
        payload: { agentDir, outputPath: messageFilePath(agentDir), status: ' M app.ts', diffstat: ' app.ts | 1 +' },
      })
      expect(await readFile(messageFilePath(agentDir), 'utf8')).toBe('chore: backup')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('unfences a multiline Korean commit response before the runner sees it', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-backup-fenced-'))
    try {
      await mkdir(join(agentDir, '.typeclaw'))
      const subagent = createCommitMessageSubagent()
      await subagent.handler!(
        {
          agentDir,
          userPrompt: '',
          payload: { agentDir, outputPath: messageFilePath(agentDir), status: ' M app.ts', diffstat: ' app.ts | 1 +' },
        },
        async (override) => {
          override?.onFinalMessage?.('```text\n\nfix: 검색 결과 수정\n\n검색어를 유지합니다.\n```')
        },
      )
      expect(await readFile(messageFilePath(agentDir), 'utf8')).toBe('fix: 검색 결과 수정\n\n검색어를 유지합니다.')
      await subagent.handler!(
        {
          agentDir,
          userPrompt: '',
          payload: { agentDir, outputPath: messageFilePath(agentDir), status: ' M app.ts', diffstat: ' app.ts | 1 +' },
        },
        async (override) => {
          override?.onFinalMessage?.('"docs: clarify backup recovery"')
        },
      )
      expect(await readFile(messageFilePath(agentDir), 'utf8')).toBe('docs: clarify backup recovery')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('stores a failure diagnosis without a model write to sessions/', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-backup-diagnose-'))
    try {
      await mkdir(join(agentDir, 'sessions'))
      const subagent = createDiagnoseFailureSubagent()
      expect(subagent.tools?.some((tool) => tool.__builtinTool === 'write')).toBe(false)
      await subagent.handler!(
        { agentDir, userPrompt: '', payload: { agentDir, stage: 'push', exitCode: 1, stderr: 'rejected', stdout: '' } },
        async (override) => {
          override?.onFinalMessage?.('Remote rejected the push; inspect branch protection.')
        },
      )
      await subagent.handler!(
        {
          agentDir,
          userPrompt: '',
          payload: { agentDir, stage: 'rebase', exitCode: 1, stderr: 'conflict', stdout: '' },
        },
        async (override) => {
          override?.onFinalMessage?.('Rebase conflicted; resolve manually.')
        },
      )
      const log = await readFile(join(agentDir, 'sessions', 'backup-diagnostics.log'), 'utf8')
      expect(log).toMatch(
        /^\d{4}-\d\d-\d\dT[^\n]+ Remote rejected the push; inspect branch protection\.\n\d{4}-\d\d-\d\dT[^\n]+ Rebase conflicted; resolve manually\.\n$/,
      )
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })
})
