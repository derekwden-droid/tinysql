import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { callTool, MAX_CELL_CHARS, MAX_FILES, TOOLS } from "../src/mcp/tools.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE = {
  employees: "public/datasets/employees.csv",
  departments: "public/datasets/departments.csv",
};
const JOIN = `SELECT e.name AS employee, d.name AS department, e.salary
FROM employees e
JOIN departments d ON e.dept_id = d.id
WHERE e.dept_id = 3
ORDER BY e.salary DESC`;

function ok(name: string, args: unknown, cwd = ROOT): string {
  const outcome = callTool(name, args, cwd);
  expect(outcome).not.toBeNull();
  expect(outcome!.isError, outcome!.text).toBe(false);
  return outcome!.text;
}

function fails(name: string, args: unknown, cwd = ROOT): string {
  const outcome = callTool(name, args, cwd);
  expect(outcome).not.toBeNull();
  expect(outcome!.isError, outcome!.text).toBe(true);
  return outcome!.text;
}

/** The CREATE INDEX statement a result suggests, exactly as the model would copy it. */
function suggestion(text: string): string {
  const match = /^CREATE INDEX .*;$/m.exec(text);
  expect(match, text).not.toBeNull();
  return match![0];
}

/** The result rows as printed, between the summary line and the plan. */
function printedRows(text: string): string {
  return text.slice(text.indexOf("\n\n") + 2, text.indexOf("\n\nPlan"));
}

