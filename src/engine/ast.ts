import type { SqlType, Value } from "./types.js";

/** Source span, carried so the UI can underline the offending token. */
export interface Span {
  start: number;
  end: number;
  line: number;
  column: number;
}

export type BinaryOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";

export interface ColumnExpr {
  kind: "column";
  table: string | null;
  name: string;
  span: Span;
}

export type Expr =
  | { kind: "literal"; value: Value; span: Span }
  | ColumnExpr
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr; span: Span }
  | { kind: "not"; expr: Expr; span: Span }
  | { kind: "isNull"; expr: Expr; negated: boolean; span: Span }
  | { kind: "like"; expr: Expr; pattern: Expr; span: Span };

/** One entry in the SELECT list. */
export type SelectItem =
  | { kind: "star"; span: Span }
  | { kind: "tableStar"; table: string; span: Span }
  | { kind: "expr"; expr: Expr; alias: string | null; span: Span };

export interface TableRef {
  name: string;
  /** Unquoted alias, e.g. `FROM employees e`. Null when not aliased. */
  alias: string | null;
  span: Span;
}

export interface JoinClause {
  table: TableRef;
  /** Inner equijoin only: both sides must be column references. */
  left: ColumnExpr;
  right: ColumnExpr;
  span: Span;
}

export interface OrderKey {
  column: { table: string | null; name: string };
  direction: "asc" | "desc";
  span: Span;
}

export interface SelectStmt {
  kind: "select";
  distinct: boolean;
  items: SelectItem[];
  /** Null for a tableless `SELECT 1 AS n`. */
  from: TableRef | null;
  join: JoinClause | null;
  where: Expr | null;
  orderBy: OrderKey[];
  limit: number | null;
  offset: number | null;
  span: Span;
}

export interface CreateTableStmt {
  kind: "createTable";
  name: string;
  columns: { name: string; type: SqlType }[];
  span: Span;
}

export interface CreateIndexStmt {
  kind: "createIndex";
  name: string;
  table: string;
  column: string;
  span: Span;
}

export interface DropTableStmt {
  kind: "dropTable";
  name: string;
  span: Span;
}

export interface InsertStmt {
  kind: "insert";
  table: string;
  columns: string[];
  rows: Expr[][];
  span: Span;
}

export interface ExplainStmt {
  kind: "explain";
  select: SelectStmt;
  span: Span;
}

export type Statement =
  | SelectStmt
  | CreateTableStmt
  | CreateIndexStmt
  | DropTableStmt
  | InsertStmt
  | ExplainStmt;
