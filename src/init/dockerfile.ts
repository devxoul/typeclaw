import { CONTAINER_AGENT_MESSENGER_CONFIG_DIR } from '@/agent-messenger/config-dir'
import { ASKPASS_SCRIPT, TYPECLAW_GIT_ASKPASS_PATH } from '@/bundled-plugins/github-cli-auth/git-askpass'
import { validateDockerfileAppendLine } from '@/config/config'
import type { DockerfileConfig, DockerfileFeatureToggle } from '@/config/config'
import { TESTED_BUN_VERSION } from '@/hostd/version'
import {
  CLAUDE_CREDENTIALS_FILE_NAME,
  CLAUDE_CREDENTIALS_RELATIVE_PATH,
} from '@/secrets/export-claude-credentials-file'

import { GHCR_BASE_IMAGE_REPO } from './cli-version'

export const DOCKERFILE = 'Dockerfile'

export type BuildDockerfileOptions = {
  // Null or omitted = emit the full inline heavy stack (dev mode, tests).
  baseImageVersion?: string | null
  // Host-locale decision for `cjkFonts: 'auto'`. Callers that have a host
  // locale (start/init) pass the resolved boolean; when omitted, `'auto'`
  // falls back to NOT installing (the slim default) so a context without a
  // host signal — e.g. a bare `buildDockerfile()` in tests — stays small and
  // deterministic.
  cjkFontsAuto?: boolean
  // Emit a BuildKit Dockerfile (default) or strip BuildKit-only directives for
  // hosts without buildx. `start` sets this to false when buildx is absent so
  // the legacy `docker build` can still build the agent image.
  buildKit?: boolean
}

// Apt packages that EVERY image must have — git for the agent runtime,
// curl/ca-certificates/gnupg for HTTPS and key fetches that downstream layers
// (e.g. the gh keyring) depend on. `iptables` and `util-linux` back the
// network egress entrypoint shim, installed unconditionally so that flipping
// `typeclaw.json#network.blockInternal` is a runtime toggle (re-run
// `typeclaw restart`) and not an image rebuild.
//
// On Debian trixie the single `iptables` package ships both the IPv4 nft
// frontend (`iptables-nft`, available as `iptables` through
// update-alternatives) and the IPv6 nft frontend (`ip6tables-nft`, available
// as `ip6tables`). The standalone `iptables-nft`/`ip6tables-nft` package
// names do NOT exist on trixie — `apt install iptables-nft` fails with
// "Unable to locate package". The shim invokes `iptables` and `ip6tables`
// which alternatives resolves to the nft variants.
//
// `util-linux` carries `setpriv`, which the shim uses to drop CAP_NET_ADMIN
// from the bounding set before exec'ing the agent. Listed first in the
// apt-get install line so the package set is self-documenting at a glance.
//
// xvfb is intentionally NOT in baseline — it's a toggle (`xvfb: true` by
// default, opt-out via `docker.file.xvfb: false`) because the shim
// self-heals: it spawns Xvfb (and exports DISPLAY) if the binary is on
// PATH, and execs the agent directly otherwise. See APT_FEATURES.xvfb
// below and `buildEntrypointShim`.
// `bubblewrap` ships the `bwrap(1)` setuid-less namespace sandboxer. It is
// included in baseline (not behind a toggle) because per-tool sandboxing of
// agent bash calls is a runtime concern resolved by the agent, not by the
// agent author. See `src/sandbox/` for the bwrap command builder, and
// `docs/internals/sandbox.mdx` for why bwrap is the right
// shape for per-call isolation inside an already-containerized agent. The
// outer container's `seccomp=unconfined` plus configured AppArmor profile
// (see `src/container/start.ts:planStart`) let bwrap create user/pid/mount
// namespaces from inside Docker. Docker's seccomp default blocks userns and
// docker-default AppArmor explicitly denies mount; on stock Ubuntu 23.10+ the
// operator must load the shipped typeclaw-bwrap profile because the host's
// unprivileged_userns catch-all also denies uid_map writes to unconfined
// processes. The package, options, and host profile are load-bearing together.
//
// `jq` is in baseline (not behind a toggle) so it is available to the
// per-tool bwrap sandbox that wraps agent bash calls. The sandbox only
// `--ro-bind`s `/usr` + `/bin` from the container (see `src/sandbox/build.ts`),
// so a binary that is not in the base image is invisible inside the sandbox —
// there is no per-call install path. JSON munging in one-shot read-only
// pipelines (`curl ... | jq`, `cat foo.json | jq`) is a baseline expectation
// for the explorer/reviewer/scout subagents, whose prompts already advertise
// `jq` as an available pipeline tool, so it ships unconditionally rather than
// as an opt-in toggle.
const BASELINE_APT_PACKAGES = [
  'git',
  'ca-certificates',
  'curl',
  'gnupg',
  'iptables',
  'util-linux',
  'bubblewrap',
  'jq',
  'libgomp1',
] as const

// curl-impersonate is the only currently-working way to query DuckDuckGo from
// a non-browser client on residential IPs in 2026. DDG fingerprints incoming
// requests at the TLS handshake (JA3/JA4) and HTTP/2 SETTINGS-frame layer
// before any HTTP headers are read; Bun's native fetch cannot match Chrome's
// fingerprint (upstream Bun issue #11368, open) so requests get gated behind
// 202 anomaly-modal responses, escalating to interactive duck-picker
// challenges. See `src/agent/tools/ddg.ts` for the runtime invocation.
//
// Pinned to lexiforest's actively-maintained fork (Chrome 136+ profiles in
// v1.5.6, May 2026), NOT the original `lwthiker/curl-impersonate` whose last
// release v0.6.1 (March 2024) carries Chrome ≤116 profiles — two years stale
// and useless against current DDG fingerprinting. Bumping: replace the
// version + sha256 constants below and run `typeclaw start --build` in any
// agent folder per the AGENTS.md "owns the Dockerfile" rule. Verify the new
// release ships the wrapper named in CURL_IMPERSONATE_PROFILE; lexiforest
// regenerates the bundled wrappers on Chrome major bumps and occasionally
// drops older ones.
export const CURL_IMPERSONATE_VERSION = 'v1.5.6'
export const CURL_IMPERSONATE_SHA256_AMD64 = 'b60344f63b9ed8806f0e9f7fd357d9f6c9a82aca279ed1e9e257d544885dcbde'
export const CURL_IMPERSONATE_SHA256_ARM64 = '6766bc67fd3e8e2313875f32b36b5a3fab02beffe77e5f1cf7fc5da99731d403'
// Wrapper symlink shipped in the v1.5.6 tarball. The tarball lays out
// curl_chrome136 → curl_chrome alongside the canonical `curl-impersonate`
// binary; we invoke the version-pinned wrapper so a future release that
// drops chrome136 fails loudly at search time instead of silently regressing
// the impersonation to whatever `curl_chrome` resolves to.
export const CURL_IMPERSONATE_PROFILE = 'chrome136'

// cloudflared powers `cloudflare-quick` tunnels. Pinned-version + per-arch
// SHA256 mirrors the curl-impersonate pattern above: bumping requires updating
// all three constants in the same commit, and the build fails loudly at
// `sha256sum -c` if either hash is wrong for the version. To bump: pick a
// release from https://github.com/cloudflare/cloudflared/releases, then
//   curl -fsSLO .../cloudflared-linux-amd64 && shasum -a 256 cloudflared-linux-amd64
// for each architecture. The version literal is the release tag exactly as it
// appears on GitHub (no `v` prefix).
export const CLOUDFLARED_VERSION = '2025.5.0'
export const CLOUDFLARED_SHA256_AMD64 = 'a62266fd02041374f1fca0d85694aafdf7e26e171a314467356b471d4ebb2393'
export const CLOUDFLARED_SHA256_ARM64 = '47e55e6eba2755239f641c2c4f89878643ac0d9eaa127a6c84a2cb43fa2e0f03'
export const CLOUDFLARED_RELEASE_URL_BASE = 'https://github.com/cloudflare/cloudflared/releases/download'

export const TYPECLAW_ENTRYPOINT_PATH = '/usr/local/bin/typeclaw-entrypoint'

// The installed TypeClaw CLI entry, executed directly by the container
// entrypoint. `package.json#bin.typeclaw` points at `src/cli/index.ts` and the
// package ships `src`, so this path exists for both the registry install and a
// `file:`/linked dev install (where node_modules/typeclaw is the repo). Running
// it directly bypasses `bun run typeclaw`'s script/`.bin` resolution — which
// breaks when the agent folder was installed on a Windows host: the hoisted
// linker writes Windows-native `.bin/typeclaw` shims that aren't valid Linux
// executables once the folder is bind-mounted into the container, so
// `bun run typeclaw` finds no usable bin, falls back to treating `typeclaw` as
// a path, and resolves `/agent/typeclaw.json` (`Cannot run json files`).
export const TYPECLAW_CLI_ENTRY = '/agent/node_modules/typeclaw/src/cli/index.ts'

// Perf: `--smol` selects JSC's small-heap profile (grows slower, GCs more often),
// trading a little CPU for lower resident memory. The agent runtime is a
// burst-then-idle workload, so temporary allocations get reclaimed instead of
// settling into a high-water RSS. Flag goes before `run`. Used at every exec site
// below so the runtime phase inherits it on every network-policy path.
const RUNTIME_BUN = 'bun --smol run'

// IPv4 networks the container is forbidden to egress to when
// `network.blockInternal` is true. Loopback (127/8) is NOT here — loopback
// traffic uses the `lo` interface, which the shim's first ACCEPT rule
// short-circuits. The agent inside the container needs loopback to dogfood
// its own `bun run dev` server. RFC1918 (10/8, 172.16/12, 192.168/16) covers
// router admin panels and home/office LANs. 169.254/16 covers cloud
// metadata (169.254.169.254 IMDS, 169.254.170.2 ECS task role) and Windows
// APIPA. 100.64/10 is CGNAT. 224/4 multicast and 240/4 reserved are belt-
// and-suspenders against creative exfil targets. host.docker.internal (in
// 172.16/12 on Docker Desktop/Linux) is re-allowed by the shim at runtime
// via getent so the agent's `restart` tool can still reach hostd.
export const NETWORK_BLOCK_IPV4_NETS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const

// IPv6 mirrors of the IPv4 block list. fc00::/7 is unique-local (the IPv6
// equivalent of RFC1918), fe80::/10 is link-local (incl. SLAAC + IPv6 cloud
// metadata in fd00:ec2::/64 which fits inside fc00::/7), ff00::/8 is
// multicast, ::ffff:0:0/96 is IPv4-mapped IPv6 (an attacker could otherwise
// reach 192.168.x.x via [::ffff:192.168.0.1]).
export const NETWORK_BLOCK_IPV6_NETS = ['fc00::/7', 'fe80::/10', 'ff00::/8', '::ffff:0:0/96'] as const

