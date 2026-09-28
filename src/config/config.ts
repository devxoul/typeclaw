import { accessSync, constants as fsConstants, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, resolve } from 'node:path'

import type { KnownApi, Model } from '@earendil-works/pi-ai'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import { z } from 'zod'

import { channelsSchema, SEEDED_GITHUB_EVENT_ALLOWLISTS } from '@/channels/schema'
import { commitSystemFileSync } from '@/git/system-commit'
import { rolesConfigSchema } from '@/permissions/schema'
import { secretFieldSchema } from '@/secrets/resolve'

import {
  DEFAULT_MODEL_REF,
  KNOWN_PROVIDERS,
  isKnownModelRef,
  isModelRef,
  listKnownModelRefs,
  type KnownModelRef,
  type ModelRef,
  providerForModelRef,
} from './providers'

const CONFIG_FILE = 'typeclaw.json'

const knownModelRefs = listKnownModelRefs() as [KnownModelRef, ...KnownModelRef[]]

// T9 keypad: T=8, Y=9, P=7, E=3
const DEFAULT_PORT = 8973

export const GWS_MULTI_ACCOUNT_PLUGIN_PACKAGE = 'typeclaw-gws-multi-account'
export const GWS_MULTI_ACCOUNT_PLUGIN_VERSION = '^0.3.4'
export const DEFAULT_PLUGINS = [`${GWS_MULTI_ACCOUNT_PLUGIN_PACKAGE}@${GWS_MULTI_ACCOUNT_PLUGIN_VERSION}`] as const

export function withDefaultPlugins(plugins: readonly string[]): string[] {
  const configuredNames = new Set(plugins.map(pluginPackageName))
  const defaults = DEFAULT_PLUGINS.filter((entry) => !configuredNames.has(pluginPackageName(entry)))
  return [...defaults, ...plugins]
}

function pluginPackageName(entry: string): string {
  if (entry.startsWith('@')) {
    const slash = entry.indexOf('/')
    const at = slash === -1 ? -1 : entry.indexOf('@', slash + 1)
    return at === -1 ? entry : entry.slice(0, at)
  }
  const at = entry.indexOf('@')
  return at === -1 ? entry : entry.slice(0, at)
}

// Mount names land on disk as `mounts/<name>` inside the agent folder, so they
// share a namespace with regular filenames. Restricting to lowercase
// alphanumerics + `-`/`_` keeps them shell-safe and avoids accidental shadowing
// of files like `mounts/.git` or `mounts/Hello`.
const MOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/

// Shell-portable env var identifier: a leading letter or underscore followed by
// letters, digits, or underscores. MCP `env` keys are passed verbatim to a child
// process environment, so an invalid identifier (spaces, `=`, leading digit)
// would be silently dropped or corrupt the spawned server's env.
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

// Upper bound for a per-server MCP request timeout: 10 minutes. Long-running
// MCP tools (large crawls, builds) can legitimately take minutes, but a ceiling
// guards against fat-finger values that would re-introduce the unbounded-hang
// failure mode the explicit timeouts exist to prevent.
const MCP_MAX_TIMEOUT_MS = 600_000

// URL schemes are case-insensitive (RFC 3986), and the WHATWG parser normalizes
// `.protocol` to lowercase. Checking the parsed protocol instead of a raw
// `startsWith` keeps `HTTPS://…` valid, which `z.string().url()` already accepts.
function isHttpProtocol(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export const mountSchema = z.object({
  name: z.string().regex(MOUNT_NAME_PATTERN, 'mount name must be lowercase alphanumeric with - or _'),
  path: z.string().min(1),
  readOnly: z.boolean().default(false),
  description: z.string().optional(),
})

export type Mount = z.infer<typeof mountSchema>

// MCP servers are keyed by the same shell/disk-safe namespace as mounts because
// the name becomes the tool namespace exposed to the agent. The transport is an
// XOR on purpose: stdio servers are child processes (`command` + `args` + env),
// while Streamable HTTP servers are remote endpoints (`url`); accepting both
// would make ownership, lifetime, and credential injection ambiguous at boot.
export const mcpServerSchema = z
  .object({
    name: z
      .string()
      .regex(MOUNT_NAME_PATTERN, 'MCP server name must be lowercase alphanumeric with - or _')
      .refine((name) => !name.includes('__'), {
        message: "MCP server name must not contain '__' (reserved as the tool-namespace separator)",
      }),
    description: z.string().optional(),
    // Default true so omitting the field keeps the server on; set false to keep config but skip connecting.
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().max(MCP_MAX_TIMEOUT_MS).optional(),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).default([]),
    url: z
      .string()
      .url()
      .refine((u) => isHttpProtocol(u), {
        message: 'MCP server url must use http:// or https://',
      })
      .optional(),
    env: z
      .record(z.string().regex(ENV_NAME_PATTERN, 'env var name must be a valid identifier'), secretFieldSchema)
      .default({}),
  })
  .refine((server) => (server.command !== undefined) !== (server.url !== undefined), {
    message: 'MCP server must be either stdio (command) or http (url), not both or neither',
  })

export type McpServer = z.infer<typeof mcpServerSchema>

// The name becomes the `<server>__<tool>` namespace at dispatch, so duplicates
// would make tool lookup ambiguous and silently shadow one server behind
// another. Reject them with an indexed path so the error points at the
// offending entry instead of the whole array.
const mcpServersArraySchema = z
  .array(mcpServerSchema)
  .default([])
  .superRefine((entries, ctx) => {
    const seen = new Map<string, number>()
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i]!.name
      const prev = seen.get(name)
      if (prev !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'name'],
          message: `mcpServers[${i}].name duplicates mcpServers[${prev}].name ('${name}')`,
        })
      } else {
        seen.set(name, i)
      }
    }
  })

const portNumber = z.number().int().min(1).max(65535)

// `allow` is the discriminator between "forward everything" ('*') and a fixed
// allowlist (number[]). `deny` is only meaningful when allow === '*'; combining
// it with a number[] allow is rejected at parse time so a typo doesn't silently
// drop the deny rule. An empty allowlist (`allow: []`) is the off switch.
export const portForwardSchema = z
  .object({
    allow: z.union([z.literal('*'), z.array(portNumber)]),
    deny: z.array(portNumber).optional(),
  })
  .refine((v) => !(Array.isArray(v.allow) && v.deny !== undefined && v.deny.length > 0), {
    message: 'portForward.deny is only meaningful when allow is "*"; remove deny or set allow to "*"',
    path: ['deny'],
  })
  .default({ allow: '*' })

export type PortForward = z.infer<typeof portForwardSchema>

const dockerfileLineSchema = z.string().refine((line) => !/[\r\n]/.test(line), {
  message: 'dockerfile.append entries must be single Dockerfile lines; split multiline instructions into array entries',
})

// A feature toggle is either a boolean (install latest / don't install) or a
// version string that becomes an apt pin (`pkg=<version>`). The string form
// rejects whitespace and `=` so the `pkg=<version>` invocation we pass to
// apt-get cannot be smuggled into a separate package or option flag.
const dockerfileFeatureSchema = z.union([
  z.boolean(),
  z
    .string()
    .min(1)
    .refine((v) => !/[\s=]/.test(v), {
      message: 'dockerfile feature version strings must not contain whitespace or "="',
    }),
])

