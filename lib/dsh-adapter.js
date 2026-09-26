// dsh-vcc: adapter between DSH session messages and the pi-shape messages
// consumed by the ported (verbatim) pi-vcc core under src/.
//
// DSH stores messages as { role, content: ContentBlock[], ... } where blocks
// are discriminated by `type` ('text' | 'reasoning' | 'image' | 'file' |
// 'tool-call') and tool results carry `toolCallId` instead of a tool name.
// pi-vcc consumes pi-ai shaped messages: assistant content parts of type
// 'text' | 'toolCall' (arguments as an object) and toolResult messages that
// carry `toolName`. Everything the core reads is mapped here; the ported
// core itself is untouched.

const JSON_ARGS_FALLBACK = Object.freeze({})

/** Parse a DSH tool-call JSON-string arguments object; never throws. */
export function parseToolArgs(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return JSON_ARGS_FALLBACK
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : JSON_ARGS_FALLBACK
  } catch {
    return JSON_ARGS_FALLBACK
  }
}

/**
 * Extract plain text from DSH content blocks, skipping reasoning.
 * Used for the compile side (reasoning is intentionally excluded).
 */
export function textBlocksOf(content) {
  const blocks = Array.isArray(content) ? content : []
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Convert one DSH message into a pi-shape message, or null when the message
 * has no representation the ported core can use (system/developer, empty
 * assistant, unknown role).
 *
 * @param msg - a DSH Message (from session.deriveEventMessage).
 * @param toolNames - Map<toolCallId, toolName>; assistant tool-call blocks
 *   registered here as they are seen, so a following tool result can be
 *   named. Populated as a side effect — pass the same map through a whole
 *   ordered walk.
 * @param opts.includeReasoning - when true, reasoning blocks are surfaced as
 *   text parts (used by recall search so `#N` can find decisions made in
 *   reasoning); the compile path keeps them out by passing false.
 */
export function toPiMessage(msg, toolNames = new Map(), opts = {}) {
  if (!msg || typeof msg !== 'object') return null
  const { includeReasoning = false } = opts
  const role = msg.role

  if (role === 'user') {
    const content = []
    const text = textBlocksOf(msg.content)
    if (text) content.push({ type: 'text', text })
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.type === 'image') {
          const mime = block.attachment?.mime ?? block.attachment?.mimeType
          content.push({ type: 'image', mimeType: typeof mime === 'string' ? mime : 'image' })
        }
      }
    }
    if (content.length === 0) return null
    return { role: 'user', content }
  }

  if (role === 'assistant') {
    if (!Array.isArray(msg.content) || msg.content.length === 0) return null
    const content = []
    for (const block of msg.content) {
      if (!block) continue
      if (block.type === 'text' && typeof block.text === 'string') {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'reasoning' && typeof block.text === 'string' && includeReasoning) {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool-call') {
        const call = {
          type: 'toolCall',
          name: block.name ?? 'tool',
          arguments: parseToolArgs(block.arguments),
        }
        if (typeof block.id === 'string' && !toolNames.has(block.id)) {
          toolNames.set(block.id, block.name ?? 'tool')
        }
        content.push(call)
      }
      // 'image' / 'file' blocks in assistant content are intentionally dropped.
    }
    if (content.length === 0) return null
    return { role: 'assistant', content }
  }

  if (role === 'tool') {
    const name = typeof msg.toolCallId === 'string' && toolNames.has(msg.toolCallId)
      ? toolNames.get(msg.toolCallId)
      : undefined
    // Mirror pi's toolResult shape: name is required and may be unknown when
    // the matching assistant message is out of reach (kept as 'tool').
    return {
      role: 'toolResult',
      toolName: typeof name === 'string' ? name : 'tool',
      content: textBlocksOf(msg.content),
    }
  }

  // system / developer / anything unknown: no pi equivalent on this path.
  return null
}
