import { LexError } from "./errors.js";
import type { Span } from "./ast.js";

export type TokenKind = "keyword" | "ident" | "number" | "string" | "punct" | "eof";

export interface Token {
  kind: TokenKind;
  /** Keywords and unquoted identifiers are lowercased. Strings hold their decoded value. */
  value: string;
  /** Raw source text, for error messages and editor underlining. */
  text: string;
  /** True when an identifier arrived double-quoted, so it must not be case-folded. */
  quoted: boolean;
  start: number;
  end: number;
  line: number;
  column: number;
}

const KEYWORDS = new Set([
  "select", "distinct", "from", "join", "on", "where", "order", "by", "asc", "desc",
  "limit", "offset", "create", "table", "index", "drop", "insert", "into", "values",
  "explain", "and", "or", "not", "is", "null", "like", "true", "false", "as",
  "integer", "real", "text", "boolean",
]);

/** Multi-character punctuation, longest first so `<=` wins over `<`. */
const PUNCT = ["!=", "<>", "<=", ">=", "(", ")", ",", "*", "=", "<", ">", ".", ";"];

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

/**
 * Hand-written scanner. No regex-as-parser: every character is consumed by an
 * explicit branch so that positions stay exact for editor diagnostics.
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let lineStart = 0;

  const column = (at: number): number => at - lineStart + 1;

  const advanceNewlines = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      if (src[i] === "\n") {
        line++;
        lineStart = i + 1;
      }
    }
  };

  const push = (kind: TokenKind, value: string, start: number, end: number, quoted = false): void => {
    tokens.push({
      kind,
      value,
      text: src.slice(start, end),
      quoted,
      start,
      end,
      line,
      column: column(start),
    });
  };

  while (pos < src.length) {
    const c = src[pos]!;

    // Whitespace
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      if (c === "\n") {
        line++;
        lineStart = pos + 1;
      }
      pos++;
      continue;
    }

    // Line comment
    if (c === "-" && src[pos + 1] === "-") {
      while (pos < src.length && src[pos] !== "\n") pos++;
      continue;
    }

    // Block comment
    if (c === "/" && src[pos + 1] === "*") {
      const start = pos;
      const close = src.indexOf("*/", pos + 2);
      if (close === -1) {
        throw new LexError("unterminated block comment", line, column(start));
      }
      advanceNewlines(pos, close + 2);
      pos = close + 2;
      continue;
    }

    // String literal, '' is an escaped quote
    if (c === "'") {
      const start = pos;
      const startLine = line;
      const startCol = column(start);
      pos++;
      let out = "";
      for (;;) {
        if (pos >= src.length) {
          throw new LexError("unterminated string literal", startLine, startCol);
        }
        const ch = src[pos]!;
        if (ch === "'") {
          if (src[pos + 1] === "'") {
            out += "'";
            pos += 2;
            continue;
          }
          pos++;
          break;
        }
        if (ch === "\n") {
          line++;
          lineStart = pos + 1;
        }
        out += ch;
        pos++;
      }
      tokens.push({
        kind: "string",
        value: out,
        text: src.slice(start, pos),
        quoted: true,
        start,
        end: pos,
        line: startLine,
        column: startCol,
      });
      continue;
    }

    // Double-quoted identifier, "" is an escaped quote
    if (c === '"') {
      const start = pos;
      const startCol = column(start);
      pos++;
      let out = "";
      for (;;) {
        if (pos >= src.length || src[pos] === "\n") {
          throw new LexError("unterminated quoted identifier", line, startCol);
        }
        const ch = src[pos]!;
        if (ch === '"') {
          if (src[pos + 1] === '"') {
            out += '"';
            pos += 2;
            continue;
          }
          pos++;
          break;
        }
        out += ch;
        pos++;
      }
      if (out.length === 0) {
        throw new LexError("empty quoted identifier", line, startCol);
      }
      push("ident", out, start, pos, true);
      continue;
    }

    // Number: 1, 1.0, .5 — a leading '.' is only numeric when a digit follows,
    // otherwise it is the qualified-name separator.
    if (isDigit(c) || (c === "." && isDigit(src[pos + 1] ?? ""))) {
      const start = pos;
      while (pos < src.length && isDigit(src[pos]!)) pos++;
      if (src[pos] === ".") {
        pos++;
        while (pos < src.length && isDigit(src[pos]!)) pos++;
      }
      const text = src.slice(start, pos);
      // Reject `1.2.3` and `12abc` rather than silently truncating.
      const next = src[pos];
      if (next !== undefined && (isIdentStart(next) || next === ".")) {
        throw new LexError(`malformed number literal near '${text}${next}'`, line, column(start));
      }
      push("number", text, start, pos);
      continue;
    }

    // Identifier or keyword
    if (isIdentStart(c)) {
      const start = pos;
      while (pos < src.length && isIdentPart(src[pos]!)) pos++;
      const text = src.slice(start, pos);
      const lower = text.toLowerCase();
      push(KEYWORDS.has(lower) ? "keyword" : "ident", lower, start, pos);
      continue;
    }

    // Punctuation
    const punct = PUNCT.find((p) => src.startsWith(p, pos));
    if (punct !== undefined) {
      const start = pos;
      pos += punct.length;
      push("punct", punct, start, pos);
      continue;
    }

    throw new LexError(`unexpected character '${c}'`, line, column(pos));
  }

  push("eof", "", pos, pos);
  return tokens;
}

export function spanOf(token: Token): Span {
  return { start: token.start, end: token.end, line: token.line, column: token.column };
}