// `default(() => ({}))` paired with field-level defaults is the idiom that
// makes both `docker.file: {}` and an omitted `docker.file` key resolve to the
// SAME fully-populated object. A plain `.default({})` would short-circuit the
// inner field defaults when the key is omitted, leaving downstream code with
// `{ append: undefined, tmux: undefined, ... }` and a `lines.length` crash.
const dockerfileObjectSchema = z.object({
  ffmpeg: dockerfileFeatureSchema.default(false),
  gh: dockerfileFeatureSchema.default(true),
  python: z.boolean().default(true),
  tmux: dockerfileFeatureSchema.default(true),
  // `fonts-noto-cjk` is an ~89MB metapackage that makes Chromium render
  // Korean/Japanese/Chinese glyphs correctly in screenshots, `page.pdf()`,
  // and any other raster output the agent-browser plugin produces. Without
  // it CJK text renders as silent tofu boxes (□□□) — a confusing failure an
  // agent cannot self-diagnose from a screenshot it took itself.
  //
  // Default `'auto'`: resolved at `typeclaw start` from the HOST locale
  // (`LANG`/`LC_ALL`/`Intl`), same host-signal pattern as timezone
  // detection. CJK host (ja/ko/zh) → install; otherwise skip the ~89MB. The
  // resolved boolean is baked into the emitted Dockerfile so the image stays
  // reproducible per-build. Force with an explicit `true`/`false` to bypass
  // detection. String-or-boolean (no version pin) because the package is a
  // metapackage tracking the upstream Noto release.
  cjkFonts: z.union([z.boolean(), z.literal('auto')]).default('auto'),
  // Opt into the cloudflared layer for `cloudflare-quick` tunnels. Default
  // `false` to skip the ~38MB binary on agents that don't use tunnels (the
  // common case). `typeclaw tunnel add` / `channel add github` with a
  // Cloudflare provider flip this to `true` automatically and prompt for a
  // restart, so the happy path still works; only hand-edited configs need to
  // set it explicitly. When the binary is absent at tunnel start, the
  // provider fails with a clear "enable docker.file.cloudflared and restart"
  // message rather than a cryptic spawn error.
  cloudflared: z.boolean().default(false),
  // Install xvfb so the entrypoint shim can spawn an Xvfb virtual X
  // server and export DISPLAY, giving headed Chrome (agent-browser
  // --headed, Playwright headful) a real X11 display to connect to.
  // Default `true` because modern bot detection (Akamai/Cloudflare Bot
  // Manager) fingerprints `--headless` and `--headless=new` regardless
  // of UA spoof, and headed-via-Xvfb is the cheapest path to a passing
  // fingerprint from a container. Opt-out with `xvfb: false` to save
  // ~5MB image + ~10MB RAM/idle on agents that never touch a browser.
  // The shim self-heals — when Xvfb isn't on PATH it execs the agent
  // directly, no other Dockerfile or shim change needed. Boolean-only
  // because the package has no API-stable versioning that matters
  // here; xvfb tracks the upstream X server release.
  xvfb: z.boolean().default(true),
  // `claudeCode` is boolean-only (not an apt feature toggle): the upstream
  // installer is `curl | bash` and manages versions via env vars at install
  // time, not via version pins like apt. Default `false`; the bundled
  // `typeclaw-claude-code` skill prompts the user to opt in.
  claudeCode: z.boolean().default(false),
  // `codexCli` is boolean-only (not an apt feature toggle): the upstream
  // installer is the npm package `@openai/codex` which we install globally
  // via `bun install -g`. Default `false`; the bundled `typeclaw-codex-cli`
  // skill prompts the user to opt in. Mirrors the `claudeCode` toggle for
  // OpenAI's Codex CLI (https://github.com/openai/codex) — same shape, same
  // restart-required semantics, separate hook scripts (Codex uses
  // hooks.json with a different event matcher than Claude Code).
  codexCli: z.boolean().default(false),
  append: z.array(dockerfileLineSchema).default([]),
})

export const dockerfileSchema = dockerfileObjectSchema.default(() => dockerfileObjectSchema.parse({}))

export type DockerfileConfig = z.infer<typeof dockerfileSchema>
export type DockerfileFeatureToggle = z.infer<typeof dockerfileFeatureSchema>

// The `docker` namespace nests Docker-related blocks under one top-level key
// so future extensions (e.g. `docker.compose`, `docker.buildArgs`) have a home
// without polluting the root. Today the only inhabitant is `docker.file`,
// which holds the same shape that used to live at top-level `dockerfile`.
// One-time migration (see `migrateLegacyConfigShape`) rewrites the old
// top-level key into the new path on first load.
export const dockerSchema = z
  .object({
    file: dockerfileSchema,
  })
  .default(() => ({ file: dockerfileObjectSchema.parse({}) }))

export type DockerConfig = z.infer<typeof dockerSchema>

const gitignoreLineSchema = z.string().refine((line) => !/[\r\n]/.test(line), {
  message: 'git.ignore.append entries must be single gitignore lines; split multiline patterns into array entries',
})

const gitignoreObjectSchema = z.object({
  append: z.array(gitignoreLineSchema).default([]),
})

export const gitignoreSchema = gitignoreObjectSchema.default(() => gitignoreObjectSchema.parse({}))

export type GitignoreConfig = z.infer<typeof gitignoreSchema>

// Same rationale as `dockerSchema`: a `git` namespace today carries `git.ignore`
// and leaves room for future siblings (e.g. `git.attributes`).
export const gitSchema = z
  .object({
    ignore: gitignoreSchema,
  })
  .default(() => ({ ignore: gitignoreObjectSchema.parse({}) }))

export type GitConfig = z.infer<typeof gitSchema>

export const DEFAULT_LOG_RETENTION_DAYS = 14
export const MAX_LOG_RETENTION_DAYS = 3650

const logsObjectSchema = z.object({
  retentionDays: z.number().int().min(1).max(MAX_LOG_RETENTION_DAYS).default(DEFAULT_LOG_RETENTION_DAYS),
})

export const logsSchema = logsObjectSchema.default(() => logsObjectSchema.parse({}))

export type LogsConfig = z.infer<typeof logsSchema>

const IPV4_CIDR_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/

const ipv4CidrSchema = z.string().refine(
  (value) => {
    const match = IPV4_CIDR_PATTERN.exec(value)
    if (!match) return false
    const octets = [match[1], match[2], match[3], match[4]].map(Number)
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
    if (match[5] !== undefined) {
      const prefix = Number(match[5])
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
    }
    return true
  },
  {
    message: 'network.allow entries must be IPv4 addresses or CIDR ranges (e.g. "10.0.0.0/16", "10.0.0.2")',
  },
)

// `blockInternal` is the kill-switch for the container-stage egress filter
// installed by Dockerfile entrypoint shim: when true, the container is granted
// CAP_NET_ADMIN at boot just long enough to install iptables OUTPUT rules
// that DROP traffic to RFC1918, link-local (incl. cloud metadata), CGNAT,
// multicast/reserved, IPv6 ULA/link-local/multicast. The capability is then
// dropped from the bounding set via setpriv before the agent process exec's,
// so no child (python, curl, bun-spawned anything) can mutate or recover it.
//
// Default is `true`: the threat model that motivated this feature — prompt
// injection asking the agent to fetch RFC1918 hosts (e.g. a LAN router admin
// page) or the cloud-IMDS endpoint — applies to every agent equally, so the
// safe default is "on" and
// the explicit opt-out is for users who need their agent to reach LAN hosts
// (NAS, internal services, sibling dev machines). PR #145 shipped this with
// default `false` to preserve existing-folder behavior on upgrade; this
// follow-up (the one PR #145 promised in its description) makes the default
// match the intent. `typeclaw init` also writes `true` explicitly so the
// field is discoverable in fresh `typeclaw.json` files. Loopback traffic
// (`-o lo`) is always allowed by the shim, so `bun run dev` and local APIs
// on `localhost` / `127.0.0.1` are unaffected.
//
// `autoAllowResolvers` (default `true`) makes the shim narrowly carve out
// the container's DNS resolvers — every `nameserver` line in
// `/etc/resolv.conf` gets a `udp/tcp --dport 53` ACCEPT inserted BEFORE the
// REJECT rules. This fixes the canonical EC2/GCE/Azure footgun: cloud VPC
// resolvers live inside RFC1918 (e.g. AWS VPC DNS at `10.0.0.2`), so
// `blockInternal: true` would otherwise kill every DNS lookup the agent
// makes. The carve-out is scoped to port 53 only — a compromised agent
// cannot reach the resolver host on any other port. On a laptop where
// `/etc/resolv.conf` points at a public resolver (1.1.1.1, 8.8.8.8), the
// generated ACCEPT rules are no-ops because public IPs are not in the
// block list to begin with. Opt-out (`false`) is for users who explicitly
// configure DNS via `.env` (e.g. `DOCKER_DNS=1.1.1.1`) and want a fully
// closed filter.
//
// `allow` is the power-user escape hatch: an explicit list of IPv4 CIDRs
// or bare IPv4 addresses that punch through the block list wholesale (all
// ports, all protocols). Use case: VPC-private services the agent must
// reach by IP — internal APIs, RDS endpoints, VPC interface endpoints for
// S3/Bedrock. Each entry inserts an unscoped `iptables -A OUTPUT -d <cidr>
// -j ACCEPT` before the REJECT rules. IPv4 only: the carve-out is for
// destinations the operator names explicitly, and every cloud VPC we
// support is IPv4-routable. Validation at parse time rejects non-CIDR
// strings, IPv6 forms, and out-of-range octets so a typo in
// `typeclaw.json` surfaces immediately instead of at container boot.
export const networkSchema = z
  .object({
    blockInternal: z.boolean().default(true),
    autoAllowResolvers: z.boolean().default(true),
    allow: z.array(ipv4CidrSchema).default([]),
  })
  .default({ blockInternal: true, autoAllowResolvers: true, allow: [] })

export type NetworkConfig = z.infer<typeof networkSchema>

// `realProc` opts the per-tool bwrap sandbox (src/sandbox/build.ts) into the
// stricter 'real-proc' /proc strategy: a fresh procfs scoped to a NEW PID
// namespace via `unshare --pid --fork --mount --mount-proc`. It adds full PID
// isolation (the agent runtime's pids are absent from the sandbox namespace),
// but needs CAP_SYS_ADMIN to mount proc — so `typeclaw start` grants the
// container `--cap-add=SYS_ADMIN` only when this is set.
//
// Default `false`, because external-package execution (`bunx agent-*`, `bun add
// <pkg>`, `bun run <pkg-bin>` — the core subagent workflow) no longer needs it:
// the default 'proc-bind' strategy `--ro-bind`s the container's already-real
// procfs into the sandbox with NO CAP_SYS_ADMIN, giving the runner's child a
// working /proc/self/{fd,maps} so it stops aborting with Bun's "NotDir". The
// agent runtime's /proc/N/environ (OPENAI_API_KEY) stays unreadable because
// bwrap's --unshare-user puts the sandbox in a child user namespace the kernel
// won't let read a parent-userns process's environ — verified at runtime by a
// probe before the strategy is selected (src/sandbox/availability.ts). Avoiding
// the broad CAP_SYS_ADMIN grant by default is a smaller blast radius than the
// non-secret PID metadata 'proc-bind' exposes — see docs/internals/sandbox.mdx.
//
// Set `true` only to add the PID-isolation posture on a host where the proc
// mount actually works (bare-metal Linux, Docker Desktop — NOT OrbStack, which
// rejects the mount even with the cap; there the runtime falls back to
// 'proc-bind' regardless). The cost is the CAP_SYS_ADMIN grant on the container.

