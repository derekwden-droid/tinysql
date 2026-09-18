import { describe, expect, it } from "vitest";
import { Catalog } from "../src/engine/catalog.js";
import { run } from "../src/engine/executor.js";
import { parseOne } from "../src/engine/parser.js";
import { planSelect, serializePlan, suggestIndex, type PlanNode } from "../src/engine/planner.js";
import { PlanningError } from "../src/engine/errors.js";

function seeded(): Catalog {
  const catalog = new Catalog();
  run(
    `CREATE TABLE employees (id INTEGER, name TEXT, dept_id INTEGER, salary INTEGER, city TEXT);
     CREATE TABLE departments (id INTEGER, name TEXT, floor INTEGER);
     INSERT INTO employees (id, name, dept_id, salary, city) VALUES
       (1, 'Ada', 3, 90000, 'Tampa'),
       (2, 'Grace', 3, 95000, 'Tampa'),
       (3, 'Linus', 1, 70000, 'Ocala'),
       (4, 'Barbara', 2, 88000, 'Miami');
     INSERT INTO departments (id, name, floor) VALUES (1, 'Ops', 1), (2, 'Sales', 2), (3, 'Eng', 3);`,
    catalog,
  );
  return catalog;
}

function plan(sql: string, catalog: Catalog): string {
  const stmt = parseOne(sql);
  if (stmt.kind !== "select") throw new Error("expected a select");
  return serializePlan(planSelect(stmt, catalog));
}

describe("planner", () => {
  it("uses a sequential scan when no index exists", () => {
    const catalog = seeded();
    expect(plan("SELECT name FROM employees WHERE dept_id = 3", catalog)).toBe(
      [
        "Project(employees.name)",
        "  Filter(employees.dept_id = 3)",
        "    SeqScan(employees)",
      ].join("\n"),
    );
  });

  it("switches to an index lookup once the index exists", () => {
    const catalog = seeded();
    run("CREATE INDEX emp_dept ON employees (dept_id);", catalog);
    expect(plan("SELECT name FROM employees WHERE dept_id = 3", catalog)).toBe(
      [
        "Project(employees.name)",
        "  IndexLookup(employees using emp_dept on dept_id = 3)",
      ].join("\n"),
    );
  });

  it("keeps the remaining AND predicate in a Filter above the lookup", () => {
    const catalog = seeded();
    run("CREATE INDEX emp_dept ON employees (dept_id);", catalog);
    expect(plan("SELECT name FROM employees WHERE dept_id = 3 AND salary > 90000", catalog)).toBe(
      [
        "Project(employees.name)",
        "  Filter(employees.salary > 90000)",
        "    IndexLookup(employees using emp_dept on dept_id = 3)",
      ].join("\n"),
    );
  });

  it("matches the literal on either side of the equality", () => {
    const catalog = seeded();
    run("CREATE INDEX emp_dept ON employees (dept_id);", catalog);
    expect(plan("SELECT name FROM employees WHERE 3 = dept_id", catalog)).toContain("IndexLookup");
  });

  it("never turns `= NULL` into an index lookup", () => {
    const catalog = seeded();
    run("CREATE INDEX emp_dept ON employees (dept_id);", catalog);
    expect(plan("SELECT name FROM employees WHERE dept_id = NULL", catalog)).toContain("SeqScan");
  });

  // The case the original spec could not produce: the predicate is written
  // against a table ALIAS and sits in a join query, so the planner has to
  // resolve `e.dept_id` to `employees.dept_id` AND push it below the join.
  it("resolves through a table alias and pushes the predicate below the join", () => {
    const catalog = seeded();
    run("CREATE INDEX emp_dept ON employees (dept_id);", catalog);
    const sql = `
      SELECT e.name AS employee, d.name AS department
      FROM employees e
      JOIN departments d ON e.dept_id = d.id
      WHERE e.dept_id = 3`;
    expect(plan(sql, catalog)).toBe(
      [
        "Project(employee, department)",
        "  NestedLoopJoin(e.dept_id = d.id)",
        "    IndexLookup(employees AS e using emp_dept on dept_id = 3)",
        "    SeqScan(departments AS d)",
      ].join("\n"),
    );
  });

  it("keeps a predicate spanning both tables above the join", () => {
    const catalog = seeded();
    const sql = `
      SELECT e.name AS n FROM employees e
      JOIN departments d ON e.dept_id = d.id
      WHERE e.salary > d.floor AND e.city = 'Tampa'`;
    expect(plan(sql, catalog)).toBe(
      [
        "Project(n)",
        "  Filter(e.salary > d.floor)",
        "    NestedLoopJoin(e.dept_id = d.id)",
        "      Filter(e.city = 'Tampa')",
        "        SeqScan(employees AS e)",
        "      SeqScan(departments AS d)",
      ].join("\n"),
    );
  });

  it("sorts below the projection so ORDER BY can name an unselected column", () => {
    const catalog = seeded();
    expect(plan("SELECT name FROM employees ORDER BY salary DESC LIMIT 5", catalog)).toBe(
      [
        "Limit(count=5)",
        "  Project(employees.name)",
        "    Sort(employees.salary DESC)",
        "      SeqScan(employees)",
      ].join("\n"),
    );
  });

  it("sorts above the projection when DISTINCT is present", () => {
    const catalog = seeded();
    expect(plan("SELECT DISTINCT dept_id FROM employees ORDER BY dept_id", catalog)).toBe(
      [
        "Sort(employees.dept_id ASC)",
        "  Distinct",
        "    Project(employees.dept_id)",
        "      SeqScan(employees)",
      ].join("\n"),
    );
  });

  it("rejects ORDER BY on an unselected column under DISTINCT", () => {
    const catalog = seeded();
    expect(() => plan("SELECT DISTINCT dept_id FROM employees ORDER BY salary", catalog)).toThrow(
      PlanningError,
    );
  });

  it("plans a tableless SELECT as a childless projection", () => {
    const catalog = seeded();
    expect(plan("SELECT 1 AS n, 'x' AS t", catalog)).toBe("Project(n, t)");
  });

  it("reports binding failures as PlanningError", () => {
    const catalog = seeded();
    expect(() => plan("SELECT * FROM nope", catalog)).toThrow(/no such table/);
    expect(() => plan("SELECT missing FROM employees", catalog)).toThrow(/no such column/);
    expect(() => plan("SELECT x.name FROM employees e", catalog)).toThrow(/unknown table qualifier/);
    // Once aliased, the original table name no longer refers to the relation.
    expect(() => plan("SELECT employees.name FROM employees e", catalog)).toThrow(
      /unknown table qualifier/,
    );
  });

  it("reports an ambiguous unqualified column across a join", () => {
    const catalog = seeded();
    expect(() =>
      plan("SELECT name FROM employees e JOIN departments d ON e.dept_id = d.id", catalog),
    ).toThrow(/ambiguous column/);
  });
});

