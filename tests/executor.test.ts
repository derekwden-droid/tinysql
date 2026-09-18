import { describe, expect, it } from "vitest";
import { Catalog } from "../src/engine/catalog.js";
import { and3, likeToRegExp, not3, or3, run } from "../src/engine/executor.js";
import type { Row } from "../src/engine/types.js";

function catalogWith(script: string): Catalog {
  const catalog = new Catalog();
  run(script, catalog);
  return catalog;
}

/** id, name, dept_id, salary, city — with NULLs in dept_id and city. */
function seeded(): Catalog {
  return catalogWith(`
    CREATE TABLE employees (id INTEGER, name TEXT, dept_id INTEGER, salary INTEGER, city TEXT);
    INSERT INTO employees (id, name, dept_id, salary, city) VALUES
      (1, 'Ada',     3,    90000, 'Tampa'),
      (2, 'Grace',   3,    95000, 'Ocala'),
      (3, 'Linus',   1,    70000, NULL),
      (4, 'Barbara', NULL, 88000, 'Miami'),
      (5, 'Alan',    2,    62000, 'Tampa');
  `);
}

function flat(rows: Row[]): unknown[] {
  return rows.map((r) => (r.length === 1 ? r[0] : r));
}

describe("three-valued logic", () => {
  it("follows the SQL truth tables", () => {
    expect(and3(true, null)).toBeNull();
    expect(and3(false, null)).toBe(false);
    expect(or3(true, null)).toBe(true);
    expect(or3(false, null)).toBeNull();
    expect(not3(null)).toBeNull();
    expect(not3(true)).toBe(false);
  });

  it("drops UNKNOWN rows from WHERE", () => {
    const catalog = seeded();
    // dept_id IS NULL for Barbara, so `= 3` and `!= 3` both exclude her.
    expect(flat(run("SELECT name FROM employees WHERE dept_id = 3;", catalog).rows)).toEqual([
      "Ada",
      "Grace",
    ]);
    expect(flat(run("SELECT name FROM employees WHERE dept_id != 3;", catalog).rows)).toEqual([
      "Linus",
      "Alan",
    ]);
  });

  it("keeps NOT of UNKNOWN out of the result", () => {
    const catalog = seeded();
    expect(flat(run("SELECT name FROM employees WHERE NOT dept_id = 3;", catalog).rows)).toEqual([
      "Linus",
      "Alan",
    ]);
  });

  it("short-circuits AND and OR correctly under 3VL", () => {
    const catalog = seeded();
    // FALSE AND UNKNOWN is FALSE, so a false conjunct wins even beside a NULL.
    expect(
      flat(run("SELECT name FROM employees WHERE salary > 999999 AND dept_id = 3;", catalog).rows),
    ).toEqual([]);
    // TRUE OR UNKNOWN is TRUE, so Barbara survives despite her NULL dept_id.
    expect(
      flat(run("SELECT name FROM employees WHERE salary > 80000 OR dept_id = 9;", catalog).rows),
    ).toEqual(["Ada", "Grace", "Barbara"]);
  });

  it("handles IS NULL and IS NOT NULL", () => {
    const catalog = seeded();
    expect(flat(run("SELECT name FROM employees WHERE city IS NULL;", catalog).rows)).toEqual([
      "Linus",
    ]);
    expect(
      run("SELECT name FROM employees WHERE dept_id IS NOT NULL;", catalog).rows,
    ).toHaveLength(4);
  });
});

describe("comparison semantics", () => {
  it("never equates values of different types", () => {
    const catalog = catalogWith(`
      CREATE TABLE t (i INTEGER, s TEXT);
      INSERT INTO t (i, s) VALUES (1, '1');
    `);
    expect(run("SELECT i FROM t WHERE i = '1';", catalog).rows).toHaveLength(0);
    expect(run("SELECT i FROM t WHERE s = 1;", catalog).rows).toHaveLength(0);
    expect(run("SELECT i FROM t WHERE s = '1';", catalog).rows).toHaveLength(1);
  });

  it("treats 1 and 1.0 as the same value", () => {
    const catalog = catalogWith(`
      CREATE TABLE t (i INTEGER);
      INSERT INTO t (i) VALUES (1), (2);
    `);
    expect(run("SELECT i FROM t WHERE i = 1.0;", catalog).rows).toHaveLength(1);
  });
});