// `sandbox.writablePaths` re-exposes operator-chosen subtrees of the agent
// folder as WRITABLE inside the per-tool bwrap sandbox, on top of the built-in
// free-write zones (workspace, public, mounts, .git). It exists for tools that
// insist on writing a fixed config dir a low-trust role would otherwise hit
// EROFS on (e.g. a CLI that rewrites `<agentDir>/.foo-cli/config.json`).
//
// Each entry is AGENT-ROOT-RELATIVE — it resolves under /agent and may not
// escape it. Absolute container paths are rejected at parse time: a blanket RW
// bind outside /agent would punch a hole through the agent trust boundary that
// the rest of the sandbox model assumes can't happen. `..` segments and
// null bytes are rejected for the same reason. Targets that don't exist, aren't
// directories, are symlinks, or land on a security-sensitive path
// (.git, .env, secrets.json, sessions, memory, .typeclaw, node_modules, the
// agent root itself) are dropped at resolve time, NOT parse time — existence is
// a runtime property and the drop keeps a stale config from aborting the
// sandbox. See resolveWritableZones in src/sandbox/writable-zones.ts.
export const relativeAgentPathSchema = z
  .string()
  .min(1)
  .refine((value) => !isAbsolute(value), 'must be relative to the agent root, not an absolute path')
  .refine((value) => !value.includes('\0'), 'must not contain a null byte')
  .refine((value) => !value.split(/[/\\]+/).includes('..'), "must not contain a '..' segment")

// `sandbox.symlinks` is the one-entry abstraction for the common case of a CLI
// that reads its config from a fixed path the sandbox can't write: it (1) creates
// the symlink `from -> /agent/<to>` and (2) makes `<to>` a writable zone (same
// machinery as `writablePaths` — every `to` is folded into the writable set).
//
// `from` is the symlink LOCATION and is fully configurable: an absolute container
// path (e.g. `/root/.metabase-cli`) or a `~/`-prefixed path expanded against the
// stage's HOME. Two layers create it: the entrypoint shim creates it at the real
// container HOME (/root) for runtime-owned processes, and the per-tool bwrap
// sandbox emits a `--symlink` at the model-facing HOME (/tmp) for every role.
// Because `$HOME` differs between the two layers, a `~/` from resolves to the
// appropriate absolute path for each consumer. The entrypoint refuses to
// clobber an existing non-symlink.
//
// `from` SECURITY: it must not contain a null byte, must not be the root `/`, and
// must not point INTO /agent (a self-referential loop). Kernel/virtual paths
// (/proc, /sys, /dev, /run) are rejected — symlinking over them is never a real
// config need and risks masking the runtime's view of them. `/etc/...` is allowed
// (a legitimate use case) because the entrypoint's no-clobber guard already stops
// it from overwriting an existing system file. `to` reuses relativeAgentPathSchema.
//
// `..` is rejected OUTRIGHT, before the /agent and kernel-root bans run. Those
// bans previously inspected the RAW string, which both consumers later normalize
// against $HOME — so a `~/../agent/workspace/.foo` (→ /agent/...) or
// `~/../proc/x` (→ /proc/...) slipped past a startsWith('/agent') /
// startsWith('/proc') check on the un-normalized text. A traversal segment is the
// ONLY way the post-$HOME effective path can re-enter a banned root, so banning
// `..` makes the raw-string bans equivalent to checking the effective path —
// stage-independent, no need to expand $HOME at parse time. The bans then run on
// the POSIX-normalized form so an absolute `from` like `/var/../proc` is caught
// even though it has no leading `/proc` literal.
const FORBIDDEN_SYMLINK_FROM_ROOTS = ['/proc', '/sys', '/dev', '/run'] as const
function normalizedSymlinkFrom(value: string): string {
  // The `~/` prefix is not a real path component; normalize only the remainder
  // so a `~/a/b` stays `~/a/b` while `/var/../proc` collapses to `/proc`.
  if (value.startsWith('~/')) return `~/${posix.normalize(value.slice(2))}`
  return posix.normalize(value)
}
export const symlinkFromSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'must not contain a null byte')
  .refine((value) => value.startsWith('~/') || isAbsolute(value), 'must be an absolute path or start with ~/')
  .refine((value) => !value.split(/[/\\]+/).includes('..'), "must not contain a '..' segment")
  .refine((value) => normalizedSymlinkFrom(value) !== '/', 'must not be the filesystem root')
  .refine((value) => {
    const normalized = normalizedSymlinkFrom(value)
    return !normalized.startsWith('/agent/') && normalized !== '/agent'
  }, 'must not point into /agent (the symlink would loop back into the agent folder)')
  .refine((value) => {
    const normalized = normalizedSymlinkFrom(value)
    return !FORBIDDEN_SYMLINK_FROM_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))
  }, 'must not point at a kernel/virtual path (/proc, /sys, /dev, /run)')

export const symlinkSchema = z.object({
  from: symlinkFromSchema,
  to: relativeAgentPathSchema,
})

export type SandboxSymlink = z.infer<typeof symlinkSchema>

// Docker treats the profile as one argument, but keeping the value to the
// kernel profile-name alphabet prevents whitespace or option-like text from
// turning a hand-edited config into ambiguous docker argv.
const apparmorProfileSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+$/, 'AppArmor profile must be non-empty and contain only letters, digits, _, ., or -')

export const sandboxSchema = z
  .object({
    apparmorProfile: apparmorProfileSchema.default('unconfined'),
    realProc: z.boolean().default(false),
    writablePaths: z.array(relativeAgentPathSchema).default([]),
    symlinks: z.array(symlinkSchema).default([]),
  })
  .default({ apparmorProfile: 'unconfined', realProc: false, writablePaths: [], symlinks: [] })

export type SandboxConfig = z.infer<typeof sandboxSchema>

// Host-stage `typeclaw compose` knobs. `exclude: true` skips this agent during
// compose discovery (same effect as parking it under an `_`-prefixed dir, but
// without renaming the folder). `monorepo` is a host-stage scaffolding hint.
// The container never reads this block — it's a pure compose CLI hint, so
// omitting it keeps the agent in every compose operation. Namespaced under
// `compose` so future compose-only settings have a home without crowding the
// top level.
export const composeSchema = z
  .object({
    exclude: z.boolean().default(false),
    monorepo: z.boolean().default(false),
  })
  .default({ exclude: false, monorepo: false })

export type ComposeConfig = z.infer<typeof composeSchema>

// Host-stage update-checker knob. `enabled: false` turns off the once-a-day
// "a newer typeclaw is on npm" notice the host CLI prints before a command
// runs. The container never reads this — the check is a pure host-stage
// affordance that compares the installed CLI version against the npm registry
// off the hot path (a detached, throttled background refresh writes a cache
// under ~/.typeclaw/; every CLI invocation only does a disk read). Env
// overrides (TYPECLAW_NO_UPDATE_CHECK, NO_UPDATE_NOTIFIER, CI) also disable it
// without touching config, so this field is the persistent opt-out.
export const updateCheckSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .default({ enabled: true })

export type UpdateCheckConfig = z.infer<typeof updateCheckSchema>

// Reverse-proxy tunnels expose a container-private port to the public internet
// via a managed subprocess (cloudflared) or a user-supplied external URL.
// See AGENTS.md `## Tunnels`. Keeping the enum scoped to what's implemented
// means validateConfig() rejects unsupported providers at `typeclaw start`
// time, before the container is torn down and rebuilt. `restart-required`
// because the tunnel manager reads this list once at boot.
const tunnelForSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('channel'), name: z.string().trim().min(1) }),
  z.object({ kind: z.literal('manual') }),
])

// `tokenEnv` is the NAME of an env var, not the token itself. Restrict to the
// shell-portable identifier shape (uppercase + digits + underscore, leading
// non-digit) so a value typed here can't break `--env-file` parsing or shell
// expansion inside the container. Matches the convention every other env var
// in the codebase already follows (TYPECLAW_*, OPENAI_*, etc.).
const tokenEnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, {
  message: 'tokenEnv must be an env var name like CLOUDFLARE_TUNNEL_TOKEN (uppercase, digits, underscore)',
})

const tunnelEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-_]*$/, {
        message: 'tunnel name must match /^[a-z0-9][a-z0-9-_]*$/ (lowercase, digits, dashes, underscores)',
      }),
    provider: z.enum(['external', 'cloudflare-quick', 'cloudflare-named']),
    for: tunnelForSchema,
    externalUrl: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), { message: 'externalUrl must use https://' })
      .optional(),
    upstreamPort: z.number().int().min(1).max(65535).optional(),
    hostname: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), { message: 'hostname must use https://' })
      .optional(),
    tokenEnv: tokenEnvNameSchema.optional(),
  })
  .refine((v) => v.provider !== 'external' || (v.externalUrl !== undefined && v.externalUrl.trim() !== ''), {
    message: "tunnels[].externalUrl is required when provider is 'external'",
  })
  .refine((v) => v.provider !== 'cloudflare-named' || (v.hostname !== undefined && v.hostname.trim() !== ''), {
    message: "tunnels[].hostname is required when provider is 'cloudflare-named'",
  })
  .refine((v) => v.provider !== 'cloudflare-named' || (v.tokenEnv !== undefined && v.tokenEnv.trim() !== ''), {
    message: "tunnels[].tokenEnv is required when provider is 'cloudflare-named'",
  })
  // cloudflared learns the upstream from the Cloudflare dashboard's Public
  // Hostname mapping, not from typeclaw. An `upstreamPort` here would be
  // silently ignored; reject at parse time so the contradiction surfaces in
  // the config file rather than as a debugging surprise.
  .refine((v) => v.provider !== 'cloudflare-named' || v.upstreamPort === undefined, {
    message:
      "tunnels[].upstreamPort must not be set when provider is 'cloudflare-named' (cloudflared reads the upstream from the Cloudflare dashboard)",
  })
  .refine((v) => v.for.kind !== 'manual' || v.provider === 'cloudflare-named' || v.upstreamPort !== undefined, {
    message: "tunnels[].upstreamPort is required when for.kind is 'manual'",
  })

const tunnelsArraySchema = z
  .array(tunnelEntrySchema)
  .default([])
  .superRefine((entries, ctx) => {
    const seen = new Map<string, number>()
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i]!.name
      const prev = seen.get(name)
      if (prev !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'name'],
          message: `tunnels[${i}].name duplicates tunnels[${prev}].name ('${name}')`,
        })
      } else {
        seen.set(name, i)
      }
    }
  })

const customModelCostSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
  })
  .catchall(z.unknown())

export const customModelMetaSchema = z
  .object({
    name: z.string().min(1).optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.string().min(1)).optional(),
    contextWindow: z.number().optional(),
    maxTokens: z.number().optional(),
    cost: customModelCostSchema.optional(),
  })
  .catchall(z.unknown())

export type CustomModelMeta = z.infer<typeof customModelMetaSchema>

export const customModelsSchema = z.record(z.string().min(1), customModelMetaSchema).default({})

export type CustomModels = z.infer<typeof customModelsSchema>

const customModelRefSchema = z.string().refine((ref) => isModelRef(ref), {
  message: 'model ref must be "<known-provider>/<model-id>" with a known provider',
})

const singleModelRef = z.union([z.enum(knownModelRefs), customModelRefSchema])

function asModelRef(value: string): ModelRef {
  if (isModelRef(value)) return value
  throw new Error(`Invalid model ref: ${value}`)
}

// `models` maps a profile name to one or more model refs. Curated refs keep
// editor autocomplete through the enum branch, while custom refs are allowed
// when they target a known provider.
// `default` profile is mandatory; every other profile is optional and falls
// back to `default` at resolution time (see `resolveProfile`).
//
// Each value is either a single model ref or a non-empty array of refs
// forming a fallback chain: when a turn against the first ref fails (hard
// throw or a soft provider error), the runtime disposes the failed session
// and replays the same prompt against the next ref. Schema accepts both
// shapes for ergonomics; the parsed value is always normalised to a
// non-empty array so downstream consumers read a uniform `ModelRef[]`.
//
// Profile names are open strings; the runtime recognizes a handful of
// well-known names by convention (`default`, `fast`, `deep`, `vision`) but
// any string is valid. Unknown profile names resolve to `default` with a
// one-time warning at session construction.
//
// The pre-multi-model schema had a single `model: KnownModelRef` at the top
// level. `migrateLegacyConfigShape` rewrites that to `models: { default: ... }`
// on first load (and writes the result back to disk + commits via
// `persistMigratedConfig`), so every downstream consumer sees the new shape.
// Mirrors pi-coding-agent's `ThinkingLevel`. Kept as a local enum (rather than
// importing the SDK type) so the schema owns the canonical value list and zod
// can validate `typeclaw.json` without a runtime SDK dependency.
export const thinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>

// Reject exact duplicates in a chain — retrying the same ref after the same
// class of failure is almost certainly a config typo, and silently deduping
// would mask user intent. Different models from the same provider (e.g.
// `["openai/gpt-5.4-nano", "openai/gpt-5.4-mini"]`) are still valid because
// they hit distinct upstream endpoints.
const noDuplicateChainRefs = (arr: readonly string[]): boolean => new Set(arr).size === arr.length
const chainRefinementMessage = { message: 'models chain must not contain duplicate refs' }
const modelChainInputSchema = z.array(singleModelRef).min(1).refine(noDuplicateChainRefs, chainRefinementMessage)

// A profile value is one of three shapes, all normalised to `ProfileEntry`:
//   "openai/gpt-5.4-nano"                              single ref
//   ["refA", "refB"]                                   fallback chain
//   { models: "refA" | ["refA","refB"], thinkingLevel? }   rich object
// The rich object couples a per-profile `thinkingLevel` to the model(s); the
// `models` key mirrors the top-level map name and reads naturally for both a
// single ref and a chain. `model` is accepted as single-ref sugar but exactly
// one of `model`/`models` may be present. Legacy string/array forms keep
// parsing untouched (they normalise to `{ refs, thinkingLevel: undefined }`),
// so no migration is needed.
const richProfileSchema = z
  .object({
    model: singleModelRef.optional(),
    models: z.union([singleModelRef, modelChainInputSchema]).optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.model === undefined && value.models === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'profile must specify `model` or `models`' })
    }
    if (value.model !== undefined && value.models !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'profile must specify only one of `model` or `models`' })
    }
  })

const profileEntrySchema = z
  .union([singleModelRef, modelChainInputSchema, richProfileSchema])
  .transform((value): ProfileEntry => {
    if (typeof value === 'string' || Array.isArray(value)) {
      const refs = (Array.isArray(value) ? value : [value]).map((ref) => asModelRef(ref))
      return { refs }
    }
    const refsInput = value.models ?? value.model!
    const refs = (Array.isArray(refsInput) ? refsInput : [refsInput]).map((ref) => asModelRef(ref))
    return value.thinkingLevel === undefined ? { refs } : { refs, thinkingLevel: value.thinkingLevel }
  })

// Built-in per-profile `thinkingLevel` defaults, materialized at parse time so
// resolved config / `typeclaw model list` / prompt dumps show the effective level
// and users can override per profile. Materialized here (not as a runtime
// constant) the `deep: 'high'` default rides on the `deep` entry itself, so it
// still beats a lowered `models.default.thinkingLevel` (resolution reads the
// profile's own level first). `default` and `vision` carry none — they fall
// through to the model/SDK default. `high` over `xhigh`: `xhigh` ~doubles latency
// and spend for no agentic-quality gain.
const PROFILE_THINKING_LEVEL_DEFAULTS = {
  fast: 'low',
  deep: 'high',
} satisfies Partial<Record<string, ThinkingLevel>>

export const modelsSchema = z
  .record(z.string().min(1), profileEntrySchema)
  .refine((m) => 'default' in m, { message: 'models.default is required' })
  // Fill only when unset, so an explicit level (including `off`) always wins.
  .transform((models): Models => {
    let next: Record<string, ProfileEntry> | undefined
    for (const [profile, thinkingLevel] of Object.entries(PROFILE_THINKING_LEVEL_DEFAULTS)) {
      const entry = models[profile]
      if (entry !== undefined && entry.thinkingLevel === undefined) {
        next ??= { ...models }
        next[profile] = { ...entry, thinkingLevel }
      }
    }
    return (next ?? models) as Models
  })

// A model profile after normalisation: its fallback chain (always non-empty)
// plus an optional reasoning effort. `thinkingLevel` resolution is layered at
// session creation: profile's own (incl. built-in per-profile defaults
// materialized above) → `default` profile's → SDK default.
export type ProfileEntry = {
  refs: ModelRef[]
  thinkingLevel?: ThinkingLevel
}

