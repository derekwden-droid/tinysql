import { ParseError } from "./errors.js";
import { spanOf, tokenize, type Token } from "./lexer.js";
import type {
  BinaryOp,
  ColumnExpr,
  Expr,
  JoinClause,
  OrderKey,
  SelectItem,
  SelectStmt,
  Span,
  Statement,
  TableRef,
} from "./ast.js";
import type { SqlType } from "./types.js";

const COMPARISON: Record<string, BinaryOp> = {
  "=": "=",
  "!=": "!=",
  "<>": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

const COLUMN_TYPES: Record<string, SqlType> = {
  integer: "integer",
  real: "real",
  text: "text",
  boolean: "boolean",
};

/**
 * Recursive descent, with a Pratt loop for expressions. No parser generator, and
 * the parser never invents a token: on failure it names what it found and what
 * would have been valid there.
 */
class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const tok = this.peek();
    if (tok.kind !== "eof") this.pos++;
    return tok;
  }

  private at(value: string): boolean {
    const tok = this.peek();
    return (tok.kind === "keyword" || tok.kind === "punct") && tok.value === value;
  }

  private accept(value: string): boolean {
    if (this.at(value)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private describe(tok: Token): string {
    if (tok.kind === "eof") return "end of input";
    return `'${tok.text}'`;
  }

  private fail(expected: string, tok = this.peek(), hint?: string): never {
    throw new ParseError(
      `expected ${expected} but found ${this.describe(tok)}`,
      tok.line,
      tok.column,
      hint,
    );
  }

  private expect(value: string, expected = `'${value}'`): Token {
    if (!this.at(value)) this.fail(expected);
    return this.next();
  }

  /** An identifier, or a non-reserved keyword used as a name. */
  private expectIdent(what = "identifier"): Token {
    const tok = this.peek();
    if (tok.kind !== "ident") this.fail(what, tok);
    return this.next();
  }

  // ---------------------------------------------------------------- statements

  parseScript(): Statement[] {
    const statements: Statement[] = [];
    while (this.peek().kind !== "eof") {
      if (this.accept(";")) continue;
      statements.push(this.parseStatement());
      if (!this.at(";") && this.peek().kind !== "eof") {
        this.fail("';' between statements");
      }
    }
    if (statements.length === 0) {
      const tok = this.peek();
      throw new ParseError("empty statement", tok.line, tok.column);
    }
    return statements;
  }

  private parseStatement(): Statement {
    const tok = this.peek();
    if (tok.kind === "keyword") {
      switch (tok.value) {
        case "select":
          return this.parseSelect();
        case "explain": {
          this.next();
          const select = this.parseSelect();
          return { kind: "explain", select, span: spanOf(tok) };
        }
        case "create":
          return this.parseCreate();
        case "drop":
          return this.parseDrop();
        case "insert":
          return this.parseInsert();
      }
    }
    this.fail("SELECT, EXPLAIN, CREATE, DROP or INSERT", tok);
  }

  private parseCreate(): Statement {
    const start = this.expect("create");
    if (this.accept("table")) {
      const name = this.expectIdent("table name");
      this.expect("(");
      const columns: { name: string; type: SqlType }[] = [];
      do {
        const col = this.expectIdent("column name");
        const typeTok = this.peek();
        const type = typeTok.kind === "keyword" ? COLUMN_TYPES[typeTok.value] : undefined;
        if (type === undefined) this.fail("INTEGER, REAL, TEXT or BOOLEAN", typeTok);
        this.next();
        columns.push({ name: col.value, type });
      } while (this.accept(","));
      this.expect(")");
      return { kind: "createTable", name: name.value, columns, span: spanOf(start) };
    }
    if (this.accept("index")) {
      const name = this.expectIdent("index name");
      this.expect("on");
      const table = this.expectIdent("table name");
      this.expect("(");
      const column = this.expectIdent("column name");
      this.expect(")");
      return {
        kind: "createIndex",
        name: name.value,
        table: table.value,
        column: column.value,
        span: spanOf(start),
      };
    }
    this.fail("TABLE or INDEX");
  }

  private parseDrop(): Statement {
    const start = this.expect("drop");
    this.expect("table");
    const name = this.expectIdent("table name");
    return { kind: "dropTable", name: name.value, span: spanOf(start) };
  }

  private parseInsert(): Statement {
    const start = this.expect("insert");
    this.expect("into");
    const table = this.expectIdent("table name");
    this.expect("(");
    const columns: string[] = [];
    do {
      columns.push(this.expectIdent("column name").value);
    } while (this.accept(","));
    this.expect(")");
    this.expect("values");
    const rows: Expr[][] = [];
    do {
      this.expect("(");
      const values: Expr[] = [];
      do {
        values.push(this.parseExpr());
      } while (this.accept(","));
      this.expect(")");
      rows.push(values);
    } while (this.accept(","));
    return { kind: "insert", table: table.value, columns, rows, span: spanOf(start) };
  }

  private parseSelect(): SelectStmt {
    const start = this.expect("select");
    const distinct = this.accept("distinct");

    const items: SelectItem[] = [];
    do {
      items.push(this.parseSelectItem());
    } while (this.accept(","));

    let from: TableRef | null = null;
    let join: JoinClause | null = null;
    if (this.accept("from")) {
      from = this.parseTableRef();
      if (this.at("join")) join = this.parseJoin();
    }

    let where: Expr | null = null;
    if (this.accept("where")) {
      if (from === null) {
        const tok = this.peek();
        throw new ParseError("WHERE requires a FROM clause", tok.line, tok.column);
      }
      where = this.parseExpr();
    }

    const orderBy: OrderKey[] = [];
    if (this.accept("order")) {
      this.expect("by");
      do {
        orderBy.push(this.parseOrderKey());
      } while (this.accept(","));
    }

    let limit: number | null = null;
    let offset: number | null = null;
    if (this.accept("limit")) {
      limit = this.parseCount("LIMIT");
      if (this.accept("offset")) offset = this.parseCount("OFFSET");
    }

    return { kind: "select", distinct, items, from, join, where, orderBy, limit, offset, span: spanOf(start) };
  }

  private parseCount(what: string): number {
    const tok = this.peek();
    if (tok.kind !== "number") this.fail(`a number after ${what}`, tok);
    this.next();
    const n = Number(tok.value);
    if (!Number.isInteger(n) || n < 0) {
      throw new ParseError(`${what} must be a non-negative integer`, tok.line, tok.column);
    }
    return n;
  }

  private parseSelectItem(): SelectItem {
    const tok = this.peek();
    if (this.at("*")) {
      this.next();
      return { kind: "star", span: spanOf(tok) };
    }
    // `table.*`
    if (tok.kind === "ident" && this.peek(1).value === "." && this.peek(2).value === "*") {
      this.next();
      this.next();
      this.next();
      return { kind: "tableStar", table: tok.value, span: spanOf(tok) };
    }
    const expr = this.parseExpr();
    let alias: string | null = null;
    if (this.accept("as")) alias = this.expectIdent("alias").value;
    return { kind: "expr", expr, alias, span: spanOf(tok) };
  }

  private parseTableRef(): TableRef {
    const name = this.expectIdent("table name");
    let alias: string | null = null;
    // An alias is a bare identifier; keywords such as WHERE end the clause.
    if (this.peek().kind === "ident") alias = this.next().value;
    return { name: name.value, alias, span: spanOf(name) };
  }

  private parseJoin(): JoinClause {
    const start = this.expect("join");
    const table = this.parseTableRef();
    this.expect("on");
    const left = this.parseColumnRef("a qualified column in the JOIN condition");
    this.expect("=", "'=' (only inner equijoins are supported)");
    const right = this.parseColumnRef("a qualified column in the JOIN condition");
    return { table, left, right, span: spanOf(start) };
  }

  private parseColumnRef(what: string): ColumnExpr {
    const tok = this.peek();
    if (tok.kind !== "ident") this.fail(what, tok);
    const expr = this.parsePrimary();
    if (expr.kind !== "column") this.fail(what, tok);
    return expr;
  }

  private parseOrderKey(): OrderKey {
    const tok = this.peek();
    if (tok.kind === "number") {
      throw new ParseError(
        "ORDER BY does not accept column positions",
        tok.line,
        tok.column,
        "name the column instead",
      );
    }
    const ref = this.parseColumnRef("a column name in ORDER BY");
    let direction: "asc" | "desc" = "asc";
    if (this.accept("desc")) direction = "desc";
    else this.accept("asc");
    return { column: { table: ref.table, name: ref.name }, direction, span: spanOf(tok) };
  }

  // --------------------------------------------------------------- expressions

  parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.at("or")) {
      const op = this.next();
      const right = this.parseAnd();
      left = { kind: "binary", op: "or", left, right, span: spanOf(op) };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.at("and")) {
      const op = this.next();
      const right = this.parseNot();
      left = { kind: "binary", op: "and", left, right, span: spanOf(op) };
    }
    return left;
  }

  /** NOT binds tighter than AND but looser than comparison, so `NOT a = b` is `NOT (a = b)`. */
  private parseNot(): Expr {
    if (this.at("not")) {
      const op = this.next();
      return { kind: "not", expr: this.parseNot(), span: spanOf(op) };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parsePrimary();
    for (;;) {
      const tok = this.peek();
      if (tok.kind === "punct" && COMPARISON[tok.value] !== undefined) {
        this.next();
        const right = this.parsePrimary();
        left = { kind: "binary", op: COMPARISON[tok.value]!, left, right, span: spanOf(tok) };
        continue;
      }
      if (this.at("is")) {
        this.next();
        const negated = this.accept("not");
        this.expect("null", "NULL after IS");
        left = { kind: "isNull", expr: left, negated, span: spanOf(tok) };
        continue;
      }
      if (this.at("like")) {
        this.next();
        const pattern = this.parsePrimary();
        left = { kind: "like", expr: left, pattern, span: spanOf(tok) };
        continue;
      }
      return left;
    }
  }

  private parsePrimary(): Expr {
    const tok = this.peek();

    if (this.accept("(")) {
      const inner = this.parseExpr();
      this.expect(")");
      return inner;
    }

    if (tok.kind === "number") {
      this.next();
      return { kind: "literal", value: Number(tok.value), span: spanOf(tok) };
    }

    if (tok.kind === "string") {
      this.next();
      return { kind: "literal", value: tok.value, span: spanOf(tok) };
    }

    if (tok.kind === "keyword") {
      if (tok.value === "true" || tok.value === "false") {
        this.next();
        return { kind: "literal", value: tok.value === "true", span: spanOf(tok) };
      }
      if (tok.value === "null") {
        this.next();
        return { kind: "literal", value: null, span: spanOf(tok) };
      }
    }

    if (tok.kind === "ident") {
      this.next();
      if (this.at(".")) {
        this.next();
        const col = this.expectIdent("column name after '.'");
        return { kind: "column", table: tok.value, name: col.value, span: spanOf(tok) };
      }
      return { kind: "column", table: null, name: tok.value, span: spanOf(tok) };
    }

    this.fail("an expression", tok);
  }
}

/** Parse a script of one or more `;`-separated statements. */
export function parse(sql: string): Statement[] {
  return new Parser(sql).parseScript();
}

/** Parse exactly one statement; convenience for tests and the CLI. */
export function parseOne(sql: string): Statement {
  const statements = parse(sql);
  if (statements.length !== 1) {
    throw new ParseError(`expected a single statement, found ${statements.length}`);
  }
  return statements[0]!;
}

export type { Span };
