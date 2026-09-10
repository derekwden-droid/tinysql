import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Catalog } from "../src/engine/catalog.js";
import { createTableFromCsv } from "../src/engine/csv.js";
import { run } from "../src/engine/executor.js";
import { serializePlan } from "../src/engine/planner.js";

const DATASETS = ["employees", "departments", "orders"] as const;

function dataset(name: string): string {
  return readFileSync(new URL(`../public/datasets/${name}.csv`, import.meta.url), "utf8");
}

function loaded(): Catalog {
  const catalog = new Catalog();
  for (const name of DATASETS) createTableFromCsv(catalog, name, dataset(name));
  return catalog;
}

/** The query the README tells a newcomer to run. */
const SAMPLE_JOIN = `
  SELECT e.name AS employee, d.name AS department
  FROM employees e
  JOIN departments d ON e.dept_id = d.id
  WHERE e.dept_id = 3`;

/** Frozen against the committed CSVs. Changing the data must fail here first. */
const ENGINEERING = [
  "Ada Lovelace",
  "Grace Hopper",
  "Alan Turing",
  "Barbara Liskov",
  "Katherine Johnson",
  "Margaret Hamilton",
  "Linus Torvalds",
];

describe("bundled datasets", () => {
  let catalog: Catalog;
  beforeAll(() => {
    catalog = loaded();
  });

  it("loads with the expected shape and inferred types", () => {
    expect(catalog.tableNames()).toEqual(["departments", "employees", "orders"]);
    expect(catalog.rowCount("employees")).toBe(44);
    expect(catalog.rowCount("departments")).toBe(8);
    expect(catalog.rowCount("orders")).toBe(48);

    expect(catalog.columns("employees").map((c) => `${c.name}:${c.type}`)).toEqual([
      "id:integer",
      "name:text",
      "dept_id:integer",
      "salary:integer",
      "city:text",
    ]);
    expect(catalog.columns("orders").map((c) => `${c.name}:${c.type}`)).toEqual([
      "id:integer",
      "employee_id:integer",
      "amount:real",
      "placed_at:text",
    ]);
  });

  it("reads a city that contains a comma", () => {
    const result = run("SELECT name FROM employees WHERE city = 'Tampa, FL' LIMIT 3;", catalog);
    expect(result.rows).toEqual([["Ada Lovelace"], ["Alan Turing"], ["Margaret Hamilton"]]);
  });

  it("treats blank cities as NULL", () => {
    const result = run("SELECT name FROM employees WHERE city IS NULL;", catalog);
    expect(result.rows.flat()).toEqual(["Evelyn Boyd", "Thelma Estrin"]);
  });

  it("compares ISO-8601 dates lexicographically", () => {
    const result = run("SELECT id FROM orders WHERE placed_at >= '2026-07-01';", catalog);
    expect(result.rows.flat()).toEqual([42, 43, 44, 45, 46, 47, 48]);
  });
});

describe("the sample join", () => {
  it("returns the engineering department without an index", () => {
    const catalog = loaded();
    const result = run(`${SAMPLE_JOIN};`, catalog);
    expect(result.columns).toEqual(["employee", "department"]);
    expect(result.rows.map((r) => r[0])).toEqual(ENGINEERING);
    expect(result.rows.every((r) => r[1] === "Engineering")).toBe(true);
    expect(result.stats.indexHits).toBe(0);
  });

  it("returns exactly the same rows with an index, but touches far fewer", () => {
    const catalog = loaded();
    const scan = run(`${SAMPLE_JOIN};`, catalog);

    run("CREATE INDEX emp_dept ON employees (dept_id);", catalog);
    const lookup = run(`${SAMPLE_JOIN};`, catalog);

    // The whole promise of the planner: same answer, less work.
    expect(lookup.rows).toEqual(scan.rows);
    expect(lookup.stats.indexHits).toBe(7);
    expect(lookup.stats.rowsTouched).toBeLessThan(scan.stats.rowsTouched);
  });

  it("plans an IndexLookup under the join once the index exists", () => {
    const catalog = loaded();
    run("CREATE INDEX emp_dept ON employees (dept_id);", catalog);
    const explained = run(`EXPLAIN ${SAMPLE_JOIN};`, catalog);

    expect(serializePlan(explained.plan!)).toBe(
      [
        "Project(employee, department)",
        "  NestedLoopJoin(e.dept_id = d.id)",
        "    IndexLookup(employees AS e using emp_dept on dept_id = 3)",
        "    SeqScan(departments AS d)",
      ].join("\n"),
    );
    expect(explained.explained).toBe(true);
    expect(explained.rows).toHaveLength(4);
  });

  it("keeps the answer stable across every dept_id, indexed or not", () => {
    const scanCatalog = loaded();
    const indexCatalog = loaded();
    run("CREATE INDEX emp_dept ON employees (dept_id);", indexCatalog);

    for (let deptId = 0; deptId <= 9; deptId++) {
      const sql = `
        SELECT e.name AS employee, d.name AS department
        FROM employees e
        JOIN departments d ON e.dept_id = d.id
        WHERE e.dept_id = ${deptId}
        ORDER BY e.id;`;
      const a = run(sql, scanCatalog);
      const b = run(sql, indexCatalog);
      expect(JSON.stringify(b.rows), `dept_id = ${deptId} disagreed`).toBe(JSON.stringify(a.rows));
    }
  });
});