// Renders the shell script that runs as PID 1 inside the container. Two
// modes, picked at boot time from `$TYPECLAW_NETWORK_BLOCK_INTERNAL`:
//
//   off (env unset or != "1"): no rules installed, no setpriv. Just exec
//   the TypeClaw CLI entry directly (see TYPECLAW_CLI_ENTRY). Identical
//   observable behavior to a container without this feature. This is the
//   opt-out path for users who set `network.blockInternal: false` in their
//   `typeclaw.json`.
//
//   on (default, env = "1" via `network.blockInternal: true`): walks IPv4 +
//   IPv6 block lists and installs
//   REJECT rules in the OUTPUT chain. Loopback (`-o lo`) is ACCEPT'd first
//   so dev-server dogfooding still works. The hostd HTTP control port on
//   `host.docker.internal` is re-allowed at runtime — narrowly, single
//   TCP destport, only when hostd is configured — so the agent's `restart`
//   tool can still reach the daemon. The shim then drops CAP_NET_ADMIN
//   from the bounding set AND from the inheritable + ambient sets via
//   setpriv before exec'ing the agent. Bounding set is the hard ceiling
//   enforced by execve; inheritable + ambient are cleared defensively to
//   match setpriv(1)'s explicit warning about not dropping the bounding
//   set alone.
//
// Carve-out is intentionally narrow: ACCEPT only `tcp --dport <hostd-port>`
// to the host gateway, never the gateway IP wholesale. Without the dport
// scope, a compromised agent could reach any host service via
// `host.docker.internal:22` (SSH), `:53` (DNS), `:5432` (postgres), etc.
// The gateway IP itself sits inside `172.16.0.0/12`, which the IPv4 reject
// rules below DROP — the narrow ACCEPT here is the only path through.
// When hostd is not configured (`TYPECLAW_HOSTD_URL` unset or unparseable),
// nothing is ACCEPT'd: the agent loses self-restart capability but the
// rest of the egress filter still works.
//
// IPv4-only carve-out uses `getent ahostsv4` to force the resolver into
// the A-record path. Without this, `getent hosts` would return whichever
// family the resolver prefers, and on systems that prefer AAAA we'd feed
// a v6 address to `iptables` and crash under `set -e`. host.docker.internal
// resolves to a bridge gateway that is IPv4-only on every Docker runtime
// we support (Docker Desktop, OrbStack, Docker on Linux with the
// `--add-host host.docker.internal:host-gateway` flag typeclaw injects).
//
// REJECT (not DROP) so the agent fails fast with an ICMP unreachable
// instead of hanging on a 30-second connect timeout — much friendlier
// debug UX and identical security posture.
//
// `set -eu` propagates rule-install failures up to PID 1 exit, which kills
// the container. Failing closed is the right thing: an unenforced
// blockInternal=true is worse than blockInternal=false.
//
// Carve-out ordering is load-bearing. iptables OUTPUT is first-match-wins,
// and we use -A (append). So the order written into the shim is the order
// rules will be evaluated:
//   1. ESTABLISHED,RELATED ACCEPT (return path for any connection initiated
//      from outside the container — see comment block below)
//   2. loopback ACCEPT
//   3. hostd port ACCEPT (narrow: tcp + single dport on the host gateway)
//   4. resolver ACCEPT (narrow: udp/tcp dport 53 to each /etc/resolv.conf
//      nameserver) — gated on TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=1
//   5. user-supplied allowlist ACCEPT (wholesale: -d <cidr>) — driven by
//      TYPECLAW_NETWORK_ALLOW comma-separated env
//   6. RFC1918 + link-local + CGNAT + multicast + reserved REJECTs
// A resolver at 10.0.0.2 hits (4) and ACCEPTs before (6) DROPs it.
//
// Rule 1 (conntrack ESTABLISHED,RELATED) is what makes Docker port-forward
// reply traffic survive the RFC1918 REJECT. On Docker Desktop and OrbStack
// the bridge gateway is in 192.168.0.0/16 (OrbStack: 192.168.215.1 or
// 192.168.139.1; Docker Desktop: 192.168.65.1). A host -> container request
// via `docker run -p 127.0.0.1:HOST:CONTAINER` arrives at the container
// from the bridge gateway IP. Without rule 1, the reply packets would
// match rule 6 (192.168.0.0/16 REJECT) and never reach the host — TCP
// handshake completes (kernel SYN/ACK is in INPUT, not OUTPUT), the
// request body is delivered, but the agent's HTTP response is dropped at
// OUTPUT. Symptom: `curl http://127.0.0.1:HOST` connects but receives
// zero bytes and times out. Stateful inversion via conntrack is the
// canonical fix: ESTABLISHED matches packets belonging to a connection
// the kernel already tracks (including the inbound port-forward), and
// RELATED covers ICMP error packets for those connections. No new
// outbound capability is granted — a compromised agent still cannot
// initiate connections to RFC1918, only respond to inbound ones.
//
// Requires the `xt_conntrack` kernel module (universal on Linux 2.6.20+
// and on every Docker/OrbStack VM kernel) and the userspace iptables
// `conntrack` match (shipped in the `iptables` Debian package on trixie
// alongside the binary itself; no extra apt install needed).
//
// The resolver carve-out reads /etc/resolv.conf inside the container, NOT
// on the host. Docker propagates the host's resolver into the container by
// default (Docker Desktop and OrbStack rewrite it to the embedded DNS
// proxy at 127.0.0.11; Docker on Linux copies the host's resolv.conf
// verbatim unless --dns is passed). On Docker Desktop / OrbStack the
// nameserver is loopback and the rule is a no-op (loopback is already
// ACCEPT'd by rule 1). On native Linux + EC2/GCE/Azure VMs, the
// nameserver is the VPC resolver inside RFC1918 — exactly the case this
// carve-out targets.
//
// `awk '/^nameserver/{print $2}'` extracts only the IP, skipping
// comments, `search`, `options`, and malformed lines. We don't validate
// the IP further: a malformed nameserver line would have crashed glibc's
// resolver long before the shim ran, so we trust resolv.conf's contents.
// IPv6 nameservers (rare in practice, never the case on EC2/GCE/Azure)
// are skipped by `grep -v ':'` to avoid feeding a v6 address to iptables.
// `iptables -C` (check) is intentionally NOT used to dedupe — duplicate
// ACCEPT rules are harmless (still first-match-wins), and the check
// flag's exit code is hard to reason about under `set -e`.
//
// The user-supplied allowlist (TYPECLAW_NETWORK_ALLOW) is splat on
// commas. Each entry is fed directly to iptables -d, which accepts both
// bare IPs and CIDR notation. Validation already happened in config.ts at
// parse time, so the shim trusts the env. Empty env → loop body never
// runs, zero ACCEPT rules added.
export function buildEntrypointShim(): string {
  const ipv4Rules = NETWORK_BLOCK_IPV4_NETS.map(
    (net) => `iptables -A OUTPUT -d ${net} -j REJECT --reject-with icmp-port-unreachable`,
  )
  const ipv6Rules = NETWORK_BLOCK_IPV6_NETS.map(
    (net) => `ip6tables -A OUTPUT -d ${net} -j REJECT --reject-with icmp6-port-unreachable`,
  )
  return `#!/bin/sh
# AUTOGENERATED by typeclaw — do not edit.
# Source: src/init/dockerfile.ts \`buildEntrypointShim()\`.
set -eu

# start_xvfb launches Xvfb in the background under a stripped capability
# bounding set so headed Chrome (agent-browser --headed, Playwright
# headful) has a real X11 display to connect to. Headless containers
# have no display server; Chrome --headless / --headless=new is
# fingerprinted by modern bot detection (Akamai / Cloudflare BM)
# regardless of UA spoof, so real headed Chrome under a virtual
# framebuffer is the only path to a passing sensor score from a
# server-side container.
#
# Two correctness invariants this function enforces:
#
# 1. Xvfb never holds CAP_NET_ADMIN. The shim runs as PID 1 with the
#    container's full capability set (including NET_ADMIN when
#    network.blockInternal=true). If we backgrounded Xvfb naked, it
#    would inherit NET_ADMIN and keep it for the container's lifetime
#    — defeating the capability-drop contract that setpriv applies to
#    the agent process. Routing Xvfb through the same setpriv invocation
#    we use for the agent strips NET_ADMIN before Xvfb's first exec.
#    On the off-path (blockInternal=false) the bounding-set drop is a
#    no-op (NET_ADMIN was never granted), but the call is harmless.
#
# 2. Xvfb startup failure is loud, not silent. \`Xvfb ... >/dev/null &\`
#    under \`set -e\` does not fail the script if Xvfb exits immediately
#    (missing library, port conflict, malformed args). Without the
#    explicit liveness probe below, the shim would then export DISPLAY
#    and exec bun, agent-browser launches would die with "cannot open
#    display", and the operator would chase a phantom bug. A monitor
#    subshell owns Xvfb, \`wait\`s for it, and drops a status file the
#    instant it exits; the poll loop checks that file (before the socket
#    check) so an early exit becomes a clear stderr line and a non-zero
#    shim exit.
#
#    We do NOT probe liveness with \`kill -0 "\$xvfb_pid"\`. A backgrounded
#    child that exits before the shell \`wait\`s for it becomes a zombie,
#    and \`kill -0\` returns success on a zombie PID (it still exists in
#    the process table). Under load the shell reaps the zombie lazily, so
#    \`kill -0\` reported the dead Xvfb as alive for up to the full 3s
#    window — the loop then timed out and printed the misleading "did not
#    create socket within 3s" diagnostic instead of "exited immediately".
#    The status-file handshake sidesteps zombie semantics entirely.
#
# We DO NOT use \`xvfb-run\`. xvfb-run hangs forever when it runs as
# PID 1 inside a container: its SIGUSR1-based ready handshake races
# and stalls because PID 1 ignores signals without explicit handlers,
# so the \`trap : USR1 ; wait || :\` dance never wakes up. Observed in
# practice: container alive, Xvfb running, PID 1 stuck in
# \`rt_sigsuspend\`, no agent process ever spawns, \`docker logs\` empty.
# Documented industry workarounds are tini-as-PID-1 or direct Xvfb
# spawn; we pick the latter (no new dep).
#
# Xvfb args:
#   :99                     fixed display number. Filesystem
#                           (/tmp/.X11-unix/X99) and abstract
#                           (\\0/tmp/.X11-unix/X99) sockets are both
#                           network-namespace-scoped, so :99 is safe
#                           across all Compose'd containers.
#   -screen 0 1920x1080x24  desktop viewport agent-browser advertises;
#                           mismatched geometry is itself a fingerprint
#                           signal.
#   -ac                     disable host-based X access control so
#                           Chrome connects without XAUTHORITY plumbing.
#   +extension RANDR        expose the RandR extension; Chrome queries
#                           it for screen geometry, and without it
#                           \`screen.*\` values come back inconsistent.
#   -nolisten tcp           refuse TCP connections (Unix socket only).
#                           Defense-in-depth — we are in a netns with
#                           no inbound exposure anyway.
# link_configured_symlinks creates the operator's \`sandbox.symlinks\` at the real
# container $HOME for runtime-owned processes. Model-driven bash runs in bwrap
# for every role and gets an equivalent in-jail symlink from the per-tool builder
# (src/sandbox/build.ts). TYPECLAW_SANDBOX_SYMLINKS is base64-encoded JSON of
# [{from,to}] (set by start.ts only when non-empty). The whole job is done in
# \`bun -e\` rather than POSIX shell because \`from\`/\`to\` are arbitrary operator
# strings: a real JSON parser + Node fs API sidesteps every word-splitting,
# glob, and metachar hazard that shell string-handling of untrusted paths
# carries. Contract enforced here (belt to the config-parse validation in
# config.ts): \`from\` is expanded against $HOME for a leading \`~/\`, \`to\` resolves
# under /agent and may not escape it, and an existing NON-symlink at \`from\` is
# refused (never clobbered) — a dangling/symlink \`from\` is replaced idempotently
# with \`ln -sfn\` semantics (force + no-deref). Failures are logged and skipped
# per-entry so one bad symlink never blocks container boot.
#
# TYPECLAW_AGENT_DIR defaults to /agent (the bind-mount path) and is overridable
# only by the shim's behavioral tests, which point it at a tmpdir. Production
# never sets it.
link_configured_symlinks() {
  [ -n "\${TYPECLAW_SANDBOX_SYMLINKS:-}" ] || return 0
  TYPECLAW_SANDBOX_SYMLINKS="$TYPECLAW_SANDBOX_SYMLINKS" HOME="$HOME" \\
    TYPECLAW_AGENT_DIR="\${TYPECLAW_AGENT_DIR:-/agent}" bun -e '
    import { lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
    import { dirname, join, normalize, resolve } from "node:path";
    const home = process.env.HOME || "/root";
    const agentDir = process.env.TYPECLAW_AGENT_DIR || "/agent";
    let specs;
    try {
      specs = JSON.parse(Buffer.from(process.env.TYPECLAW_SANDBOX_SYMLINKS, "base64").toString("utf8"));
    } catch (e) {
      console.error("typeclaw-entrypoint: could not parse TYPECLAW_SANDBOX_SYMLINKS:", String(e));
      process.exit(0);
    }
    for (const spec of Array.isArray(specs) ? specs : []) {
      const from = String(spec?.from ?? "");
      const to = String(spec?.to ?? "");
      if (from === "" || to === "") continue;
      const fromAbs = from.startsWith("~/") ? join(home, from.slice(2)) : normalize(from);
      const target = resolve(agentDir, to);
      if (target !== agentDir && !target.startsWith(agentDir + "/")) {
        console.error("typeclaw-entrypoint: skip symlink, target escapes /agent:", to);
        continue;
      }
      try {
        mkdirSync(target, { recursive: true });
        mkdirSync(dirname(fromAbs), { recursive: true });
        let existing;
        try { existing = lstatSync(fromAbs); } catch { existing = undefined; }
        if (existing && !existing.isSymbolicLink()) {
          console.error("typeclaw-entrypoint: refusing to clobber existing non-symlink at", fromAbs);
          continue;
        }
        if (existing) rmSync(fromAbs);
        symlinkSync(target, fromAbs);
      } catch (e) {
        console.error("typeclaw-entrypoint: failed to create symlink", fromAbs, "->", target, ":", String(e));
      }
    }
  ' || true
}

# link_custom_claude_credentials keeps a custom CLAUDE_CONFIG_DIR credential file
# out of model-visible reach. The Claude Code exporter writes the OAuth refresh
# token to \$CLAUDE_CONFIG_DIR/.credentials.json when that env var is set. Under
# the default (unset) it lands in the runtime HOME's .claude, which bwrap never
# binds — invisible to sandboxed bash. But a custom dir under /agent (or any
# jail-visible root) would put the real token where model bash can read it.
#
# Instead of masking every possible custom location, plant a symlink from the
# custom path INTO the runtime HOME's .claude and let the exporter's
# symlink-aware writeAtomic() follow it — so the real bytes always live in the
# unbound, already-denied runtime HOME regardless of where CLAUDE_CONFIG_DIR
# points. This restores the invariant the old persistence helper used to provide
# (it linked into the masked persist root); the target moved to the ephemeral
# HOME, but the "credential is only an alias in the custom dir" property is
# preserved. Runs in the root phase before privilege drop so custom dirs under
# root-owned roots (e.g. /etc) can still be created. No-op when the value is
# unset/blank or already resolves to the runtime HOME's .claude (avoids a
# self-referential link). Re-linking is idempotent (an existing symlink is
# replaced); failures are non-fatal so a bad custom path never blocks boot.
#
# The from-path MUST match where the exporter actually writes. The exporter
# (src/secrets/export-claude-credentials-file.ts resolveClaudeConfigDir) applies
# JS String.trim() and treats an all-whitespace value as unset. Replicating that
# in POSIX sed would diverge on Unicode whitespace (\u00A0, \u2003, …) that
# .trim() strips but a byte-oriented sed class does not — a divergence is a
# credential-isolation bypass (exporter writes the trimmed path, alias sits at
# the padded path, token stays model-readable). So do the normalization in the
# same \`bun -e\` runtime the exporter uses, guaranteeing byte-for-byte identical
# trimming, and create the symlink there too.
link_custom_claude_credentials() {
  CLAUDE_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-}" _CLAUDE_RUNTIME_HOME="$runtime_home" \\
    _CLAUDE_CRED_FILE="${CLAUDE_CREDENTIALS_FILE_NAME}" _CLAUDE_CRED_REL="${CLAUDE_CREDENTIALS_RELATIVE_PATH}" bun -e '
    import { mkdirSync, rmSync, symlinkSync } from "node:fs";
    import { dirname, join } from "node:path";
    const raw = process.env.CLAUDE_CONFIG_DIR;
    const trimmed = raw?.trim();
    if (trimmed === undefined || trimmed.length === 0) process.exit(0);
    const runtimeHome = process.env._CLAUDE_RUNTIME_HOME || "/home/agent";
    const from = join(trimmed, process.env._CLAUDE_CRED_FILE);
    const to = join(runtimeHome, process.env._CLAUDE_CRED_REL);
    if (from === to) process.exit(0);
    try {
      mkdirSync(trimmed, { recursive: true });
      mkdirSync(dirname(to), { recursive: true });
      // Unconditionally (re)point the alias, matching the old ln -sfn: a
      // pre-existing real file at the custom path would otherwise keep the token
      // model-readable, which is exactly the exposure this aliasing closes.
      try { rmSync(from); } catch { /* nothing to remove */ }
      symlinkSync(to, from);
    } catch (e) {
      console.error("typeclaw-entrypoint: failed to alias custom Claude credentials:", String(e));
    }
  ' || true
}

# seed_runtime_home copies the image-baked Claude Code / Codex CLI settings from
# the build-time HOME (/root) into the ephemeral runtime HOME. The Dockerfile
# writes ~/.claude.json, ~/.claude/settings.json, and ~/.codex/hooks.json against
# /root during \`docker build\`; once the runtime runs under HOME=$runtime_home
# those files would otherwise be invisible, silently disabling Claude onboarding
# state and both CLIs' completion hooks for claudeCode/codexCli users.
#
# Runs in the root setup phase (HOME is still /root), BEFORE the optional chown
# so copied files have the dynamic host ownership when the runtime drops
# privileges. \`cp -n\` keeps repeated shim execution idempotent within one
# container life; Docker removes this HOME with the container.
seed_runtime_home() {
  _src="\${1:-/root}"
  _dst="$2"
  [ "$_src" = "$_dst" ] && return 0
  mkdir -p "$_dst"
  [ -f "$_src/.claude.json" ] && cp -n "$_src/.claude.json" "$_dst/.claude.json" 2>/dev/null || true
  if [ -f "$_src/.claude/settings.json" ]; then
    mkdir -p "$_dst/.claude"
    cp -n "$_src/.claude/settings.json" "$_dst/.claude/settings.json" 2>/dev/null || true
  fi
  if [ -f "$_src/.codex/hooks.json" ]; then
    mkdir -p "$_dst/.codex"
    cp -n "$_src/.codex/hooks.json" "$_dst/.codex/hooks.json" 2>/dev/null || true
  fi
  unset _src _dst
}

start_xvfb() {
  if ! command -v Xvfb >/dev/null 2>&1; then
    return 0
  fi
  # A monitor subshell owns Xvfb and \`wait\`s for it (the bare command
  # blocks until exit), then writes Xvfb's exit code to a status file.
  # The poll loop below reads that file instead of probing \`kill -0\` —
  # see invariant 2 above for why zombie semantics make \`kill -0\`
  # unreliable. \`set +e\` inside the subshell keeps the outer \`set -e\`
  # from killing the monitor before it records a non-zero Xvfb exit.
  xvfb_status="/tmp/typeclaw-xvfb-status.$$"
  rm -f "$xvfb_status"
  (
    set +e
    # The nested setpriv strips NET_ADMIN so Xvfb never inherits it (invariant
    # 1). But when we've ALREADY re-exec'd into the non-root runtime phase
    # (TYPECLAW_ENTRYPOINT_RUNTIME=1), the outer handoff emptied the bounding
    # set and dropped CAP_SETPCAP — so a second \`setpriv --bounding-set\` here
    # can no longer modify the bounding set and exits non-zero (127), which the
    # liveness probe would misreport as "Xvfb exited immediately". There is also
    # nothing left to strip: NET_ADMIN is already gone. So in the runtime phase
    # launch Xvfb DIRECTLY; keep the nested drop only for the root fallback
    # paths (where this shim is still PID 1 with the full capability set).
    if [ "\${TYPECLAW_ENTRYPOINT_RUNTIME:-0}" = "1" ]; then
      Xvfb :99 -screen 0 1920x1080x24 -ac +extension RANDR -nolisten tcp \\
        >/dev/null 2>&1
    else
      setpriv --bounding-set -net_admin --inh-caps -net_admin --ambient-caps -net_admin \\
        -- Xvfb :99 -screen 0 1920x1080x24 -ac +extension RANDR -nolisten tcp \\
        >/dev/null 2>&1
    fi
    printf '%s\\n' "$?" > "$xvfb_status"
  ) &
  xvfb_pid=$!
  export DISPLAY=:99
  # Poll every 10ms up to ~3s. Xvfb cold start is typically ~20-50ms on
  # a modern host; 3s covers slow Docker Desktop VMs, Rosetta/QEMU
  # emulation, and loaded CI runners. The status-file check comes FIRST
  # so an Xvfb that creates the socket and then immediately dies is still
  # treated as a startup failure.
  i=0
  while [ $i -lt 300 ]; do
    if [ -f "$xvfb_status" ]; then
      wait "$xvfb_pid" 2>/dev/null || true
      rm -f "$xvfb_status"
      echo "typeclaw-entrypoint: Xvfb exited immediately; cannot start headed display (docker.file.xvfb=true)" >&2
      exit 1
    fi
    if [ -S /tmp/.X11-unix/X99 ]; then
      rm -f "$xvfb_status"
      unset i xvfb_pid xvfb_status
      return 0
    fi
    sleep 0.01
    i=$((i + 1))
  done
  rm -f "$xvfb_status"
  echo "typeclaw-entrypoint: Xvfb did not create /tmp/.X11-unix/X99 within 3s; refusing to continue (docker.file.xvfb=true)" >&2
  exit 1
}

if [ "\${TYPECLAW_ENTRYPOINT_RUNTIME:-0}" = "1" ]; then
  link_configured_symlinks
  start_xvfb
  exec ${RUNTIME_BUN} ${TYPECLAW_CLI_ENTRY} "$@"
fi

runtime_home="\${TYPECLAW_RUNTIME_HOME:-/home/agent}"
mkdir -p "$runtime_home"
seed_runtime_home "$HOME" "$runtime_home"
link_custom_claude_credentials
if [ -n "\${TYPECLAW_HOST_UID:-}" ] && [ -n "\${TYPECLAW_HOST_GID:-}" ]; then
  chown -R "$TYPECLAW_HOST_UID:$TYPECLAW_HOST_GID" "$runtime_home"
fi
# Adopt the runtime HOME for the rest of this root phase, BEFORE any
# link_configured_symlinks call. The re-exec paths below override HOME again for
# the fresh runtime process, but the no-host-identity/root fallbacks run
# link_configured_symlinks in THIS process — without this they would create the
# operator's \`~/\` symlinks under the inherited build HOME (/root) instead of
# \$runtime_home.
export HOME="$runtime_home"

if [ "\${TYPECLAW_NETWORK_BLOCK_INTERNAL:-0}" != "1" ]; then
  if [ -n "\${TYPECLAW_HOST_UID:-}" ] && [ -n "\${TYPECLAW_HOST_GID:-}" ]; then
    # NOTE: no \`--reset-env\`. setpriv --reset-env clears every non-terminal
    # variable, which would wipe the runtime's own configuration: --env-file
    # values (provider credentials, etc.) plus TYPECLAW_SANDBOX_SYMLINKS,
    # TYPECLAW_TUI_TOKEN, TYPECLAW_CONTAINER_NAME, TYPECLAW_HOSTD_URL,
    # TYPECLAW_MODEL_CACHE, and TZ — all injected by start.ts and read after the
    # re-exec. We only need to OVERRIDE two variables for the runtime phase, and
    # the trailing \`env HOME=… TYPECLAW_ENTRYPOINT_RUNTIME=1\` does exactly that
    # while forwarding everything else unchanged.
    exec setpriv --reuid="$TYPECLAW_HOST_UID" --regid="$TYPECLAW_HOST_GID" --clear-groups \\
      --bounding-set=-all --inh-caps=-all --ambient-caps=-all \\
      -- env HOME="$runtime_home" TYPECLAW_ENTRYPOINT_RUNTIME=1 "$0" "$@"
  fi
  link_configured_symlinks
  start_xvfb
  exec env HOME="$runtime_home" ${RUNTIME_BUN} ${TYPECLAW_CLI_ENTRY} "$@"
fi

iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Hostd HTTP control carve-out: narrow ACCEPT, scoped to one TCP port on
# the host gateway. Skipped silently when hostd is not configured.
hostd_port=""
if [ -n "\${TYPECLAW_HOSTD_URL:-}" ]; then
  hostd_port="$(printf '%s' "$TYPECLAW_HOSTD_URL" | sed -n 's#^https\\{0,1\\}://[^/:]\\{1,\\}:\\([0-9]\\{1,5\\}\\).*#\\1#p')"
fi
if [ -n "\${hostd_port:-}" ]; then
  host_gw_ip="$(getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1; exit}')"
  if [ -n "\${host_gw_ip:-}" ]; then
    iptables -A OUTPUT -p tcp -d "$host_gw_ip" --dport "$hostd_port" -j ACCEPT
  fi
fi

# Resolver carve-out: parse /etc/resolv.conf nameservers and ACCEPT
# udp+tcp dport 53 to each. Gated on TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=1.
if [ "\${TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS:-0}" = "1" ] && [ -r /etc/resolv.conf ]; then
  for ns in $(awk '/^[[:space:]]*nameserver[[:space:]]+/{print $2}' /etc/resolv.conf | grep -v ':' || true); do
    iptables -A OUTPUT -p udp -d "$ns" --dport 53 -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$ns" --dport 53 -j ACCEPT
  done
fi

# User-supplied allowlist carve-out: comma-separated CIDRs/IPs from
# TYPECLAW_NETWORK_ALLOW. Already validated at config-parse time.
if [ -n "\${TYPECLAW_NETWORK_ALLOW:-}" ]; then
  IFS=','
  for cidr in $TYPECLAW_NETWORK_ALLOW; do
    [ -z "$cidr" ] && continue
    iptables -A OUTPUT -d "$cidr" -j ACCEPT
  done
  unset IFS
fi
${ipv4Rules.join('\n')}

ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT
${ipv6Rules.join('\n')}

if [ -n "\${TYPECLAW_HOST_UID:-}" ] && [ -n "\${TYPECLAW_HOST_GID:-}" ]; then
  # No \`--reset-env\` — see the network-off handoff above: it would strip the
  # --env-file values and the TypeClaw-injected runtime variables. The trailing
  # \`env\` overrides only HOME + TYPECLAW_ENTRYPOINT_RUNTIME and forwards the rest.
  exec setpriv --reuid="$TYPECLAW_HOST_UID" --regid="$TYPECLAW_HOST_GID" --clear-groups \\
    --bounding-set=-all --inh-caps=-all --ambient-caps=-all \\
    -- env HOME="$runtime_home" TYPECLAW_ENTRYPOINT_RUNTIME=1 "$0" "$@"
fi
link_configured_symlinks
start_xvfb
exec env HOME="$runtime_home" setpriv --bounding-set -net_admin --inh-caps -net_admin --ambient-caps -net_admin -- ${RUNTIME_BUN} ${TYPECLAW_CLI_ENTRY} "$@"
`
}

