// dsh-vcc: session-backed message source — the DSH replacement for pi-vcc's
// load-messages / global-indices / lineage modules.
//
// pi-vcc indexes "message entries" in session-file order; DSH sessions number
// their events by seq and can project any event to a durable message via
// `session.deriveEventMessage`. The global index used by vcc_recall (and by
// the (#N) refs the compaction summary emits) is therefore the EVENT SEQ:
// stable across compaction, guaranteed to point at the same message, and
// shared between the engine and the recall tool.
//
//   scope 'lineage' (default) → surface events only (the live conversation
//   path, equivalent to pi's active lineage);
//   scope 'all'               → every event in the log, including shadowed
//   branches replaced by compaction or retries.

import { renderMessage } from '../src/core/render-entries.js'
import { toPiMessage } from './dsh-adapter.js'

export const SURFACE_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/result',
  'system/message',
  'developer/message',
])

/** Events of the live surface in surface order. */
export function surfaceEvents(session) {
  const events = []
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return events
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (event) events.push(event)
  }
  return events
}

/** Raw log events in seq order (surface and shadowed), from a snapshot. */
export function snapshotEvents(session) {
  return typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
}

/**
 * Collect the messages of a scope as pi-shape raw messages plus rendered
 * entries, in index order.
 *
 * @param opts.full - render entries with full content (no clipping), used by
 *   the expand path so #N returns untruncated content like pi's
 *   loadAllMessages(sessionFile, true).
 * @returns {{ rawMessages: any[], rendered: RenderedEntry[], byIndex: Map<number, any> }}
 *   `rawMessages[i]` is the pi-shape message whose global index is
 *   `indices[i]`; `rendered` mirrors `renderMessage`; `byIndex` maps the
 *   global index (the event seq) to the pi-shape message.
 */
export function collectMessages(session, scope = 'lineage', opts = {}) {
  const events = scope === 'all' ? snapshotEvents(session) : surfaceEvents(session)
  const toolNames = new Map()
  const rawMessages = []
  const indices = []
  const rendered = []
  const byIndex = new Map()

  for (const event of events) {
    if (!event || !SURFACE_EVENT_TYPES.has(event.type)) continue
    let msg
    try {
      msg = session.deriveEventMessage(event)
    } catch {
      msg = undefined
    }
    if (!msg) continue
    const pi = toPiMessage(msg, toolNames, { includeReasoning: true })
    if (!pi) continue
    const seq = Number(event.seq)
    if (!Number.isInteger(seq)) continue
    rawMessages.push(pi)
    indices.push(seq)
    byIndex.set(seq, pi)
    rendered.push(renderMessage(pi, seq, Boolean(opts.full)))
  }

  return { rawMessages, indices, rendered, byIndex }
}

/**
 * Messages restricted to an allowed index set (used to enforce lineage scope
 * on expand requests, mirroring pi's loadAllMessages(sessionFile, false,
 * lineageEntryIds)).
 */
export function collectMessagesIn(session, scope, allowedIndices, opts) {
  const all = collectMessages(session, scope, opts)
  const allow = allowedIndices && allowedIndices.size > 0 ? allowedIndices : null
  if (!allow) return all
  return {
    rawMessages: all.rawMessages.filter((_, i) => allow.has(all.indices[i])),
    indices: all.indices.filter((i) => allow.has(i)),
    rendered: all.rendered.filter((e) => allow.has(e.index)),
    byIndex: new Map([...all.byIndex].filter(([i]) => allow.has(i))),
  }
}
