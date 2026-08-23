# dsh-turn-fork

Turn-atomic message editing, retry, reroll, and version-tree navigation for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) conversations.

[简体中文](README.zh-CN.md)

- Edit any settled user message and re-run the conversation from that turn
  (`truncate` or `preserve` downstream turns).
- Retry any historical turn; regenerate the latest reply.
- Version tree Timeline with undo/redo navigation across branches.
- Branch logs **survive a dsh process restart** — the P0 durability guarantee
  the community plugin `dsh-message-edit` fails (see below).
- Official slots only: Timeline tab, session-header actions, and per-message
  assistant actions. No DOM injection, no text guessing.
- Bilingual UI (zh / en) through the `dsh-client-locale` service.

## Install

```bash
dsh plugin add dsh-turn-fork
```

Then restart dsh. The plugin registers a **Turn Fork** tab (between Trajectory
and Prompt Studio), compact undo/redo/regenerate buttons in the session
header, and retry/regenerate buttons on each finalized assistant message.

## Why this plugin exists

`dsh-message-edit` (v0.2.3) has a P0 defect: its durable provenance event
`message-edit/version` is written **without** the `ignorable` marker. The live
write path accepts it, but after a dsh restart the persistence layer's
cold-read vocabulary guard (`assertEventsSupported`) rejects the whole log
with `SessionFormatUnsupportedError` — every branch session becomes
unreadable. See `tests/p0-persistence.test.mjs` for a reproduction (live
write OK → restart → cold read REJECTED) and this plugin's regression test
(ignorable marker → restart → cold read PASSES), run against the real
`dsh-session` + `dsh-session-persistence-jsonl` packages in a fresh child
process.

`dsh-turn-fork` also fixes the design gaps the review found in the community
plugin:

| Gap | This plugin |
| --- | --- |
| Custom events must be `ignorable: true` | `turn-fork/version` is always ignorable; schema-versioned for future migration |
| HTTP route without trust fence (CSRF / DNS rebinding, quota burning) | Origin/Host loopback fence + content-type check + 64 KiB body cap |
| Message targeting by DOM text guessing | Official slots only (`conversation.view`, `conversation.session.header.actions`, `conversation.chat.assistant-actions`) |
| `reasoningEffort` / config lost on fork | `provider`/`model`/`maxTokens` derive from the last `request/header`; `reasoningEffort` and `adapterDefaults` ride the inherited header inside the seed |
| Steering messages dropped on replay | Every user input of a turn is preserved and replayed in order |
| Assistant edits forge `source: {kind:'model'}` and drop tool calls | Not supported (honest limitation, see below) |
| Undo navigation leaves branches running silently | Running branches are reported; each has an explicit Stop control |
| `preserve` replays N turns with no confirmation | Cost hint and explicit cascade choice before saving |
| No tests, no i18n | node:test suite + P0 regression + dsh-testkit lifecycle gate; zh/en dictionaries |

## Usage

- **Edit a user message** — open the *Turn Fork* tab, pick a message, correct
  the text, choose the downstream policy and save. A new branch session is
  created from the completed prefix and the corrected turn re-runs.
- **Retry / regenerate** — per-turn buttons in the tab, per-message buttons on
  assistant replies, or the header regenerate button for the latest reply.
- **Version tree** — the tab lists every branch with its operation summary
  (`from "…" to "…"`), marks the current version, and offers Undo/Redo
  navigation plus Open for any branch. Branches with a running agent show a
  warning and a Stop control.
- **Cascade policy** — `truncate` drops everything after the edited turn;
  `preserve` replays the edited turn and every later turn (each replayed input
  becomes its own turn, with inputs of the same original turn kept in order).
  The editor shows how many turns `preserve` will replay before you confirm.

## Design notes

- **Fork semantics.** The official `session.fork(atSeq)` RPC cuts *including*
  the anchored turn, which cannot express "edit turn N and re-run it". This
  plugin therefore uses the same underlying transaction seam the official
  fork uses internally — `ctx.agents.create` — with the seed cut *before* the
  target turn, official lineage meta (`parentSession`, `seedLength`, `cwd`,
  `agentPreset`), the source's preset re-mounted, and durability flushed
  before the branch is announced.
- **Workspace.** The fork inherits the source's workspace attachment exactly
  like the official fork does (re-attach, no filesystem snapshot). Re-running
  a task that rewrites files can therefore leave the working tree at the new
  branch's state. Pair with a checkpointing plugin
  (e.g. `dsh-checkpoint-rewind`) when you need workspace state rewind.
- **Branch deletion / GC.** The platform currently exposes no session-delete
  API, so branches cannot be garbage-collected yet; the version tree is a
  plain disclosure of this lineage.
- **Migration from `dsh-message-edit`.** Logs written by the broken event
  format are refused by the persistence layer itself, so no reader — this
  plugin included — can repair them in place. The Timeline detects the
  refusal and reports it explicitly. To recover old transcripts, use the
  official export flow before upgrading, or wait for the upstream fix.

## HTTP trust fence

The host route `/turn-fork` is served by the dsh web server, which performs no
origin checks of its own. Every request must pass the plugin's fence: a
browser `Origin` must be `http(s)://localhost|127.0.0.1|[::1]` with the
server's exact port (relaxed only when the server listens on `0.0.0.0`, the
operator's explicit remote-exposure opt-in); requests without an `Origin`
must carry a loopback `Host`. POST bodies must be `application/json` and at
most 64 KiB.

## Development

```bash
npm install
npm run build      # tsc typecheck + tsdown host/client bundles
npm test           # build + node:test (core, lineage, P0 persistence regression)
```

Version 0.1.2 is developed and release-tested against DSH `0.1.1-rc.2`. Slot contributions wait for their rc.2 declarations through `slots.inject()`, while `dsh-client-runtime/client` uses rc.2's implicit preloaded client baseline rather than a redundant package-specific external.

### Tests

- `tests/p0-persistence.test.mjs` — the P0 regression: the plugin's real fork
  seed is written through a real `dsh-session` store and
  `dsh-session-persistence-jsonl` backend, flushed to disk, then cold-read in
  a fresh child process ("restart"). A negative control proves the guard
  rejects the same log with the marker stripped.
- `tests/core.test.mjs` — steering fidelity, plan boundaries, seed
  construction, model-config derivation, trust-fence matrix, body cap,
  operation decoding.
- `tests/lineage.test.mjs` — version projection, undo/redo stacks, running
  flags.
- `tests/rc2-lifecycle.test.mjs` and `tests/rc2-package-contract.test.mjs` —
  optional Web lifecycle injection plus exact rc.2 manifest/lock closure.
- `dsh-testkit.yaml` — real-host lifecycle gate (install → boot → register →
  uninstall → reboot → residue) via the community
  [dsh-testkit](https://github.com/iiwish/dsh-testkit), plus the generated
  `.github/workflows/dsh-lifecycle.yml` CI workflow, both pinned to rc.2.

### Testkit notes

The published dsh-testkit package currently declares a prerelease range that
does not semver-admit `0.1.1-rc.2`, so it is deliberately not part of this
candidate's npm development lock. The checked-in quick-suite contract and CI
action remain pinned to rc.2; local package checks use the direct lifecycle,
real JSONL persistence, and exact package-lock tests above without resolving a
mixed rc.8 graph.

## License

MIT. The client bundle preset under `scripts/dsh-client-preset.ts` is vendored
from the DeepSeek Harness repository (MIT, © DeepSeek).