describe("run_sql", () => {
  it("shows the sample join reading every employee and names the index that would help", () => {
    const text = ok("run_sql", { tables: SAMPLE, sql: JOIN });
    expect(text).toMatch(/^7 rows · .+ · 108 rows touched · no index used\n/);
    expect(text).toContain("Margaret Hamilton");
    expect(text).toMatch(/SeqScan\(employees AS e\) {2}\[est 44, actual 44, read 44\]/);
    expect(text).toContain("<- most rows read");
    expect(suggestion(text)).toBe('CREATE INDEX "employees_dept_id" ON "employees" ("dept_id");');
  });

  it("follows its own suggestions from 108 to 71 to 14 rows touched, with the same rows each time", () => {
    const first = ok("run_sql", { tables: SAMPLE, sql: JOIN });
    const byDept = suggestion(first);

    const second = ok("run_sql", { tables: SAMPLE, sql: `${byDept}\n${JOIN}` });
    expect(second).toMatch(/· 71 rows touched · index used: employees_dept_id\n/);
    expect(second).toContain("IndexLookup(employees AS e using employees_dept_id on dept_id = 3)");
    const byId = suggestion(second);
    expect(byId).toBe('CREATE INDEX "departments_id" ON "departments" ("id");');

    const third = ok("run_sql", { tables: SAMPLE, sql: `${byDept}\n${byId}\n${JOIN}` });
    expect(third).toMatch(/· 14 rows touched · index used: employees_dept_id, departments_id\n/);
    expect(third).toContain("IndexLookup(departments AS d using departments_id on id = e.dept_id)");
    expect(third).not.toContain("Index suggestion");

    expect(printedRows(second)).toBe(printedRows(first));
    expect(printedRows(third)).toBe(printedRows(first));
  });

  it("keeps nothing from one call to the next", () => {
    ok("run_sql", { tables: SAMPLE, sql: `CREATE INDEX by_dept ON employees (dept_id); ${JOIN}` });
    expect(ok("run_sql", { tables: SAMPLE, sql: JOIN })).toContain("no index used");
    expect(fails("run_sql", { sql: "SELECT * FROM employees" })).toContain("no such table: employees");
  });

  it("explains a plan without running it", () => {
    const text = ok("run_sql", { tables: SAMPLE, sql: `EXPLAIN ${JOIN}` });
    expect(text).toMatch(/^EXPLAIN: estimates only/);
    expect(text).toContain("SeqScan(employees AS e)  [est 44]");
    expect(text).not.toMatch(/actual \d/);
    expect(suggestion(text)).toBe('CREATE INDEX "employees_dept_id" ON "employees" ("dept_id");');
  });

  it("runs a script that builds its own table, and says when nothing was queried", () => {
    const query = ok("run_sql", {
      sql: "CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y'); SELECT b FROM t WHERE a = 2",
    });
    expect(query).toMatch(/^1 row · /);

    const noQuery = ok("run_sql", { sql: "CREATE TABLE t (a INTEGER); INSERT INTO t (a) VALUES (1), (2)" });
    expect(noQuery).toContain("2 rows inserted into 't'");
    expect(noQuery).toContain("lasted only for this call");
  });

  it("caps the rows it prints but not the counts", () => {
    const text = ok("run_sql", { tables: SAMPLE, sql: "SELECT id, name FROM employees ORDER BY id", max_rows: 3 });
    expect(text).toMatch(/^44 rows · /);
    expect(text).toContain("Showing the first 3 of 44 rows.");
    expect(printedRows(text).split("\n\n")[0]!.split("\n")).toHaveLength(2 + 3);
    expect(text).toContain("SeqScan(employees)  [est 44, actual 44, read 44]");
  });

  it("shortens long text in the printed rows only", () => {
    const long = "x".repeat(MAX_CELL_CHARS + 50);
    const text = ok("run_sql", { sql: `CREATE TABLE t (s TEXT); INSERT INTO t (s) VALUES ('${long}'); SELECT s FROM t` });
    expect(text).toContain(`${"x".repeat(MAX_CELL_CHARS - 1)}…`);
    expect(text).not.toContain("x".repeat(MAX_CELL_CHARS));
    expect(text).toContain(`Text longer than ${MAX_CELL_CHARS} characters is shortened above`);
  });

  it("says when a query fails because TinySQL lacks the feature, and lists the loaded tables", () => {
    const text = fails("run_sql", { tables: SAMPLE, sql: "SELECT dept_id, COUNT(*) FROM employees GROUP BY dept_id" });
    expect(text).toMatch(/^Tinysql: parse error at 1:\d+/);
    expect(text).toContain("TinySQL does not support GROUP BY");
    expect(text).toContain("Tables loaded for this call: employees(id, name, dept_id, salary, city); departments(id, name, floor)");

    const leftJoin = fails("run_sql", {
      tables: SAMPLE,
      sql: "SELECT e.name FROM employees e LEFT JOIN departments d ON e.dept_id = d.id",
    });
    expect(leftJoin).toContain("TinySQL does not support outer joins");
  });

  it("does not blame a missing feature for an ordinary mistake", () => {
    const text = fails("run_sql", { tables: SAMPLE, sql: "SELECT nme FROM employees" });
    expect(text).toContain("nme");
    expect(text).not.toContain("does not support");
  });

  it("rejects bad arguments with messages the model can act on", () => {
    expect(fails("run_sql", {})).toContain("sql is required");
    expect(fails("run_sql", { sql: "  " })).toContain("sql is required");
    expect(fails("run_sql", { sql: "SELECT 1", max_rows: 0 })).toContain("max_rows must be a whole number from 1 to 1000");
    expect(fails("run_sql", { sql: "SELECT 1", max_rows: 2.5 })).toContain("max_rows");
    expect(fails("run_sql", { query: "SELECT 1" })).toContain("Unknown argument 'query'");
    expect(fails("run_sql", { sql: "SELECT 1", tables: ["a.csv"] })).toContain("tables must map table names to CSV paths");
    expect(fails("run_sql", { sql: "SELECT 1", tables: { "2020_sales": "a.csv" } })).toContain("plain SQL identifier");
    expect(fails("run_sql", { sql: "SELECT 1", tables: { order: "a.csv" } })).toContain("'order' is a SQL keyword");
    expect(fails("run_sql", { sql: "SELECT 1", tables: { Emp: "a.csv", emp: "b.csv" } })).toContain("'emp' is given twice");
    expect(fails("run_sql", { sql: "SELECT 1", tables: { emp: 7 } })).toContain("must be a non-empty string");
    expect(fails("run_sql", "SELECT 1")).toContain("must be a JSON object");

    const many = Object.fromEntries(Array.from({ length: MAX_FILES + 1 }, (_, i) => [`t${i}`, "a.csv"]));
    expect(fails("run_sql", { sql: "SELECT 1", tables: many })).toContain(`At most ${MAX_FILES} CSV files`);
  });

  it("folds table names to lowercase, as unquoted SQL does", () => {
    const text = ok("run_sql", { tables: { Employees: SAMPLE.employees }, sql: "SELECT name FROM EMPLOYEES WHERE id = 1" });
    expect(text).toContain("Ada Lovelace");
  });
});

