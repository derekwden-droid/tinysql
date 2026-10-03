// Generated from src/engine/errors.ts by scripts/build-plugin.ts. Do not edit:
// change the TypeScript source and run `npm run build:plugin`.
export class TinysqlError extends Error {
    /** 1-based line, or undefined for errors with no source position. */
    line;
    /** 1-based column. */
    column;
    hint;
    constructor(message, line, column, hint) {
        super(message);
        this.name = new.target.name;
        this.line = line;
        this.column = column;
        this.hint = hint;
    }
    /** Human-facing single line, used identically by the CLI and the UI. */
    format() {
        const where = this.line !== undefined ? ` at ${this.line}:${this.column ?? 1}` : "";
        const hint = this.hint ? ` (${this.hint})` : "";
        return `Tinysql: ${this.kind} error${where}: ${this.message}${hint}`;
    }
}
export class LexError extends TinysqlError {
    kind = "lex";
}
export class ParseError extends TinysqlError {
    kind = "parse";
}
export class PlanningError extends TinysqlError {
    kind = "planning";
    constructor(message, hint) {
        super(message, undefined, undefined, hint);
    }
}
export class ExecError extends TinysqlError {
    kind = "exec";
    constructor(message, hint) {
        super(message, undefined, undefined, hint);
    }
}
export function isTinysqlError(e) {
    return e instanceof TinysqlError;
}
/** Format any thrown value for display. */
export function formatError(e) {
    if (isTinysqlError(e))
        return e.format();
    return `Tinysql: ${e instanceof Error ? e.message : String(e)}`;
}
