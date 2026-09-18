import { ExecError, PlanningError } from "./errors.js";
import { parse } from "./parser.js";
import { encodeRowKey } from "./hash-index.js";
import {
  children,
  explainRows,
  outputColumnNames,
  planSelect,
  type PExpr,
  type PlanNode,
} from "./planner.js";
import { typeRank, type Bool3, type Row, type Value } from "./types.js";
import type { Catalog } from "./catalog.js";
import type { Expr, Statement } from "./ast.js";

export interface NodeStats {
  /** Rows this node emitted. Compared against `estRows` in the plan view. */
  actualRows: number;
  /**
   * Base-relation rows this node read. Only scans, lookups and the join's inner
   * side count, so the total is the number that actually moves when the planner
   * picks an index rather than a scan.
   */
  rowsTouched: number;
}

export interface ExecStats {
  rowsTouched: number;
  indexHits: number;
  elapsedMs: number;
  /** Names of indexes the plan actually used. */
  indexesUsed: string[];
}

export interface QueryResult {
  columns: string[];
  rows: Row[];
  stats: ExecStats;
  /** Present for SELECT and EXPLAIN. */
  plan?: PlanNode;
  /** Runtime counters keyed by plan node id. */
  nodeStats?: Map<number, NodeStats>;
  /** True when `rows` describe the plan rather than data. */
  explained?: boolean;
  /** Message for statements that return no rows. */
  notice?: string;
}

// ------------------------------------------------------- three-valued logic

export function and3(a: Bool3, b: Bool3): Bool3 {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}