describe("index suggestions", () => {
  function tree(sql: string, catalog: Catalog): PlanNode {
    const stmt = parseOne(sql);
    if (stmt.kind !== "select") throw new Error("expected a select");
    return planSelect(stmt, catalog);
  }

  const SAMPLE_JOIN = `
    SELECT e.name AS employee, d.name AS department
    FROM employees e
    JOIN departments d ON e.dept_id = d.id
    WHERE e.dept_id = 3`;

  it("names the index the aliased sample join is missing", () => {
    const catalog = seeded();
    expect(suggestIndex(tree(SAMPLE_JOIN, catalog))).toEqual({ table: "employees", column: "dept_id" });
  });

  it("suggests nothing once the plan already uses that index", () => {
    const catalog = seeded();
    run("CREATE INDEX emp_dept ON employees (dept_id);", catalog);
    expect(suggestIndex(tree(SAMPLE_JOIN, catalog))).toBeNull();
  });

  it("suggests nothing for predicates a hash index cannot serve", () => {
    const catalog = seeded();
    for (const where of [
      "salary > 90000",
      "city LIKE 'T%'",
      "city IS NULL",
      "dept_id = NULL",
      "dept_id = 3 OR dept_id = 1",
      "NOT dept_id = 3",
      "dept_id = id",
    ]) {
      expect(suggestIndex(tree(`SELECT name FROM employees WHERE ${where}`, catalog)), where).toBeNull();
    }
    expect(suggestIndex(tree("SELECT name FROM employees", catalog))).toBeNull();
  });

  it("suggests nothing for an equality that spans both sides of a join", () => {
    const catalog = seeded();
    const sql = "SELECT e.name AS n FROM employees e JOIN departments d ON e.dept_id = d.id WHERE e.id = d.floor";
    expect(suggestIndex(tree(sql, catalog))).toBeNull();
  });

  it("follows the planner's first-match order among conjuncts", () => {
    const catalog = seeded();
    const sql = "SELECT name FROM employees WHERE salary > 1 AND city = 'Tampa' AND dept_id = 3";
    expect(suggestIndex(tree(sql, catalog))).toEqual({ table: "employees", column: "city" });
  });

  it("works through both sides of a join, one index at a time", () => {
    const catalog = seeded();
    const sql = `SELECT e.name AS n FROM employees e JOIN departments d ON e.dept_id = d.id
                 WHERE e.dept_id = 3 AND d.floor = 3`;
    expect(suggestIndex(tree(sql, catalog))).toEqual({ table: "employees", column: "dept_id" });
    run("CREATE INDEX emp_dept ON employees (dept_id);", catalog);
    expect(suggestIndex(tree(sql, catalog))).toEqual({ table: "departments", column: "floor" });
    run("CREATE INDEX dept_floor ON departments (floor);", catalog);
    expect(suggestIndex(tree(sql, catalog))).toBeNull();
  });

  // The property the UI's "Create index and rerun" button depends on: taking a
  // suggestion always turns that scan into a lookup on that column.
  it("always names an index that turns the scan into an IndexLookup", () => {
    const queries = [
      "SELECT name FROM employees WHERE dept_id = 3",
      "SELECT name FROM employees WHERE 3 = dept_id",
      "SELECT name FROM employees WHERE salary > 1 AND city = 'Tampa' AND dept_id = 3",
      "SELECT name FROM employees WHERE name = 'Ada' AND 1 = 1",
      "SELECT name FROM employees WHERE city = 'Tampa' ORDER BY salary DESC LIMIT 2",
      "SELECT DISTINCT city FROM employees WHERE dept_id = 3",
      SAMPLE_JOIN,
      "SELECT e.name AS n FROM employees e JOIN departments d ON e.dept_id = d.id WHERE d.floor = 2",
      "SELECT e.name AS n FROM employees e JOIN departments d ON e.dept_id = d.id WHERE e.salary > d.floor AND e.city = 'Tampa'",
    ];
    for (const sql of queries) {
      const catalog = seeded();
      const suggestion = suggestIndex(tree(sql, catalog));
      expect(suggestion, sql).not.toBeNull();
      run(`CREATE INDEX probe ON ${suggestion!.table} (${suggestion!.column});`, catalog);
      expect(plan(sql, catalog), sql).toContain(`using probe on ${suggestion!.column} = `);
    }
  });
});

