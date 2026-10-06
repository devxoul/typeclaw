import { defineCommand } from 'citty'

import {
  composeDoctor,
  composeLogs,
  composeRestart,
  composeStart,
  composeStats,
  composeStatus,
  composeStop,
  composeUsage,
  type AgentResult,
  type ComposeDoctorReport,
} from '@/compose'
import { config } from '@/config'
import { parseTailValue } from '@/container'
import { formatJson, formatReport } from '@/doctor'

import { formatComposeStats } from './compose-stats'
import { formatComposeStatus } from './compose-status'
import { formatComposeUsage, formatComposeUsageJson } from './compose-usage'
import { preflightDocker, printDockerGuidance } from './docker-preflight'
import { c, errorLine, log, spinner } from './ui'
import { parseSince, parseUntil } from './usage-args'

// Compose fans a docker command out across every agent folder. A down daemon
// would otherwise surface as N identical raw-stderr rows (one per agent) instead
// of one actionable message, so gate the whole fleet operation on a single
// preflight up front. usage reads only local session files and never touches
// docker, so it is intentionally not gated.
async function requireDockerOrExit(): Promise<void> {
  const preflight = await preflightDocker()
  if (!preflight.ok) {
    printDockerGuidance(preflight)
    process.exit(1)
  }
}

const startSub = defineCommand({
  meta: { name: 'start', description: 'start every agent in immediate subdirectories of cwd' },
  args: {
    port: {
      type: 'string',
      description: 'preferred host port for each agent; collisions fall back to ephemeral per-agent',
      default: String(config.port),
    },
    build: {
      type: 'boolean',
      description: 'regenerate each Dockerfile from the template and rebuild',
      default: false,
    },
  },
  async run({ args }) {
    await requireDockerOrExit()
    const board = makeBoard('Starting agents')
    const s = spinner()
    const { agents, results, memoryWarning } = await composeStart({
      rootCwd: process.cwd(),
      preferredHostPort: Number(args.port),
      forceBuild: args.build,
      cliEntry: process.argv[1],
      onProgress: (event) => {
        if (event.kind === 'agent-start') {
          board.add(s, event.name, 'starting')
        } else {
          board.set(s, event.name, formatStartDone(event.result))
        }
      },
    })
    if (agents.length === 0) {
      console.log(c.dim('No typeclaw agents found in immediate subdirectories of cwd.'))
      return
    }
    const failed = results.reduce((n, r) => (r.ok ? n : n + 1), 0)
    board.finish(s, results, 'started', failed)
    if (memoryWarning !== null) log.warn(memoryWarning.join('\n'))
    if (failed > 0) process.exit(1)
  },
})

const stopSub = defineCommand({
  meta: { name: 'stop', description: 'stop every agent in immediate subdirectories of cwd' },
  async run() {
    await requireDockerOrExit()
    const board = makeBoard('Stopping agents')
    const s = spinner()
    const { agents, results } = await composeStop({
      rootCwd: process.cwd(),
      onProgress: (event) => {
        if (event.kind === 'agent-start') {
          board.add(s, event.name, 'stopping')
        } else {
          board.set(s, event.name, formatStopDone(event.result))
        }
      },
    })
    if (agents.length === 0) {
      console.log(c.dim('No typeclaw agents found in immediate subdirectories of cwd.'))
      return
    }
    const failed = results.reduce((n, r) => (r.ok ? n : n + 1), 0)
    board.finish(s, results, 'stopped', failed)
    if (failed > 0) process.exit(1)
  },
})

const restartSub = defineCommand({
  meta: { name: 'restart', description: 'stop and relaunch every agent in immediate subdirectories of cwd' },
  args: {
    port: {
      type: 'string',
      description: 'preferred host port for each agent; collisions fall back to ephemeral per-agent',
      default: String(config.port),
    },
    build: {
      type: 'boolean',
      description: 'regenerate each Dockerfile from the template and rebuild',
      default: false,
    },
  },
  async run({ args }) {
    await requireDockerOrExit()
    const board = makeBoard('Restarting agents')
    const s = spinner()
    const { agents, results, memoryWarning } = await composeRestart({
      rootCwd: process.cwd(),
      preferredHostPort: Number(args.port),
      forceBuild: args.build,
      cliEntry: process.argv[1],
      onProgress: (event) => {
        if (event.kind === 'agent-start') {
          board.add(s, event.name, 'stopping')
        } else if (event.kind === 'agent-stopped') {
          board.set(s, event.name, c.dim('starting...'))
        } else {
          board.set(s, event.name, formatRestartDone(event.result))
        }
      },
    })
    if (agents.length === 0) {
      console.log(c.dim('No typeclaw agents found in immediate subdirectories of cwd.'))
      return
    }
    const failed = results.reduce((n, r) => (r.ok ? n : n + 1), 0)
    board.finish(s, results, 'restarted', failed)
    if (memoryWarning !== null) log.warn(memoryWarning.join('\n'))
    if (failed > 0) process.exit(1)
  },
})

