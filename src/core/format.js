const section = (title, items) => {
    if (items.length === 0)
        return "";
    const body = items.map((i) => `- ${i}`).join("\n");
    return `[${title}]\n${body}`;
};
export const BRIEF_MAX_LINES = 120;
const TUI_SAFE_LINE_CHARS = 120;
const wrapLine = (line, maxChars) => {
    if (line.length <= maxChars)
        return [line];
    const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
    const continuationIndent = indent ? " ".repeat(Math.min(indent.length, 8)) : "";
    const wrapped = [];
    let remaining = line;
    let prefix = "";
    while (prefix.length + remaining.length > maxChars) {
        const available = Math.max(20, maxChars - prefix.length);
        let splitAt = remaining.lastIndexOf(" ", available);
        if (splitAt < Math.floor(available * 0.5))
            splitAt = available;
        wrapped.push(prefix + remaining.slice(0, splitAt).trimEnd());
        remaining = remaining.slice(splitAt).trimStart();
        prefix = continuationIndent;
    }
    if (remaining)
        wrapped.push(prefix + remaining);
    return wrapped;
};
export const wrapLongLines = (text, maxChars = TUI_SAFE_LINE_CHARS) => text.split("\n").flatMap((line) => wrapLine(line, maxChars)).join("\n");
export const capBrief = (text) => {
    const lines = text.split("\n");
    if (lines.length <= BRIEF_MAX_LINES)
        return text;
    const omitted = lines.length - BRIEF_MAX_LINES;
    const kept = lines.slice(-BRIEF_MAX_LINES);
    // Find first section header to avoid cutting mid-section
    const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
    const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
    return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};
export const RECALL_NOTE = "Use `vcc_recall` to search for prior work, decisions, and context from before this summary. " +
    "Do not redo work already completed.";
export const formatSummary = (data, options = {}) => {
    const capBriefTranscript = options.capBriefTranscript ?? true;
    const headerParts = [
        section("Session Goal", data.sessionGoal),
        section("Files And Changes", data.filesAndChanges),
        section("Commits", data.commits),
        section("Outstanding Context", data.outstandingContext),
        section("User Preferences", data.userPreferences),
    ].filter(Boolean);
    const parts = [];
    if (headerParts.length > 0) {
        parts.push(headerParts.join("\n\n"));
    }
    if (data.briefTranscript) {
        parts.push(capBriefTranscript ? capBrief(data.briefTranscript) : data.briefTranscript);
    }
    if (parts.length === 0)
        return "";
    // NOTE: RECALL_NOTE is intentionally NOT appended here.
    // It is appended once by `compile()` at the very end, after merge-with-previous,
    // to avoid the note compounding inside the brief transcript across compactions.
    return wrapLongLines(parts.join("\n\n---\n\n"));
};