// Layer 6: install the network-egress entrypoint shim. Content is base64-
// encoded inline so the Dockerfile is fully self-contained — no second file
// in the build context, no COPY, no chicken-and-egg between init and start.
// Layer placement is intentionally late: shim source changes invalidate
// only this small layer (~1KB image impact), keeping Chrome and apt cached.
function renderEntrypointShimLayer(): string {
  const encoded = Buffer.from(buildEntrypointShim(), 'utf8').toString('base64')
  return `# Layer 6 (small, changes with the egress shim): install /usr/local/bin/typeclaw-entrypoint.
# The shim is a no-op unless \`network.blockInternal\` is true at runtime.
RUN echo "${encoded}" | base64 -d > ${TYPECLAW_ENTRYPOINT_PATH} \\
 && chmod +x ${TYPECLAW_ENTRYPOINT_PATH}`
}

// Bake the secret-free git-askpass helper (github-cli-auth broker delivers the
// token to it via env). Root-owned at build time so the non-root runtime, which
// cannot write the read-only /usr, still finds it.
function renderGitAskPassLayer(): string {
  const encoded = Buffer.from(ASKPASS_SCRIPT, 'utf8').toString('base64')
  return `RUN echo "${encoded}" | base64 -d > ${TYPECLAW_GIT_ASKPASS_PATH} \\
 && chmod 755 ${TYPECLAW_GIT_ASKPASS_PATH}`
}

