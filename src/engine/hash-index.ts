import type { Row, Value } from "./types.js";

/**
 * Equality-only hash index over one column, storing row ids.
 *
 * Keys carry a RUNTIME type tag so `1` and `"1"` cannot collide. The tag is
 * deliberately taken from the runtime type and not the declared column type: an
 * `i:`/`r:` split by declared type would put `1` and `1.0` in different buckets
 * and `WHERE x = 1.0` would silently miss rows that a sequential scan finds.
 * The index must never change the answer — see tests/hash-index.test.ts.
 */
export function encodeKey(value: Value): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case "number":
      // String(1) === String(1.0) === "1", which is exactly what we want.
      return `n:${String(value)}`;
    case "boolean":
      return `b:${value ? "true" : "false"}`;
    default:
      return `t:${value}`;
  }
}

/**
 * The row form of `encodeKey`, for DISTINCT: the same equality (`1` and `1.0`
 * are one value, two NULLs are duplicates) extended to whole rows. JSON quotes
 * and escapes every key, so no value can forge a boundary between columns, as
 * text containing a delimiter could when keys were joined with one.
 */
export function encodeRowKey(row: readonly Value[]): string {
  return JSON.stringify(row.map(encodeKey));
}

export class HashIndex {
  readonly name: string;
  readonly table: string;
  readonly column: string;
  /** Ordinal of the indexed column within the table's rows. */
  readonly ordinal: number;

  private readonly buckets = new Map<string, number[]>();
  /** Row ids whose key is NULL. Never returned by equality lookup. */
  private readonly nullRows: number[] = [];

  constructor(name: string, table: string, column: string, ordinal: number) {
    this.name = name;
    this.table = table;
    this.column = column;
    this.ordinal = ordinal;
  }

  /** Number of distinct non-NULL keys, used for cardinality estimates. */
  get distinctKeys(): number {
    return this.buckets.size;
  }

  get size(): number {
    let n = this.nullRows.length;
    for (const rows of this.buckets.values()) n += rows.length;
    return n;
  }

  add(row: Row, rowId: number): void {
    const key = encodeKey(row[this.ordinal] ?? null);
    if (key === null) {
      this.nullRows.push(rowId);
      return;
    }
    const bucket = this.buckets.get(key);
    if (bucket === undefined) this.buckets.set(key, [rowId]);
    else bucket.push(rowId);
  }

  /** Row ids matching `value` under `=`. NULL matches nothing, as `= NULL` is unknown. */
  lookup(value: Value): readonly number[] {
    const key = encodeKey(value);
    if (key === null) return [];
    return this.buckets.get(key) ?? [];
  }

  static build(name: string, table: string, column: string, ordinal: number, rows: readonly Row[]): HashIndex {
    const index = new HashIndex(name, table, column, ordinal);
    for (let i = 0; i < rows.length; i++) index.add(rows[i]!, i);
    return index;
  }
}
