import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { OOM_SCORE_ADJ, withToolOomPriorityArgv, withToolOomPriorityCommand } from './tool-oom-priority'

const readScore = 'cat /proc/self/oom_score_adj; /bin/sh -c "cat /proc/self/oom_score_adj"'

describe('tool subprocess OOM priority', () => {
  test.skipIf(process.platform !== 'linux')('raises the command and its grandchild, not the agent runtime', () => {
    const baseline = Number(readFileSync('/proc/self/oom_score_adj', 'utf8').trim())
    const argv = withToolOomPriorityArgv(['/bin/sh', '-c', readScore])
    const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual([String(OOM_SCORE_ADJ), String(OOM_SCORE_ADJ)])
    expect(Number(readFileSync('/proc/self/oom_score_adj', 'utf8').trim())).toBe(baseline)
  })

  test.skipIf(process.platform !== 'linux')('raises a bash-tool shell before sandbox/command grandchildren', () => {
    const result = spawnSync('bash', ['-c', withToolOomPriorityCommand(readScore)], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual([String(OOM_SCORE_ADJ), String(OOM_SCORE_ADJ)])
  })

  test.skipIf(process.platform !== 'linux')(
    'keeps command output, stderr, and exit code when the score write fails',
    () => {
      for (const path of ['/dev/full', '/proc/self/stat', '/proc/self/nonexistent-score']) {
        const argv = withToolOomPriorityArgv(['/bin/sh', '-c', 'printf success; printf diagnostic >&2; exit 37'], path)
        const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
        expect(result.status).toBe(37)
        expect(result.stdout).toBe('success')
        expect(result.stderr).toBe('diagnostic')
      }
    },
  )

  test.skipIf(process.platform !== 'linux')('preserves adversarial argv and shell-command quoting', () => {
    const argument = `two words ' " $HOME ; $(printf injected) \n newline`
    const argv = withToolOomPriorityArgv(['/bin/sh', '-c', 'printf "%s" "$1"', 'inner-shell', argument])
    const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(argument)
    const command = `printf '%s' 'literal $HOME; $(printf injected)'`
    const bash = spawnSync('bash', ['-c', withToolOomPriorityCommand(command)], { encoding: 'utf8' })
    expect(bash.status).toBe(0)
    expect(bash.stdout).toBe('literal $HOME; $(printf injected)')
  })

  test.skipIf(process.platform === 'linux')('keeps the command and arguments unchanged on non-Linux platforms', () => {
    const argv = ['/bin/sh', '-c', 'printf working']
    expect(withToolOomPriorityArgv(argv)).toBe(argv)
    expect(withToolOomPriorityCommand(argv[2]!)).toBe(argv[2]!)
  })

  // Needs a POSIX shell; Windows has no /bin/sh.
  test.skipIf(process.platform === 'win32')('the wrapped command still runs and keeps its output', () => {
    const wrapped = withToolOomPriorityArgv(['/bin/sh', '-c', 'printf working'])
    const result = spawnSync(wrapped[0]!, wrapped.slice(1), { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('working')
  })
})
