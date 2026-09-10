import { describe, expect, it } from "vitest";
import { parse, parseOne } from "../src/engine/parser.js";
import { ParseError } from "../src/engine/errors.js";
import type { SelectStmt } from "../src/engine/ast.js";

function select(sql: string): SelectStmt {
  const stmt = parseOne(sql);
  if (stmt.kind !== "select") throw new Error(`expected a select, got ${stmt.kind}`);
  return stmt;
}

describe("parser", () => {
  it("parses join + where + order + limit", () => {
    const stmt = select(`
      SELECT e.name AS employee, d.name AS department
      FROM employees e
      JOIN departments d ON e.dept_id = d.id
      WHERE e.salary > 50000 AND d.floor = 3
      ORDER BY e.name DESC, d.name
      LIMIT 10 OFFSET 5
    `);

    expect(stmt.from).toEqual(expect.objectContaining({ name: "employees", alias: "e" }));
    expect(stmt.join?.table).toEqual(expect.objectContaining({ name: "departments", alias: "d" }));
    expect(stmt.join?.left).toEqual(expect.objectContaining({ table: "e", name: "dept_id" }));
    expect(stmt.join?.right).toEqual(expect.objectContaining({ table: "d", name: "id" }));
    expect(stmt.where?.kind).toBe("binary");
    expect(stmt.orderBy.map((k) => [k.column.name, k.direction])).toEqual([
      ["name", "desc"],
      ["name", "asc"],
    ]);
    expect([stmt.limit, stmt.offset]).toEqual([10, 5]);
    expect(stmt.items.map((i) => (i.kind === "expr" ? i.alias : i.kind))).toEqual([
      "employee",
      "department",
    ]);
  });

  it("parses a tableless SELECT", () => {
    const stmt = select("SELECT 1 AS n, 'x' AS t");
    expect(stmt.from).toBeNull();
    expect(stmt.items).toHaveLength(2);
  });

  it("parses star and table.star", () => {
    const stmt = select("SELECT *, e.* FROM employees e");
    expect(stmt.items.map((i) => i.kind)).toEqual(["star", "tableStar"]);
  });

  it("gives NOT lower precedence than comparison", () => {
    const stmt = select("SELECT * FROM t WHERE NOT a = 1");
    expect(stmt.where?.kind).toBe("not");
    if (stmt.where?.kind === "not") expect(stmt.where.expr.kind).toBe("binary");
  });

  it("gives AND higher precedence than OR", () => {
    const stmt = select("SELECT * FROM t WHERE a = 1 OR b = 2 AND c = 3");
    expect(stmt.where).toEqual(expect.objectContaining({ kind: "binary", op: "or" }));
    if (stmt.where?.kind === "binary") {
      expect(stmt.where.right).toEqual(expect.objectContaining({ op: "and" }));
    }
  });

  it("parses IS NULL, IS NOT NULL and LIKE", () => {
    const stmt = select("SELECT * FROM t WHERE a IS NULL AND b IS NOT NULL AND c LIKE 'x%'");
    expect(JSON.stringify(stmt.where)).toContain('"isNull"');
    expect(JSON.stringify(stmt.where)).toContain('"like"');
  });

  it("treats <> as !=", () => {
    const a = select("SELECT * FROM t WHERE a <> 1");
    const b = select("SELECT * FROM t WHERE a != 1");
    expect(JSON.stringify(a.where)).toBe(JSON.stringify(b.where));
  });

  it("parses a multi-statement script", () => {
    const stmts = parse("CREATE INDEX i ON employees (dept_id); SELECT * FROM employees;");
    expect(stmts.map((s) => s.kind)).toEqual(["createIndex", "select"]);
  });

  it("parses CREATE TABLE, INSERT and DROP TABLE", () => {
    const create = parseOne("CREATE TABLE t (id INTEGER, name TEXT, ok BOOLEAN, r REAL)");
    expect(create).toEqual(expect.objectContaining({ kind: "createTable" }));

    const insert = parseOne("INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b')");
    if (insert.kind !== "insert") throw new Error("expected insert");
    expect(insert.rows).toHaveLength(2);

    expect(parseOne("DROP TABLE t")).toEqual(expect.objectContaining({ kind: "dropTable" }));
  });

  it("parses EXPLAIN SELECT", () => {
    const stmt = parseOne("EXPLAIN SELECT * FROM t");
    expect(stmt.kind).toBe("explain");
  });

  it("errors on a trailing comma in the select list", () => {
    expect(() => select("SELECT a, b, FROM t")).toThrow(ParseError);
  });

  it("errors on a trailing comma in a CREATE TABLE column list", () => {
    expect(() => parseOne("CREATE TABLE t (a INTEGER,)")).toThrow(ParseError);
  });

  it("rejects ORDER BY column positions with a hint", () => {
    try {
      select("SELECT a FROM t ORDER BY 1");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).hint).toContain("name the column");
    }
  });

  it("rejects a non-equality join condition", () => {
    expect(() => select("SELECT * FROM a JOIN b ON a.x > b.y")).toThrow(ParseError);
  });

  it("reports the position of an unexpected token", () => {
    try {
      select("SELECT *\nFROM employees\nWHERE");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).line).toBe(3);
      expect((e as ParseError).format()).toContain("Tinysql: parse error at 3:6");
    }
  });
});
