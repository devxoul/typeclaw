// Under a 6 GiB memcg, a ~230 MiB tool process contributes only ~38 points
// from RSS, versus ~230 for a 1.4 GiB agent runtime. +600 puts even that
// tool ahead of the runtime without using the maximum (+1000) and making
// tiny helper processes unconditional first victims. Children inherit the
// score across fork/exec. The shell writes its OWN score before any command
// can fork; writing /proc/<pid> from the parent after spawn would race.
const OOM_SCORE_ADJ = 600
const SCORE_PATH = '/proc/self/oom_score_adj'
const PRIORITY_SCRIPT = `if [ -w ${SCORE_PATH} ]; then printf '%s\\n' ${OOM_SCORE_ADJ} 2>/dev/null >${SCORE_PATH} || :; fi`

function priorityScript(scorePath: string): string {
  // The default is pre-rendered; alternate paths are solely a test seam for
  // an absent or write-failing procfs, never derived from a tool command.
  return scorePath === SCORE_PATH
    ? PRIORITY_SCRIPT
    : `if [ -w '${scorePath}' ]; then printf '%s\\n' ${OOM_SCORE_ADJ} 2>/dev/null >'${scorePath}' || :; fi`
}

// Shell built-in printf runs in this process. An absent/unwritable procfs
// (including non-container dev environments) fails open without changing the
// command's output, exit status, environment, or timeout behavior.
export function withToolOomPriorityCommand(command: string, scorePath = SCORE_PATH): string {
  return process.platform === 'linux' ? `${priorityScript(scorePath)}\n${command}` : command
}

export function withToolOomPriorityArgv(command: string[], scorePath = SCORE_PATH): string[] {
  return process.platform === 'linux'
    ? ['/bin/sh', '-c', `${priorityScript(scorePath)}\nexec "$@"`, 'tool-oom-priority', ...command]
    : command
}

export { OOM_SCORE_ADJ }