const statusSub = defineCommand({
  meta: { name: 'status', description: 'show status of every agent in immediate subdirectories of cwd' },
  async run() {
    await requireDockerOrExit()
    const result = await composeStatus(process.cwd())
    const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
    process.stdout.write(`${formatComposeStatus(result, { useColor })}\n`)
  },
})

const statsSub = defineCommand({
  meta: { name: 'stats', description: 'show cpu, memory, and pids for every agent in immediate subdirectories of cwd' },
  async run() {
    await requireDockerOrExit()
    const result = await composeStats(process.cwd())
    const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
    process.stdout.write(`${formatComposeStats(result, { useColor })}\n`)
  },
})

const logsSub = defineCommand({
  meta: { name: 'logs', description: 'multiplex docker logs for every running agent in immediate subdirectories' },
  args: {
    follow: {
      type: 'boolean',
      alias: 'f',
      description: 'stream new log output as it arrives',
      default: false,
    },
    tail: {
      type: 'string',
      alias: 'n',
      description: 'number of lines to show from the end of each agent\'s logs (non-negative integer or "all")',
    },
  },
  async run({ args }) {
    let tail: string | undefined
    if (args.tail !== undefined) {
      const parsed = parseTailValue(args.tail)
      if (!parsed.ok) {
        console.error(errorLine(parsed.reason))
        process.exit(2)
      }
      tail = parsed.value
    }

    await requireDockerOrExit()

    const controller = new AbortController()
    const onSig = (): void => controller.abort()
    process.once('SIGINT', onSig)
    process.once('SIGTERM', onSig)
    try {
      if (args.follow) {
        console.log(c.cyan('Streaming logs for all agents...'))
      } else {
        console.log(c.dim('Showing logs for all agents.'))
      }
      const result = await composeLogs({
        rootCwd: process.cwd(),
        follow: args.follow,
        tail,
        signal: controller.signal,
      })
      if (result.agents.length === 0) {
        console.log(c.dim('No typeclaw agents found in immediate subdirectories of cwd.'))
        return
      }
      if (result.exitCode !== 0) process.exit(result.exitCode)
    } finally {
      process.off('SIGINT', onSig)
      process.off('SIGTERM', onSig)
    }
  },
})

const usageSub = defineCommand({
  meta: {
    name: 'usage',
    description: 'report LLM token usage and cost across every agent in immediate subdirectories of cwd',
  },
  args: {
    json: { type: 'boolean', description: 'emit the usage report as JSON', default: false },
    since: { type: 'string', description: "ISO date or relative duration ('today', '7d', '30d')" },
    until: { type: 'string', description: 'ISO date upper bound (exclusive)' },
  },
  async run({ args }) {
    const since = parseSince(args.since, 'typeclaw compose usage')
    const until = parseUntil(args.until, 'typeclaw compose usage')
    const result = await composeUsage({
      rootCwd: process.cwd(),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    })
    if (args.json) {
      process.stdout.write(`${formatComposeUsageJson(result)}\n`)
      return
    }
    const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
    process.stdout.write(`${formatComposeUsage(result, { useColor })}\n`)
    const anyFailed = result.results.some((r) => !r.ok)
    if (anyFailed) process.exit(1)
  },
})

const doctorSub = defineCommand({
  meta: { name: 'doctor', description: 'diagnose every agent in immediate subdirectories of cwd' },
  args: {
    verbose: { type: 'boolean', alias: 'v', default: false, description: 'show check details' },
    json: { type: 'boolean', default: false, description: 'emit the report as JSON' },
    fix: {
      type: 'boolean',
      default: false,
      description: 'attempt auto-fixes per agent and commit changes in each agent folder',
    },
    only: { type: 'string', description: 'comma-separated category filter' },
    shallow: {
      type: 'boolean',
      default: false,
      description: 'run cross-agent checks only; skip per-agent doctor runs',
    },
  },
  async run({ args }) {
    const only = args.only
      ? args.only
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined
    const report = await composeDoctor({
      rootCwd: process.cwd(),
      fix: args.fix,
      shallow: args.shallow,
      ...(only !== undefined ? { only } : {}),
    })
    emitComposeDoctor(report, { verbose: args.verbose, json: args.json })
    if (!report.ok) process.exit(1)
  },
})

export const composeCommand = defineCommand({
  meta: {
    name: 'compose',
    description: 'orchestrate every typeclaw agent in subdirectories of cwd',
  },
  subCommands: {
    start: startSub,
    stop: stopSub,
    restart: restartSub,
    status: statusSub,
    stats: statsSub,
    logs: logsSub,
    usage: usageSub,
    doctor: doctorSub,
  },
})