// Zod's `z.record(..., refine)` doesn't refine the inferred type. The
// `default` key is schema-enforced, so we narrow it here to spare every
// consumer the `T | undefined` assertion noise.
export type Models = Record<string, ProfileEntry> & { default: ProfileEntry }

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
    // `default(() => ...)` ensures every parsed config has at least
    // `models.default`. Direct `.default({ default: ... })` would short-circuit
    // the refinement, so we lean on the lazy thunk form. The default value is
    // shaped to match the post-transform output (a `ProfileEntry`), not the
    // user-facing input shape.
    models: modelsSchema.default(() => ({
      default: { refs: [asModelRef(DEFAULT_MODEL_REF)] },
    })) as unknown as z.ZodType<Models>,
    customModels: customModelsSchema,
    // Defaults to `[]` so the field can be omitted from `typeclaw.json` (no
    // host paths exposed) without failing the whole config load. `typeclaw
    // init` omits this field so users don't see noise for the empty case.
    mounts: z.array(mountSchema).default([]),
    mcpServers: mcpServersArraySchema,
    plugins: z.array(z.string().min(1)).default([]),
    // Additional names the agent answers to in channel engagement, on top
    // of `basename(agentDir)` which is always implicit. Each entry is a
    // plain string matched case-insensitively as a substring of the
    // inbound text. Empty/whitespace-only entries are rejected at parse
    // time. Defaults to `[]`. Hatching appends the agent's chosen name
    // here, so a freshly-hatched bot already has its identity wired up.
    alias: z.array(z.string().trim().min(1)).default([]),
    compose: composeSchema,
    updateCheck: updateCheckSchema,
    channels: channelsSchema,
    portForward: portForwardSchema,
    network: networkSchema,
    sandbox: sandboxSchema,
    docker: dockerSchema,
    git: gitSchema,
    logs: logsSchema,
    roles: rolesConfigSchema.optional(),
    tunnels: tunnelsArraySchema,
    // When `true` (default), the system prompt tells the agent it runs on
    // TypeClaw and stamps the runtime version. Set `false` to strip every
    // TypeClaw-identifying clue from the system prompt: the base prompt's
    // opening lines are phrased generically ("a general-purpose AI agent"
    // instead of "…running inside TypeClaw") and the `## Runtime` version
    // block is omitted entirely. Read fresh per session via `getConfig()`, so
    // it applies on reload without a restart.
    branding: z.boolean().default(true),
  })
  .catchall(z.unknown())

export type Config = z.infer<typeof configSchema>

export function resolveModel(ref: KnownModelRef | ModelRef | string): Model<KnownApi> {
  const providerId = providerForModelRef(ref)
  const modelId = ref.slice(providerId.length + 1)
  const provider = KNOWN_PROVIDERS[providerId]
  if (isKnownModelRef(ref)) {
    const model = (provider.models as Record<string, Model<KnownApi>>)[modelId]
    if (model !== undefined) return model
  }

  if (!isModelRef(ref)) {
    throw new Error(`Invalid model ref "${ref}". Expected "<known-provider>/<model-id>".`)
  }

  const templateModelId = Object.keys(provider.models)[0]
  if (templateModelId === undefined) {
    throw new Error(`Provider ${providerId} has no curated models to use as a transport template`)
  }
  const template = (provider.models as Record<string, Model<KnownApi>>)[templateModelId]
  if (template === undefined) {
    throw new Error(`Provider ${providerId} has no curated models to use as a transport template`)
  }

  const meta = getConfig().customModels[ref]
  // `api`, `baseUrl`, and (by default) `compat` come from the provider template
  // because they describe the PROVIDER's wire dialect, not the model. pi-ai
  // infers compat from the baseUrl and only recognises first-party hosts, so a
  // custom ref on a provider that pins compat (OpenGateway, Upstage) would
  // otherwise fall back to OpenAI-native defaults and send `store`, the
  // `developer` role, `strict` tool schemas and `max_completion_tokens` to an
  // endpoint that never accepts them.
  //
  // The exception is a ref that pi-ai's catalog already knows, exactly or as
  // its undated `-YYYYMMDD` base, on the same transport. The catalog describes
  // the MODEL, so its name, capabilities, limits, and pricing are the defaults;
  // `customModels` remains the explicit per-field override. pi 0.87 reads some
  // behavior only from per-model metadata: e.g. Anthropic adaptive thinking is
  // `compat.forceAdaptiveThinking` and is no longer inferred from the id.
  // Anthropic's streamSimple gates adaptive thinking on the resolved model's
  // `reasoning` capability, so a dated Sonnet 5 alias must inherit that too.
  // That entry's compat and thinkingLevelMap are used, minus
  // `allowedFallbackModels` (see the Fable 5 record) and `supportsStrictTools`
  // (see the Anthropic records in providers.ts). Without a catalog match
  // `thinkingLevelMap` is deliberately not carried: it varies per model even
  // within one provider, so copying the template's would be a guess.
  const builtin = findBuiltinModel(providerId, modelId)
  const catalogMetadata = builtin !== undefined && builtin.api === template.api ? builtin : undefined
  let compat = template.compat
  if (catalogMetadata !== undefined) {
    const catalogCompat: Record<string, unknown> | undefined =
      catalogMetadata.compat === undefined ? undefined : { ...catalogMetadata.compat }
    if (catalogCompat !== undefined) {
      delete catalogCompat.allowedFallbackModels
      delete catalogCompat.supportsStrictTools
    }
    compat = catalogCompat as Model<KnownApi>['compat']
  }
  return {
    id: modelId,
    provider: providerId,
    baseUrl: provider.baseUrl ?? template.baseUrl,
    api: template.api,
    ...(compat !== undefined ? { compat } : {}),
    ...(catalogMetadata?.thinkingLevelMap !== undefined ? { thinkingLevelMap: catalogMetadata.thinkingLevelMap } : {}),
    name: meta?.name ?? catalogMetadata?.name ?? modelId,
    reasoning: meta?.reasoning ?? catalogMetadata?.reasoning ?? false,
    input: resolveCustomModelInput(meta?.input, catalogMetadata?.input),
    contextWindow: meta?.contextWindow ?? catalogMetadata?.contextWindow ?? template.contextWindow,
    maxTokens: meta?.maxTokens ?? catalogMetadata?.maxTokens ?? template.maxTokens,
    cost: resolveCustomModelCost(meta?.cost, catalogMetadata?.cost),
  }
}

function findBuiltinModel(providerId: string, modelId: string): Model<KnownApi> | undefined {
  const direct = getBuiltinModel(providerId as never, modelId as never) as Model<KnownApi> | undefined
  if (direct !== undefined) return direct
  const undatedId = modelId.replace(/-\d{8}$/, '')
  return undatedId === modelId
    ? undefined
    : (getBuiltinModel(providerId as never, undatedId as never) as Model<KnownApi> | undefined)
}

function resolveCustomModelInput(
  input: readonly string[] | undefined,
  fallback: Model<KnownApi>['input'] | undefined,
): Model<KnownApi>['input'] {
  if (input === undefined) return fallback ?? ['text']
  const supported = input.filter(
    (value): value is Model<KnownApi>['input'][number] => value === 'text' || value === 'image',
  )
  return supported.length > 0 ? supported : ['text']
}

function resolveCustomModelCost(
  cost: CustomModelMeta['cost'],
  fallback: Model<KnownApi>['cost'] | undefined,
): Model<KnownApi>['cost'] {
  return {
    input: cost?.input ?? fallback?.input ?? 0,
    output: cost?.output ?? fallback?.output ?? 0,
    cacheRead: cost?.cacheRead ?? fallback?.cacheRead ?? 0,
    cacheWrite: cost?.cacheWrite ?? fallback?.cacheWrite ?? 0,
  }
}

// Resolves a profile name (e.g. `fast`, `deep`, `vision`) to its fallback
// chain and per-profile thinking level. Unknown profiles fall back to
// `default` so callers can pass through arbitrary subagent-declared or
// user-overridden strings without crashing. `refs` is non-empty (the schema
// guarantees `default` exists and every value is at least one ref). `ref` is
// the head of the chain — the model the session is created with first.
// Callers that don't implement fallback can keep reading `ref`; fallback-aware
// callers iterate `refs`. `thinkingLevel` is the profile's own override (may be
// undefined, meaning inherit the `default` profile's level — see session
// creation).
export type ResolvedProfile = {
  ref: ModelRef
  refs: ModelRef[]
  thinkingLevel?: ThinkingLevel
  profile: string
  fellBackToDefault: boolean
}

export function resolveProfile(models: Models, name: string | undefined): ResolvedProfile {
  const requested = name ?? 'default'
  const entry = models[requested]
  if (entry !== undefined) {
    return {
      ref: entry.refs[0]!,
      refs: entry.refs,
      thinkingLevel: entry.thinkingLevel,
      profile: requested,
      fellBackToDefault: false,
    }
  }
  const fallback = models.default
  return {
    ref: fallback.refs[0]!,
    refs: fallback.refs,
    thinkingLevel: fallback.thinkingLevel,
    profile: 'default',
    fellBackToDefault: true,
  }
}

// Resolves a mount's `path` field to an absolute host path, mirroring shell
// expansion rules: `~`/`~/...` → home dir, relative → resolved against `cwd`,
// absolute → unchanged. Single source of truth so validation and Docker arg
// building agree on the resolved path.
export function expandMountPath(input: string, cwd: string): string {
  if (input === '~' || input.startsWith('~/')) {
    return join(homedir(), input.slice(1))
  }
  return isAbsolute(input) ? input : resolve(cwd, input)
}

