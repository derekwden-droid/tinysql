import { ExecError, PlanningError } from "./errors.js";
import { formatValue } from "./format.js";
import { HashIndex, encodeKey } from "./hash-index.js";
import { fitsType, type ColumnDef, type Row, type TableDef } from "./types.js";

export const MAX_ROWS = 200_000;
export const MAX_BYTES = 20 * 1024 * 1024;

export interface TableState {
  def: TableDef;
  rows: Row[];
  /** column name → ordinal */
  columnIndex: Map<string, number>;
}

/**
 * The only mutable store in the engine. Everything else is a pure function of
 * (AST, catalog).
 */
export class Catalog {
  private readonly tables = new Map<string, TableState>();
  private readonly indexes = new Map<string, HashIndex>();
  /** Bumped on any mutation so cached column statistics can be invalidated. */
  private version = 0;
  private readonly distinctCache = new Map<string, number>();

  // ------------------------------------------------------------------- tables

  createTable(def: TableDef): void {
    if (this.tables.has(def.name)) {
      throw new ExecError(`table '${def.name}' already exists`);
    }
    const columnIndex = new Map<string, number>();
    def.columns.forEach((c, i) => {
      if (columnIndex.has(c.name)) {
        throw new ExecError(`duplicate column '${c.name}' in table '${def.name}'`);
      }
      columnIndex.set(c.name, i);
    });
    this.tables.set(def.name, { def, rows: [], columnIndex });
    this.version++;
  }

  dropTable(name: string): void {
    if (!this.tables.has(name)) {
      throw new ExecError(`no such table: ${name}`);
    }
    this.tables.delete(name);
    // Indexes cannot outlive their table.
    for (const [indexName, index] of this.indexes) {
      if (index.table === name) this.indexes.delete(indexName);
    }
    this.version++;
    this.distinctCache.clear();
  }

  hasTable(name: string): boolean {
    return this.tables.has(name);
  }

  /** Throws PlanningError, because an unknown table is a binding failure. */
  getTable(name: string): TableState {
    const table = this.tables.get(name);
    if (table === undefined) throw new PlanningError(`no such table: ${name}`);
    return table;
  }

  tableNames(): string[] {
    return [...this.tables.keys()].sort();
  }

  columns(name: string): ColumnDef[] {
    return this.getTable(name).def.columns;
  }

  rowCount(name: string): number {
    return this.getTable(name).rows.length;
  }

  // -------------------------------------------------------------------- rows

  /**
   * Append rows, maintaining every index on the table. Every value is checked
   * against its column's declared type before anything is written, so a failed
   * insert changes nothing, and no write path (INSERT, CSV import, the UI's
   * generator) can store a value its column's type does not allow.
   */
  insert(tableName: string, rows: Row[]): number {
    const table = this.getTable(tableName);
    if (table.rows.length + rows.length > MAX_ROWS) {
      throw new ExecError(
        `table '${tableName}' would exceed the ${MAX_ROWS.toLocaleString("en-US")} row cap`,
      );
    }
    for (const row of rows) {
      table.def.columns.forEach((column, i) => {
        const value = row[i] ?? null;
        if (!fitsType(value, column.type)) {
          const shown = typeof value === "string" ? `'${value}'` : formatValue(value);
          throw new ExecError(`cannot store ${shown} in ${column.type} column '${column.name}'`);
        }
      });
    }
    const tableIndexes = [...this.indexes.values()].filter((i) => i.table === tableName);
    for (const row of rows) {
      const rowId = table.rows.length;
      table.rows.push(row);
      for (const index of tableIndexes) index.add(row, rowId);
    }
    this.version++;
    this.distinctCache.clear();
    return rows.length;
  }

  // ------------------------------------------------------------------ indexes

  createIndex(name: string, tableName: string, column: string): HashIndex {
    if (this.indexes.has(name)) {
      throw new ExecError(`index '${name}' already exists`);
    }
    const table = this.getTable(tableName);
    const ordinal = table.columnIndex.get(column);
    if (ordinal === undefined) {
      throw new ExecError(`no such column: ${tableName}.${column}`);
    }
    // One index per column: a second would hold identical rows, cost every
    // INSERT a second update, and leave the planner choosing by creation order.
    const existing = this.findIndex(tableName, column);
    if (existing !== undefined) {
      throw new ExecError(`${tableName}.${column} is already indexed by '${existing.name}'`);
    }
    const index = HashIndex.build(name, tableName, column, ordinal, table.rows);
    this.indexes.set(name, index);
    this.version++;
    return index;
  }

  /** The index the planner would use for `table.column = ?`, if one exists. */
  findIndex(tableName: string, column: string): HashIndex | undefined {
    for (const index of this.indexes.values()) {
      if (index.table === tableName && index.column === column) return index;
    }
    return undefined;
  }

  indexesFor(tableName: string): HashIndex[] {
    return [...this.indexes.values()].filter((i) => i.table === tableName);
  }

  getIndex(name: string): HashIndex | undefined {
    return this.indexes.get(name);
  }

  indexNames(): string[] {
    return [...this.indexes.keys()].sort();
  }

  // --------------------------------------------------------------- statistics

  /**
   * Distinct non-NULL values in a column. Used for join and index cardinality
   * estimates; memoised against the mutation counter.
   */
  distinctCount(tableName: string, column: string): number {
    const key = `${this.version}\u0000${tableName}\u0000${column}`;
    const cached = this.distinctCache.get(key);
    if (cached !== undefined) return cached;

    const index = this.findIndex(tableName, column);
    if (index !== undefined) {
      this.distinctCache.set(key, index.distinctKeys);
      return index.distinctKeys;
    }

    const table = this.getTable(tableName);
    const ordinal = table.columnIndex.get(column);
    if (ordinal === undefined) return 1;
    const seen = new Set<string>();
    for (const row of table.rows) {
      const k = encodeKey(row[ordinal] ?? null);
      if (k !== null) seen.add(k);
    }
    this.distinctCache.set(key, seen.size);
    return seen.size;
  }
}
