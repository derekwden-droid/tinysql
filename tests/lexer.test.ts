import { describe, expect, it } from "vitest";
import { tokenize } from "../src/engine/lexer.js";
import { LexError } from "../src/engine/errors.js";

function kinds(sql: string): string[] {
  return tokenize(sql)
    .filter((t) => t.kind !== "eof")
    .map((t) => `${t.kind}:${t.value}`);
}

describe("lexer", () => {
  it("lowercases keywords and unquoted identifiers", () => {
    expect(kinds("SELECT Name FROM Employees")).toEqual([
      "keyword:select",
      "ident:name",
      "keyword:from",
      "ident:employees",
    ]);
  });

  it("preserves case inside double-quoted identifiers", () => {
    const [tok] = tokenize('"MixedCase"');
    expect(tok!.kind).toBe("ident");
    expect(tok!.value).toBe("MixedCase");
    expect(tok!.quoted).toBe(true);
  });

  it("decodes '' as an escaped quote inside strings", () => {
    const [tok] = tokenize("'O''Brien'");
    expect(tok!.kind).toBe("string");
    expect(tok!.value).toBe("O'Brien");
  });

  it("strips line and block comments", () => {
    expect(kinds("SELECT -- trailing\n1 /* inline\nspanning */ , 2")).toEqual([
      "keyword:select",
      "number:1",
      "punct:,",
      "number:2",
    ]);
  });

  it("keeps line numbers correct across a block comment", () => {
    const tokens = tokenize("SELECT\n/* two\nlines */\n1");
    const one = tokens.find((t) => t.value === "1");
    expect(one!.line).toBe(4);
  });

  it("distinguishes != from <>", () => {
    expect(kinds("a != b <> c")).toEqual([
      "ident:a",
      "punct:!=",
      "ident:b",
      "punct:<>",
      "ident:c",
    ]);
  });

  it("scans 1, 1.0 and .5", () => {
    expect(kinds("1, 1.0, .5")).toEqual([
      "number:1",
      "punct:,",
      "number:1.0",
      "punct:,",
      "number:.5",
    ]);
  });

  it("treats a dot between identifiers as a qualifier, not a number", () => {
    expect(kinds("e.dept_id")).toEqual(["ident:e", "punct:.", "ident:dept_id"]);
  });

  it("reports accurate line and column on a multi-line statement", () => {
    const tokens = tokenize("SELECT *\nFROM employees\nWHERE id = 3");
    const where = tokens.find((t) => t.value === "where");
    expect([where!.line, where!.column]).toEqual([3, 1]);
    const three = tokens.find((t) => t.value === "3");
    expect([three!.line, three!.column]).toEqual([3, 12]);
  });

  it("rejects an unterminated string with a position", () => {
    try {
      tokenize("SELECT 'abc");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LexError);
      expect((e as LexError).line).toBe(1);
      expect((e as LexError).column).toBe(8);
    }
  });

  it("rejects a malformed number rather than truncating it", () => {
    expect(() => tokenize("SELECT 1.2.3")).toThrow(LexError);
    expect(() => tokenize("SELECT 12abc")).toThrow(LexError);
  });

  it("rejects an unterminated block comment", () => {
    expect(() => tokenize("SELECT 1 /* never closed")).toThrow(LexError);
  });
});
