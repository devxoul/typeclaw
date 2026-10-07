---
name: typeclaw-memory
description: Use this skill whenever the user asks what you remember, what you forgot, what you dreamed, why a fact is or isn't in your memory, when memory consolidation happens, or whenever you are about to read or write `MEMORY.md`, anything under `memory/`, or `memory/skills/`. Triggers include "what do you remember", "do you remember X", "forget that", "what did you dream", "when do you dream next", "why did you forget X", "edit MEMORY.md", "add to memory", "your daily streams", "memory-logger", "dreaming", "muscle memory", or any mention of `memory.idleMs` / `memory.bufferBytes` / `memory.dreaming.schedule` in `typeclaw.json`. Read it before you touch any memory file — `MEMORY.md` and `memory/yyyy-MM-dd.jsonl` are runtime-owned, hand-edits are easy to do wrong, and the user almost always means something more specific than "edit memory" when they say it.
---

# typeclaw-memory

The agent's long-term memory is sharded across files in `memory/topics/<slug>.md`. Each shard is one topic with YAML frontmatter (`heading`, `cites`, `days`, `lastReinforced`, optional `tags`) + body markdown. The dreaming subagent writes shard bodies and the runtime computes the frontmatter; neither is yours to author.

## Reading

The `# Memory` block is injected per turn into the user prompt; the system prompt never contains long-term memory; vector memory is always on. Undreamed daily-stream events are **not** dumped wholesale into prompts — use `memory_search` when you need them. When speaking in a channel, shard bodies are dropped and only headings/slugs show; call `memory_search` to fetch the bodies you need. The same `memory_search` covers both surfaces (topic shards and undreamed stream events), so one tool call reaches everything.

Under budget you get shard bodies de-duplicated across turns; over budget you get the top-K shards/fragments/references most relevant to the current message (hybrid vector + keyword search). This keeps the system-prompt cache prefix stable across a session and lets retrieval track the current topic instead of a stale session-start snapshot. `memory_search` remains available on demand.

## Writing

You don't author shards directly. The dreaming subagent (runs on a cron schedule, default every 30 minutes) reads undreamed fragments from `memory/streams/<date>.jsonl` and rebalances the shards. Do not edit `memory/topics/`, `memory/skills/`, or the stream files yourself — the dreaming subagent and runtime own them. To capture something memorable, surface it in your reply and let the memory-logger append it to `memory/streams/`.

`memory/skills/<name>/SKILL.md` is muscle memory the dreaming subagent distills from recurring procedures; the runtime auto-loads those as first-class skills on next boot. A durable task procedure you want to keep goes to its existing editable owner skill (or a support file that skill links) first — see `typeclaw-skills` for who owns which skill — not into `memory/skills/` or `AGENTS.md`.

## Citations

Citations in shard bodies use the canonical form `streams/yyyy-MM-dd#<fragment-id>`. Legacy `memory/yyyy-MM-dd#<fragment-id>` is still parsed during the migration window. Every citation you emit MUST resolve to a fragment in the corresponding daily stream — the citation-superset check reverts your run if any pre-existing citation goes missing.

## `memory_search` tool

When index-mode injection hides bodies, or when you need recent fragments the dreaming subagent hasn't consolidated yet, use `memory_search({query, asRegex?, full?, maxResults?, workspace?, chat?, thread?})`. It searches topic shards, active cited-child provenance, and undreamed stream events. Substring (case-insensitive) by default; `asRegex: true` for regex. The legacy `where` argument is an alias for `chat`.

Use `memory_search({topic: "<slug>", workspace?, chat?, thread?})` for an exact shard lookup. Scope applies here too: the shard is returned only when an active cited child matches every supplied coordinate. Scoped lookup does not return references because references have no origin children.

Workspace/chat/thread IDs and captured names are searchable lexical metadata and appear in result provenance, but they are never embedded. Recall is globally visible by default across roles and origins. Optional `workspace`, `chat`, and `thread` arguments narrow query and exact-topic results to matching coordinates; names and aliases participate in lexical matching only. A mixed-scope shard remains eligible when any active child matches an explicit scope, and returned provenance contains only matching children. Automatic hybrid retrieval and channel heading injection remain global.

Historical Discord names and parent-room metadata live only in a bounded runtime registry rebuilt by adapter-start maintenance. There is no provenance sidecar to edit. Do not rewrite stream JSONL. Resolver failure intentionally falls back to raw IDs, and `memory_search` never performs network calls.

Plain queries are **phrase-first with a word fallback**: the whole query is tried as one substring, and only if that finds nothing is the query split on whitespace and the distinct words OR-matched (ranked by how many words each hit contains). So a descriptive multi-word query like `quarterly regional revenue summary` still returns results even when no entry contains that exact phrase. You don't need to pre-split queries into single keywords — but a focused phrase still wins when an entry contains it verbatim. Regex queries never fall back (whitespace stays part of the pattern).

Results are discriminated by `source`:

- `source: "topic"` — fields `shardPath`, `slug`, `heading`, `excerpt`, `fullBody?`, `provenance`
- `source: "stream"` — fields `streamPath`, `date`, `eventId?` (citation-format `streams/yyyy-MM-dd#<id>` for fragments; absent for legacy prose), `topic`, `excerpt`, `fullBody?`, and optional `who`/`when`/`where`

Ordering depends on mode. Exact-phrase (and regex) results list all topic matches first (alphabetical by slug), then stream matches (newest day first), and `maxResults` truncates streams before topics. Word-fallback results are instead ranked by matched-word count — that same topic-first/stream-newest order is only the tiebreak within a score band, so a higher-scoring stream can precede a lower-scoring topic, and `maxResults` drops the lowest-scored tail regardless of source. `full: true` returns the entire shard or fragment body.

## Per-shard truncation

Individual shards are capped at 12 KB on injection (defense against a runaway shard blowing the budget). Keep topic bodies focused and short.
