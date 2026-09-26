// dsh-vcc: deterministic, no-LLM conversation compaction for DeepSeek Harness.
//
// This file mounts one service row into the preset's `compaction` group:
// DshVccCompactionEngine extends the BasicCompactionEngine and overrides
// `summarize()` — the subclass hook the basic backend reserves — with the
// deterministic VCC compile pipeline ported from pi-vcc (MIT; see README for
// attribution). All replay/durable-mutation machinery, thresholds, and
// shrink-gate checks stay untouched. The same row also registers the
// vcc_recall tool and the /vcc commands, so one installed bundle provides
// compaction + recall together.

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import z from '@deepseek-ai/schemastery'
import { compileRanked } from './src/core/summarize.js'
import { toPiMessage } from './lib/dsh-adapter.js'
import { alignSourceIndices, previousSummaryText, isCompileArtifactMessage } from './lib/engine-util.js'
import { registerRecallTool } from './lib/recall-tool.js'
import { registerVccCommands } from './lib/commands.js'

const PROVIDER = 'dsh-vcc'
const MODEL = 'deterministic'

/** Keys the basic backend's resolveConfig understands (strict whitelist). */
const ENGINE_CONFIG_KEYS = new Set([
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'auto',
])

const modelPolicy = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: z.number(),
  headroomTokens: z.number().step(1).min(0),
  retainRatio: z.number(),
  retainTokens: z.number().step(1).min(0),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: z.number().step(1).min(1),
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
})

/**
 * Deterministic VCC compaction engine.
 *
 * `summarize(input, agent, signal)` receives the exact contiguous surface run
 * the basic backend selected for compaction (buildSummarizationInput). The
 * summary is produced purely algorithmically — no LLM, no network — while the
 * (maxTokens) shrink gate, retry backoff, and region selection that
 * BasicCompactionEngine already performs are preserved as-is.
 */
export default class DshVccCompactionEngine extends BasicCompactionEngine {
  static inject = [...BasicCompactionEngine.inject, 'tools', 'commands']

  static Config = z.object({
    thresholdRatio: z.number(),
    headroomTokens: z.number().step(1).min(0),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
    // vcc-specific knobs are validated here but never passed to the basic
    // backend (its resolveConfig rejects unknown keys).
    vcc: z.object({}),
  })

  constructor(ctx, config = {}) {
    // Whittle the config down to the keys the basic backend understands.
    const engineConfig = {}
    for (const key of ENGINE_CONFIG_KEYS) {
      if (config[key] !== undefined) engineConfig[key] = config[key]
    }
    super(ctx, engineConfig)
    this.vccConfig = config.vcc ?? {}

    if (ctx.tools) {
      ctx.effect(() => registerRecallTool(ctx), 'dsh-vcc recall tool')
    }
    if (ctx.commands) {
      ctx.effect(() => registerVccCommands(ctx), 'dsh-vcc commands')
    }
  }

  /** The subclass customization hook of BasicCompactionEngine. */
  async summarize(input, agent, signal) {
    signal?.throwIfAborted?.()
    const session = agent?.session
    if (!session) {
      throw new Error('dsh-vcc: no session available for compaction')
    }

    // Align each input message to its surface event seq so the summary's
    // (#N) refs point at vcc_recall's global indices. Unaligned messages
    // (rare projection rewrites) simply lose their ref.
    const sourceIndices = alignSourceIndices(session, input.messages)

    // Previous summary comes from the last compaction/summary event; the
    // frame is stripped here so the ported merge sees bare VCC text. Foreign
    // (LLM-era) summaries are discarded by previousSummaryText.
    const previousSummary = previousSummaryText(session)

    const pairs = []
    for (let i = 0; i < input.messages.length; i++) {
      // Skip prior-checkpoint frames and runtime-context snapshots: they are
      // compaction artifacts, not conversation. The prior checkpoint merges
      // structurally via previousSummary (above); re-compiling its raw frame
      // only pollutes the extractors (e.g. the goal extractor reads the first
      // user block) and re-embeds tags into the new brief.
      if (isCompileArtifactMessage(input.messages[i])) continue
      const pi = toPiMessage(input.messages[i], new Map(), { includeReasoning: false })
      if (pi) pairs.push({ pi, seq: sourceIndices[i] })
    }

    const text = compileRanked({
      messages: pairs.map((p) => p.pi),
      sourceIndices: pairs.map((p) => p.seq),
      previousSummary,
    })
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('dsh-vcc: deterministic compilation produced no summary content')
    }

    // Deterministic result shape: rawOutput mirrors the summary (no stream).
    const summary = [{ type: 'text', text }]
    return {
      summary,
      rawOutput: summary,
      provider: PROVIDER,
      model: MODEL,
      maxTokens: text.length, // informational; the shrink gate re-checks anyway
    }
  }

  /** @internal exposed for /vcc preview: compile the whole live surface. */
  compileSurface(session) {
    const messages = []
    const nodes = session?.surface?.nodes ?? []
    for (const seq of nodes) {
      const event = session.eventAt(seq)
      if (!event) continue
      const msg = session.deriveEventMessage(event)
      if (msg) messages.push(msg)
    }
    const sourceIndices = alignSourceIndices(session, messages)
    const pairs = []
    for (let i = 0; i < messages.length; i++) {
      // Same artifact filter as summarize(): keep checkpoint/context frames
      // out of the /vcc preview compile too.
      if (isCompileArtifactMessage(messages[i])) continue
      const pi = toPiMessage(messages[i], new Map(), { includeReasoning: false })
      if (pi) pairs.push({ pi, seq: sourceIndices[i] })
    }
    return compileRanked({
      messages: pairs.map((p) => p.pi),
      sourceIndices: pairs.map((p) => p.seq),
      previousSummary: previousSummaryText(session),
    })
  }
}