// Layer 7: install @huggingface/transformers with its linux-native binaries.
//
// The host node_modules is bind-mounted over /agent at runtime carrying
// whatever binaries the host (typically macOS) resolved, so this layer seeds
// LINUX binaries into an image path that survives the bind mount and still
// wins Node/Bun resolution. Two native-dep mechanisms, fixed differently:
//
//   1. onnxruntime-node ships its addon via a POSTINSTALL that materializes the
//      binary inside the package dir, so a plain `bun add` covers it.
//   2. sharp resolves its native code from SEPARATE `@img/sharp-*` optional
//      PACKAGES, not a postinstall addon. sharp is a MANDATORY dep of
//      transformers, loaded eagerly because the package main chains
//      transformers.js -> utils/image.js (top-level `import sharp`) even though
//      typeclaw only does text feature-extraction. `bun add
//      @huggingface/transformers` alone does NOT pull the linux `@img/*` when
//      the bind-mounted host tree already satisfies sharp with the macOS ones —
//      so `sharp.js` throws at import ("Could not load the sharp module using
//      the linux-<arch> runtime") and the container exits at startup. We
//      install the arch-matched linux platform packages EXPLICITLY to fix it.
//
// CRITICAL — install location. `typeclaw start` bind-mounts the host agent
// folder over /agent at runtime (`-v <cwd>:/agent`), so anything written under
// /agent/node_modules at BUILD time is MASKED at runtime and can never win.
// The prior fix ran this `bun add` under `WORKDIR /agent`, populating
// /agent/node_modules — invisible behind the bind mount, so the sharp crash
// persisted. We install from `WORKDIR /` instead: the linux packages land in
// the IMAGE's /node_modules, which is NOT masked by the /agent mount. Node/Bun
// resolution for `require('@img/sharp-linux-<arch>')` ascends from
// /agent/node_modules/sharp up the directory chain and finds /node_modules,
// so the linux binary resolves. WORKDIR is restored to /agent afterwards so
// later layers and the runtime CWD are unchanged.
//
// EXACT transformers version this image installs. Must stay in lockstep with
// `@huggingface/transformers` in the repo package.json (a guard test in
// dockerfile.test.ts asserts the two agree). The pin is EXACT — not a caret —
// because this layer's `bun add` runs at `WORKDIR /` with NO project lockfile,
// so the repo `bun.lock` does NOT constrain it. A bare `@huggingface/
// transformers` (no version) would resolve npm `latest` at BUILD time: the day
// a newer transformers ships, the container would install it while the
// sharp/libvips pins below stay fixed, and the mismatched sharp platform
// packages crash at container import ("Could not load the sharp module using
// the linux-<arch> runtime"). Pinning the version closes that drift.
export const TRANSFORMERS_VERSION = '4.2.0'

// sharp + libvips versions are pinned to what @huggingface/transformers@4.2.0
// resolves. A future transformers bump that moves sharp must bump
// TRANSFORMERS_VERSION, `sharp@`, `@img/sharp-linux-*`, and
// `@img/sharp-libvips-linux-*` together — mismatched sharp/libvips platform
// packages are a known failure mode.
//
// ARCH DETECTION — uname -m, not $TARGETARCH. Deriving the arch from the build
// arg as `${TARGETARCH:-amd64}` was a footgun: a bare `docker build` without
// BuildKit/buildx leaves TARGETARCH unset, so the default installed x64 packages
// even on arm64 hosts. The arm64 platform packages then exist in NEITHER
// /agent/node_modules/@img NOR /node_modules/@img, so sharp exhausts every
// candidate and aborts with a clean MODULE_NOT_FOUND ("Could not load the sharp
// module using the linux-arm64 runtime") the moment any code touches it (e.g.
// `typeclaw --help`). `uname -m` is the arch that actually runs this `bun add`
// (and the arch the native code must later load on), correct in every build path
// including emulated cross-builds. Unknown machines fail the build loudly.
const LAYER_TRANSFORMERS_INSTALL = `# Layer 7: install @huggingface/transformers with its linux-native binaries.
# Installs the linux onnxruntime-node addon AND sharp's linux platform packages
# (@img/sharp-linux-*) into the image's /node_modules so they survive the
# runtime /agent bind mount and still win Node/Bun resolution from
# /agent/node_modules/sharp. The transformers version is pinned EXACT (this
# bun add has no lockfile) — see src/init/dockerfile.ts for the rationale.
WORKDIR /
RUN SHARP_ARCH="$(case "$(uname -m)" in aarch64|arm64) echo arm64 ;; x86_64|amd64) echo x64 ;; *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; esac)" \\
 && bun add \\
      @huggingface/transformers@${TRANSFORMERS_VERSION} \\
      sharp@0.34.5 \\
      "@img/sharp-linux-\${SHARP_ARCH}@0.34.5" \\
      "@img/sharp-libvips-linux-\${SHARP_ARCH}@1.2.4"
WORKDIR /agent`

// Claude Code's official installer is `curl | bash`, not apt — can't live
// in APT_FEATURES. Layer placed after the toggle apt install (so curl + ca-
// certificates from the baseline are guaranteed present) and before the
// entrypoint shim (which is always last). Omitted entirely when disabled.
//
// The Anthropic installer drops `claude` at `$HOME/.local/bin/claude` and
// emits a "~/.local/bin is not in your PATH" warning on every install on
// bun:1-slim (PATH out of the box is `/usr/local/sbin:/usr/local/bin:/usr/
// sbin:/usr/bin:/sbin:/bin:/usr/local/bun-node-fallback-bin`, no
// `~/.local/bin`). Without intervention, every `which claude` from the
// agent (and from the typeclaw-claude-code skill's verification step)
// returns empty. Symlink into `/usr/local/bin/` — already on PATH, matches
// what `cloudflared` does, survives `/root/.local/bin` getting rewritten
// by the installer's "update" path. The symlink resolves to the
// `~/.local/bin/claude` shim, which itself dereferences to the versioned
// binary under `~/.local/share/claude/versions/<ver>/`, so upgrades via
// `claude update` keep working without re-running this layer.
// `~/.claude.json` is Claude Code's internal state file (NOT
// `~/.claude/settings.json`, which is user-facing). On first run with an
// empty or missing file, `claude` enters a TTY-only theme picker:
// "Welcome to Claude Code … Choose the text style that looks best with
// your terminal" with 7 options. The picker is unskippable via CLI
// flags or env vars (no `--skip-onboarding`, no `--theme=dark`;
// `IS_DEMO=1` exists but has documented side effects). The single
// official escape hatch is writing `{"hasCompletedOnboarding": true,
// "theme": "dark"}` to `~/.claude.json` before the first launch —
// confirmed by Anthropic in multiple GitHub issues
// (anthropics/claude-code#4714, #8938, #13827) and the empirical
// answer used by metabase/metabase's `bin/claude-dangerous`, the
// `claudeCodeAlDevContainer` feature, and dozens of other Docker
// integrations.
//
// Without the pre-seed, the very first agent-driven `tmux new-session …
// claude` invocation hangs on the theme picker: the agent's
// `send-keys "<prompt>" Enter` arrives at the picker, gets interpreted
// as picker input, and never reaches claude's actual prompt. The
// `typeclaw-claude-code` skill is structured around a `Stop`-hook
// sentinel, which never fires while the picker is up, so the polling
// loop only learns of the hang at the 10-minute wall-clock budget.
// Pre-seeding here costs ~85 bytes on disk and zero runtime overhead.
//
// SCOPE: this seed is NECESSARY but not SUFFICIENT for a fully
// no-questions-asked first launch. Claude Code also shows two
// post-seed modal dialogs that this file deliberately does NOT
// pre-clear:
//   1. "Detected a custom API key from environment. Do you want to use
//      this API key?" — fires when ANTHROPIC_API_KEY is set. Options
//      `[No (recommended), Yes]`, focus on No, picker does NOT wrap.
//   2. Workspace trust ("Do you trust the files in this folder?") —
//      fires on every new cwd. Options `[Yes, proceed, No, exit]`,
//      focus on Yes.
// Both are kept as runtime decisions handled by the
// `typeclaw-claude-code` skill (see its "Driving the session" section,
// "Clear startup dialogs" step, which uses dialog-specific keystrokes
// because the picker doesn't wrap). Pre-seeding
// `hasTrustDialogAccepted` or `customApiKeyResponses.approved` here
// would silently widen the trust surface in ways the operator hasn't
// consented to — the seed's job is strictly cosmetic-wizard removal,
// not trust/permission preemption.
//
// `theme: "dark"` matches typeclaw's default TUI theme so the visual
// transition between the typeclaw TUI and a tmux-attached claude pane
// is consistent. Users on light terminals can override by editing
// `~/.claude.json` (which persists across container restarts only if
// they mount it; in the default container-ephemeral state it resets
// to this default on every rebuild, which is fine — `claude` reads
// the file at startup and the theme has no behavioral impact).
//
// `lastOnboardingVersion` is INTENTIONALLY OMITTED. ii-agent and a
// few other templates ship `lastOnboardingVersion: "1.0.30"`, but
// that value is version-coupled and goes stale on every Claude Code
// release. Empirically against Claude Code 2.1.146, the current
// `hasCompletedOnboarding: true` alone is honored without a version
// pin. If a future Claude version starts re-triggering the picker
// when the field is missing, capture `claude --version` output at
// build time and inject it then — don't hardcode a stale value.
//
// `installMethod: "native"` and `numStartups: 1` match the shape
// Claude Code itself writes after a clean first launch; keeping them
// makes our seed indistinguishable from a real post-onboarding state,
// which minimizes the chance of a future "if the file looks like
// agent-pre-seed, redo onboarding" detection heuristic landing on us.
//
// Built via `JSON.stringify` rather than a hand-written string
// literal so quote/escape bugs surface as TS errors at compile time,
// not as a corrupt `~/.claude.json` discovered only when the build
// runs. The `printf '%s\\n' '<JSON>'` shell pattern relies on the
// JSON containing no single quotes (true by construction — JSON.
// stringify only emits double quotes); a regression test parses the
// emitted JSON back to confirm.
const CLAUDE_CODE_ONBOARDING_SEED = JSON.stringify({
  hasCompletedOnboarding: true,
  theme: 'dark',
  installMethod: 'native',
  numStartups: 1,
})

