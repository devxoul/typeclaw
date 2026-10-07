---
name: typeclaw-skills
description: Use this skill whenever the user asks you to install, find, list, update, or remove an agent skill, whenever you yourself want to add a new capability via a skill or record a durable procedure fix (deciding between an existing skill, its support doc, a new skill, or `AGENTS.md`), or whenever you are about to edit any file under `.agents/skills/`. Triggers include "install skill", "add a skill", "find a skill", "update skills", "remove skill", "skill from <repo>", any mention of the `skills` CLI / `bunx skills`, any reference to `SKILL.md`, `skills-lock.json`, `.skill-lock.json`, and any time you read or write under `.agents/skills/<name>/`. Read it before you touch a skill — TypeClaw has three skill layers with different ownership rules, and editing a skill that the `skills` CLI manages will silently get overwritten on the next `bunx skills update`.
---

# typeclaw-skills

You operate inside an agent folder. Skills — markdown files with YAML frontmatter — are how this folder teaches you new procedures, conventions, and APIs without changing your code. The runtime discovers them on session start, parses each `SKILL.md`'s frontmatter, and surfaces the `name` + `description` (plus an absolute `<location>` path) to you in the `<available_skills>` section so you can decide when to read the body. **You do not import or invoke skills; you load one by `read`-ing the `SKILL.md` at the exact `<location>` path that section gives you.**

**Never construct or guess a skill's path.** Use the `<location>` verbatim. Do not assume a layout like `node_modules/typeclaw/src/skills/<name>/SKILL.md` — bundled skills resolve through the installed package, user skills live under `.agents/skills/`, and muscle-memory skills under `memory/skills/`. If a skill you expect is not listed in `<available_skills>`, it is not a file-based skill and has no `SKILL.md` to read — stop looking on disk. (Subagent-only skills loaded via the `load_skill` tool, e.g. the `reviewer` subagent's `code-review`, are never files.)

This skill exists so you (a) understand which skills you can edit and which you must not, (b) can install new skills cleanly when the user asks, and (c) can author your own skills without colliding with the rest of the system.

## The three skill layers

Skills live in three places. The runtime loads them in this order, **first wins on name collisions**:

1. **System skills** — bundled with TypeClaw, ship inside the `typeclaw` package itself.
   - **Path**: `<typeclaw-package>/src/skills/<name>/SKILL.md` (resolved via `getBundledSkillsDir()` in `src/agent/index.ts`).
   - **Naming**: every system skill is prefixed `typeclaw-` (with a few legacy exceptions). The prefix is reserved — don't use it for your own skills.
   - **Ownership**: TypeClaw maintainers. Ship via typeclaw releases.
   - **You must not edit these.** They live inside `node_modules/typeclaw/` (or the symlinked dev repo). Edits would be lost on the next `bun install`. If a system skill is wrong, the fix is a typeclaw PR, not a local edit.

