# dsh-vcc

Deterministic, **no-LLM** conversation compaction for DeepSeek Harness, with
lossless recall — adapted from [pi-vcc](https://github.com/…/pi-vcc)'s
view-oriented compiler approach.

When a session grows past its window, instead of paying an LLM to compress the
history, dsh-vcc *compiles* the conversation into a structured, stable
summary:

- **[Session Goal]** / **[Files And Changes]** / **[Commits]** /
  **[Outstanding Context]** / **[User Preferences]** header sections, merged
  across compactions (dedup, cross-compaction file merge, volatile sections
  rebuilt fresh);
- a ranked brief transcript (`---` separated) whose messages keep lossless
  `(#N)` references into the session log.

`(#N)` is the event **seq** — the same index `vcc_recall` searches — so
anything compaction drops stays one deterministic call away:

```
vcc_recall(query: "redis cache decision")     → ranked, paged hits (#N)
vcc_recall(expand: [42])                       → full untruncated content
vcc_recall(query: "#42:auth.ts")               → drill into a file from an entry
vcc_recall(query: "#42:auth.ts:full")          → all lines of that file content
vcc_recall(mode: "touched")                    → files worked on, with entry indices
vcc_recall(scope: "all")                       → also reach edited/retried branches
```

Also ships `/vcc` (preview the summary the next compaction would write, with no
mutation) and `/vcc-recall` (the tool as a human command).

## Layout

| Path | Role |
| --- | --- |
| `index.js` | `DshVccCompactionEngine` (default export) — extends the basic backend, overrides its `summarize` hook with the deterministic pipeline; registers the recall tool and commands. |
| `lib/dsh-adapter.js` | DSH message → pi message shape (tool-call id→name correlation, reasoning policy). |
| `lib/session-source.js` | Session events → message streams (`lineage` = live surface, `all` = full log). |
| `lib/engine-util.js` | seq alignment for `(#N)` refs; previous-summary extraction. |
| `lib/drill-down-dsh.js` | `#N:path` drill-down, re-rooted on session events. |
| `lib/recall-tool.js` | `vcc_recall` tool + shared recall algorithm. |
| `lib/commands.js` | `/vcc` and `/vcc-recall` human commands. |
| `src/` | The pi-vcc core pipeline compiled to ESM (MIT, see NOTICE): normalize, filter-noise, sections, rank, build-sections, summarize, search-entries, render-entries, format-recall, recall-scope, extract/\*. |
| `cordis.patch.yml` | Enables the engine inside the preset's `compaction` group and disables the preset's stock LLM backend. |
| `node_modules/@deepseek-ai/*` | Symlink farm to the harness checkout packages the bundle imports at module-eval time (see below). |

## How it works

- The bundle mounts one service row (`dsh-vcc`) into the **cordis agent
  preset's** `compaction` group and disables the preset's stock
  `compaction-basic` row in the same group. Preset sessions then resolve
  `ctx.compaction` to `DshVccCompactionEngine` — a subclass of the basic
  backend that keeps all of its machinery (threshold/overflow auto triggers,
  region selection, `(maxTokens)` shrink gate, retry backoff, durable session
  mutation, `compaction/summary` events) and replaces only the `summarize`
  hook with `compileRanked` from the ported pi-vcc core.
- Alignment: `buildSummarizationInput` hands the engine the exact messages it
  plans to shadow; messages are the durable surface objects, so an identity
  map (`Map<Message, seq>` built from `session.surface.nodes`) recovers each
  message's event seq, fail-closed. The summary's `(#N)` refs and
  `vcc_recall`'s indices are the same seqs — self-consistent by construction.
- The compiled result is returned as `{ summary, rawOutput, provider:
  'dsh-vcc', model: 'deterministic' }` with no `llmStreamCall` — the non-LLM
  branch of the backend's `SummaryResult`. An empty compile throws, so the
  backend treats it like a summarizer that produced nothing (retry/error
  path).

## Install & verify

```text
plugin_manager  →  install_bundle  →  target: /home/user1/dsh-compaction/dsh-vcc
```

- `install_bundle` records `@local/dsh-vcc: link:<this dir>` in the profile's
  `package.json` and applies `cordis.patch.yml`; **no restart is needed on
  first install**.
- Confirm: `cordis_inspect_query` (Host Config / Tool / Service), then run
  `/vcc` in a cordis-preset session to see the live deterministic preview, and
  `/compact` to compact. `vcc_recall` then answers questions about the
  shadowed history.
- Replacing an already-installed version of the same package still needs a
  profile restart to load the new module generation.

## Known scope (v1)

- Activates for the **cordis** preset only (the patch targets the
  last-occurring rows in the composed profile). `standard` / `ptc` / `minimal`
  presets keep their stock compaction backend.
- Deterministic by design: no LLM calls, no network, no nondeterminism —
  identical input always produces identical output.
- Only the current session is searchable; earlier sessions are not.

## Attribution

dsh-vcc is a port of **pi-vcc** (MIT) — itself derived from **pi-blackhole**
(by k0valik, MIT) and **invisible-continue** (by monotykamary, MIT). The
compiled core under `src/` is the pi-vcc pipeline (normalize, filter-noise,
build-sections, rank, summarize, extract/*, search/render/format-recall,
recall-scope) with only its load-messages/JSONL layer replaced by
`lib/session-source.js` and its drill-down re-rooted on session events. See
`NOTICE` for the full license texts.