// Single clack spinner with a multi-line message body, one line per agent.
// Concurrent clack spinners can't coexist: each one's render loop writes
// cursor.to(0) + erase.down() to process.stdout, so they trample each other.
// Multi-line redraw is safe while this board owns the terminal — clack counts
// newlines in the previous message and walks the cursor up before erasing (see
// @clack/prompts spinner.ts). Compose start/restart therefore capture process
// output instead of letting child progress or warnings invalidate clack's
// cursor position.
type Board = {
  add: (s: ReturnType<typeof spinner>, name: string, state: string) => void
  set: (s: ReturnType<typeof spinner>, name: string, state: string) => void
  finish: <T>(s: ReturnType<typeof spinner>, results: AgentResult<T>[], verb: string, failed: number) => void
}

function makeBoard(header: string): Board {
  const order: string[] = []
  const states = new Map<string, string>()
  let started = false

  const renderLines = (): string => {
    const width = order.reduce((w, name) => Math.max(w, name.length), 0)
    return order.map((name) => `  ${c.bold(name.padEnd(width))}  ${states.get(name) ?? ''}`).join('\n')
  }

  const paint = (s: ReturnType<typeof spinner>): void => {
    const body = `${header}\n${renderLines()}`
    if (!started) {
      started = true
      s.start(body)
    } else {
      s.message(body)
    }
  }

  return {
    add(s, name, state) {
      order.push(name)
      states.set(name, c.dim(`${state}...`))
      paint(s)
    },
    set(s, name, state) {
      states.set(name, state)
      paint(s)
    },
    finish(s, results, verb, failed) {
      const total = results.length
      const ok = total - failed
      const summary = failed === 0 ? `${verb} ${ok}/${total}` : `${verb} ${ok}/${total} (${failed} failed)`
      const body = `${failed === 0 ? c.green(summary) : c.red(summary)}\n${renderLines()}`
      if (failed === 0) s.stop(body)
      else s.error(body)
    },
  }
}

function formatStartDone<T extends { alreadyRunning?: boolean; hostPort: number }>(result: AgentResult<T>): string {
  if (!result.ok) return appendWarnings(`${c.red('✖')} ${c.red('failed:')} ${result.reason}`, result.warnings)
  const verb = result.data.alreadyRunning ? 'already running' : 'started'
  const head = `${c.green('✔')} ${verb} on host port ${c.cyan(String(result.data.hostPort))}`
  return appendWarnings(head, result.warnings)
}

function formatStopDone<T extends { running: boolean }>(result: AgentResult<T>): string {
  if (!result.ok) return appendWarnings(`${c.red('✖')} ${c.red('failed:')} ${result.reason}`, result.warnings)
  const head = result.data.running ? `${c.green('✔')} stopped` : `${c.dim('○')} ${c.dim('not running')}`
  return appendWarnings(head, result.warnings)
}

function formatRestartDone<T extends { start: { hostPort: number } }>(result: AgentResult<T>): string {
  if (!result.ok) return appendWarnings(`${c.red('✖')} ${c.red('failed:')} ${result.reason}`, result.warnings)
  const head = `${c.green('✔')} restarted on host port ${c.cyan(String(result.data.start.hostPort))}`
  return appendWarnings(head, result.warnings)
}

// Surface non-fatal validateConfig warnings under the per-agent compose status
// line so compose start/restart don't silently drop what `typeclaw start` prints.
function appendWarnings(head: string, warnings: string[] | undefined): string {
  if (warnings === undefined || warnings.length === 0) return head
  // Continuation lines of a multi-line warning stay under its first line.
  return [head, ...warnings.map((w) => `  ${c.yellow('⚠')} ${w.replaceAll('\n', '\n    ')}`)].join('\n')
}

function emitComposeDoctor(report: ComposeDoctorReport, opts: { verbose: boolean; json: boolean }): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
  const sectionHead = useColor ? c.bold : (s: string) => s

  process.stdout.write(`${sectionHead('compose doctor')}  ${c.dim(report.rootCwd)}\n\n`)

  process.stdout.write(`${sectionHead('Cross-agent checks')}\n`)
  for (const check of report.crossChecks) {
    const marker = checkMarker(check.status)
    process.stdout.write(`  ${marker} ${check.message} ${c.dim(`(${check.name})`)}\n`)
    if (opts.verbose && check.details !== undefined) {
      for (const d of check.details) process.stdout.write(`      ${c.dim(`• ${d}`)}\n`)
    }
  }
  process.stdout.write('\n')

  for (const agent of report.agents) {
    process.stdout.write(`${sectionHead(`Agent: ${agent.entry.name}`)}  ${c.dim(agent.entry.cwd)}\n`)
    process.stdout.write(
      `${opts.json ? formatJson(agent.result.final ?? agent.result.initial) : formatReport(agent.result.initial, { useColor, verbose: opts.verbose })}\n\n`,
    )
  }

  process.stdout.write(
    `${report.ok ? c.green('●') : c.red('●')} compose doctor ${report.ok ? 'passed' : 'found issues'}\n`,
  )
}

function checkMarker(status: 'ok' | 'warning' | 'error' | 'info'): string {
  switch (status) {
    case 'ok':
      return c.green('✓')
    case 'warning':
      return c.yellow('!')
    case 'error':
      return c.red('✗')
    case 'info':
      return c.cyan('i')
  }
}