// The Stop hook is what powers the typeclaw-claude-code skill's done-signal:
// the operator subagent spawns claude in a worktree, polls a sentinel file,
// and decides "turn done" from the file's contents. The hook was originally
// per-worktree (`<worktree>/.claude/settings.json` + `<worktree>/hook-on-
// stop.sh`), which meant the operator subagent wrote both files itself at
// delegation time. That worked when operator wrote the canonical shape —
// and silently failed when it didn't. Claude Code's settings parser
// ignores unknown keys, so wrong-shape configs (`{"hooks": {"onStop":
// "./script.sh"}}`, `{"hooks": {"Stop": "./script.sh"}}`,
// `{"hooks": {"Stop": [{"command": "./script.sh"}]}}` etc.) surface as
// "polling timed out at the 10-minute wall-clock budget" rather than as a
// parse error — the failure is invisible until you've already paid the
// budget. The skill's "do not simplify this JSON" warning helps but doesn't
// eliminate the slip: as long as an LLM has to write the JSON, an LLM can
// invent a shape.
//
// Move both pieces to Dockerfile-build time, where the JSON is constructed
// once via JSON.stringify and the shape can never drift from the operator's
// reading of the skill:
//
//   1. `/usr/local/bin/typeclaw-cc-stop-hook` — the hook script. Stable
//      absolute path so the global settings.json can name it without
//      worrying about $PATH. Reads stdin (Claude Code's Stop event JSON)
//      and atomically writes `$PWD/sentinel.json` + touches `$PWD/.done`.
//      The temp-file-then-rename keeps the read side from ever seeing a
//      partial sentinel even if the polling loop races the write — same
//      atomicity contract as the previous per-worktree script.
//   2. `~/.claude/settings.json` — the user-level (global) hook config.
//      User-level hooks fire for every `claude` invocation regardless of
//      cwd, so the operator's worktree no longer needs its own
//      `.claude/settings.json`. (Claude Code merges hooks additively
//      across scopes per docs.claude.com/en/docs/claude-code/settings —
//      if a future user mounts their own `~/.claude/settings.json` with a
//      different Stop hook, both fire in parallel rather than ours being
//      clobbered.)
//
// Both files are written via JSON.stringify + heredoc; the JSON shape is
// validated by JSON.parse in dockerfile.test.ts, so a future edit that
// corrupts the structure fails the test, not the docker build (let alone
// the next delegation that runs against the broken hook). The previous
// per-worktree path is fully removed from the skill body; the only place
// the hook shape lives is here.
//
// IMPORTANT — \`$PWD\` vs \`$CLAUDE_PROJECT_DIR\`: an earlier version of this
// layer used \`$CLAUDE_PROJECT_DIR\`. Self-review caught this as a critical
// bug. \`CLAUDE_PROJECT_DIR\` is Claude Code's documented env var for "the
// project root" — but empirically (see anthropics/claude-code#27343 and
// #44450), inside a git worktree it resolves to the *main repo's* git
// root, NOT the worktree's path. The operator's flow is:
//   git -C /agent worktree add /tmp/cc-<id> HEAD
//   tmux new-session -d -s cc-<id> -c /tmp/cc-<id> claude
// So \`/tmp/cc-<id>\` is a registered worktree of \`/agent\`, and Claude
// Code would resolve \`CLAUDE_PROJECT_DIR=/agent\` — landing the sentinel
// in the live agent folder while the polling loop watches the worktree.
//
// The fix: write to \`$PWD\` instead. \`$PWD\` is set by every POSIX shell
// on every invocation (POSIX-required since IEEE 1003.1-1988), and it's
// the literal cwd Claude Code was invoked with — exactly the worktree
// path \`tmux -c\` set. \`CLAUDE_PROJECT_DIR\` is Anthropic-specific and
// has shifted semantics across versions per the cited bug reports; we
// deliberately avoid depending on it.
//
// PER-SESSION FILENAMES — concurrent-claude race safety: the Stop hook
// writes to \`sentinel-<session_id>.json\` and \`.done-<session_id>\`,
// not a fixed filename. session_id comes from Claude Code's Stop event
// JSON on stdin (\`BaseHookInputSchema.session_id\`, always present per
// the upstream schema). The operator learns the UUID by reading a
// \`.session-id\` file that a SessionStart hook (also baked here) writes
// at session-start time; see TYPECLAW_CC_SESSION_START_HOOK_SCRIPT
// below.
//
// The earlier shape used fixed \`sentinel.json\` + \`.done\` names, which
// is safe when each worktree has at most one claude session (today's
// only caller). But if two callers ever share a cwd — operator A and
// operator B both delegating in \`/agent\`, a future plugin that runs
// \`claude\` from a shared dir, or an out-of-band caller violating the
// "one worktree per delegation" invariant — both write to the same
// file and corrupt each other's state with no diagnostic. Per-session
// filenames make the race structurally impossible.
//
// WHY NOT \`claude --session-id <pre-generated-uuid>\`: an earlier
// iteration of this PR had the operator pre-generate a UUID and pass
// it via \`--session-id\`. Self-review caught that as a critical bug:
// per anthropics/claude-code#44607, the \`--session-id\` flag only
// controls the persistence/transcript UUID in \`-p\` (print) mode. In
// interactive mode (which the typeclaw-claude-code skill uses), the
// flag sets a separate telemetry/API ID while the CLI generates its
// own internal UUID for the transcript file and for the \`session_id\`
// field that hooks see. The pre-generated UUID and the hook's UUID
// don't match — the polling loop times out forever. The current
// design sidesteps this entirely: the operator does NOT pass
// \`--session-id\`; it lets claude generate its own UUID and learns it
// back via the \`.session-id\` file the SessionStart hook writes.
//
// session_id extraction: \`bun -e\` against the JSON payload. We use bun,
// NOT POSIX sed, because bun is guaranteed in the container (bun:1-slim
// base) and is a real JSON parser. A previous iteration used
// \`sed -n 's/.*"session_id":"\\([^"]*\\)".*/\\1/p'\` which is greedy and
// picks the LAST \`"session_id":"..."\` occurrence in the JSON.
// Claude Code's Stop event carries \`last_assistant_message\` which
// contains the assistant's prose — that prose can include the literal
// text \`"session_id":"<fake-uuid>"\` (the model might have been
// discussing session IDs!), which sed would extract instead of the
// top-level field. bun's JSON.parse picks the structural \`session_id\`
// regardless of what appears in nested string values. UUID-shape
// validation still applies downstream as defense-in-depth against
// path-traversal session_id values; malformed JSON or missing field
// falls back to "malformed" so the polling loop sees SOMETHING and
// can surface the corruption.
//
// FALLBACK FILENAMES — \`sentinel-malformed.json\` / \`.done-malformed\`:
// if session_id extraction fails or validation rejects the result, the
// hook writes to these fixed names. The operator's polling loop watches
// its own \`<sid>\` file (read from \`.session-id\`) and will time out —
// but the \`-malformed\` file exists on disk so a post-mortem inspector
// can tell "hook fired but session_id was bad" apart from "hook never
// fired at all."
//
// SECURITY/SCOPE: both hook scripts only touch files inside \`$PWD\`,
// with filenames validated to UUID shape or the fixed "malformed"
// fallback. Even with an adversarial \`session_id\` in the stdin
// payload, the worst case is "hook writes \`$PWD/sentinel-malformed.json\`"
// or "hook writes \`$PWD/.session-id\` containing 'malformed'" — never
// path traversal, never writes outside \`$PWD\`. The hooks run as root
// inside the container like every other in-container process; there is
// no privilege boundary to cross.
const TYPECLAW_CC_STOP_HOOK_PATH = '/usr/local/bin/typeclaw-cc-stop-hook'
const TYPECLAW_CC_SESSION_START_HOOK_PATH = '/usr/local/bin/typeclaw-cc-session-start-hook'

// SessionStart hook script. Fires when a session begins via
// startup/resume/clear/compact per the upstream lifecycle docs. Writes
// \`$PWD/.session-id\` containing the validated UUID, atomically.
//
// IMPORTANT — \`.session-id\` is a FAST PATH, not a precondition. Per
// anthropics/claude-code#11519, SessionStart can be SKIPPED entirely
// when workspace trust hasn't been accepted yet: debug logs show
// \`Skipping SessionStart:startup hook execution - workspace trust not
// accepted\`. For the typeclaw-claude-code skill flow, EVERY first
// invocation in a fresh worktree hits this — the trust dialog fires
// before any prompt can be sent. So \`.session-id\` may never appear
// pre-first-prompt. The skill instructs the operator to fall back to
// reading session_id from the FIRST Stop hook's sentinel instead.
// \`.session-id\` is still useful for sessions that were already
// trusted (re-attaching to a running worktree, etc.) — when it
// appears, the operator can skip the discovery step.
//
// IMPORTANT — \`compact\` can ROTATE the session_id. The upstream
// behavior is documented in anthropics/claude-code#29094: a SessionStart
// with \`source: "compact"\` is a NEW session linked via
// \`parent_session_id\`. So \`.session-id\` can change mid-delegation if
// a long claude session compacts itself. The operator's polling loop
// must handle session_id rotation: a new \`.done-<different-uuid>\`
// appearing means \`cc_session_id\` should update to the new value.
const TYPECLAW_CC_SESSION_START_HOOK_SCRIPT = `#!/bin/sh
# typeclaw SessionStart-hook for Claude Code. Stdin carries the
# SessionStart event JSON. Writes \$PWD/.session-id with the session
# UUID as a fast-path optimization (the operator falls back to
# discovering session_id from the first Stop sentinel if .session-id
# never appears — see anthropics/claude-code#11519). Rationale lives
# in src/init/dockerfile.ts.
#
# Both temp filenames are PID-scoped (PID = \$\$) so two SessionStart
# hooks firing concurrently in the same cwd don't race on the same
# temp file.
set -eu
tmp_out="\${PWD}/.session-id.\$\$.tmp"
trap 'rm -f "\$tmp_out"' EXIT
sid=\$(bun -e 'try { const j = await new Response(Bun.stdin.stream()).json(); process.stdout.write(String(j.session_id ?? "")) } catch { process.stdout.write("") }')
case "\$sid" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) sid=malformed ;;
esac
printf '%s\\n' "\$sid" > "\$tmp_out"
mv "\$tmp_out" "\${PWD}/.session-id"
trap - EXIT
`

// Single-quoted heredoc so the body is delivered verbatim — no shell
// expansion at build time. Runtime expansion of \`$PWD\`, \`$sid\`, etc.
// is what we want, so the heredoc must NOT expand them during \`docker
// build\`. POSIX \`<<'EOF'\` (quoted delimiter) is the canonical way to
// get verbatim heredoc.
//
// Script flow:
//   1. Buffer stdin to a temp file (we need to read it twice: once for
//      session_id extraction, once for the sentinel write).
//   2. Extract session_id via POSIX sed. Result is matched against the
//      RFC-4122-style UUID regex (8-4-4-4-12 hex with dashes). Anything
//      that doesn't match — empty extraction, embedded escapes, path
//      traversal, missing field — falls through to "malformed".
//   3. Atomic write: \`mv\` is POSIX-atomic on the same filesystem (we
//      stay inside \`$PWD\` so the temp and final paths share an fs).
//   4. \`touch .done-<sid>\` AFTER the mv so a polling reader never sees
//      .done existing before sentinel.json — the polling loop watches
//      .done as the readiness signal.
const TYPECLAW_CC_STOP_HOOK_SCRIPT = `#!/bin/sh
# typeclaw Stop-hook for Claude Code. Stdin carries the Stop event JSON.
# Writes per-session sentinel/.done files into \$PWD. Rationale (including
# the security model, \$PWD semantics, and why bun-not-sed for JSON
# extraction) lives in src/init/dockerfile.ts.
set -eu
tmp_in="\${PWD}/.cc-stop-hook-in.\$\$"
trap 'rm -f "\$tmp_in"' EXIT
cat > "\$tmp_in"
sid=\$(bun -e 'try { const j = await Bun.file(process.argv[1]).json(); process.stdout.write(String(j.session_id ?? "")) } catch { process.stdout.write("") }' "\$tmp_in")
case "\$sid" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) sid=malformed ;;
esac
mv "\$tmp_in" "\${PWD}/sentinel-\${sid}.json"
trap - EXIT
touch "\${PWD}/.done-\${sid}"
`

// User-level Claude Code settings file; applies to every invocation
// regardless of cwd. Registers BOTH the SessionStart hook (so the
// operator can learn the session UUID) and the Stop hook (so the
// operator can poll for turn-completion). Built via JSON.stringify
// rather than a string literal so any future shape edit fails the
// JSON.parse regression test, not the docker build (or worse, the
// first failed delegation).
//
// SessionStart matcher \`startup|resume|clear|compact\`: covers all four
// session-origin types per the upstream matcher reference. Stop has no
// matcher support (always fires on every occurrence per the docs), so
// \`matcher: "*"\` is the canonical "fire on every Stop" form.
//
// \`args: []\` is the exec-form trigger per docs.claude.com/en/docs/
// claude-code/hooks: with \`args\` present, Claude Code runs the command
// directly via execvp (kernel-handled shebang, no shell tokenization).
// With \`args\` absent, Claude Code falls back to shell form (\`sh -c
// "<command>"\`), which works for our absolute-path-no-special-chars
// case but is fragile to any future path change. Exec form is the
// canonical robust shape.
const TYPECLAW_CC_GLOBAL_SETTINGS = JSON.stringify({
  hooks: {
    SessionStart: [
      {
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: TYPECLAW_CC_SESSION_START_HOOK_PATH, args: [] }],
      },
    ],
    Stop: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: TYPECLAW_CC_STOP_HOOK_PATH, args: [] }],
      },
    ],
  },
})

function renderClaudeCodeInstallLayer(enabled: boolean): string {
  if (!enabled) return ''
  return `# Layer 5.6 (toggle): install Anthropic's Claude Code CLI. Opt-in via
# typeclaw.json#docker.file.claudeCode. The skill \`typeclaw-claude-code\`
# documents the auth + usage flow. Pre-seed ~/.claude.json so the first
# launch skips the TTY-only theme picker; see CLAUDE_CODE_ONBOARDING_SEED
# above for the rationale and what the seed deliberately does NOT cover.
# Also pre-write the canonical Stop-hook config and helper script at
# build time (see TYPECLAW_CC_STOP_HOOK_PATH above) so the operator
# subagent never has to construct that JSON itself — the historically
# failure-prone step where wrong-shape configs (\`onStop\`, bare-string
# values, etc.) would silently disable the done-signal and burn the
# polling loop's wall-clock budget. The seed write runs LAST in the
# chain so the final layer state is exactly the seeded config —
# independent of whether any earlier command (or a future Claude
# version's \`--version\` smoke test) writes a default \`~/.claude.json\`
# partway through the layer.
RUN curl -fsSL https://claude.ai/install.sh | bash \\
 && ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude \\
 && claude --version > /dev/null \\
 && cat > ${TYPECLAW_CC_SESSION_START_HOOK_PATH} <<'TYPECLAW_CC_SESSION_START_HOOK_EOF'
${TYPECLAW_CC_SESSION_START_HOOK_SCRIPT}TYPECLAW_CC_SESSION_START_HOOK_EOF
RUN cat > ${TYPECLAW_CC_STOP_HOOK_PATH} <<'TYPECLAW_CC_STOP_HOOK_EOF'
${TYPECLAW_CC_STOP_HOOK_SCRIPT}TYPECLAW_CC_STOP_HOOK_EOF
RUN chmod +x ${TYPECLAW_CC_SESSION_START_HOOK_PATH} ${TYPECLAW_CC_STOP_HOOK_PATH} \\
 && mkdir -p "$HOME/.claude" \\
 && printf '%s\\n' '${TYPECLAW_CC_GLOBAL_SETTINGS}' > "$HOME/.claude/settings.json" \\
 && printf '%s\\n' '${CLAUDE_CODE_ONBOARDING_SEED}' > "$HOME/.claude.json"`
}

