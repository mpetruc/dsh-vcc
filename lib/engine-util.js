// dsh-vcc: engine-side utilities —
//   * message→seq alignment for (#N) refs,
//   * retrieval + de-framing of the previous compaction summary.
//
// Alignment is free in DSH: `session.deriveEventMessage` returns the durable
// stored message object, so an identity map keyed by the message reference
// aligns any projectable message to the event seq that produced it. When a
// message cannot be aligned (projection rewrite created a fresh object), the
// ref is dropped (fail-closed): the summary stays correct, only the (#N)
// link for that one message is omitted.

// (no shared imports needed)

/** Map surface message objects to their event seqs.
 * @returns Map<Message, Seq> built by walking session.surface.nodes.
 */
export function buildSurfaceSeqMap(session) {
  const byMessage = new Map()
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return byMessage
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!event) continue
    let msg
    try {
      msg = session.deriveEventMessage(event)
    } catch {
      msg = undefined
    }
    if (msg && typeof msg === 'object' && !byMessage.has(msg)) {
      byMessage.set(msg, seq)
    }
  }
  return byMessage
}

/**
 * Align a list of projectable messages to surface seqs.
 * @returns (number | undefined)[] parallel to messages.
 */
export function alignSourceIndices(session, messages) {
  const byMessage = buildSurfaceSeqMap(session)
  return messages.map((msg) => (msg && byMessage.has(msg) ? byMessage.get(msg) : undefined))
}

const SUMMARY_TAG_OPEN = '<compacted-summary>'
const SUMMARY_TAG_CLOSE = '</compacted-summary>'

/**
 * DSH checkpoint artifacts that must not be re-compiled as conversation.
 *
 * A compaction lands as a REPLACEMENT user message in the surface: the
 * preamble + <compacted-summary> block that summarizer.ts frames. That
 * message is the previous checkpoint, not content to summarize again — left
 * in, its raw text (tags included) pollutes every extractor (the goal
 * extractor treats the first user block as goals) and the brief re-embeds
 * the frame. Prior-checkpoint content enters the NEW summary structurally
 * via previousSummaryText() instead.
 *
 * The harness also injects 'Current runtime context...' snapshots as user
 * messages; each supersedes the previous one, so they are environment
 * boilerplate, not conversation.
 */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation'
export const RUNTIME_CONTEXT_PREFIX =
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'

function messageText(msg) {
  if (!msg || typeof msg !== 'object') return ''
  const parts = []
  for (const block of Array.isArray(msg.content) ? msg.content : []) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** A previous-checkpoint frame (preamble and/or <compacted-summary> block). */
export function isCheckpointMessage(msg) {
  const text = messageText(msg)
  return text.includes(SUMMARY_TAG_OPEN) || text.startsWith(CHECKPOINT_PREAMBLE)
}

/** A harness-injected 'Current runtime context...' snapshot. */
export function isRuntimeContextMessage(msg) {
  return messageText(msg).startsWith(RUNTIME_CONTEXT_PREFIX)
}

/** Anything the compile path must skip: prior checkpoints + runtime context. */
export function isCompileArtifactMessage(msg) {
  return isCheckpointMessage(msg) || isRuntimeContextMessage(msg)
}

/**
 * Extract the previous compaction summary so the ported merge logic sees the
 * same plain VCC text pi-vcc persisted as `prev`.
 *
 * Storage is tolerated in both shapes seen in real sessions:
 *   - bare text (the summary blocks themselves), and
 *   - framed text with <compacted-summary> tags (no preamble).
 * The frame, when present, is stripped here.
 *
 * Classification:
 *   - already-VCC text (own `[Session Goal]`/`…`/brief separator) — pass through,
 *   - foreign structured summaries (earlier produced by the LLM backend, with
 *     `## ` sections) — ADOPTED by reframing their sections onto the VCC headers
 *     (see reframeForeignSummary); discarding them would erase every section
 *     when the fresh surface is already compacted (no user messages left),
 *   - unstructured prose with no `## ` structure — discarded (nothing to map;
 *     it cannot even be recall-searched, so keeping it would only pollute the
 *     deterministic output).
 */
export function previousSummaryText(session) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  let data
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event && event.type === 'compaction/summary' && event.data?.summary) {
      data = event.data
      break
    }
  }
  if (!data) return undefined

  const blocks = Array.isArray(data.summary) ? data.summary : []
  const framed = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
  if (!framed) return undefined

  let inner
  const open = framed.indexOf(SUMMARY_TAG_OPEN)
  const close = framed.indexOf(SUMMARY_TAG_CLOSE)
  if (open >= 0 && close > open) {
    inner = framed.slice(open + SUMMARY_TAG_OPEN.length, close)
  } else if (open >= 0) {
    inner = framed.slice(open + SUMMARY_TAG_OPEN.length)
  } else if (close >= 0) {
    inner = framed.slice(0, close)
  } else {
    // No tags: bare storage (seen on real sessions) — use the whole text.
    inner = framed
  }

  const trimmed = inner.trim()
  if (!trimmed) return undefined
  const looksVcc = /\[Session Goal\]/.test(trimmed) || /\[Outstanding Context\]/.test(trimmed) || /\[Files And Changes\]/.test(trimmed) || /\n\n---\n\n/.test(trimmed)
  if (looksVcc) return trimmed
  return reframeForeignSummary(trimmed)
}

