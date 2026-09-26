// dsh-vcc: vcc_recall tool — deterministic recall over the current DSH
// session, mirroring pi-vcc's tools/recall.ts execute flow, re-rooted on
// session events (snapshotEvents / surface) instead of pi's JSONL layer.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { searchEntriesDetailed, getTouchedFiles } from '../src/core/search-entries.js'
import { formatRecallOutput, formatTouchedOutput } from '../src/core/format-recall.js'
import { normalizeRecallScope, normalizeRecallMode } from '../src/core/recall-scope.js'
import { parseDrillDown, expandEntry } from './drill-down-dsh.js'
import { collectMessages, collectMessagesIn } from './session-source.js'
import { surfaceEvents } from './session-source.js'

const DEFAULT_RECENT = 25
const PAGE_SIZE = 5

/** Indices available on the active lineage (surface seqs). */
function lineageIndices(session) {
  const set = new Set()
  for (const event of surfaceEvents(session)) {
    if (event && Number.isInteger(event.seq)) set.add(event.seq)
  }
  return set
}

export const invalidExpandIndices = (requested, available) =>
  requested.filter((i) => !Number.isInteger(i) || !available.has(i))

/**
 * The recall algorithm shared by the vcc_recall tool and the /vcc-recall
 * command. Pure function of the session + params; returns the text output.
 * Throws when params are unusable (mirrors pi's tool contract).
 */
export function runRecall(session, args) {
  const scope = normalizeRecallScope(args.scope)
  // scope lineage → the live surface; scope all → the full log.
  const allowed = scope === 'lineage' ? lineageIndices(session) : null

  // Drill-down: #N:path resolves to file-scoped tool content.
  const q = typeof args.query === 'string' ? args.query.trim() : ''
  if (q && parseDrillDown(q)) {
    const parsed = parseDrillDown(q)
    if (allowed) {
      const { indices } = collectMessagesIn(session, scope, allowed)
      if (!indices.includes(parsed.index)) {
        return `Cannot expand indices outside active lineage: ${parsed.index}. Use scope:'all' to reach other branches.`
      }
    }
    const { byIndex } = collectMessages(session, scope)
    return expandEntry(
      byIndex,
      parsed.index,
      parsed.pathPattern,
      parsed.full,
      parsed.offset,
      parsed.limit,
    )
  }

  // touched mode: aggregate file operations across the live window.
  if (normalizeRecallMode(args.mode) === 'touched') {
    const { rawMessages, rendered } = collectMessagesIn(session, scope, allowed)
    const touched = getTouchedFiles(rawMessages, rendered)
    return formatTouchedOutput(touched, args.page)
  }

  const expandSet = new Set(
    Array.isArray(args.expand) ? args.expand.map((n) => Number(n)) : [],
  )
  const hasExpand = expandSet.size > 0

  if (hasExpand) {
    const { indices, rendered: fullRendered } = collectMessages(session, scope, {
      full: true,
    })
    const requested = [...expandSet]
    const available = new Set(indices)
    const invalid = invalidExpandIndices(requested, available)
    if (invalid.length > 0) {
      return `Cannot expand indices outside ${scope === 'all' ? 'session history' : 'active lineage'}: ${invalid.join(', ')}`
    }
    const byRendered = new Map(fullRendered.map((r) => [r.index, r]))
    const full = requested
      .map((i) => byRendered.get(i))
      .filter(Boolean)
    const output =
      (scope === 'all' ? 'Scope: all\n\n' : '') + formatRecallOutput(full, undefined)
    return output
  }

  const { rawMessages, rendered } = collectMessagesIn(session, scope, allowed)

  if (q) {
    const { hits, totalBeforeCap, truncated } = searchEntriesDetailed(
      rendered,
      rawMessages,
      q,
    )
    const page = Math.max(1, Number(args.page) || 1)
    const totalPages = Math.ceil(hits.length / PAGE_SIZE)
    const scopeSuffix = scope === 'all' ? ' (scope: all)' : ''
    const truncationNote = truncated
      ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results`
      : ''

    if (hits.length > 0 && page > totalPages) {
      const guidance = truncated
        ? `Use a page between 1 and ${totalPages}.`
        : `Use a page between 1 and ${totalPages}, or refine your query.`
      return (
        `Page ${page} is outside the available range 1-${totalPages} ` +
        `(${hits.length} matches${scopeSuffix}${truncationNote}). ${guidance}`
      )
    }

    const start = (page - 1) * PAGE_SIZE
    const pageResults = hits.slice(start, start + PAGE_SIZE)
    const header = totalPages > 1
      ? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})`
      : `${hits.length} matches${scopeSuffix}${truncationNote}`
    const footer = page < totalPages
      ? `\n--- Use page:${page + 1}${scope === 'all' ? " with scope:'all'" : ''} for more results ---`
      : ''
    return formatRecallOutput(pageResults, q, header) + footer
  }

  return (scope === 'all' ? 'Scope: all\n\n' : '') +
    formatRecallOutput(rendered.slice(-DEFAULT_RECENT), undefined)
}

/**
 * Register the vcc_recall tool. `exec.agent.session` is the calling session
 * (workspace-access semantics: the tool only runs with an agent context).
 */
export function registerRecallTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'vcc_recall',
    description:
      'Recall earlier parts of the current session — decisions made, files touched, commands run, ' +
      'including anything dropped by compaction and the reasoning that preceded the visible text. ' +
      'Reach for this before telling the user you no longer have the context. Plain keywords work ' +
      'best; a regex pattern is also accepted. Results are paged (page); pass expand with entry ' +
      'indices to read full untruncated content. Use mode:\'touched\' to list files worked on in ' +
      'this session with their entry indices, and #N:path to drill into a file\'s content from an ' +
      'entry (#N:path:full for all lines). Note: apply_patch paths (inside the diff payload) and ' +
      'bash redirects do not appear in the touched index. Only the current session is searchable — ' +
      'earlier sessions are not. Entry indices (#N) are event seqs, the same numbers the ' +
      'compaction summary uses in its (#N) references.',
    // dsh-tools' defineTool takes a per-property author-schema map (each
    // property is a value-schema object), not a wrapped JSON-Schema object.
    parameters: {
      query: {
        type: 'string',
        description:
          "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. A query of the form #N:path (e.g. #42:auth.ts) drills into a file's content from that entry.",
      },
      expand: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Entry indices to return full untruncated content for',
      },
      page: {
        type: 'integer',
        description: 'Page number (1-based) for paginated search results. Default: 1.',
      },
      scope: {
        type: 'string',
        enum: ['lineage', 'all'],
        description:
          "Default 'lineage' covers the live conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried.",
      },
      mode: {
        type: 'string',
        enum: ['hybrid', 'touched'],
        description:
          'What to show. hybrid (default) = normal search; touched = aggregated files-by-path with entry indices.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: true,
    async execute(args, exec) {
      const session = exec.agent?.session
      if (!session) {
        throw new Error(
          'vcc_recall: no agent session available; this tool only works inside an agent conversation.',
        )
      }
      return runRecall(session, args ?? {})
    },
  }))
}