export function or3(a: Bool3, b: Bool3): Bool3 {
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

export function not3(a: Bool3): Bool3 {
  return a === null ? null : !a;
}

/** WHERE keeps TRUE only: UNKNOWN and FALSE both drop the row. */
export function isTrue(v: Bool3): boolean {
  return v === true;
}

/**
 * Total order across types: null < boolean < number < text. Used by ORDER BY and
 * by the ordering comparisons, so both agree.
 */
export function compareValues(a: Value, b: Value): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (a === null || b === null) return 0;
  if (typeof a === "boolean" && typeof b === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Values of different types are never equal; `1` and `1.0` are one value. */
export function valuesEqual(a: Value, b: Value): boolean {
  return a === b;
}

const likeCache = new Map<string, RegExp>();

/** `%` matches any sequence, `_` exactly one character. Case-sensitive in v1. */
export function likeToRegExp(pattern: string): RegExp {
  const cached = likeCache.get(pattern);
  if (cached !== undefined) return cached;
  let out = "^";
  for (const ch of pattern) {
    if (ch === "%") out += "[\\s\\S]*";
    else if (ch === "_") out += "[\\s\\S]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  out += "$";
  const re = new RegExp(out);
  likeCache.set(pattern, re);
  return re;
}

// ------------------------------------------------------------- expressions

export function evaluate(expr: PExpr, row: Row): Value {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "ordinal":
      return row[expr.index] ?? null;
    case "not":
      return not3(asBool3(evaluate(expr.expr, row)));
    case "isNull": {
      const v = evaluate(expr.expr, row);
      return expr.negated ? v !== null : v === null;
    }
    case "like": {
      const v = evaluate(expr.expr, row);
      const p = evaluate(expr.pattern, row);
      if (v === null || p === null) return null;
      if (typeof v !== "string" || typeof p !== "string") return null;
      return likeToRegExp(p).test(v);
    }
    case "binary": {
      if (expr.op === "and") {
        return and3(asBool3(evaluate(expr.left, row)), asBool3(evaluate(expr.right, row)));
      }
      if (expr.op === "or") {
        return or3(asBool3(evaluate(expr.left, row)), asBool3(evaluate(expr.right, row)));
      }
      const a = evaluate(expr.left, row);
      const b = evaluate(expr.right, row);
      if (a === null || b === null) return null;
      switch (expr.op) {
        case "=":
          return valuesEqual(a, b);
        case "!=":
          return !valuesEqual(a, b);
        case "<":
          return compareValues(a, b) < 0;
        case "<=":
          return compareValues(a, b) <= 0;
        case ">":
          return compareValues(a, b) > 0;
        case ">=":
          return compareValues(a, b) >= 0;
      }
    }
  }
}

/** Non-boolean values in a boolean position are UNKNOWN rather than truthy. */
function asBool3(v: Value): Bool3 {
  if (v === null) return null;
  return typeof v === "boolean" ? v : null;
}

// ------------------------------------------------------------------ runtime

interface ExecContext {
  catalog: Catalog;
  stats: Map<number, NodeStats>;
}

function statsFor(ctx: ExecContext, id: number): NodeStats {
  let s = ctx.stats.get(id);
  if (s === undefined) {
    s = { actualRows: 0, rowsTouched: 0 };
    ctx.stats.set(id, s);
  }
  return s;
}

/** Whether a join's inner side probes an index with the outer row, rather than scanning. */
function probesOuter(node: PlanNode): boolean {
  if (node.op === "IndexLookup") return node.probe.kind === "outer";
  return node.op === "Filter" && probesOuter(node.child);
}

/**
 * `outer` is the current outer row when this node sits on the inner side of an
 * index nested loop; a join probe reads its key from it.
 */
function* execNode(node: PlanNode, ctx: ExecContext, outer?: Row): Generator<Row> {
  const self = statsFor(ctx, node.id);

  switch (node.op) {
    case "SeqScan": {
      const table = ctx.catalog.getTable(node.table);
      for (const row of table.rows) {
        self.rowsTouched++;
        self.actualRows++;
        yield row;
      }
      return;
    }

    case "IndexLookup": {
      const table = ctx.catalog.getTable(node.table);
      // Run the index the plan names, not whatever a fresh (table, column)
      // lookup would find: the plan node is the record of what was chosen.
      const index = ctx.catalog.getIndex(node.index);
      if (index === undefined || index.table !== node.table || index.column !== node.column) {
        throw new ExecError(`index '${node.index}' changed between planning and execution`);
      }
      let key: Value;
      if (node.probe.kind === "literal") {
        key = node.probe.value;
      } else {
        if (outer === undefined) {
          throw new ExecError(`join probe on '${node.index}' ran without an outer row`);
        }
        key = outer[node.probe.ordinal] ?? null;
      }
      for (const rowId of index.lookup(key)) {
        self.rowsTouched++;
        self.actualRows++;
        yield table.rows[rowId]!;
      }
      return;
    }

    case "Filter": {
      for (const row of execNode(node.child, ctx, outer)) {
        if (isTrue(asBool3(evaluate(node.predicate, row)))) {
          self.actualRows++;
          yield row;
        }
      }
      return;
    }

    case "NestedLoopJoin": {
      if (probesOuter(node.right)) {
        // Index nested loop: run the inner side once per outer row, keyed by
        // that row. Its rows are counted where they are read, at the lookup;
        // this node reads nothing itself.
        for (const outerRow of execNode(node.left, ctx)) {
          const key = outerRow[node.leftCol] ?? null;
          if (key === null) continue;
          for (const row of execNode(node.right, ctx, outerRow)) {
            // Re-check `=`: the index narrows the rows, it never decides the answer.
            if (valuesEqual(key, row[node.rightCol] ?? null)) {
              self.actualRows++;
              yield [...outerRow, ...row];
            }
          }
        }
        return;
      }

      // Otherwise the inner side is materialised once and rescanned per outer row.
      const inner: Row[] = [...execNode(node.right, ctx)];
      for (const outer of execNode(node.left, ctx)) {
        const key = outer[node.leftCol] ?? null;
        for (const row of inner) {
          self.rowsTouched++;
          if (key !== null && valuesEqual(key, row[node.rightCol] ?? null)) {
            self.actualRows++;
            yield [...outer, ...row];
          }
        }
      }
      return;
    }

    case "Project": {
      if (node.child === undefined) {
        self.actualRows++;
        yield node.items.map((item) => evaluate(item.expr, []));
        return;
      }
      for (const row of execNode(node.child, ctx)) {
        self.actualRows++;
        yield node.items.map((item) => evaluate(item.expr, row));
      }
      return;
    }

    case "Sort": {
      const buffered = [...execNode(node.child, ctx)];
      buffered.sort((a, b) => {
        for (const key of node.keys) {
          const c = compareValues(a[key.index] ?? null, b[key.index] ?? null);
          if (c !== 0) return key.direction === "asc" ? c : -c;
        }
        return 0;
      });
      for (const row of buffered) {
        self.actualRows++;
        yield row;
      }
      return;
    }

    case "Distinct": {
      const seen = new Set<string>();
      for (const row of execNode(node.child, ctx)) {
        const key = encodeRowKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        self.actualRows++;
        yield row;
      }
      return;
    }

    case "Limit": {
      let skipped = 0;
      let emitted = 0;
      if (node.count === 0) return;
      for (const row of execNode(node.child, ctx)) {
        if (skipped < node.offset) {
          skipped++;
          continue;
        }
        self.actualRows++;
        emitted++;
        yield row;
        if (emitted >= node.count) return;
      }
      return;
    }
  }
}

function collectStats(plan: PlanNode, nodeStats: Map<number, NodeStats>, elapsedMs: number): ExecStats {
  let rowsTouched = 0;
  let indexHits = 0;
  const indexesUsed: string[] = [];

  const walk = (node: PlanNode): void => {
    const s = nodeStats.get(node.id);
    if (s !== undefined) rowsTouched += s.rowsTouched;
    if (node.op === "IndexLookup") {
      indexHits += s?.actualRows ?? 0;
      if (!indexesUsed.includes(node.index)) indexesUsed.push(node.index);
    }
    for (const child of children(node)) walk(child);
  };
  walk(plan);

  return { rowsTouched, indexHits, elapsedMs, indexesUsed };
}

function emptyStats(elapsedMs: number): ExecStats {
  return { rowsTouched: 0, indexHits: 0, elapsedMs, indexesUsed: [] };
}

// --------------------------------------------------------------- statements

/** Evaluate a constant expression from an INSERT ... VALUES list. */
function constantValue(expr: Expr, table: string): Value {
  if (expr.kind !== "literal") {
    throw new ExecError(`INSERT INTO ${table} accepts literal values only`);
  }
  return expr.value;
}

function executeStatement(stmt: Statement, catalog: Catalog): QueryResult {
  const started = performance.now();

  switch (stmt.kind) {
    case "createTable": {
      catalog.createTable({ name: stmt.name, columns: stmt.columns });
      return {
        columns: [],
        rows: [],
        stats: emptyStats(performance.now() - started),
        notice: `table '${stmt.name}' created`,
      };
    }

    case "createIndex": {
      const index = catalog.createIndex(stmt.name, stmt.table, stmt.column);
      return {
        columns: [],
        rows: [],
        stats: emptyStats(performance.now() - started),
        notice: `index '${stmt.name}' created on ${stmt.table}(${stmt.column}), ${index.size} rows indexed`,
      };
    }

    case "dropTable": {
      catalog.dropTable(stmt.name);
      return {
        columns: [],
        rows: [],
        stats: emptyStats(performance.now() - started),
        notice: `table '${stmt.name}' dropped`,
      };
    }

    case "insert": {
      const table = catalog.getTable(stmt.table);
      const ordinals = stmt.columns.map((name) => {
        const ordinal = table.columnIndex.get(name);
        if (ordinal === undefined) {
          throw new ExecError(`no such column: ${stmt.table}.${name}`);
        }
        return ordinal;
      });
      const seen = new Set<number>();
      for (const o of ordinals) {
        if (seen.has(o)) throw new ExecError(`column '${table.def.columns[o]!.name}' listed twice`);
        seen.add(o);
      }

      const rows: Row[] = stmt.rows.map((values) => {
        if (values.length !== ordinals.length) {
          throw new ExecError(
            `expected ${ordinals.length} values but found ${values.length}`,
          );
        }
        const row: Row = table.def.columns.map(() => null);
        values.forEach((expr, i) => {
          row[ordinals[i]!] = constantValue(expr, stmt.table);
        });
        return row;
      });

      // The catalog checks every value against its declared type, all rows
      // before any is written.
      const n = catalog.insert(stmt.table, rows);
      return {
        columns: [],
        rows: [],
        stats: emptyStats(performance.now() - started),
        notice: `${n} row${n === 1 ? "" : "s"} inserted into '${stmt.table}'`,
      };
    }

    case "explain": {
      const plan = planSelect(stmt.select, catalog);
      const rows: Row[] = explainRows(plan).map((r) => [
        r.id,
        `${"  ".repeat(r.depth)}${r.op}`,
        r.detail,
        r.estRows,
      ]);
      return {
        columns: ["id", "op", "detail", "est_rows"],
        rows,
        stats: emptyStats(performance.now() - started),
        plan,
        explained: true,
        notice: "estimates only — run the query to see actual rows",
      };
    }

    case "select": {
      const plan = planSelect(stmt, catalog);
      const ctx: ExecContext = { catalog, stats: new Map() };
      const rows = [...execNode(plan, ctx)];
      const elapsedMs = performance.now() - started;
      return {
        columns: outputColumnNames(plan.schema),
        rows,
        stats: collectStats(plan, ctx.stats, elapsedMs),
        plan,
        nodeStats: ctx.stats,
      };
    }
  }
}

/**
 * Parse and run a script. Statements execute in order and the last result is
 * returned, so `CREATE INDEX ...; EXPLAIN SELECT ...;` behaves as written.
 */
export function run(sql: string, catalog: Catalog): QueryResult {
  const statements = parse(sql);
  let result: QueryResult | null = null;
  for (const stmt of statements) {
    result = executeStatement(stmt, catalog);
  }
  if (result === null) throw new PlanningError("no statement to run");
  return result;
}

/** Run one statement and return its rows; convenience for tests. */
export function query(sql: string, catalog: Catalog): QueryResult {
  return run(sql, catalog);
}