describe("cardinality estimates", () => {
  it("estimates a sequential scan at the table size and a filter at 30%", () => {
    const catalog = seeded();
    const stmt = parseOne("SELECT name FROM employees WHERE salary > 1");
    if (stmt.kind !== "select") throw new Error("expected a select");
    const root = planSelect(stmt, catalog);
    // Project -> Filter -> SeqScan
    if (root.op !== "Project" || root.child === undefined) throw new Error("unexpected plan");
    expect(root.child.estRows).toBe(2); // ceil(4 * 0.3)
    expect(root.child.op === "Filter" ? root.child.child.estRows : -1).toBe(4);
  });

  it("estimates an index lookup as rows / distinct keys", () => {
    const catalog = seeded();
    run("CREATE INDEX emp_dept ON employees (dept_id);", catalog);
    const stmt = parseOne("SELECT name FROM employees WHERE dept_id = 3");
    if (stmt.kind !== "select") throw new Error("expected a select");
    const root = planSelect(stmt, catalog);
    if (root.op !== "Project" || root.child === undefined) throw new Error("unexpected plan");
    // 4 rows over 3 distinct dept_ids -> ceil(4/3) = 2
    expect(root.child.estRows).toBe(2);
  });

  it("estimates an equijoin well below the cross product", () => {
    const catalog = seeded();
    const stmt = parseOne(
      "SELECT e.name AS n FROM employees e JOIN departments d ON e.dept_id = d.id",
    );
    if (stmt.kind !== "select") throw new Error("expected a select");
    const root = planSelect(stmt, catalog);
    if (root.op !== "Project" || root.child === undefined) throw new Error("unexpected plan");
    const join = root.child;
    // 4 employees x 3 departments / 3 distinct department ids = 4, not 12.
    expect(join.estRows).toBe(4);
  });
});
