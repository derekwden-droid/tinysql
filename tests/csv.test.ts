import { describe, expect, it } from "vitest";
import { createTableFromCsv, parseCsv, sanitizeIdentifier, tableNameFromFile } from "../src/engine/csv.js";
import { Catalog } from "../src/engine/catalog.js";
import { run } from "../src/engine/executor.js";
import { ExecError } from "../src/engine/errors.js";

describe("csv parsing", () => {
  it("keeps a comma inside a quoted field", () => {
    const table = parseCsv('id,city\n1,"Tampa, FL"\n');
    expect(table.rows).toEqual([[1, "Tampa, FL"]]);
  });

  it("keeps a newline inside a quoted field", () => {
    const table = parseCsv('id,note\n1,"line one\nline two"\n');
    expect(table.rows).toEqual([[1, "line one\nline two"]]);
  });

  it("decodes doubled quotes", () => {
    const table = parseCsv('id,note\n1,"she said ""hi"""\n');
    expect(table.rows).toEqual([[1, 'she said "hi"']]);
  });

  it("accepts CRLF line endings", () => {
    const table = parseCsv("id,name\r\n1,Ada\r\n2,Grace\r\n");
    expect(table.rows).toEqual([
      [1, "Ada"],
      [2, "Grace"],
    ]);
  });

  it("infers integer, real and text per column", () => {
    const table = parseCsv("i,r,t\n1,1.5,a\n2,2.25,b\n");
    expect(table.columns.map((c) => c.type)).toEqual(["integer", "real", "text"]);
  });

  it("treats an empty cell as NULL and still infers the column type", () => {
    const table = parseCsv("i,t\n1,a\n,b\n3,\n");
    expect(table.columns.map((c) => c.type)).toEqual(["integer", "text"]);
    expect(table.rows).toEqual([
      [1, "a"],
      [null, "b"],
      [3, null],
    ]);
  });

  it("falls back to text when a column mixes numbers and words", () => {
    const table = parseCsv("v\n1\nabc\n");
    expect(table.columns[0]!.type).toBe("text");
  });

  it("sanitizes header names into identifiers", () => {
    expect(sanitizeIdentifier("Placed At", 0)).toBe("placed_at");
    expect(sanitizeIdentifier("  Dept ID  ", 0)).toBe("dept_id");
    expect(sanitizeIdentifier("2026 Total", 0)).toBe("c2026_total");
    expect(sanitizeIdentifier("", 4)).toBe("c5");
  });

  it("deduplicates repeated header names", () => {
    const table = parseCsv("name,name,name\na,b,c\n");
    expect(table.columns.map((c) => c.name)).toEqual(["name", "name_2", "name_3"]);
  });

  it("synthesises column names when there is no header row", () => {
    const table = parseCsv("1,2\n3,4\n");
    expect(table.columns.map((c) => c.name)).toEqual(["c1", "c2"]);
    expect(table.rows).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("strips a UTF-8 BOM from the first column name", () => {
    const table = parseCsv("\uFEFFid,name\n1,Ada\n");
    expect(table.columns[0]!.name).toBe("id");
  });

  it("rejects an unterminated quoted field", () => {
    expect(() => parseCsv('id,name\n1,"unclosed\n')).toThrow(ExecError);
  });

  it("derives a table name from a file name", () => {
    expect(tableNameFromFile("Employees 2026.csv")).toBe("employees_2026");
    expect(tableNameFromFile("C:\\data\\orders.CSV")).toBe("orders");
  });
});

describe("csv into the catalog", () => {
  it("creates a queryable table", () => {
    const catalog = new Catalog();
    createTableFromCsv(catalog, "people", 'id,name,city\n1,Ada,"Tampa, FL"\n2,Grace,\n');
    const result = run("SELECT name FROM people WHERE city IS NULL;", catalog);
    expect(result.rows).toEqual([["Grace"]]);
  });

  it("replaces an existing table of the same name", () => {
    const catalog = new Catalog();
    createTableFromCsv(catalog, "t", "a\n1\n");
    createTableFromCsv(catalog, "t", "a,b\n1,2\n3,4\n");
    expect(catalog.rowCount("t")).toBe(2);
    expect(catalog.columns("t").map((c) => c.name)).toEqual(["a", "b"]);
  });
});