// The full set of agent-relative dirs the sandbox should make writable: the
// explicit `sandbox.writablePaths` plus every `sandbox.symlinks[].to` (so an
// operator declaring a symlink doesn't also have to list its target). Order is
// stable (writablePaths first) and duplicates are harmless — resolveWritableZones
// dedupes after resolving each to an absolute path.
export function getSandboxWritablePathSpecs(cfg: Pick<Config, 'sandbox'>): string[] {
  return [...cfg.sandbox.writablePaths, ...cfg.sandbox.symlinks.map((link) => link.to)]
}

// Loaded eagerly from process.cwd()/typeclaw.json at module-import time so
// citty arg defaults (e.g. config.port in src/cli/*.ts) see real values, not
// hardcoded fallbacks. Missing file → schema defaults; malformed file → ALSO
// schema defaults plus a stderr warning.
//
// Why soft-fail and not throw: every CLI command — including diagnostic ones
// (`typeclaw status`, `typeclaw doctor`, `typeclaw logs`, `typeclaw stop`,
// `typeclaw usage`, `typeclaw tui`) — pays this eager-load cost through its
// import graph, regardless of whether the command actually reads config. A
// hard throw here turns every read-only diagnostic into a crash exactly when
// the user needs the diagnostic to figure out what's wrong with their config.
// `validateConfig` (called by `start`/`restart`/`reload`/host-side mutations)
// is the strict gate for destructive paths; that's where malformed-config
// errors should surface, not at module-import time.
//
// `config` is a module-import-time snapshot. Container-stage code that must
// observe `typeclaw run` reloads should call `getConfig()` instead, which
// returns the current swapped-in value. Host-stage CLI processes are
// short-lived, so they keep using `config` directly.
export const config: Config = loadConfigSyncOrDefaults(process.cwd())

export function loadConfigSyncOrDefaults(cwd: string, options: { warn?: (message: string) => void } = {}): Config {
  try {
    return loadConfigSync(cwd)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const warn = options.warn ?? ((message: string) => process.stderr.write(message))
    warn(
      `warning: ${detail}\n` +
        `warning: continuing with default config so diagnostic commands still work; ` +
        `run \`typeclaw doctor\` or fix ${CONFIG_FILE} before \`typeclaw start\`/\`restart\`/\`reload\`.\n`,
    )
    return configSchema.parse({})
  }
}

let current: Config = config

export function getConfig(): Config {
  return current
}

// Test-only: restore the live pointer to the module-import-time snapshot. Lets
// reload-aware tests run without leaking a swapped pointer into other test
// files that still mutate the eager `config` export directly.
export function __resetConfigForTesting(): void {
  current = config
}

export type ConfigChange = {
  path: string
  before: unknown
  after: unknown
}

export type ConfigReloadDiff = {
  applied: ConfigChange[]
  restartRequired: ConfigChange[]
  ignored: ConfigChange[]
}

// Reloads typeclaw.json from disk and atomically swaps the live config pointer
// on success. Throws (and leaves `current` untouched) when the file is
// malformed or schema-invalid — callers translate that into a `Reloadable`
// failure result.
export function reloadConfig(cwd: string): ConfigReloadDiff {
  const next = loadConfigSync(cwd)
  const diff = diffConfig(current, next)
  current = next
  return diff
}

// Field classification. The fence is intentional: only fields that are read
// fresh on each session/subagent/cron-reload land in `applied`. Boot-only
// fields (port, mounts, container/server bind) are reported as
// `restartRequired` so the user knows the reload landed but the change won't
// take effect until restart.
export type FieldEffect = 'applied' | 'restart-required' | 'ignored'

export const FIELD_EFFECTS: Record<string, FieldEffect> = {
  $schema: 'ignored',
  models: 'applied',
  customModels: 'applied',
  port: 'restart-required',
  mounts: 'restart-required',
  mcpServers: 'restart-required',
  plugins: 'restart-required',
  alias: 'applied',
  compose: 'ignored',
  updateCheck: 'ignored',
  channels: 'applied',
  portForward: 'restart-required',
  network: 'restart-required',
  sandbox: 'restart-required',
  tunnels: 'restart-required',
  'docker.file': 'restart-required',
  'git.ignore': 'restart-required',
  logs: 'ignored',
  // Split: `match` lists are reload-safe (typeclaw role claim, hand-edits
  // adding/removing match rules apply without a container restart);
  // `permissions` lists are restart-required (changing what a role can DO
  // is a bigger deal than changing WHO fills it, and several consumers —
  // plugin contexts, the security plugin guards — capture the permissions
  // contract at boot). The diff machinery in diffConfig() understands
  // `roles.match` and `roles.permissions` as virtual paths and compares
  // the corresponding projections of the whole `roles` block.
  'roles.match': 'applied',
  'roles.permissions': 'restart-required',
  branding: 'applied',
}

// Stable JSON for value comparison. Fields are small JSON-shaped objects, so
// JSON.stringify with sorted keys is sufficient and avoids a deep-equal dep.
function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k]
      }
      return sorted
    }
    return v
  })
}

function diffConfig(before: Config, after: Config): ConfigReloadDiff {
  const diff: ConfigReloadDiff = { applied: [], restartRequired: [], ignored: [] }
  const keys = new Set<string>(Object.keys(FIELD_EFFECTS))

  for (const path of keys) {
    const b = readPath(before, path)
    const a = readPath(after, path)
    if (stableStringify(b) === stableStringify(a)) continue

    const change: ConfigChange = { path, before: b, after: a }
    const effect = FIELD_EFFECTS[path] ?? 'applied'
    if (effect === 'applied') diff.applied.push(change)
    else if (effect === 'restart-required') diff.restartRequired.push(change)
    else diff.ignored.push(change)
  }

  return diff
}

function readPath(obj: unknown, path: string): unknown {
  if (path === 'roles.match') return projectRoles(obj, 'match')
  if (path === 'roles.permissions') return projectRoles(obj, 'permissions')
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function projectRoles(obj: unknown, field: 'match' | 'permissions'): unknown {
  if (typeof obj !== 'object' || obj === null) return undefined
  const roles = (obj as Record<string, unknown>).roles
  if (typeof roles !== 'object' || roles === null) return undefined
  const projection: Record<string, unknown> = {}
  for (const [roleName, roleVal] of Object.entries(roles as Record<string, unknown>)) {
    if (typeof roleVal !== 'object' || roleVal === null) continue
    const val = (roleVal as Record<string, unknown>)[field]
    if (val !== undefined) projection[roleName] = val
  }
  return projection
}

// Plugin configs live at the top level of typeclaw.json keyed by plugin name
// (e.g. "standup-log": { ... }). They are preserved by configSchema.catchall(z.unknown())
// because the schema does not predeclare these keys. This helper returns the
// raw map of unknown values keyed by plugin name; the plugin loader re-validates
// each block against its plugin's `configSchema`.
export function extractPluginConfigs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {}
  const known = new Set([
    '$schema',
    'port',
    'models',
    'customModels',
    'mounts',
    'plugins',
    'alias',
    'compose',
    'updateCheck',
    'channels',
    'portForward',
    'network',
    'docker',
    'git',
    'logs',
    'roles',
    'permissions',
    'tunnels',
    'mcpServers',
  ])
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key)) result[key] = value
  }
  return result
}

export function loadPluginConfigsSync(cwd: string): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return {}
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return {}
  }
  const migrated = migrateLegacyConfigShape(json)
  if (migrated.changed) {
    persistMigratedConfig(cwd, migrated.json, migrated.applied)
  }
  return extractPluginConfigs(migrated.json)
}

export function loadConfigSync(cwd: string): Config {
  let raw: string
  try {
    raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return configSchema.parse({})
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${detail}`)
  }

  const migrated = migrateLegacyConfigShape(json)
  if (migrated.changed) {
    persistMigratedConfig(cwd, migrated.json, migrated.applied)
  }

  const result = configSchema.safeParse(migrated.json)
  if (!result.success) {
    throw new Error(`${CONFIG_FILE} is invalid: ${formatZodError(result.error)}`)
  }
  return result.data
}

// Single-read variant of loadConfigSync + loadPluginConfigsSync for the boot
// path, which otherwise reads + parses + migrates typeclaw.json twice. Throws on
// invalid JSON / failed schema parse and returns defaults + `{}` on a missing
// file, matching loadConfigSync.
export function loadConfigBundleSync(cwd: string): { config: Config; pluginConfigs: Record<string, unknown> } {
  let raw: string
  try {
    raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return { config: configSchema.parse({}), pluginConfigs: {} }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${detail}`)
  }

  const migrated = migrateLegacyConfigShape(json)
  if (migrated.changed) {
    persistMigratedConfig(cwd, migrated.json, migrated.applied)
  }

  const result = configSchema.safeParse(migrated.json)
  if (!result.success) {
    throw new Error(`${CONFIG_FILE} is invalid: ${formatZodError(result.error)}`)
  }
  return { config: result.data, pluginConfigs: extractPluginConfigs(migrated.json) }
}