describe("LIKE", () => {
  it("maps % to any run and _ to exactly one character", () => {
    expect(likeToRegExp("%x_").test("box1")).toBe(true);
    expect(likeToRegExp("%x_").test("ox1")).toBe(true);
    expect(likeToRegExp("%x_").test("box")).toBe(false);
    expect(likeToRegExp("a_c").test("abc")).toBe(true);
    expect(likeToRegExp("a_c").test("ac")).toBe(false);
  });

  it("escapes regular-expression metacharacters in the pattern", () => {
    expect(likeToRegExp("a.c").test("abc")).toBe(false);
    expect(likeToRegExp("a.c").test("a.c")).toBe(true);
  });

  it("is case-sensitive and returns UNKNOWN for NULL", () => {
    const catalog = seeded();
    expect(flat(run("SELECT name FROM employees WHERE name LIKE 'A%';", catalog).rows)).toEqual([
      "Ada",
      "Alan",
    ]);
    expect(run("SELECT name FROM employees WHERE name LIKE 'a%';", catalog).rows).toHaveLength(0);
    // Linus has a NULL city: LIKE against NULL is UNKNOWN, so he is dropped.
    expect(flat(run("SELECT name FROM employees WHERE city LIKE '%a%';", catalog).rows)).toEqual([
      "Ada",
      "Grace",
      "Barbara",
      "Alan",
    ]);
  });
});

describe("DISTINCT, ORDER BY, LIMIT", () => {
  it("collapses two NULLs into one DISTINCT row", () => {
    const catalog = catalogWith(`
      CREATE TABLE t (k INTEGER);
      INSERT INTO t (k) VALUES (1), (NULL), (1), (NULL), (2);
    `);
    expect(flat(run("SELECT DISTINCT k FROM t;", catalog).rows)).toEqual([1, null, 2]);
  });

  it("keeps rows apart even when text contains a NUL character", () => {
    // DISTINCT keys used to join column keys with NUL, so these two different
    // rows produced the same key and one of them vanished.
    const nul = String.fromCharCode(0);
    const catalog = catalogWith("CREATE TABLE t (a TEXT, b TEXT);");
    run(`INSERT INTO t (a, b) VALUES ('p${nul}t:q', 'r'), ('p', 'q${nul}t:r');`, catalog);
    expect(run("SELECT DISTINCT a, b FROM t;", catalog).rows).toHaveLength(2);
  });

  it("places NULLs first ascending and last descending", () => {
    const catalog = seeded();
    expect(flat(run("SELECT dept_id FROM employees ORDER BY dept_id;", catalog).rows)).toEqual([
      null, 1, 2, 3, 3,
    ]);
    expect(flat(run("SELECT dept_id FROM employees ORDER BY dept_id DESC;", catalog).rows)).toEqual([
      3, 3, 2, 1, null,
    ]);
  });

  it("orders by a column that is not in the select list", () => {
    const catalog = seeded();
    expect(flat(run("SELECT name FROM employees ORDER BY salary DESC;", catalog).rows)).toEqual([
      "Grace",
      "Ada",
      "Barbara",
      "Linus",
      "Alan",
    ]);
  });

  it("sorts on multiple keys in order", () => {
    const catalog = seeded();
    expect(
      flat(run("SELECT name FROM employees ORDER BY city, salary DESC;", catalog).rows),
    ).toEqual(["Linus", "Barbara", "Grace", "Ada", "Alan"]);
  });

  it("applies LIMIT and OFFSET", () => {
    const catalog = seeded();
    expect(
      flat(run("SELECT name FROM employees ORDER BY id LIMIT 2 OFFSET 1;", catalog).rows),
    ).toEqual(["Grace", "Linus"]);
    expect(run("SELECT name FROM employees LIMIT 0;", catalog).rows).toHaveLength(0);
  });
});

describe("projection", () => {
  it("runs a SELECT with no FROM", () => {
    const result = run("SELECT 1 AS n, 'x' AS t, NULL AS nothing;", new Catalog());
    expect(result.columns).toEqual(["n", "t", "nothing"]);
    expect(result.rows).toEqual([[1, "x", null]]);
  });

  it("qualifies duplicate output column names", () => {
    const catalog = catalogWith(`
      CREATE TABLE employees (id INTEGER, name TEXT, dept_id INTEGER);
      CREATE TABLE departments (id INTEGER, name TEXT);
      INSERT INTO employees (id, name, dept_id) VALUES (1, 'Ada', 3);
      INSERT INTO departments (id, name) VALUES (3, 'Eng');
    `);
    const result = run(
      "SELECT e.name, d.name FROM employees e JOIN departments d ON e.dept_id = d.id;",
      catalog,
    );
    expect(result.columns).toEqual(["e.name", "d.name"]);
    expect(result.rows).toEqual([["Ada", "Eng"]]);
  });

  it("expands * and table.*", () => {
    const catalog = seeded();
    expect(run("SELECT * FROM employees;", catalog).columns).toEqual([
      "id",
      "name",
      "dept_id",
      "salary",
      "city",
    ]);
  });
});