// Codex CLI's official distribution channel is the npm package
// \`@openai/codex\` (https://www.npmjs.com/package/@openai/codex). Unlike
// Claude Code's \`curl | bash\` install, Codex installs cleanly via the same
// bun-global path agent-browser uses, so we layer it under the existing
// \`bun install -g\` invariant: cache-mount keyed install, no \$HOME/.local/bin
// symlink dance, no installer scratch.
//
// Hook architecture: Codex CLI ships a hook system with the SAME event names
// as Claude Code (SessionStart, Stop, PreToolUse, PostToolUse, etc.) and the
// SAME JSON shape (\`{ session_id, transcript_path, cwd, hook_event_name }\` on
// stdin). The two CLIs are NOT interoperable — Codex's config file is
// \`~/.codex/hooks.json\` (or inline \`[hooks]\` in \`config.toml\`), and the trust
// model differs (Codex prompts for hook trust on first run, gated by
// \`--dangerously-bypass-hook-trust\`). But the hook script body, the
// per-session filenames (\`.done-<sid>\`, \`sentinel-<sid>.json\`), the
// \`.session-id\` fast path, and the \`malformed\` fallback are byte-for-byte
// reusable. We deliberately use distinct paths (\`typeclaw-cx-*\` instead of
// \`typeclaw-cc-*\`) and a distinct settings file (\`~/.codex/hooks.json\` vs
// \`~/.claude/settings.json\`) so an agent with BOTH toggles on doesn't have
// the two CLIs racing on the same sentinel files. The skill side
// (\`typeclaw-codex-cli\`) documents which UUID-bearing artifacts belong to
// which CLI.
//
// Onboarding: Codex has NO theme picker, NO telemetry consent dialog, NO
// terms-of-service prompt — verified against
// codex-rs/tui/src/onboarding/onboarding_screen.rs in the upstream repo.
// The TUI's onboarding state machine has exactly three steps: Welcome,
// Auth, TrustDirectory. We CAN'T pre-seed past Welcome (it's an animation,
// not a prompt), and we DELIBERATELY don't pre-seed past Auth (the user
// must paste their OPENAI_API_KEY or run \`codex login\` themselves) or past
// TrustDirectory (trusting an arbitrary worktree silently widens the trust
// surface in ways the operator hasn't consented to — exact same reasoning
// as Claude Code's "don't preseed hasTrustDialogAccepted"). The
// \`typeclaw-codex-cli\` skill handles all three at runtime via dialog
// polling, the same shape Claude Code's skill uses for its post-seed
// modals.
//
// Smoke test: \`codex --version\` is supported per codex-rs/cli/src/main.rs
// (clap \`version\` attribute), so we use it as the build-time install check.
const TYPECLAW_CX_STOP_HOOK_PATH = '/usr/local/bin/typeclaw-cx-stop-hook'
const TYPECLAW_CX_SESSION_START_HOOK_PATH = '/usr/local/bin/typeclaw-cx-session-start-hook'

const TYPECLAW_CX_SESSION_START_HOOK_SCRIPT = `#!/bin/sh
# typeclaw SessionStart-hook for Codex CLI. Stdin carries the SessionStart
# event JSON. Writes \$PWD/.session-id with the session UUID as a fast-path
# optimization (the operator falls back to discovering session_id from the
# first Stop sentinel if .session-id never appears). Rationale lives in
# src/init/dockerfile.ts.
set -eu
tmp_out="\${PWD}/.session-id.\$\$.tmp"
trap 'rm -f "\$tmp_out"' EXIT
sid=\$(bun -e 'try { const j = await new Response(Bun.stdin.stream()).json(); process.stdout.write(String(j.session_id ?? "")) } catch { process.stdout.write("") }')
case "\$sid" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) sid=malformed ;;
esac
printf '%s\\n' "\$sid" > "\$tmp_out"
mv "\$tmp_out" "\${PWD}/.session-id"
trap - EXIT
`

const TYPECLAW_CX_STOP_HOOK_SCRIPT = `#!/bin/sh
# typeclaw Stop-hook for Codex CLI. Stdin carries the Stop event JSON.
# Writes per-session sentinel/.done files into \$PWD. Rationale (the
# security model, \$PWD semantics, and why bun-not-sed for JSON
# extraction) lives in src/init/dockerfile.ts.
set -eu
tmp_in="\${PWD}/.cx-stop-hook-in.\$\$"
trap 'rm -f "\$tmp_in"' EXIT
cat > "\$tmp_in"
sid=\$(bun -e 'try { const j = await Bun.file(process.argv[1]).json(); process.stdout.write(String(j.session_id ?? "")) } catch { process.stdout.write("") }' "\$tmp_in")
case "\$sid" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) sid=malformed ;;
esac
mv "\$tmp_in" "\${PWD}/sentinel-\${sid}.json"
trap - EXIT
touch "\${PWD}/.done-\${sid}"
`

// Codex CLI's hook config file lives at ~/.codex/hooks.json. The JSON shape
// mirrors Claude Code's settings.json hooks block exactly — same nesting,
// same matcher syntax, same exec-form via \`args: []\`. Built via
// JSON.stringify so a shape edit fails the JSON.parse regression test, not
// the docker build (or the first failed delegation).
//
// SessionStart matcher \`startup|resume\`: Codex documents \`startup\` and
// \`resume\` as the two SessionStart sources (vs Claude Code's
// \`startup|resume|clear|compact\` — Codex has no \`/clear\` command and no
// auto-compaction in the same shape). Claude's broader matcher would not
// be wrong but would match against events Codex never fires.
const TYPECLAW_CX_GLOBAL_HOOKS = JSON.stringify({
  hooks: {
    SessionStart: [
      {
        matcher: 'startup|resume',
        hooks: [{ type: 'command', command: TYPECLAW_CX_SESSION_START_HOOK_PATH, args: [] }],
      },
    ],
    Stop: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: TYPECLAW_CX_STOP_HOOK_PATH, args: [] }],
      },
    ],
  },
})

function renderCodexCliInstallLayer(enabled: boolean, buildKit: boolean): string {
  if (!enabled) return ''
  return `# Layer 5.7 (toggle): install OpenAI's Codex CLI. Opt-in via
# typeclaw.json#docker.file.codexCli. The skill \`typeclaw-codex-cli\`
# documents the auth + usage flow. Codex ships as the npm package
# \`@openai/codex\`, so we install via \`bun install -g\` reusing the same
# cache mount agent-browser uses. Hook scripts and ~/.codex/hooks.json
# are pre-written at build time so the operator subagent never has to
# construct that JSON itself — same load-bearing reason as the Claude
# Code layer above.
RUN ${bunCacheMount(buildKit)}bun install -g @openai/codex \\
 && codex --version > /dev/null \\
 && cat > ${TYPECLAW_CX_SESSION_START_HOOK_PATH} <<'TYPECLAW_CX_SESSION_START_HOOK_EOF'
${TYPECLAW_CX_SESSION_START_HOOK_SCRIPT}TYPECLAW_CX_SESSION_START_HOOK_EOF
RUN cat > ${TYPECLAW_CX_STOP_HOOK_PATH} <<'TYPECLAW_CX_STOP_HOOK_EOF'
${TYPECLAW_CX_STOP_HOOK_SCRIPT}TYPECLAW_CX_STOP_HOOK_EOF
RUN chmod +x ${TYPECLAW_CX_SESSION_START_HOOK_PATH} ${TYPECLAW_CX_STOP_HOOK_PATH} \\
 && mkdir -p "$HOME/.codex" \\
 && printf '%s\\n' '${TYPECLAW_CX_GLOBAL_HOOKS}' > "$HOME/.codex/hooks.json"`
}

// Shared-library runtime deps Chrome for Testing needs to launch on amd64
// Debian trixie (base of `oven/bun:1-slim`). This layer is the ONLY thing
// that installs them. `agent-browser install --with-deps` looks like it
// would, but it cannot: it shells out to `sudo apt-get` and there is no
// sudo in the image. Its hardcoded list also omits `libglib2.0-0t64`
// (still true at 0.33.0), so even where apt worked Chrome would die on
// launch with `libglib-2.0.so.0: cannot open shared object file`. We
// install the full Playwright-tested chromium dep set here so the bug
// doesn't recur if upstream omits another package.
//
// Package list mirrors Playwright's `debian13-x64` chromium deps in
// nativeDeps.ts (https://github.com/microsoft/playwright). t64-suffixed
// names are the trixie-renamed variants from the 64-bit time_t ABI
// transition; SONAMEs (libglib-2.0.so.0 etc.) are unchanged. Packages
// without t64 here have no t64 sibling on trixie — verified against
// packages.debian.org/trixie. Fonts are intentionally omitted from this
// list: the failure these packages address is launch-time linker errors,
// not rendering glyphs. CJK glyph rendering is a separate concern handled
// by the `cjkFonts` toggle (see CJK_FONTS_PACKAGE / APT_FEATURES below),
// which layers `fonts-noto-cjk` on top via the toggle apt install path.
export const CHROME_RUNTIME_APT_PACKAGES_AMD64 = [
  'libasound2t64',
  'libatk-bridge2.0-0t64',
  'libatk1.0-0t64',
  'libatspi2.0-0t64',
  'libcairo2',
  'libcups2t64',
  'libdbus-1-3',
  'libdrm2',
  'libgbm1',
  'libglib2.0-0t64',
  'libnspr4',
  'libnss3',
  'libpango-1.0-0',
  'libx11-6',
  'libxcb1',
  'libxcomposite1',
  'libxdamage1',
  'libxext6',
  'libxfixes3',
  'libxkbcommon0',
  'libxrandr2',
] as const

// `fonts-noto-cjk` provides CJK glyphs for Chromium-rendered output
// (screenshots, page.pdf()). Without it CJK text in agent-browser output
// renders as `.notdef` tofu boxes. Treated as a toggle apt package (like
// gh/tmux) rather than a base-image staple so users with `cjkFonts: false`
// genuinely skip the ~56MB layer; baking into the base image would force
// every GHCR-base user to ship the fonts regardless of their opt-out.
export const CJK_FONTS_PACKAGE = 'fonts-noto-cjk'

type AptFeature = {
  toAptArgs: (toggle: DockerfileFeatureToggle) => string[]
}

const APT_FEATURES: Record<'ffmpeg' | 'gh' | 'tmux' | 'python' | 'xvfb', AptFeature> = {
  ffmpeg: { toAptArgs: (v) => singlePackageArgs('ffmpeg', v) },
  gh: { toAptArgs: (v) => singlePackageArgs('gh', v) },
  tmux: { toAptArgs: (v) => singlePackageArgs('tmux', v) },
  python: {
    toAptArgs: (v) => (v === true ? ['python3', 'python3-pip', 'python3-venv', 'python-is-python3'] : []),
  },
  xvfb: { toAptArgs: (v) => (v === true ? ['xvfb'] : []) },
}

function resolveCjkFonts(value: boolean | 'auto', auto: boolean): boolean {
  return value === 'auto' ? auto : value
}

export function buildDockerfile(
  config: DockerfileConfig = defaultConfig(),
  options: BuildDockerfileOptions = {},
): string {
  // buildKit is the default; `start` passes false on hosts without buildx so the
  // generated Dockerfile omits the `# syntax=` pragma and every cache mount —
  // the legacy builder accepts the result as-is, no text post-processing needed.
  const buildKit = options.buildKit !== false
  const cjkFonts = resolveCjkFonts(config.cjkFonts, options.cjkFontsAuto ?? false)
  const toggleAptArgs = collectToggleAptArgs(config, cjkFonts)
  const ghKeyringLayer = renderGhKeyringLayer(config.gh, buildKit)
  const cloudflaredLayer = renderCloudflaredLayer(config.cloudflared)
  const customLines = renderCustomDockerfileLines(config.append)
  const baseImageVersion = options.baseImageVersion ?? null

  const claudeCodeLayer = renderClaudeCodeInstallLayer(config.claudeCode)
  const codexCliLayer = renderCodexCliInstallLayer(config.codexCli, buildKit)
  const fromAndHeavyLayers =
    baseImageVersion !== null
      ? renderVersionedHead(
          baseImageVersion,
          ghKeyringLayer,
          toggleAptArgs,
          cloudflaredLayer,
          claudeCodeLayer,
          codexCliLayer,
          buildKit,
        )
      : renderInlineHead(ghKeyringLayer, toggleAptArgs, cloudflaredLayer, claudeCodeLayer, codexCliLayer, buildKit)

  const header = buildKit ? `${BUILDKIT_HEADER}\n` : ''
  return `${header}# AUTOGENERATED by typeclaw — do not edit.
# This file is rewritten on every \`typeclaw start\` from src/init/dockerfile.ts
# in the typeclaw repo. Local edits will be overwritten (and committed away if
# the working tree is dirty). To change the template, edit dockerfile.ts there.

${fromAndHeavyLayers}
# The agent folder (including node_modules) is bind-mounted at runtime by
# \`typeclaw start\`, so we do not COPY or install here. This keeps the image
# tiny and lets edits on the host take effect without rebuilds.

ENV NODE_ENV=production

# Persist first-party GWS config without changing global XDG/git config lookup.
ENV GWS_CONFIG_HOME=/agent/workspace/.config/gws

# Keep agent-messenger runtime storage inside workspace/. LINE writes E2EE key
# material under line-storage/ here; Instagram stores its live session here.
# KakaoTalk credentials instead live in secrets.json#channels.kakaotalk and
# container writes go through hostd's secrets-patch RPC.
ENV AGENT_MESSENGER_CONFIG_DIR=${CONTAINER_AGENT_MESSENGER_CONFIG_DIR}

${customLines}ENTRYPOINT ["${TYPECLAW_ENTRYPOINT_PATH}"]
CMD ["run"]
`
}