/**
 * Map a foreign (LLM-era) `## Section` summary onto the deterministic VCC
 * section headers, adopting the parts that describe the session's present and
 * ongoing state. Sections that are history (Errors and Fixes, Files and Code)
 * are deliberately not adopted: they are fully recoverable via vcc_recall and
 * merging them into the volatile deterministic sections would pollute them.
 */
const FOREIGN_SECTION_MAP = new Map([
  ['primary request and intent', 'Session Goal'],
  ['key technical concepts', 'Outstanding Context'],
  ['pending jobs', 'Outstanding Context'],
  ['current work', 'Outstanding Context'],
  ['next step', 'Outstanding Context'],
  ['critical context', 'Outstanding Context'],
])

/** Fold wrap-wrapped body lines back into bullets (LLM checkpoints wrap at ~100 chars). */
function reframeSectionBullets(bodyLines) {
  const bullets = []
  let cur = null
  for (const raw of bodyLines) {
    const line = raw.trim()
    if (!line) continue
    const bullet = /^\s*(?:[-*]|\*\*)\s+/.test(line)
    if (bullet) {
      if (cur) bullets.push(cur)
      cur = line.replace(/^\s*[-*]\s+/, '').trim()
    } else if (cur) {
      cur += ' ' + line
    } else {
      cur = line
    }
  }
  if (cur) bullets.push(cur)
  return bullets.filter((t) => t.length > 0).map((t) => '- ' + t)
}

/** @returns VCC-shaped text (or undefined when nothing mappable). */
export function reframeForeignSummary(text) {
  if (typeof text !== 'string' || !/^##\s/m.test(text)) return undefined

  const sections = new Map() // VCC header -> bullets[]
  let curHeader = null
  let curBody = []
  const flush = () => {
    if (!curHeader) return
    const vcc = FOREIGN_SECTION_MAP.get(curHeader)
    if (vcc) {
      const bullets = reframeSectionBullets(curBody)
      if (bullets.length > 0) sections.set(vcc, [...(sections.get(vcc) ?? []), ...bullets])
    }
    curHeader = null
    curBody = []
  }
  for (const raw of text.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(raw)
    if (m) {
      flush()
      curHeader = m[1].trim().toLowerCase()
      curBody = []
    } else if (curHeader !== null) {
      curBody.push(raw)
    }
  }
  flush()

  const parts = []
  const ORDER = ['Session Goal', 'Files And Changes', 'Commits', 'Outstanding Context', 'User Preferences']
  for (const header of ORDER) {
    const bullets = sections.get(header)
    if (bullets?.length) parts.push(`[${header}]\n${bullets.join('\n')}`)
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}