describe("statistics and EXPLAIN", () => {
  it("touches fewer rows with an index than with a scan", () => {
    const catalog = seeded();
    const scan = run("SELECT name FROM employees WHERE dept_id = 3;", catalog);
    expect(scan.stats.rowsTouched).toBe(5);
    expect(scan.stats.indexHits).toBe(0);

    run("CREATE INDEX emp_dept ON employees (dept_id);", catalog);
    const lookup = run("SELECT name FROM employees WHERE dept_id = 3;", catalog);
    expect(lookup.stats.rowsTouched).toBe(2);
    expect(lookup.stats.indexHits).toBe(2);
    expect(lookup.stats.indexesUsed).toEqual(["emp_dept"]);
    expect(lookup.rows).toEqual(scan.rows);
  });

  it("records actual rows per plan node", () => {
    const catalog = seeded();
    const result = run("SELECT name FROM employees WHERE dept_id = 3;", catalog);
    const plan = result.plan!;
    expect(result.nodeStats!.get(plan.id)!.actualRows).toBe(2);
  });

  it("returns EXPLAIN as rows and as a structured plan", () => {
    const catalog = seeded();
    const result = run("EXPLAIN SELECT name FROM employees WHERE dept_id = 3;", catalog);
    expect(result.explained).toBe(true);
    expect(result.columns).toEqual(["id", "op", "detail", "est_rows"]);
    expect(result.rows.map((r) => String(r[1]).trim())).toEqual(["Project", "Filter", "SeqScan"]);
    expect(result.plan!.op).toBe("Project");
  });
});

describe("index and scan must return the same answer", () => {
  const script = `
    CREATE TABLE probe (i INTEGER, r REAL, s TEXT, b BOOLEAN);
    INSERT INTO probe (i, r, s, b) VALUES
      (1,    1.5,  '1',  TRUE),
      (1,    1.0,  'a',  FALSE),
      (2,    2.5,  '2',  TRUE),
      (NULL, NULL, NULL, NULL),
      (0,    0.0,  '',   FALSE),
      (3,    1.5,  'A',  TRUE);
  `;

  const literals = [
    "1", "1.0", "2", "0", "3", ".5", "99",
    "'1'", "'a'", "'A'", "''", "'2'", "'zz'",
    "TRUE", "FALSE", "NULL",
  ];

  it("agrees for every column and probe value", () => {
    const withIndex = catalogWith(script);
    run(
      `CREATE INDEX p_i ON probe (i);
       CREATE INDEX p_r ON probe (r);
       CREATE INDEX p_s ON probe (s);
       CREATE INDEX p_b ON probe (b);`,
      withIndex,
    );
    const withoutIndex = catalogWith(script);

    let indexedProbes = 0;
    for (const column of ["i", "r", "s", "b"]) {
      for (const literal of literals) {
        const sql = `SELECT * FROM probe WHERE ${column} = ${literal};`;
        const a = run(sql, withIndex);
        const b = run(sql, withoutIndex);
        expect(JSON.stringify(a.rows), `${sql} disagreed`).toBe(JSON.stringify(b.rows));
        if (a.stats.indexesUsed.length > 0) indexedProbes++;
      }
    }
    // Guard against a vacuous pass: the indexed catalog must really be using them.
    expect(indexedProbes).toBeGreaterThan(0);
  });

  it("finds the same rows for `= 1` and `= 1.0` with an index present", () => {
    const catalog = catalogWith(script);
    run("CREATE INDEX p_i ON probe (i);", catalog);
    const one = run("SELECT s FROM probe WHERE i = 1;", catalog);
    const oneReal = run("SELECT s FROM probe WHERE i = 1.0;", catalog);
    expect(one.rows).toEqual([["1"], ["a"]]);
    expect(oneReal.rows).toEqual(one.rows);
  });
});

describe("DML errors", () => {
  it("rejects a value of the wrong type", () => {
    const catalog = catalogWith("CREATE TABLE t (i INTEGER);");
    expect(() => run("INSERT INTO t (i) VALUES ('x');", catalog)).toThrow(/cannot store/);
  });

  it("rejects a fraction in an INTEGER column, and writes none of the rows", () => {
    const catalog = catalogWith("CREATE TABLE t (i INTEGER, r REAL);");
    expect(() => run("INSERT INTO t (i, r) VALUES (1, 1.0), (1.5, 1.5);", catalog)).toThrow(
      "cannot store 1.5 in integer column 'i'",
    );
    expect(run("SELECT i FROM t;", catalog).rows).toEqual([]);
  });

  it("accepts 2.0 in an INTEGER column, because it is 2", () => {
    const catalog = catalogWith("CREATE TABLE t (i INTEGER, r REAL);");
    run("INSERT INTO t (i, r) VALUES (2.0, 1.5);", catalog);
    expect(run("SELECT i, r FROM t;", catalog).rows).toEqual([[2, 1.5]]);
  });

  it("rejects a value-count mismatch and unknown columns", () => {
    const catalog = catalogWith("CREATE TABLE t (i INTEGER, j INTEGER);");
    expect(() => run("INSERT INTO t (i, j) VALUES (1);", catalog)).toThrow(/expected 2 values/);
    expect(() => run("INSERT INTO t (nope) VALUES (1);", catalog)).toThrow(/no such column/);
  });

  it("rejects dropping a table that does not exist", () => {
    expect(() => run("DROP TABLE ghost;", new Catalog())).toThrow(/no such table/);
  });
});
