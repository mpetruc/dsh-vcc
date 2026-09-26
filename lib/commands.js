// dsh-vcc: /vcc and /vcc-recall human commands.
//
// /vcc            — preview the deterministic summary the engine would write
//                   for the current session (no mutation, no compaction run).
// /vcc-recall …   — the vcc_recall tool as a command (same algorithm).

import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { parseRecallScope } from '../src/core/recall-scope.js'
import { runRecall } from './recall-tool.js'

const VCC_PREVIEW_MAX = 30_000

/**
 * Register /vcc and /vcc-recall on every human-command adapter.
 * @param ctx - context carrying the command registry.
 */
export function registerVccCommands(ctx) {
  ctx.commands.register({
    definitionId: CommandDefinitionId('@local/dsh-vcc/command-vcc'),
    name: 'vcc',
    description: 'Preview the deterministic VCC compaction summary for the current session',
    async handler(invocation) {
      const session = invocation.agent?.session
      if (!session) {
        return { kind: 'error', text: 'No session available.' }
      }
      if (invocation.rawInput.trim().length > 0) {
        return {
          kind: 'error',
          text: 'Usage: /vcc (no arguments) — previews the summary the next compaction would write.',
        }
      }
      // ctx is the engine's own context (the compaction provider of the
      // preset's isolated group), resolved lazily at dispatch time.
      const engine = ctx.compaction
      if (!engine || typeof engine.compileSurface !== 'function') {
        return {
          kind: 'error',
          text: 'No dsh-vcc compaction engine active in this session (only that engine exposes /vcc).',
        }
      }
      const text = engine.compileSurface(session)
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { kind: 'success', text: 'Nothing compactable in this session yet.' }
      }
      const clipped = text.length > VCC_PREVIEW_MAX
        ? `${text.slice(0, VCC_PREVIEW_MAX)}\n… (preview clipped at ${VCC_PREVIEW_MAX} chars)`
        : text
      return { kind: 'success', text: clipped }
    },
  })

  ctx.commands.register({
    definitionId: CommandDefinitionId('@local/dsh-vcc/command-vcc-recall'),
    name: 'vcc-recall',
    description: 'Recall earlier parts of this session (the vcc_recall tool as a command)',
    async handler(invocation) {
      const session = invocation.agent?.session
      if (!session) {
        return { kind: 'error', text: 'No session available.' }
      }
      // Same param contract as the tool: query keywords + optional tokens.
      const { scope, text } = parseRecallScope(invocation.rawInput ?? '')
      const mode = /(^|\s)touched(\s|$)/i.test(text)
        ? 'touched'
        : 'hybrid'
      const query = text.replace(/\btouched\b/gi, '').replace(/\s+/g, ' ').trim()
      try {
        const output = runRecall(session, {
          scope,
          mode,
          query: query || undefined,
          page: 1,
          expand: undefined,
        })
        return { kind: 'success', text: output }
      } catch (error) {
        return { kind: 'error', text: `vcc-recall failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
}
