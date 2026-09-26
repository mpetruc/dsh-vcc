export const PATH_KEYS = ["path", "file_path", "filePath", "file"];
export const extractPath = (args) => {
    for (const key of ["path", "file_path", "filePath", "file"]) {
        if (typeof args[key] === "string")
            return args[key];
    }
    return null;
};
export const summarizeToolArgs = (args) => {
    const path = extractPath(args);
    if (path)
        return `path=${path}`;
    if (typeof args.command === "string")
        return `command=${args.command}`;
    if (typeof args.query === "string")
        return `query=${args.query}`;
    return Object.keys(args).join(", ");
};
