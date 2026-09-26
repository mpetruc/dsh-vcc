const SCOPE_RE = /\bscope:(lineage|all)\b/i;
const VALID_MODES = new Set(["hybrid", "touched"]);
export const normalizeRecallScope = (scope) => typeof scope === "string" && scope.toLowerCase() === "all" ? "all" : "lineage";
/**
 * Normalize a mode param to a supported recall mode. Without OM integration,
 * only "touched" adds behavior beyond the default hybrid search — "file"-only
 * search is not implemented in pi-vcc, so it is not exposed.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export const normalizeRecallMode = (mode) => typeof mode === "string" && VALID_MODES.has(mode.toLowerCase())
    ? mode.toLowerCase()
    : "hybrid";
export const parseRecallScope = (text) => {
    const match = text.match(SCOPE_RE);
    return {
        scope: normalizeRecallScope(match?.[1]),
        text: text.replace(SCOPE_RE, "").replace(/\s+/g, " ").trim(),
    };
};
