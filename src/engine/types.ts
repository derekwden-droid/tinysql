/**
 * Core value and schema types.
 *
 * INTEGER and REAL are two declared types over ONE runtime numeric domain, so
 * `1` and `1.0` are the same value everywhere: in `=`, in ORDER BY, and in hash
 * index keys. Anything that separates them is a bug (see hash-index.ts).
 */

export type SqlType = "integer" | "real" | "text" | "boolean" | "null";

export interface ColumnDef {
  name: string;
  type: SqlType;
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
}

export type Value = number | string | boolean | null;

/** A row is a flat array addressed by ordinal. Never an object in the hot path. */
export type Row = Value[];

/** One column of a plan node's output schema. `table` is the alias, if any. */
export interface ColumnRef {
  /** Qualifier as written in the query (alias if aliased), or null for computed columns. */
  table: string | null;
  name: string;
  type: SqlType;
}

/** Truth value under three-valued logic. `null` is UNKNOWN. */
export type Bool3 = boolean | null;

/**
 * Type rank for cross-type ordering. Values of different types are never equal;
 * when ordered, they sort by this rank. Mirrors SQLite's storage-class ordering.
 */
export function typeRank(v: Value): number {
  if (v === null) return 0;
  switch (typeof v) {
    case "boolean":
      return 1;
    case "number":
      return 2;
    default:
      return 3;
  }
}

/**
 * Whether a value may be stored in a column of the declared type. NULL fits
 * every column. INTEGER and REAL share one numeric domain, so integrality is
 * the only thing between them: `2.0` fits INTEGER because it is `2`; `1.5`
 * does not. The catalog checks this on every write.
 */
export function fitsType(v: Value, type: SqlType): boolean {
  if (v === null) return true;
  switch (type) {
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "real":
      return typeof v === "number" && Number.isFinite(v);
    case "text":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return false;
  }
}

/** The declared type that best describes a runtime value. */
export function runtimeType(v: Value): SqlType {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(v) ? "integer" : "real";
    default:
      return "text";
  }
}