// FROMs the prebuilt typeclaw-base image at the pinned version. Heavy
// layers (apt baseline, Chrome runtime libs, curl-impersonate, agent-browser,
// Chrome for Testing) are already in that image, so the per-agent head only
// re-runs the toggle apt install and (optionally) the gh keyring bootstrap.
//
// The entrypoint shim is ALSO re-emitted here, even though the base image
// already carries it. Two reasons: (1) older base images published before
// the shim landed (or before a shim source edit) don't have the up-to-date
// binary at TYPECLAW_ENTRYPOINT_PATH, and the per-agent ENTRYPOINT line
// would crash on startup with `stat: no such file or directory`. Re-emitting
// is ~1KB of image and keeps the contract local: whatever per-agent
// Dockerfile we emit guarantees the shim path exists, regardless of which
// base-image vintage we FROM. (2) Edits to `buildEntrypointShim()` ship via
// npm + `typeclaw start --build` immediately, instead of being blocked on a
// fresh base-image release. The base image's copy is harmlessly overwritten
// by this RUN — same path, same chmod.
function renderVersionedHead(
  baseImageVersion: string,
  ghKeyringLayer: string,
  toggleAptArgs: string[],
  cloudflaredLayer: string,
  claudeCodeLayer: string,
  codexCliLayer: string,
  buildKit: boolean,
): string {
  const toggleAptLayer = toggleAptArgs.length === 0 ? '' : `${renderToggleAptInstallLayer(toggleAptArgs, buildKit)}\n\n`
  const cloudflaredBlock = cloudflaredLayer === '' ? '' : `${cloudflaredLayer}\n\n`
  const claudeCodeBlock = claudeCodeLayer === '' ? '' : `${claudeCodeLayer}\n\n`
  const codexCliBlock = codexCliLayer === '' ? '' : `${codexCliLayer}\n\n`
  return `FROM ${GHCR_BASE_IMAGE_REPO}:${baseImageVersion}

WORKDIR /agent

ARG TARGETARCH

${ghKeyringLayer}${toggleAptLayer}${cloudflaredBlock}${claudeCodeBlock}${codexCliBlock}${renderEntrypointShimLayer()}
${renderGitAskPassLayer()}

${LAYER_TRANSFORMERS_INSTALL}

`
}

// FROMs oven/bun:1-slim and rebuilds the full heavy stack inline. Used by
// dev-mode runs (typeclaw installed via file: / link: spec) where the
// matching :version GHCR tag does not yet exist, and by the test suite to
// keep coverage of the full-stack layers independent of GHCR availability.
function renderInlineHead(
  ghKeyringLayer: string,
  toggleAptArgs: string[],
  cloudflaredLayer: string,
  claudeCodeLayer: string,
  codexCliLayer: string,
  buildKit: boolean,
): string {
  const baselineAndToggleArgs = [...BASELINE_APT_PACKAGES, ...toggleAptArgs]
  const cloudflaredBlock = cloudflaredLayer === '' ? '' : `${cloudflaredLayer}\n\n`
  const claudeCodeBlock = claudeCodeLayer === '' ? '' : `${claudeCodeLayer}\n\n`
  const codexCliBlock = codexCliLayer === '' ? '' : `${codexCliLayer}\n\n`
  return `${FROM_AND_WORKDIR}

# Layers are ordered most-stable first to maximize Docker layer cache hits on
# rebuilds. Anything that pulls from npm (volatile) sits below anything that
# pulls from apt (stable, version-pinned by the base image's debian release),
# and the heavy Chrome-for-Testing download on amd64 is isolated in its own
# final layer so unrelated changes do not invalidate it.

${LAYER_0_APT_KEEP_CACHE}

${ghKeyringLayer}# Layer 2 (changes when the package list changes): the actual apt install.
# Cache mounts make a re-install nearly free when this layer is invalidated:
# .deb files come straight from the host's BuildKit cache instead of being
# refetched from Debian/GitHub mirrors. Package set is composed from the
# \`docker.file\` config block in typeclaw.json — toggles for tmux/python/gh/
# ffmpeg fan out into the args below. Baseline (git/ca-certificates/curl/
# gnupg) is always installed because downstream layers depend on it.
#
# No \`rm -rf /var/lib/apt/lists/*\` because the lists live on a cache mount
# that is excluded from the image layer by definition.
RUN ${aptCacheMount(buildKit)}apt-get update \\
 && apt-get install -y --no-install-recommends \\
      ${baselineAndToggleArgs.join(' ')} \\
 && if [ "$TARGETARCH" = "arm64" ]; then \\
      apt-get install -y --no-install-recommends chromium; \\
    else \\
      apt-get install -y --no-install-recommends \\
        ${CHROME_RUNTIME_APT_PACKAGES_AMD64.join(' ')}; \\
    fi

${LAYER_2_5_CURL_IMPERSONATE}

${LAYER_3_AGENT_BROWSER_ARM64_CONFIG}

${renderAgentBrowserInstallLayer(buildKit)}

${LAYER_4_5_AGENT_BROWSER_HEADED_WRAPPER}

${renderChromeForTestingLayer()}

${cloudflaredBlock}${claudeCodeBlock}${codexCliBlock}${renderEntrypointShimLayer()}
${renderGitAskPassLayer()}

${LAYER_TRANSFORMERS_INSTALL}

`
}

function renderCloudflaredLayer(enabled: boolean): string {
  if (!enabled) return ''
  return `# Layer 5.5 (optional): pinned cloudflared for cloudflare-quick tunnels.
RUN ARCH_BIN="$(if [ "$TARGETARCH" = "arm64" ]; then echo arm64; else echo amd64; fi)" \
 && ARCH_SHA="$(if [ "$TARGETARCH" = "arm64" ]; then echo ${CLOUDFLARED_SHA256_ARM64}; else echo ${CLOUDFLARED_SHA256_AMD64}; fi)" \
 && cd /tmp \
 && curl -fsSL -o cloudflared \
      "${CLOUDFLARED_RELEASE_URL_BASE}/${CLOUDFLARED_VERSION}/cloudflared-linux-\${ARCH_BIN}" \
 && echo "\${ARCH_SHA}  cloudflared" | sha256sum -c - \
 && chmod +x cloudflared \
 && mv cloudflared /usr/local/bin/cloudflared \
 && /usr/local/bin/cloudflared --version > /dev/null

`
}

function renderToggleAptInstallLayer(toggleAptArgs: string[], buildKit: boolean): string {
  return `# Layer 1 (toggle apt install): packages requested via typeclaw.json
# #docker.file toggles. Baseline + Chrome runtime libs are already in the
# base image; this layer only adds gh/tmux/python/ffmpeg/cjkFonts if enabled.
RUN ${aptCacheMount(buildKit)}apt-get update \\
 && apt-get install -y --no-install-recommends \\
      ${toggleAptArgs.join(' ')}`
}

// Recipe for the prebuilt typeclaw-base image published to
// ghcr.io/typeclaw/typeclaw-base by .github/workflows/base-image.yml. Built
// from the same constants and layer templates as buildDockerfile() so the
// two cannot drift — the published image is a function of this source, not
// a checked-in Dockerfile that needs hand-syncing. The base intentionally
// stops before the per-agent layers (gh keyring, apt feature toggles,
// docker.file.append, ENV, ENTRYPOINT) so users can still toggle them via
// typeclaw.json without forcing a base-image rebuild.
//
// Layer 2's apt-get install line installs only the baseline packages, NOT
// the gh/python/tmux/ffmpeg toggles — those layer onto the base in the
// per-agent Dockerfile.
export function buildBaseDockerfile(): string {
  return `${BUILDKIT_HEADER}
# AUTOGENERATED by scripts/emit-base-dockerfile.ts from src/init/dockerfile.ts.
# Do not edit by hand — your changes will be lost on the next CI run.

${FROM_AND_WORKDIR}

${LAYER_0_APT_KEEP_CACHE}

# Layer 2 (baseline only): apt baseline + Chrome runtime libs. Toggle-driven
# packages (gh/python/tmux/ffmpeg) are intentionally NOT installed here —
# they layer onto the base in the per-agent Dockerfile so users can opt in/
# out via typeclaw.json without forcing a base-image rebuild.
RUN ${aptCacheMount(true)}apt-get update \\
 && apt-get install -y --no-install-recommends \\
      ${BASELINE_APT_PACKAGES.join(' ')} \\
 && if [ "$TARGETARCH" = "arm64" ]; then \\
      apt-get install -y --no-install-recommends chromium; \\
    else \\
      apt-get install -y --no-install-recommends \\
        ${CHROME_RUNTIME_APT_PACKAGES_AMD64.join(' ')}; \\
    fi

${LAYER_2_5_CURL_IMPERSONATE}

${LAYER_3_AGENT_BROWSER_ARM64_CONFIG}

${renderAgentBrowserInstallLayer(true)}

${LAYER_4_5_AGENT_BROWSER_HEADED_WRAPPER}

${renderChromeForTestingLayer()}

${renderEntrypointShimLayer()}
${renderGitAskPassLayer()}

${LAYER_TRANSFORMERS_INSTALL}
`
}

// Shared layer templates. Both buildDockerfile() (per-agent) and
// buildBaseDockerfile() (prebuilt base image) compose from these so the
// two outputs cannot drift on Chrome runtime libs, curl-impersonate
// version, or the agent-browser install path.

const BUILDKIT_HEADER = `# syntax=docker/dockerfile:1.7`

// Cache-mount prefixes spliced between `RUN ` and the command. BuildKit honors
// `--mount=type=cache` (apt .debs / bun packages reused across builds); the
// legacy builder (hosts without buildx) has no equivalent, so legacy mode emits
// an empty prefix — same image, just no cross-build cache. Generating the two
// modes structurally is why typeclaw needs no Dockerfile text post-processing.
const APT_CACHE_MOUNT =
  '--mount=type=cache,target=/var/cache/apt,sharing=locked \\\n' +
  '    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\\n    '
const BUN_CACHE_MOUNT = '--mount=type=cache,target=/root/.bun/install/cache,sharing=locked \\\n    '

const aptCacheMount = (buildKit: boolean): string => (buildKit ? APT_CACHE_MOUNT : '')
const bunCacheMount = (buildKit: boolean): string => (buildKit ? BUN_CACHE_MOUNT : '')

// Pinned rather than the floating `oven/bun:1-slim`, which silently started
// resolving to Bun 1.4.0 the day it shipped — that would put an unvalidated
// runtime in every container while CI still tested 1.3.14. Bump this in the
// same change as the `bun-version:` pins in .github/workflows/*.yml so the
// host-stage checks and the container-stage runtime never disagree. The
// version itself lives in `TESTED_BUN_VERSION`, which also drives the host-Bun
// warning in `typeclaw doctor` and the host daemon log.
export const BUN_BASE_IMAGE = `oven/bun:${TESTED_BUN_VERSION}-slim`

const FROM_AND_WORKDIR = `FROM ${BUN_BASE_IMAGE}

WORKDIR /agent

ARG TARGETARCH`

// Layer 0: defeat Debian's apt auto-clean so \`--mount=type=cache\` below
// actually retains downloaded .debs across builds. The default
// /etc/apt/apt.conf.d/docker-clean (inherited from debian:slim) deletes
// /var/cache/apt/archives at the end of every apt invocation, which would
// nullify our cache mount. Also pre-create the keyring dir so the gh repo
// layer in the per-agent Dockerfile is one cheap cp/echo with no mkdir.
const LAYER_0_APT_KEEP_CACHE = `# Layer 0 (rarely changes): defeat Debian's apt auto-clean so cache mounts
# below actually retain downloaded .debs across builds.
RUN rm -f /etc/apt/apt.conf.d/docker-clean \\
 && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache \\
 && mkdir -p -m 755 /etc/apt/keyrings`