// Strips a `channels.github.eventAllowlist` that deep-equals a value `channel
// add` / `init` previously seeded verbatim, so the config re-tracks the shipped
// default. Called from every entry point that reads `typeclaw.json` so the rest
// of the pipeline only ever sees the canonical shape.
//
// The returned `applied` array names each migration step that fired, so
// callers in `typeclaw start` can build a meaningful git commit message.
// `changed` is the boolean equivalent of `applied.length > 0` and is preserved
// for back-compat with the many call sites that only care whether ANY rewrite
// happened.
export type MigrationStep = { kind: 'drop-github-seeded-event-allowlist' } | { kind: 'drop-memory-vector-config' }

export type MigrationResult = { json: unknown; changed: boolean; applied: MigrationStep[] }

export function migrateLegacyConfigShape(json: unknown): MigrationResult {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { json, changed: false, applied: [] }
  }

  const obj = json as Record<string, unknown>
  const applied: MigrationStep[] = []
  const next: Record<string, unknown> = { ...obj }

  if (isSeededGithubEventAllowlist(obj)) {
    dropSeededGithubEventAllowlist(next)
    applied.push({ kind: 'drop-github-seeded-event-allowlist' })
  }

  if (hasLegacyMemoryVectorConfig(obj)) {
    dropMemoryVectorConfig(next)
    applied.push({ kind: 'drop-memory-vector-config' })
  }

  return { json: applied.length > 0 ? next : json, changed: applied.length > 0, applied }
}

// True when channels.github.eventAllowlist deep-equals an allowlist that
// `channel add` / `init` has previously seeded verbatim. Such a value is
// indistinguishable from "the default at that time", so stripping it lets the
// config re-track the shipped default. A user who hand-edited to any other set
// (added/removed/reordered an event) fails this check and is preserved.
function isSeededGithubEventAllowlist(obj: Record<string, unknown>): boolean {
  const github = isPlainObject(obj.channels) ? obj.channels.github : undefined
  if (!isPlainObject(github)) return false
  const list = github.eventAllowlist
  if (!Array.isArray(list)) return false
  return SEEDED_GITHUB_EVENT_ALLOWLISTS.some((seeded) => arraysEqual(list, seeded))
}

function dropSeededGithubEventAllowlist(next: Record<string, unknown>): void {
  const channels = next.channels
  if (!isPlainObject(channels)) return
  const github = channels.github
  if (!isPlainObject(github)) return
  const { eventAllowlist: _dropped, ...rest } = github
  next.channels = { ...channels, github: rest }
}

function hasLegacyMemoryVectorConfig(obj: Record<string, unknown>): boolean {
  const memory = obj.memory
  return isPlainObject(memory) && Object.prototype.hasOwnProperty.call(memory, 'vector')
}

function dropMemoryVectorConfig(next: Record<string, unknown>): void {
  const memory = next.memory
  if (!isPlainObject(memory)) return
  const clone = { ...memory }
  delete clone.vector
  if (Object.keys(clone).length === 0) {
    delete next.memory
    return
  }
  next.memory = clone
}

function arraysEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// Returns null when no steps were applied — callers should not commit in
// that case. Keeping the null branch here (vs an empty string) makes the
// "nothing happened" case impossible to misuse at the call site.
export function buildConfigMigrationCommitMessage(applied: readonly MigrationStep[]): string | null {
  const first = applied[0]
  if (first === undefined) return null

  const subject = `typeclaw.json: ${shortStepLabel(first)}`
  const bodyLines: string[] = applied.map((step) => `- ${describeStep(step)}`)
  return `${subject}\n\n${bodyLines.join('\n')}\n`
}

function shortStepLabel(step: MigrationStep): string {
  switch (step.kind) {
    case 'drop-github-seeded-event-allowlist':
      return 'drop seeded channels.github.eventAllowlist'
    case 'drop-memory-vector-config':
      return 'drop memory.vector config'
  }
}