2. **User skills** — anything under `.agents/skills/<name>/SKILL.md` in the agent folder.
   - **Path**: `.agents/skills/` is created by `typeclaw init` and added to the resource loader by `src/agent/index.ts` only if the directory exists.
   - **Two sub-categories** (see "User-created vs user-downloaded" below — the distinction is critical):
     - **User-created**: the user (or you, on the user's request) hand-authored the skill in this agent folder.
     - **User-downloaded**: the skill was fetched by the upstream `skills` CLI (vercel-labs/skills) from a remote source.
   - **Ownership**: depends on the sub-category. **Get it wrong and you destroy work.**

3. **Memory skills** — _muscle memory_. Skills the dreaming subagent distilled from procedures it kept seeing in your daily memory streams.
   - **Path**: `memory/skills/<name>/SKILL.md`.
   - **Author**: the dreaming subagent, every time it consolidates a daily stream. Bar for promoting a fragment-pattern into a skill: multi-step, recurred across at least two distinct fragments, and the trigger conditions are statable as a "Use when..." description.
   - **Loading**: `src/agent/index.ts` adds `<agentDir>/memory/skills/` to `additionalSkillPaths` (existence-gated), so the resource loader auto-discovers every `SKILL.md` there on session start, identical to `.agents/skills/`.
   - **Persistence**: `memory/` is gitignored at the agent level, but the dreaming subagent force-commits its outputs (`MEMORY.md` plus everything under `memory/`, including `memory/skills/`) and applies `skip-worktree` so the human's `git status` stays clean.
   - **You must not write to `memory/skills/` manually.** It is owned by the dreaming subagent. Hand-authored content there will be ignored by the part of the system that dreaming reads (it consolidates from `memory/streams/yyyy-MM-dd.jsonl`, not from existing skill files), and the dreaming subagent may overwrite the same path on a future run. If you want a hand-authored skill, put it in `.agents/skills/`.

The collision rule (first wins) means: if a downloaded skill happens to share a name with a bundled one, the bundled one still wins and the downloaded copy is silently dropped with a collision diagnostic. Useful as a safety net, but do not rely on it — pick non-colliding names.

## The skill format

Every `SKILL.md` is a YAML frontmatter block followed by markdown body:

```markdown
---
name: my-skill
description: One paragraph telling you when to read this skill. Triggers and example phrases live here.
---

# my-skill

(body)
```

**Required frontmatter fields**: `name`, `description`.

The runtime parses the frontmatter to populate the `<available_skills>` system-prompt section. Only `name` and `description` are surfaced to you up front — the body is loaded only when you decide to read it. **A weak description is the most common reason a skill never gets activated**; spell out triggers verbatim. Look at any of the bundled `typeclaw-*` skills for the tone.

Other frontmatter fields (`metadata.version`, `metadata.author`, `license`, etc.) may be present on downloaded skills because their upstream authors chose to include them. The runtime ignores anything beyond `name` / `description`. Their presence does **not** prove the skill is downloaded — see the next section for the actual heuristic.

## User-created vs user-downloaded — the rule that protects you from destroying work

Both categories live in `.agents/skills/<name>/`. You cannot tell them apart by looking at the directory contents alone — and the distinction matters because **editing a downloaded skill will be silently overwritten the next time the user (or you) runs `bunx skills update`.**

### The reliable signal: the lockfile

The `skills` CLI tracks every skill it installs in a lockfile. **A skill is downloaded (managed by the CLI) if and only if its name appears as a key in one of these lockfiles**:

- **Project-scoped install** → `./skills-lock.json` at the agent folder root.
  - Schema: `{ "version": 1, "skills": { "<name>": { "source", "ref?", "sourceType", "skillPath?", "computedHash" } } }`
- **Global install** → `~/.agents/.skill-lock.json` (or `$XDG_STATE_HOME/skills/.skill-lock.json` if the user has XDG configured).
  - Schema: `{ "version": <n>, "skills": { "<name>": { "source", "sourceType", "sourceUrl", "ref?", "skillPath?", "skillFolderHash", "installedAt", "updatedAt", "pluginName?" } }, "dismissed?", "lastSelectedAgents?" }`

If the skill name is in either lockfile → **downloaded** → do not edit. If the skill name is in neither lockfile → **user-created** → safe to edit.

This is reliable because `bunx skills update` only touches skills it finds in the lockfile. Anything outside the lockfile is invisible to the CLI's update path and will never be overwritten.

### Heuristics that look reliable but are not — do not use them

- **`metadata.version` in frontmatter.** The `skills` CLI does **not** inject this on install. It only appears because some upstream repos (notably `vercel-labs/agent-skills`) author it into their source. Other registries skip it, and a user can trivially add `version: "1.0.0"` to their hand-authored skill. False negatives and false positives both common.
- **Symlink detection.** On many agents the CLI uses symlinks, so the agent-specific dir is a symlink back to a canonical copy. **For TypeClaw, this fails entirely** — TypeClaw is treated as a "universal" agent by the CLI (its skills dir already is `.agents/skills/`), so the CLI writes a real directory directly with no symlink to inspect.
- **Timestamps, file count, or directory layout.** None of these is set by the installer in any consistent way.

**Use the lockfile. Nothing else.**

### Workflow before editing any skill in `.agents/skills/`

1. Note the skill's directory name (e.g. `web-design-guidelines`).
2. Check the project lockfile: `cat ./skills-lock.json 2>/dev/null | jq '.skills | has("<name>")'`. If `true` → downloaded.
3. If the project lockfile didn't have it, check the global lockfile: `cat ~/.agents/.skill-lock.json 2>/dev/null | jq '.skills | has("<name>")'`. If `true` → downloaded.
4. If both are `false` (or the files don't exist), the skill is user-created → safe to edit.
5. **If downloaded, refuse the edit and tell the user**: "`<name>` is managed by `bunx skills`. Editing it would be lost on the next `bunx skills update`. Options: (a) fork it as a user-created skill under a new name, (b) propose the change upstream at `<source>` from the lockfile entry, or (c) `bunx skills remove <name>` first if you want to take ownership locally."
6. If user-created, edit normally and **commit immediately** (see `typeclaw-git` skill).

## When the user asks "install a skill"

The upstream tool is `vercel-labs/skills`, published on npm as `skills`. It has no SDK — it is CLI-only. Always invoke via `bunx skills <command>` so you don't depend on a global install and you don't pollute the container. Bun is already available; `bunx` resolves and caches the binary on first call.

### Two TypeClaw rules that override the CLI's defaults

Before the workflow: two non-negotiable rules for every install.

1. **Always pin `--agent universal`.** The `skills` CLI tries to detect the host agent and writes to that agent's directory by default. Inside the typeclaw container that detection is unreliable, and the wrong choice means the skill lands in a path the typeclaw runtime does not load. `--agent universal` writes directly to `.agents/skills/<name>/`, which is exactly the directory typeclaw's resource loader scans. Hard-code this on every `add` and every `remove`.

2. **Always specify `--skill <name>`.** Most skill repos (especially `vercel-labs/agent-skills`) are bundles of many skills, not a single one. Installing without `--skill` runs `@clack/prompts` interactively, and even with `-y` the no-flag default may install everything (`--all`-like behavior depending on the source layout). Either way, the user almost never wants the entire repo. **Refuse to install without an explicit skill name in hand.** If the user named only a repo, list the skills first (`-l`), show the names + descriptions, and ask the user which one(s) to install. Loop until they pick — do not guess, do not install "the obvious one", do not pick the most-starred. The user's intent is the only valid signal.

The canonical install command therefore is:

```bash
bunx skills add <source> --agent universal --skill <name> -y
```

Never drop `--agent universal`. Never drop `--skill <name>`. Never drop `-y`.

### Workflow

1. **Identify the source.** The user gave you a repo (`vercel-labs/agent-skills`), a URL, or a name (`skill-creator`). If only a name, search first with `bunx skills find <query>` (see "Searching the registry") and confirm the source with the user.
2. **List the skills in the source.** Run:
   ```bash
   bunx skills add <source> --agent universal -l
   ```
   The `-l` flag lists without installing. Output includes each skill's `name` and `description`.
3. **Show the list to the user and ask which to install.** Do not pick on their behalf, even if the list has only one entry — confirm explicitly. Do not install if they said something ambiguous like "the design one"; ask for the exact name.
4. **Install with the canonical command** (one skill at a time unless the user explicitly asked for several):
   ```bash
   bunx skills add <source> --agent universal --skill <name> -y
   ```
5. **Commit** per "Commit policy" below.
6. **Tell the user when the skill takes effect.** Skills are loaded on session start, not mid-session. The new skill becomes visible to you on the next prompt the user starts after the install commits.

### `<source>` accepts

- GitHub shorthand: `vercel-labs/agent-skills`
- GitHub URL with subpath: `https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines`
- GitLab URL: `https://gitlab.com/<org>/<repo>`
- Generic git URL: `git@github.com:<org>/<repo>.git`
- Local path: `./my-skills` (handy for testing user-authored skill bundles)

### Other flags — when (not) to use them

- `-l, --list` — list available skills in the source without installing. **Always use this in step 2 of the workflow.** Never skip it; the user must see the names before picking.
- `--all` — install every discovered skill from the source. **Only when the user verbatim said "install all of them" after seeing the list.** Never use `--all` as a shortcut around the listing step.
- Do **not** pass `-g, --global` from inside the container. Global installs go to `~/.agents/skills/`, which inside the container is the container's ephemeral home — not the user's host. Project-scoped (default) writes to `.agents/skills/` in the agent folder, which is the bind-mounted host directory.
- Do **not** pass `--copy` unless the user has a specific reason. Default mode is correct for TypeClaw under `--agent universal`.
- Do **not** pass `--dangerously-accept-openclaw-risks` ever. If a source is flagged, refuse and tell the user.

### Searching the registry

```bash
bunx skills find <query>
```

This hits `https://skills.sh/api/search` — a central registry curated by the `skills` project. Useful when the user says "find me a skill for X" without naming a repo. Returns matches with `name`, `slug`, `source`, `installs`. Pick the most relevant; do not auto-install — read the description first and confirm with the user.

### Listing what's installed

```bash
bunx skills list
```

Lists every installed skill in the project. Useful when the user asks "what skills are installed" — prefer this over `ls .agents/skills/` because `list` reads the lockfile and shows source/version metadata too.

### Updating

```bash
bunx skills update --agent universal [<name>...]
```

With no name arguments: updates every skill in the lockfile. With names: updates only those.

Update will overwrite any local edits to managed skills. Before running it, if the user has been editing skills, double-check none of those skills are in `skills-lock.json` (use the lockfile heuristic above).

### Removing

```bash
bunx skills remove <name> --agent universal -y
```

Removes the skill directory and the lockfile entry. After this, the name is free to reuse for a user-created skill. Pin `--agent universal` here too, for the same reason as install — the CLI's auto-detection is unreliable inside the container.

## Commit policy

`.agents/skills/` and `skills-lock.json` are **tracked** in git, not gitignored. Every install/update/remove mutates the working tree, and `typeclaw-git` says: every edit gets committed immediately with decision context.

The `skills` CLI does not commit on your behalf. After every successful mutating call, you commit:

```bash
git add .agents/skills/ skills-lock.json && \
  git commit -m "skills: install <source>" -m "<why the user wanted this skill>"
```

Subject convention: `skills: install <source>`, `skills: update <names>`, `skills: remove <names>`, `skills: author <name>` (for hand-written ones).

If the CLI exited non-zero, do **not** commit. The working tree may be partially mutated. Either:

1. Inspect with `git status` and decide if anything useful landed,
2. Reset the affected paths: `git checkout -- .agents/skills skills-lock.json && git clean -fd .agents/skills` and tell the user the install failed cleanly,
3. Surface the CLI stderr to the user so they can decide.

Do not invent a reason for a half-applied install. The lockfile and the working tree should agree at the moment of every commit.

If the agent folder is not a git repo, `bunx skills` still works — it just means there's no commit to make. Tell the user once: "Heads up, this folder isn't a git repo, so I can't snapshot the install."

## Before authoring: find the owner

A new skill is the last option, not the first, when you are the one deciding where a lesson goes. When a recurring task needs a durable correction or more detail, route it to one owner. If the user explicitly asks for a specific skill or file, that request stands, subject to the ownership rules in this skill.

1. **An existing editable skill already covers the task** → edit that skill in place. Editable means a user-created skill under `.agents/skills/` that is in neither lockfile (see the workflow above), or a skill shipped by a local plugin you author in this agent folder (`packages/<name>/`, via its `skills`/`skillsDirs`) — edit that one in the plugin's source.
2. **The owner is right, but the detail is long** (edge cases, a runbook) → put it in a support file the skill already links (or add one next to `SKILL.md` and link it), and keep a short pointer in `SKILL.md`.
3. **The owner is not editable** → do not edit it. A system `typeclaw-*` skill is fixed with a typeclaw PR. A downloaded skill in a lockfile gets one of the three options from the workflow above (fork under a new name, propose upstream at its `<source>`, or `bunx skills remove` it first). A skill shipped by a published plugin package is proposed to that package. `memory/skills/` belongs to the dreaming subagent and is never hand-edited.
4. **An independent recurring workflow with no fitting owner** → author a new user-created skill (below).

Not every lesson belongs in a skill:

- **`AGENTS.md`**, when present where the session's project-context discovery finds it, is loaded into each such session. Keep it to cross-task conventions and short pointers to the owning skill — not task procedures, which would duplicate the skill and grow every one of those sessions' context.
- **Deterministic requirements** (fixed codes, mappings, thresholds, mandatory items) belong in code or config with a check that exercises the behavior. Prose in a skill is not enforcement.
- **A one-off event or transient failure** (a single timeout, a flaky network call) is not a standing rule. Report it; don't write it down as procedure.

None of this grants edit rights you don't already have: operator-owned files (`package.json` and dependencies, `.env`, secrets) keep their own rules.

## Authoring a user-created skill

When the user says "write me a skill for X", or the owner check above found no existing skill that fits a recurring procedure:

1. **Pick a name that does not collide.** Check both `<typeclaw-package>/src/skills/` (system) and `.agents/skills/` (user). Prefer specific names (`postgres-backups`, not `db`). Do not prefix with `typeclaw-` — that prefix is reserved for system skills shipped by typeclaw.
2. **Create the directory**: `mkdir -p .agents/skills/<name>`.
3. **Write `SKILL.md`** with YAML frontmatter:

   ```markdown
   ---
   name: <name>
   description: One paragraph. Spell out triggers verbatim — phrases the user is likely to type, file types, error messages. The runtime decides whether to surface this skill to you based on the description match. A vague description means the skill never activates.
   ---

   # <name>

   (body — purpose, workflow steps, examples, things-you-must-not-do)
   ```

4. **Match the bundled-skill voice.** Read one of the `typeclaw-*` skills first. Decision-grounded, evidence-pinned, present-tense, "Things you must not do" section near the bottom.
5. **Do not add `version` or `metadata` fields.** They are ignored by the runtime and would only confuse the lockfile heuristic for future you.
6. **Commit** with `typeclaw-git`'s rule: `skills: author <name>` subject, body explains why the procedure deserved to be a skill.
7. The skill takes effect on the **next session** — the resource loader scans on session start, not mid-session. Tell the user: "Authored `<name>`. It loads on the next session — start a fresh prompt to use it."

## Things you must not do

- **Do not edit a skill listed in `skills-lock.json` or `~/.agents/.skill-lock.json`.** It is managed by `bunx skills` and your edit will be silently overwritten by `bunx skills update`. If the user wants to change a downloaded skill, the right answer is one of: fork it locally under a new name, propose the change upstream, or remove it from the lockfile first.
- **Do not edit anything under `<typeclaw-package>/src/skills/`** (system skills). They live inside `node_modules/` (or the dev symlink target) and edits do not survive `bun install`. If a system skill is wrong, escalate to a typeclaw PR.
- **Do not write to `memory/skills/`** manually. That directory is owned by the dreaming subagent (the muscle-memory layer). Hand-authored skills go in `.agents/skills/`. If you need to remove a stale muscle-memory skill, `rm -rf memory/skills/<name>/` is the user's call — surface the request to the user, do not delete on their behalf.
- **Do not run `skills` without `bunx`.** A bare `skills add ...` call relies on a global install that may not be present in the container; `bunx` resolves and caches it on demand without polluting global state.
- **Do not omit `-y` from `bunx skills` calls.** Without it, `@clack/prompts` blocks waiting for TTY input that never arrives, and the call hangs forever.
- **Do not run `bunx skills add/remove/update` without `--agent universal`.** The CLI's auto-detection is unreliable in the container; without the flag the skill may land in a directory typeclaw does not load, and the user sees nothing happen even though the install reported success.
- **Do not run `bunx skills add` without an explicit `--skill <name>`.** Most repos hold many skills. Installing without naming one means installing everything the source happens to contain, polluting `.agents/skills/` with skills the user never asked for. If you don't know which skill to install, list first with `-l`, show the names to the user, and ask. Loop until they pick. Never guess.
- **Do not pass `-g, --global` from inside the container.** Global writes go to the container's `~/.agents/`, which is ephemeral — the user expects skills to land in their bind-mounted agent folder.
- **Do not commit a half-finished install.** If `bunx skills` exited non-zero, the working tree is in an unknown state. Inspect, reset, or surface the error — do not paper over it with a commit.
- **Do not invent a `metadata.version` or other frontmatter to mark "this is mine".** It does not affect runtime behavior, and it actively misleads the lockfile heuristic.
- **Do not use the `typeclaw-` prefix for user-authored skills.** That namespace is for skills shipped inside the typeclaw package. Use a domain-specific name.
- **Do not auto-install a skill `bunx skills find` returned without showing it to the user.** Always read the description and confirm before `bunx skills add`. Skill bodies become part of your context — installing one is granting it a procedural channel into your behavior.

## What this skill does _not_ cover

- **Plugin authoring** (`definePlugin`, contributing tools/subagents/cron jobs, plugin-owned config blocks) — see `typeclaw-plugins`. Plugins are code; skills are markdown.
- **Cron-driven skill installation** — if the user wants `bunx skills update` to run on a schedule, that's an `exec` cron job; see `typeclaw-cron`.
- **Authoring muscle-memory skills directly** — that is the dreaming subagent's job, not yours. The layer is documented under "Memory skills" above so you know where the files come from and that you must not edit them; how dreaming decides what to promote lives in the dreaming subagent's own system prompt (`src/bundled-plugins/memory/dreaming.ts`).
- **The `skills` CLI's own internals** — schema details, alternate install modes, registry implementation. Defer to `bunx skills --help` and the upstream README at https://github.com/vercel-labs/skills.
