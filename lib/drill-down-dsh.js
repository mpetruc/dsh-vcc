// dsh-vcc: drill-down (#N:path) support — verbatim port of pi-vcc's
// src/core/drill-down.ts parsing and formatting (itself a port of
// pi-blackhole, MIT), with `expandEntryFile` re-rooted on the DSH session
// message source instead of a pi JSONL file.
//
// The compiled src/core/drill-down.js is NOT used because it binds to
// pi's load-messages/JSONL layer; only parseDrillDown and the formatting
// helpers move here, unchanged except for the loader.

import { isContentBearing } from '../src/core/content.js'
import { extractPath } from '../src/core/tool-args.js'

/**
 * Find content-bearing tool calls that have a `path` argument and at least
 * one content field (content, edits, oldText, newText).
 * Uses the shared isContentBearing() heuristic (ported from pi-blackhole).
 */
function findContentBearingCalls(content) {
  if (!Array.isArray(content)) return []
  const results = []
  for (const part of content) {
    if (!part || part.type !== 'toolCall') continue
    const args = part.arguments ?? {}
    if (!isContentBearing(args)) continue
    const path = extractPath(args)
    if (!path) continue
    const entry = { name: part.name ?? '', path }
    if (typeof args.content === 'string') entry.content = args.content
    if (Array.isArray(args.edits)) {
      entry.edits = args.edits.filter((e) => e !== null && typeof e === 'object')
    }
    if (typeof args.oldText === 'string' && !Array.isArray(args.edits))
      entry.oldText = args.oldText
    if (typeof args.newText === 'string' && !Array.isArray(args.edits))
      entry.newText = args.newText
    results.push(entry)
  }
  return results
}

/** Format content for display with optional offset/limit slicing. */
function formatToolCallContent(tc, entryIndex, options) {
  let body
  if (tc.content) {
    body = tc.content
  } else if (tc.edits) {
    body = tc.edits
      .map(
        (e, i) =>
          `--- edit ${i + 1} ---\n${e.oldText ?? ''}\n--- becomes ---\n${e.newText ?? ''}`,
      )
      .join('\n\n')
  } else if (tc.oldText && tc.newText) {
    body = `--- old ---\n${tc.oldText}\n--- new ---\n${tc.newText}`
  } else {
    body = '(no file content found in tool call arguments)'
  }

  const full = options?.full ?? false
  const offset = options?.offset
  const limit = options?.limit
  const allLines = body.split('\n')
  const totalLines = allLines.length
  const previewLimit = 30
  const MAX_FULL_BYTES = 50 * 1024

  if (full) {
    if (Buffer.byteLength(body, 'utf8') > MAX_FULL_BYTES) {
      const truncated = body.slice(0, MAX_FULL_BYTES)
      return `File: ${tc.path}
Tool: ${tc.name}

${truncated}

... (${Buffer.byteLength(body, 'utf8') - MAX_FULL_BYTES} more bytes — file exceeds 50KB display limit. Use #${entryIndex}:${tc.path}:${previewLimit} for next page.)`
    }
    return `File: ${tc.path}
Tool: ${tc.name}

${body}`
  }

  if (offset !== undefined) {
    const startLine = Math.max(0, offset)
    const maxLines = limit ?? 30
    const endLine = Math.min(startLine + maxLines, totalLines)
    const visible = allLines.slice(startLine, endLine)
    const displayStart = startLine + 1 // 1-indexed for user display

    if (visible.length === 0) {
      return `Offset ${startLine} is beyond file length ${totalLines}. Use #${entryIndex}:${tc.path} for the first ${previewLimit} lines.`
    }

    let result = `File: ${tc.path}
Tool: ${tc.name}
Lines ${displayStart}-${endLine} (of ${totalLines}):

`
    result += visible.join('\n')

    if (endLine < totalLines) {
      result += `\n\n--- Use #${entryIndex}:${tc.path}:${endLine} or #${entryIndex}:${tc.path}:${endLine}:${maxLines} for next ${maxLines} lines, #${entryIndex}:${tc.path}:full for complete ---`
    } else if (offset > 0) {
      result += `\n\n(End of file)`
    }

    return result
  }

  // Default preview mode: first ${previewLimit} lines
  if (totalLines > previewLimit) {
    const preview = allLines.slice(0, previewLimit).join('\n')
    return `File: ${tc.path}
Tool: ${tc.name}

${preview}

...(${totalLines - previewLimit} more lines — use #${entryIndex}:${tc.path}:full for complete content, or #${entryIndex}:${tc.path}:${previewLimit} for next ${previewLimit} lines)`
  }

  return `File: ${tc.path}
Tool: ${tc.name}

${body}`
}

// ── Parse drill-down query ────────────────────────────────────────────────

/**
 * Pattern: #N:path, #N:path:full, #N:path:offset, or #N:path:offset:limit
 * Group 1: index number
 * Group 2: path (consumed lazily, expanded until suffix can match)
 * Group 3: suffix — "full", a number (offset), or "offset:limit"
 */
const DRILLDOWN_PATTERN = /^#(\d+):(.+?)(?::(full|\d+(?::\d+)?))?$/

/**
 * Parse a drill-down query like #42:auth.ts or #42:auth.ts:full.
 * Returns null if the query doesn't match the drill-down pattern.
 */
export function parseDrillDown(query) {
  const match = query.match(DRILLDOWN_PATTERN)
  if (!match) return null
  const index = parseInt(match[1], 10)
  const pathPattern = match[2]
  const suffix = match[3]

  if (suffix === 'full') {
    return { index, pathPattern, full: true, offset: undefined, limit: undefined }
  }

  if (suffix !== undefined) {
    const parts = suffix.split(':')
    const offset = parseInt(parts[0], 10)
    const limit = parts[1] !== undefined ? parseInt(parts[1], 10) : undefined
    if (!Number.isNaN(offset)) {
      return { index, pathPattern, full: false, offset, limit }
    }
  }

  return { index, pathPattern, full: false, offset: undefined, limit: undefined }
}

/**
 * Expand a drill-down query (#N:path) to tool call content, against a
 * messages collection with a byIndex map of global index (event seq) to
 * pi-shape message.
 */
export function expandEntry(byIndex, entryIndex, pathPattern, full = false, offset, limit) {
  const count = byIndex.size
  if (!Number.isInteger(entryIndex) || entryIndex < 0 || !byIndex.has(entryIndex)) {
    return `Entry #${entryIndex} not found in session history.`
  }

  const msg = byIndex.get(entryIndex)
  const content = msg?.content
  const calls = findContentBearingCalls(Array.isArray(content) ? content : [])

  // Special case: #42:file keyword
  if (pathPattern === 'file') {
    if (calls.length === 0) {
      return `No file content found in entry #${entryIndex}.`
    }
    if (calls.length === 1) {
      return formatToolCallContent(calls[0], entryIndex, { full, offset, limit })
    }
    const items = calls.map((tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`)
    return `Entry #${entryIndex} has ${calls.length} file operations:\n${items.join('\n')}\n\nUse #${entryIndex}:path to drill into a specific file.`
  }

  const matched = calls.filter((tc) => tc.path.includes(pathPattern))

  if (matched.length === 0) {
    return `No file content found in entry #${entryIndex} for "${pathPattern}".`
  }

  if (matched.length > 1) {
    const items = matched.map((tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`)
    return `Entry #${entryIndex} has ${matched.length} file operations matching "${pathPattern}":
${items.join('\n')}

Use #${entryIndex}:<more-specific-path> to drill into a specific file.`
  }

  return formatToolCallContent(matched[0], entryIndex, { full, offset, limit })
}
