import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * TinySQL exists to implement a SQL engine, so pulling one in as a dependency
 * would defeat the point. This is the spec's "forbidden list" as a test rather
 * than as prose, because prose does not fail CI.
 */
const FORBIDDEN = [
  "sql.js",
  "sqlite",
  "sqlite3",
  "better-sqlite3",
  "duckdb",
  "@duckdb/duckdb-wasm",
  "alasql",
  "lokijs",
  "taffydb",
  "taffy",
  "node-sql-parser",
  "sql-parser",
  "pgsql-ast-parser",
  "nearley",
  "peggy",
  "pegjs",
  "antlr4",
  "antlr4ts",
];

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundledDependencies",
] as const;

interface PackageJson {
  [field: string]: unknown;
}

describe("dependency policy", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageJson;

  it("declares no third-party SQL engine or parser generator", () => {
    const found: string[] = [];
    for (const field of DEPENDENCY_FIELDS) {
      const value = pkg[field];
      if (value === undefined) continue;
      const names = Array.isArray(value) ? value : Object.keys(value as object);
      for (const name of names) {
        const lower = String(name).toLowerCase();
        if (FORBIDDEN.some((f) => lower === f || lower.startsWith(`${f}@`))) {
          found.push(`${field}: ${name}`);
        }
      }
    }
    expect(found, "the engine must be implemented, not imported").toEqual([]);
  });

  it("still lists the dependencies the build actually needs", () => {
    // Guards against "passing" this file by emptying package.json.
    const deps = Object.keys((pkg.dependencies ?? {}) as object);
    const devDeps = Object.keys((pkg.devDependencies ?? {}) as object);
    expect(deps).toContain("codemirror");
    expect(devDeps).toContain("vitest");
    expect(devDeps).toContain("vite");
  });
});
