import { clip, textOf } from "./content.js";
import { summarizeToolArgs } from "./tool-args.js";
import { extractPath } from "./tool-args.js";
const toolCalls = (content) => {
    if (!content || typeof content === "string")
        return "";
    return content
        .filter((c) => c.type === "toolCall")
        .map((c) => `${c.name}(${summarizeToolArgs(c.arguments)})`)
        .join(", ");
};
const extractFilesFromContent = (content) => {
    if (!content || typeof content === "string")
        return [];
    return content
        .filter((c) => c.type === "toolCall")
        .map((c) => extractPath(c.arguments))
        .filter((p) => p !== null);
};
export const renderMessage = (msg, index, full = false) => {
    if (msg.role === "user") {
        return { index, role: "user", summary: full ? textOf(msg.content) : clip(textOf(msg.content), 300) };
    }
    if (msg.role === "toolResult") {
        const text = full ? textOf(msg.content) : clip(textOf(msg.content), 200);
        return {
            index, role: "tool_result",
            summary: `[${msg.toolName}] ${text}`,
        };
    }
    // bashExecution has command+output instead of content
    if (msg.role === "bashExecution") {
        const cmd = msg.command ?? "";
        const out = msg.output ?? "";
        const text = full ? `$ ${cmd}\n${out}` : clip(`$ ${cmd}\n${out}`, 300);
        return { index, role: "bash", summary: text };
    }
    const text = full ? textOf(msg.content) : clip(textOf(msg.content), 300);
    const tools = toolCalls(msg.content);
    const files = extractFilesFromContent(msg.content);
    const summary = tools ? `${tools}\n${text}` : text;
    return { index, role: "assistant", summary, ...(files.length > 0 && { files }) };
};