function describeStep(step: MigrationStep): string {
  switch (step.kind) {
    case 'drop-github-seeded-event-allowlist':
      return 'drop seeded channels.github.eventAllowlist so it re-tracks the shipped default'
    case 'drop-memory-vector-config':
      return 'drop memory.vector config; vector memory is always on'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function persistMigratedConfig(cwd: string, json: unknown, applied: readonly MigrationStep[]): void {
  try {
    writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(json, null, 2)}\n`)
  } catch {
    // Best-effort write-back: the migration is also applied in-memory on every
    // load, so a read-only filesystem (e.g. snapshotted CI checkout) just
    // means the rewrite retries next start. Surfacing the error would brick
    // load paths the user didn't ask to mutate. Bail before the commit step
    // too — without the write there's nothing to commit.
    return
  }

  // Pair the disk rewrite with a git commit so the agent folder is never
  // silently dirty after a migration. typeclaw.json is in git's "tracked"
  // category (unlike Dockerfile, which is regenerated on every start and
  // intentionally gitignored), so an uncommitted rewrite gets mixed into
  // unrelated commits the moment any other tool touches the repo.
  // commitSystemFileSync no-ops on non-git folders, missing Bun, and clean
  // files, so canonical-shape reads pay zero cost.
  //
  // Called from every entry point that reads typeclaw.json (host CLI,
  // hostd daemon, container runtime) so the commit follows the rewrite
  // wherever it happens — not only from `typeclaw start`.
  const message = buildConfigMigrationCommitMessage(applied)
  if (message !== null) {
    commitSystemFileSync(cwd, CONFIG_FILE, message)
  }
}

export type ValidateConfigResult = { ok: true; warnings?: string[] } | { ok: false; reason: string }

// Missing file → ok (matches `loadMounts` in src/container/up.ts; `isInitialized`
// is the dedicated check for "not initialized"). Present but invalid → fail, so
// `restart` doesn't stop the container before discovering the config is broken.
//
// Mount accessibility is checked here (after schema parse succeeds) so every
// caller — `typeclaw start`, `restart`, `reload`, hostd's restart RPC — fails
// fast with a clear, mount-named error instead of letting Docker surface a
// confusing path-sharing error (or, on some Linux setups, silently bind-mount
// an empty auto-created directory). First-failure reporting matches the
// schema-error path's shape; users fix one and re-run.
export type ValidateConfigOptions = {
  // Skip the mount-path accessibility check. Host-side callers leave this
  // false (the default) so missing mount directories surface as a precise
  // pre-`docker run` error. Container-side callers (the reload registry)
  // set it true because mount paths in typeclaw.json are host paths and
  // don't resolve inside the container's filesystem.
  skipMounts?: boolean
}

export function validateConfig(cwd: string, options: ValidateConfigOptions = {}): ValidateConfigResult {
  let raw: string
  try {
    raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return { ok: true }
  }

  const parsed = parseConfigJson(raw, { migrate: true, persistTarget: cwd })
  if (!parsed.ok) return parsed

  // Append lines are advisory here — never fatal. The Dockerfile renderer
  // (renderCustomDockerfileLines) is the enforcement boundary: it STRIPS unsafe
  // lines so the container still comes up, and a bad line written by the
  // in-container agent can never brick `typeclaw start`. We surface the same
  // strip/warn decisions as warnings so the operator sees them pre-build.
  const warnings: string[] = []
  const appendLines = parsed.config.docker.file.append
  for (let i = 0; i < appendLines.length; i++) {
    const check = validateDockerfileAppendLine(appendLines[i]!)
    if (!check.ok) {
      warnings.push(`docker.file.append[${i}] will be stripped on start — ${check.reason}`)
      continue
    }
    if (check.warning) warnings.push(`docker.file.append[${i}] ${check.warning}`)
  }

  if (!options.skipMounts) {
    for (const mount of parsed.config.mounts) {
      const check = validateMount(mount, cwd)
      if (!check.ok) return check
    }
  }

  return warnings.length > 0 ? { ok: true, warnings } : { ok: true }
}

export type ParseConfigJsonResult = { ok: true; config: Config } | { ok: false; reason: string }

export type ParseConfigJsonOptions = {
  // Run `migrateLegacyConfigShape` before schema validation. Defaults to true
  // so callers don't reject content the agent could have written through
  // legacy keys; pass false to validate the exact bytes (used in tests).
  migrate?: boolean
  // When set, persist + commit the migrated shape to this agent dir if the
  // migration ran. Only `validateConfig` uses this; the guard's in-memory
  // validation never persists (the bytes aren't yet on disk).
  persistTarget?: string
}

// Pure validator for an in-memory `typeclaw.json` string. Used by the
// managed-config guard to reject `write`/`edit` calls that would land an
// invalid file on disk. Does NOT check mount accessibility — that is the
// runtime concern handled by `validateConfig` at `typeclaw start` time, and
// the file the agent is producing may legitimately reference a mount path
// that only exists on the host outside the container.
export function parseConfigJson(raw: string, options: ParseConfigJsonOptions = {}): ParseConfigJsonResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `${CONFIG_FILE} is not valid JSON: ${detail}` }
  }

  const shouldMigrate = options.migrate ?? true
  const migrated = shouldMigrate
    ? migrateLegacyConfigShape(json)
    : { json, changed: false, applied: [] as MigrationStep[] }
  if (migrated.changed && options.persistTarget !== undefined) {
    persistMigratedConfig(options.persistTarget, migrated.json, migrated.applied)
  }

  const result = configSchema.safeParse(migrated.json)
  if (!result.success) {
    return { ok: false, reason: `${CONFIG_FILE} is invalid: ${formatZodError(result.error)}` }
  }
  return { ok: true, config: result.data }
}

// Verifies a mount's host path: exists, is a regular file or directory, is
// readable, and is writable when not declared `readOnly`. Symlinks are
// followed (statSync's default) so a broken symlink reads as "does not exist".
// File mounts are allowed so credentials and config can be exposed as a single
// path (e.g. an SSH private key); sockets, FIFOs, and devices are rejected
// because exposing them is an advanced, security-sensitive case we don't take
// implicitly. Permission checks are skipped when running as root (uid 0) —
// euidaccess returns success regardless, so the test would be vacuous and
// inconsistent with non-root.
export function validateMount(mount: Mount, cwd: string): ValidateConfigResult {
  const resolved = expandMountPath(mount.path, cwd)
  const label = `mount "${mount.name}"`

  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { ok: false, reason: `${label}: path ${resolved} does not exist` }
    }
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `${label}: cannot stat ${resolved}: ${detail}` }
  }

  if (!stats.isDirectory() && !stats.isFile()) {
    return { ok: false, reason: `${label}: path ${resolved} is not a file or directory` }
  }

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  if (isRoot) return { ok: true }

  try {
    accessSync(resolved, fsConstants.R_OK)
  } catch {
    return { ok: false, reason: `${label}: path ${resolved} is not readable` }
  }

  if (!mount.readOnly) {
    try {
      accessSync(resolved, fsConstants.W_OK)
    } catch {
      return {
        ok: false,
        reason: `${label}: path ${resolved} is not writable (declare readOnly: true if read-only access is intended)`,
      }
    }
  }

  return { ok: true }
}

// FROM/ENTRYPOINT/CMD/MAINTAINER are intentionally excluded — see the
// structural blocks in validateDockerfileAppendLine for why.
const ALLOWED_APPEND_INSTRUCTIONS = new Set([
  'RUN',
  'ENV',
  'ARG',
  'LABEL',
  'COPY',
  'ADD',
  'USER',
  'WORKDIR',
  'SHELL',
  'EXPOSE',
  'VOLUME',
  'STOPSIGNAL',
  'HEALTHCHECK',
  'ONBUILD',
])

// Decode primitives that, paired with dynamic execution on the same line, form
// the "decode an opaque blob and run it" anti-pattern that bricked a real build
// (an agent base64-decoded the bash entrypoint shim and fed it to python3
// exec). Matching is substring/case-insensitive — these are code tokens the
// agent emits, not natural-language, so English literals are correct here (cf.
// the protocol-token exception in AGENTS.md).
const DECODE_PRIMITIVES = ['base64', 'b64decode', 'atob(', 'unhexlify', '.fromhex(', 'xxd -r']

// True dynamic-execution sinks — language constructs that run a STRING as code.
// Deliberately NOT including interpreter flags like `python3 -c`/`node -e`: a
// benign `python3 -c "print(base64.b64encode(...))"` legitimately mentions a
// decode primitive without ever executing the decoded bytes. The footgun is
// decode + a real exec sink (or decode piped to an interpreter, below).
const EXEC_PRIMITIVES = ['exec(', 'eval(', 'new function(', 'function(']

// Decoded stdout piped straight into an interpreter: `base64 -d ... | sh`,
// `... | python3`, etc. The pipe is the execution step here, so it pairs with
// DECODE_PRIMITIVES independently of the EXEC_PRIMITIVES sinks above.
const DECODE_PIPED_TO_INTERPRETER =
  /\|\s*(?:sudo\s+)?(?:ba)?sh\b|\|\s*(?:sudo\s+)?python3?\b|\|\s*(?:sudo\s+)?(?:node|perl|ruby)\b/i

// Risky-but-legitimate operator patterns: piping a remote script straight into
// a shell, or ADDing a remote URL. Common enough in real build steps that a
// hard block would frustrate power users, dangerous enough to flag.
const APPEND_WARN_PATTERNS: Array<{ test: RegExp; note: string }> = [
  {
    test: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i,
    note: 'pipes a remote script directly into a shell (curl|bash); verify the source is trusted',
  },
  {
    test: /<\(\s*(?:curl|wget)\b/i,
    note: 'executes a remote script via process substitution; verify the source is trusted',
  },
  {
    test: /^ADD\s+https?:\/\//i,
    note: 'ADD of a remote URL fetches an unpinned artifact at build time; prefer a pinned COPY or checksum-verified RUN',
  },
]

export type AppendLineCheck =
  | { ok: true; warning?: string }
  // `structural` blocks are unconditional (they break Dockerfile generation);
  // `semantic` blocks are waivable via the host env override.
  | { ok: false; reason: string; kind: 'structural' | 'semantic' }

// Pure, side-effect-free validator for ONE docker.file.append entry. The newline
// rejection stays in the zod schema (dockerfileLineSchema) so it fires on every
// parse including the agent's own config-write guard; this adds the contextual
// policy the schema can't express cheaply. Returns the first problem found.
export function validateDockerfileAppendLine(line: string): AppendLineCheck {
  const trimmed = line.trim()

  if (trimmed === '') {
    return { ok: false, reason: 'is empty or whitespace-only', kind: 'structural' }
  }

  // A trailing backslash is a line continuation: it would merge the generated
  // ENTRYPOINT (spliced right after the append block) into this instruction.
  if (/\\\s*$/.test(line)) {
    return {
      ok: false,
      reason:
        'ends with a line-continuation backslash, which would swallow the generated ENTRYPOINT; keep each entry self-contained',
      kind: 'structural',
    }
  }

  // Heredoc syntax spans multiple lines by definition and cannot work in a
  // single spliced entry — it would consume the following generated lines.
  if (/<<-?\s*['"]?\w/.test(trimmed)) {
    return {
      ok: false,
      reason: 'uses heredoc syntax (<<EOF), which cannot be expressed as a single Dockerfile line',
      kind: 'structural',
    }
  }

  if (trimmed.startsWith('#')) {
    // Parser directives (`# syntax=`, `# escape=`) only have meaning at the top
    // of a Dockerfile; spliced before ENTRYPOINT they are at best inert and at
    // worst confusing. Plain comments are fine.
    if (/^#\s*(syntax|escape|check)\s*=/i.test(trimmed)) {
      return {
        ok: false,
        reason: 'is a parser directive (# syntax=/# escape=), which is only valid at the top of a Dockerfile',
        kind: 'structural',
      }
    }
    return { ok: true }
  }

  const instruction = trimmed.split(/\s+/, 1)[0]?.toUpperCase() ?? ''

  if (instruction === 'FROM') {
    return {
      ok: false,
      reason: 'starts a new build stage (FROM), discarding everything TypeClaw layered before it',
      kind: 'structural',
    }
  }
  if (instruction === 'ENTRYPOINT' || instruction === 'CMD') {
    return {
      ok: false,
      reason: `overrides the container ${instruction}, which TypeClaw owns (the entrypoint shim is appended right after this block)`,
      kind: 'structural',
    }
  }
  if (!ALLOWED_APPEND_INSTRUCTIONS.has(instruction)) {
    // Reason is intentionally input-free: this string is forwarded verbatim into
    // operator-facing warnings (classifyDockerfileAppend -> dockerfileWarnings),
    // and the offending token is user-controlled — echoing it could leak a
    // secret/token-like first word from a malformed line into start/doctor output.
    return {
      ok: false,
      reason: 'does not begin with a recognized Dockerfile instruction',
      kind: 'structural',
    }
  }

  const lower = trimmed.toLowerCase()

  // The actual incident: mutating TypeClaw's own entrypoint shim. This is never
  // a supported customization surface — entrypoint changes belong in TypeClaw
  // source, not in a build-time patch script.
  if (lower.includes('typeclaw-entrypoint')) {
    return {
      ok: false,
      reason:
        'references the TypeClaw-owned entrypoint (typeclaw-entrypoint); patching it from docker.file.append is unsupported and brittle',
      kind: 'semantic',
    }
  }

  // Decode-an-opaque-blob-and-execute-it. A benign decode (encoding output,
  // writing a file) or a bare `python3 -c "print(...)"` both pass; only decode
  // PAIRED with a real exec sink — or piped into an interpreter — is blocked.
  const hasDecode = DECODE_PRIMITIVES.some((p) => lower.includes(p))
  const hasExec = EXEC_PRIMITIVES.some((p) => lower.includes(p)) || DECODE_PIPED_TO_INTERPRETER.test(lower)
  if (hasDecode && hasExec) {
    return {
      ok: false,
      reason:
        'decodes an opaque payload and executes it (e.g. base64 + exec/eval), an obfuscated-code anti-pattern that has bricked builds',
      kind: 'semantic',
    }
  }

  for (const { test, note } of APPEND_WARN_PATTERNS) {
    if (test.test(trimmed)) return { ok: true, warning: note }
  }

  return { ok: true }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}
