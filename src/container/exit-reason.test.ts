import { describe, expect, test } from 'bun:test'

import { inspectContainerExit } from './exit-reason'
import type { DockerExec } from './shared'

const id = 'a'.repeat(64)
const finishedAt = '2026-09-29T04:58:43.28123Z'

describe('inspectContainerExit', () => {
  test.each([
    [
      `${id}|false|true|137|6442450944|${finishedAt}`,
      'agent runtime was SIGKILLed (137) and the container recorded an OOM kill during this run (likely container memory limit 6144 MiB). Restart the agent and reduce memory-heavy parallel work.',
    ],
    [
      `${id}|false|true|137|0|${finishedAt}`,
      'agent runtime was SIGKILLed (137) and the container recorded an OOM kill during this run. Restart the agent and reduce memory-heavy parallel work.',
    ],
    [
      `${id}|false|true|0|6442450944|${finishedAt}`,
      'agent runtime exited with code 0; an OOM kill occurred in the container earlier in this run (likely container memory limit 6144 MiB); a subprocess may have been killed. Restart the agent and reduce memory-heavy parallel work.',
    ],
    [
      `${id}|false|false|137|6442450944|${finishedAt}`,
      'agent runtime exited with SIGKILL (137); Docker did not report an OOM kill.',
    ],
    [`${id}|false|false|1|6442450944|${finishedAt}`, null],
  ])('classifies a stopped container from Docker state: %s', async (stdout, reason) => {
    const exec: DockerExec = async () => ({ exitCode: 0, stdout, stderr: '' })
    expect(await inspectContainerExit(exec, 'agent')).toEqual({ kind: 'stopped', containerId: id, finishedAt, reason })
  })

  test('running container yields no exit reason even with stale OOM flag', async () => {
    const exec: DockerExec = async () => ({
      exitCode: 0,
      stdout: `${id}|true|true|137|6442450944|0001-01-01T00:00:00Z`,
      stderr: '',
    })
    expect(await inspectContainerExit(exec, 'agent')).toEqual({ kind: 'running', containerId: id })
  })

  test('failed and malformed inspect never assert OOM', async () => {
    const failed: DockerExec = async () => ({
      exitCode: 1,
      stdout: `${id}|false|true|137|6442450944|${finishedAt}`,
      stderr: 'daemon down',
    })
    const malformed: DockerExec = async () => ({
      exitCode: 0,
      stdout: `${id}|false|true|137|oops|${finishedAt}`,
      stderr: '',
    })
    expect(await inspectContainerExit(failed, 'agent')).toBeNull()
    expect(await inspectContainerExit(malformed, 'agent')).toBeNull()
  })
})
