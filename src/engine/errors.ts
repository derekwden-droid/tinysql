/**
 * Typed errors. Language problems never throw a raw Error, so the UI and CLI can
 * render position information without string-scraping.
 *
 * Display form: `Tinysql: parse error at 3:12: expected identifier`
 */

export type ErrorKind = "lex" | "parse" | "planning" | "exec";

export abstract class TinysqlError extends Error {
  abstract readonly kind: ErrorKind;
  /** 1-based line, or undefined for errors with no source position. */
  readonly line?: number;
  /** 1-based column. */
  readonly column?: number;
  readonly hint?: string;

  constructor(message: string, line?: number, column?: number, hint?: string) {
    super(message);
    this.name = new.target.name;
    this.line = line;
    this.column = column;
    this.hint = hint;
  }

  /** Human-facing single line, used identically by the CLI and the UI. */
  format(): string {
    const where = this.line !== undefined ? ` at ${this.line}:${this.column ?? 1}` : "";
    const hint = this.hint ? ` (${this.hint})` : "";
    return `Tinysql: ${this.kind} error${where}: ${this.message}${hint}`;
  }
}

export class LexError extends TinysqlError {
  readonly kind = "lex" as const;
}

export class ParseError extends TinysqlError {
  readonly kind = "parse" as const;
}

export class PlanningError extends TinysqlError {
  readonly kind = "planning" as const;
  constructor(message: string, hint?: string) {
    super(message, undefined, undefined, hint);
  }
}

export class ExecError extends TinysqlError {
  readonly kind = "exec" as const;
  constructor(message: string, hint?: string) {
    super(message, undefined, undefined, hint);
  }
}

export function isTinysqlError(e: unknown): e is TinysqlError {
  return e instanceof TinysqlError;
}

/** Format any thrown value for display. */
export function formatError(e: unknown): string {
  if (isTinysqlError(e)) return e.format();
  return `Tinysql: ${e instanceof Error ? e.message : String(e)}`;
}