// Layer 2.5: install pinned curl-impersonate (lexiforest fork) for the
// web_search tool's DDG scraper. Required to evade DDG's TLS/HTTP2
// fingerprinting on residential IPs — see src/agent/tools/ddg.ts for the
// full rationale. Placed after Layer 2 so curl + ca-certificates + tar
// (already in baseline) are present, and before agent-browser so a version
// bump there doesn't invalidate this layer.
const LAYER_2_5_CURL_IMPERSONATE = `# Layer 2.5 (stable): pinned curl-impersonate (lexiforest fork) for DDG.
RUN ARCH_TARBALL="$(if [ "$TARGETARCH" = "arm64" ]; then echo aarch64-linux-gnu; else echo x86_64-linux-gnu; fi)" \\
 && ARCH_SHA="$(if [ "$TARGETARCH" = "arm64" ]; then echo ${CURL_IMPERSONATE_SHA256_ARM64}; else echo ${CURL_IMPERSONATE_SHA256_AMD64}; fi)" \\
 && cd /tmp \\
 && curl -fsSL -o curl-impersonate.tar.gz \\
      "https://github.com/lexiforest/curl-impersonate/releases/download/${CURL_IMPERSONATE_VERSION}/curl-impersonate-${CURL_IMPERSONATE_VERSION}.\${ARCH_TARBALL}.tar.gz" \\
 && echo "\${ARCH_SHA}  curl-impersonate.tar.gz" | sha256sum -c - \\
 && tar -xzf curl-impersonate.tar.gz -C /usr/local/bin/ \\
 && rm curl-impersonate.tar.gz \\
 && /usr/local/bin/curl_${CURL_IMPERSONATE_PROFILE} --version > /dev/null`

const LAYER_3_AGENT_BROWSER_ARM64_CONFIG = `# Layer 3 (stable, arm64 only): point agent-browser at the apt-installed
# chromium. Independent of the npm install below so it stays cached across
# agent-browser version bumps.
RUN if [ "$TARGETARCH" = "arm64" ]; then \\
      mkdir -p /root/.agent-browser \\
   && printf '%s\\n' '{"executablePath":"/usr/bin/chromium"}' > /root/.agent-browser/config.json; \\
    fi`

const renderAgentBrowserInstallLayer = (buildKit: boolean): string =>
  `# Layer 4 (volatile): install agent-browser globally so it survives the
# runtime bind-mount over /agent/node_modules.
RUN ${bunCacheMount(buildKit)}bun install -g agent-browser@^0.33.0`

// Layer 4.5: shim the agent-browser binary with a wrapper that calls
// \`agent-browser close\` before \`open\`/\`goto\`/\`navigate\` when headed
// mode is requested. Works around vercel-labs/agent-browser issue #1083
// ("headed silently ignored on existing session"): when a daemon is
// already running with a headless browser, subsequent commands with
// --headed / AGENT_BROWSER_HEADED reuse the existing headless browser
// regardless of the requested mode. Three upstream fix PRs (#660, #370,
// #387) have been open and unmerged for months as of 2026-05, so we
// patch this locally rather than block on upstream.
//
// Allowlist, not denylist. The wrapper only pre-closes on the three
// commands that explicitly start a new browsing session (\`open\`,
// \`goto\`, \`navigate\`). Every other agent-browser subcommand — \`click\`,
// \`snapshot\`, \`chat\`, \`connect\`, \`batch\`, \`tab\`, \`record\`, \`trace\`,
// \`stream\`, \`cookies\`, \`network\`, ... — passes through untouched.
// Rationale: those subcommands may operate on the live browser/page
// state (cookies, in-progress recording, attached external CDP, etc.),
// and a pre-close from us would silently destroy it. The user-reported
// scenario for #1083 (\"\`agent-browser open <url> --headed\` after a
// previous headless invocation\") is fully covered because the
// follow-up commands inherit the now-headed browser the \`open\`
// pre-close forced. An earlier draft used a deny-list approach that
// pre-closed on every non-skip subcommand under headed env; oracle
// self-review flagged the state-destruction risk for stateful commands,
// and the allowlist fix is the resulting narrower contract.
//
// Truthy contract mirrors upstream's \`env_var_is_truthy\`
// (cli/src/flags.rs:183): any non-empty value EXCEPT case-insensitive
// "0" / "false" / "no" counts as truthy. So
// \`AGENT_BROWSER_HEADED=yes\`, \`=y\`, \`=on\`, \`=anything-non-falsy\` all
// trigger the workaround — matching what upstream's CLI parser would
// see — instead of the original narrower 1|true match that left the
// bug present for legitimate truthy values.
//
// Re-entrancy is defended at two layers. (1) The pre-close path is
// \`open\`/\`goto\`/\`navigate\` only, and the close subcommand isn't in the
// allowlist, so the pre-close never recurses through the wrapper into
// another pre-close. (2) \`_TYPECLAW_AGENT_BROWSER_HEADED_HANDLED=1\` is
// set on the env passed to both the pre-close and the final exec; if a
// future subcommand we don't recognize shells out to \`agent-browser\` as
// a subprocess while headed env is still set, the child sees the guard
// and bypasses straight to .real without recursing.
const LAYER_4_5_AGENT_BROWSER_HEADED_WRAPPER = `# Layer 4.5 (cheap): wrap agent-browser to work around upstream issue
# #1083 (--headed / AGENT_BROWSER_HEADED ignored on existing session).
# See src/init/dockerfile.ts for the full rationale.
RUN mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser.real \\
 && cat > /usr/local/bin/agent-browser <<'TYPECLAW_AGENT_BROWSER_WRAPPER_EOF' \\
 && chmod +x /usr/local/bin/agent-browser
#!/bin/sh
# typeclaw-agent-browser-image-wrapper
# typeclaw wrapper for agent-browser — see src/init/dockerfile.ts.
set -e
real="\${TYPECLAW_AGENT_BROWSER_REAL:-/usr/local/bin/agent-browser.real}"
# Re-entrancy guard: if the wrapper invoked us, skip straight to the real
# binary. Prevents infinite recursion if a subcommand shells out to
# agent-browser while AGENT_BROWSER_HEADED is still set.
if [ "\${_TYPECLAW_AGENT_BROWSER_HEADED_HANDLED:-}" = "1" ]; then
  exec "$real" "$@"
fi
# Match upstream precedence: an explicit --user-agent flag or non-empty
# AGENT_BROWSER_USER_AGENT wins; otherwise use a current desktop Linux UA.
has_user_agent=0
for arg in "$@"; do
  case "$arg" in
    --user-agent|--user-agent=*) has_user_agent=1; break ;;
  esac
done
if [ -z "\${AGENT_BROWSER_USER_AGENT:-}" ] && [ "$has_user_agent" = "0" ]; then
  export AGENT_BROWSER_USER_AGENT='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
fi
# Pre-close is only needed when the caller is requesting headed mode.
# Match upstream's env_var_is_truthy contract (cli/src/flags.rs:183):
# truthy = any non-empty value except case-insensitive "0", "false", "no".
# Argv triggers: bare --headed, --headed=true, --headed=1. (A bare
# --headed followed by a separate "false" argument is upstream-supported
# to FORCE headless; the wrapper still pre-closes on the --headed match
# and the real binary launches headless — wasted close, correct end
# state. The narrower argv match keeps the wrapper from triggering on
# unrelated --headed-prefixed flags that may exist in future upstream
# versions.)
headed=0
val=\${AGENT_BROWSER_HEADED:-}
lower=$(printf '%s' "$val" | tr '[:upper:]' '[:lower:]')
case "$lower" in
  ''|'0'|'false'|'no') ;;
  *) headed=1 ;;
esac
for arg in "$@"; do
  case "$arg" in
    --headed|--headed=true|--headed=1) headed=1; break ;;
  esac
done
if [ "$headed" != "1" ]; then
  exec "$real" "$@"
fi
# Allowlist of commands where pre-close is safe and necessary. Only
# user-visible "start a new browsing session" verbs go here. Everything
# else (click, snapshot, chat, connect, batch, tab, record, trace,
# stream, cookies, ...) may depend on live browser/page state and must
# not be pre-closed by us.
first=""
for arg in "$@"; do
  case "$arg" in
    -*) continue ;;
    *) first="$arg"; break ;;
  esac
done
case "$first" in
  open|goto|navigate) ;;
  *) exec "$real" "$@" ;;
esac
# Best-effort pre-close. If the daemon is already gone, the real binary
# prints "No active sessions" and exits 0 — safe to call unconditionally.
# We discard its output so it never pollutes the caller's stdout/stderr,
# and we tolerate failures (network blip, stale socket) by falling
# through to the real command anyway.
_TYPECLAW_AGENT_BROWSER_HEADED_HANDLED=1 "$real" close >/dev/null 2>&1 || true
exec env _TYPECLAW_AGENT_BROWSER_HEADED_HANDLED=1 "$real" "$@"
TYPECLAW_AGENT_BROWSER_WRAPPER_EOF`

// Layer 5: download the pinned Chrome for Testing build into
// ~/.agent-browser/browsers/. NO cache mount on that path because the
// runtime needs the binary in the image, and no apt cache mount either
// because nothing in this layer runs apt.
//
// Deliberately NOT `--with-deps`. That flag shells out to `sudo apt-get`
// and there is no sudo in the image, so it could never install anything
// here. Through 0.27.x it failed silently and still exited 0, which is
// why it looked like a working backstop; 0.33.0 made it fail-closed
// ("fails if deps fail" in its own --help) and turned that dead no-op
// into a hard build failure. Chrome's shared libraries are installed for
// real in Layer 2.
const renderChromeForTestingLayer = (): string =>
  `# Layer 5 (heavy, amd64 only): Chrome for Testing download.
RUN if [ "$TARGETARCH" != "arm64" ]; then \\
      agent-browser install; \\
    fi`

function defaultConfig(): DockerfileConfig {
  return {
    ffmpeg: false,
    gh: true,
    python: true,
    tmux: true,
    cjkFonts: 'auto',
    cloudflared: false,
    xvfb: true,
    claudeCode: false,
    codexCli: false,
    append: [],
  }
}

function collectToggleAptArgs(config: DockerfileConfig, cjkFonts: boolean): string[] {
  const args: string[] = []
  for (const key of ['ffmpeg', 'gh', 'python', 'tmux'] as const) {
    args.push(...APT_FEATURES[key].toAptArgs(config[key]))
  }
  if (cjkFonts) args.push(CJK_FONTS_PACKAGE)
  args.push(...APT_FEATURES.xvfb.toAptArgs(config.xvfb))
  return args
}

function singlePackageArgs(name: string, toggle: DockerfileFeatureToggle): string[] {
  if (toggle === false) return []
  if (toggle === true) return [name]
  return [`${name}=${toggle}`]
}

// The gh keyring bootstrap is a separate layer so editing the package list
// (the most frequent change) does not re-fetch the GPG key over the network.
// When `gh` is disabled, omit the layer entirely — both to skip the network
// roundtrip on cold builds and to keep the package source registry clean.
function renderGhKeyringLayer(toggle: DockerfileFeatureToggle, buildKit: boolean): string {
  if (toggle === false) return ''
  return `# Layer 1 (rarely changes): register the GitHub CLI apt repository and trust
# its keyring. Split from the package install below so editing the package
# list (the most frequent change to this Dockerfile) does NOT re-fetch the
# GPG key over the network. The cache mount on /var/cache/apt covers the
# tiny gnupg/curl install we need to bootstrap the key fetch.
RUN ${aptCacheMount(buildKit)}apt-get update \\
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \\
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \\
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \\
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
      > /etc/apt/sources.list.d/github-cli.list

`
}

// Render-time enforcement is the security boundary: this is the sole bottleneck
// where docker.file.append entries reach the generated Dockerfile, so unsafe
// lines are STRIPPED here (never spliced into the build) rather than blocking
// `typeclaw start`. docker.file.append is untrusted input even when the
// in-container agent writes it — a bad line (e.g. the decode-and-exec footgun
// that bricked a real build) becomes ineffective, not fatal. Validation
// elsewhere only warns; this is what guarantees the line never runs.
function renderCustomDockerfileLines(lines: string[]): string {
  const { kept, strippedCount } = classifyDockerfileAppend(lines)
  if (kept.length === 0 && strippedCount === 0) return ''
  // Durable, payload-free record so a stripped line isn't a silent no-op: the
  // operator sees the Dockerfile itself note the count (full reasons surface as
  // startup warnings). Never echo the stripped content — it may carry secrets.
  const strippedNote =
    strippedCount > 0
      ? `# typeclaw stripped ${strippedCount} unsafe docker.file.append line(s); see startup warnings and typeclaw.json.
`
      : ''
  if (kept.length === 0) return strippedNote ? `${strippedNote}\n` : ''
  return `${strippedNote}# Custom lines from typeclaw.json#docker.file.append.
${kept.join('\n')}

`
}

export type DockerfileAppendClassification = {
  kept: string[]
  warnings: string[]
  strippedCount: number
}

// Single source of truth for "what happens to each docker.file.append line",
// reusing the config-layer classifier (validateDockerfileAppendLine). Both the
// renderer (enforcement: drops unsafe lines) and refreshDockerfile (reporting:
// surfaces warnings to the user) call this so the two never drift. Warn-but-
// allow lines (curl|bash, remote ADD) are KEPT but produce a warning; structural
// and semantic blocks are stripped with a warning.
export function classifyDockerfileAppend(lines: string[]): DockerfileAppendClassification {
  const kept: string[] = []
  const warnings: string[] = []
  let strippedCount = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const check = validateDockerfileAppendLine(line)
    if (!check.ok) {
      strippedCount++
      warnings.push(`docker.file.append[${i}] stripped — ${check.reason}`)
      continue
    }
    if (check.warning) warnings.push(`docker.file.append[${i}] ${check.warning}`)
    kept.push(line)
  }
  return { kept, warnings, strippedCount }
}