describe("file checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "tinysql-mcp-"));
  writeFileSync(join(dir, "notes.txt"), "secret,stuff\n1,2\n");
  writeFileSync(join(dir, "people.csv"), "Full Name,Age\nAda,36\nGrace,85\n");
  writeFileSync(join(dir, "broken.csv"), 'a,b\n1,"never closed\n');
  writeFileSync(join(dir, "big.csv"), "a\n");
  truncateSync(join(dir, "big.csv"), 21 * 1024 * 1024);
  mkdirSync(join(dir, "folder.csv"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("loads absolute paths and folds header names into identifiers", () => {
    const text = ok("run_sql", { tables: { people: join(dir, "people.csv") }, sql: "SELECT full_name FROM people WHERE age > 50" });
    expect(text).toMatch(/^1 row · /);
    expect(text).toContain("Grace");
  });

  it("resolves relative paths against the session's directory", () => {
    expect(ok("describe_csv", { tables: { people: "people.csv" } }, dir)).toContain("Table people: 2 rows");
  });

  it("expands ~ to the home directory", () => {
    const text = fails("describe_csv", { tables: { t: "~/tinysql-no-such-file.csv" } });
    expect(text).toContain(`looked for ${join(homedir(), "tinysql-no-such-file.csv")}`);
  });

  it("refuses anything but a regular .csv file within the size limit", () => {
    expect(fails("describe_csv", { tables: { t: join(dir, "notes.txt") } })).toContain("is not a .csv file");
    expect(fails("describe_csv", { tables: { t: join(dir, "missing.csv") } })).toContain("no such file");
    expect(fails("describe_csv", { tables: { t: join(dir, "folder.csv") } })).toContain("is not a regular file");
    expect(fails("describe_csv", { tables: { t: join(dir, "big.csv") } })).toContain(
      "is 21.0 MB; TinySQL loads CSV files up to 20.0 MB",
    );
  });

  it("checks the extension again after following a link", (context) => {
    try {
      symlinkSync(join(dir, "notes.txt"), join(dir, "sneaky.csv"));
    } catch {
      context.skip(); // Windows without Developer Mode cannot create symlinks.
    }
    expect(fails("describe_csv", { tables: { t: join(dir, "sneaky.csv") } })).toContain("which is not a .csv file");
  });

  it("names the file when its CSV cannot be parsed", () => {
    const text = fails("describe_csv", { tables: { t: join(dir, "broken.csv") } });
    expect(text).toContain("broken.csv");
    expect(text).toContain("unterminated quoted field");
  });
});

describe("describe_csv", () => {
  it("shows column names, types, distinct counts, the row count and the first rows", () => {
    const text = ok("describe_csv", { tables: { employees: SAMPLE.employees, orders: "public/datasets/orders.csv" } });
    expect(text).toContain("Table employees: 44 rows, loaded from ");
    expect(text).toContain(
      "Columns: id INTEGER (44 distinct), name TEXT (44 distinct), dept_id INTEGER (8 distinct), salary INTEGER (44 distinct), city TEXT (4 distinct)",
    );
    expect(text).toContain("Table orders: 48 rows");
    expect(text).toContain("amount REAL");
    expect(text).toContain("First 5 rows:");
  });

  it("needs at least one table", () => {
    expect(fails("describe_csv", {})).toContain("tables is required");
    expect(fails("describe_csv", { tables: {} })).toContain("tables is empty");
  });
});

describe("tool definitions", () => {
  it("are the two tools callTool knows, with closed object schemas", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["describe_csv", "run_sql"]);
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.openWorldHint).toBe(false);
    }
    expect(callTool("drop_everything", {})).toBeNull();
  });
});
