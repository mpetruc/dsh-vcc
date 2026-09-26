import { clipSentence, nonEmptyLines } from "./content.js";
import { extractGoals } from "../extract/goals.js";
import { extractFiles } from "../extract/files.js";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../extract/preferences.js";
import { extractCommits, formatCommits } from "../extract/commits.js";
import { buildBriefSections, stringifyBrief } from "./brief.js";
const BLOCKER_RE = /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;
const extractOutstandingContext = (blocks) => {
    const items = [];
    const tail = blocks.slice(-20);
    for (const b of tail) {
        if (b.kind === "assistant" || b.kind === "user") {
            for (const line of nonEmptyLines(b.text)) {
                if (!BLOCKER_RE.test(line))
                    continue;
                if (line.length < 15)
                    continue;
                // Skip continuation fragments (sub-bullets, parentheticals, dangling clauses)
                if (/^\s*[-*+>]\s/.test(line))
                    continue;
                if (/^\s*\(/.test(line))
                    continue;
                // Require sentence-like start: capital letter, code identifier, or quote
                if (!/^\s*["'`*_]?[A-Z`]/.test(line))
                    continue;
                const clipped = b.kind === "user" ? `[user] ${clipSentence(line, 150)}` : clipSentence(line, 150);
                if (!items.includes(clipped))
                    items.push(clipped);
                break;
            }
        }
    }
    return items.slice(0, 5);
};
const formatFileActivity = (blocks, fileOps) => {
    const act = extractFiles(blocks, fileOps);
    // Dedup: if already Modified, drop from Created (file existed before)
    for (const p of act.modified)
        act.created.delete(p);
    const lines = [];
    const cap = (set, limit) => {
        const arr = [...set];
        if (arr.length <= limit)
            return arr.join(", ");
        return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
    };
    if (act.modified.size > 0)
        lines.push(`Modified: ${cap(act.modified, 10)}`);
    if (act.created.size > 0)
        lines.push(`Created: ${cap(act.created, 10)}`);
    if (act.read.size > 0)
        lines.push(`Read: ${cap(act.read, 10)}`);
    return lines;
};
export const buildSections = (input) => {
    const { blocks } = input;
    const briefSections = buildBriefSections(input.briefBlocks ?? blocks);
    const sessionGoal = extractGoals(blocks);
    const userPreferences = dedupPreferencesAgainstGoals(extractPreferences(blocks), sessionGoal);
    return {
        sessionGoal,
        outstandingContext: extractOutstandingContext(blocks),
        filesAndChanges: formatFileActivity(blocks, input.fileOps),
        commits: formatCommits(extractCommits(blocks)),
        userPreferences,
        briefTranscript: stringifyBrief(briefSections),
    };
};
