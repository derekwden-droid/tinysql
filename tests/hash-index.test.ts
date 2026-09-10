import { describe, expect, it } from "vitest";
import { Catalog } from "../src/engine/catalog.js";
import { HashIndex, encodeKey } from "../src/engine/hash-index.js";
import { run } from "../src/engine/executor.js";
import { serializePlan } from "../src/engine/planner.js";
import { planSelect } from "../src/engine/planner.js";
import { parseOne } from "../src/engine/parser.js";

function planOf(sql: string, catalog: Catalog): string {
  const stmt = parseOne(sql);
  if (stmt.kind !== "select") throw new Error("expected a select");
  return serializePlan(planSelect(stmt, catalog));
}

function seeded(): Catalog {
  const catalog = new Catalog();
  run(
    `CREATE TABLE t (id INTEGER, k INTEGER, s TEXT);
     INSERT INTO t (id, k, s) VALUES (1, 3, 'a'), (2, 3, 'b'), (3, 7, 'c'), (4, NULL, 'd');`,
    catalog,
  );
  return catalog;
}

describe("hash index keys", () => {
  it("tags by runtime type so 1 and '1' do not collide", () => {
    expect(encodeKey(1)).toBe("n:1");
    expect(encodeKey("1")).toBe("t:1");
    expect(encodeKey(1)).not.toBe(encodeKey("1"));
  });

  it("treats 1 and 1.0 as the same key", () => {
    // INTEGER and REAL are one runtime numeric domain. If these differ,
    // `WHERE x = 1.0` silently misses rows a sequential scan would return.
    expect(encodeKey(1)).toBe(encodeKey(1.0));
  });

  it("keeps booleans distinct from numbers and strings", () => {
    expect(new Set([encodeKey(true), encodeKey(1), encodeKey("true")]).size).toBe(3);
  });

  it("gives NULL no key", () => {
    expect(encodeKey(null)).toBeNull();
  });
});

describe("HashIndex", () => {
  it("groups row ids by key and counts distinct keys", () => {
    const index = HashIndex.build("i", "t", "k", 0, [[3], [3], [7], [null]]);
    expect([...index.lookup(3)]).toEqual([0, 1]);
    expect([...index.lookup(7)]).toEqual([2]);
    expect(index.distinctKeys).toBe(2);
    expect(index.size).toBe(4);
  });

  it("never returns NULL-keyed rows from an equality lookup", () => {
    const index = HashIndex.build("i", "t", "k", 0, [[null], [1]]);
    expect([...index.lookup(null)]).toEqual([]);
  });
});

describe("index maintenance", () => {
  it("sees rows inserted after the index was created", () => {
    const catalog = seeded();
    run("CREATE INDEX t_k ON t (k);", catalog);
    const before = run("SELECT id FROM t WHERE k = 3;", catalog);
    expect(before.rows.flat()).toEqual([1, 2]);

    run("INSERT INTO t (id, k, s) VALUES (5, 3, 'e');", catalog);
    const after = run("SELECT id FROM t WHERE k = 3;", catalog);
    expect(after.rows.flat()).toEqual([1, 2, 5]);
    expect(after.stats.indexHits).toBe(3);
  });

  it("drops a table's indexes with the table", () => {
    const catalog = seeded();
    run("CREATE INDEX t_k ON t (k);", catalog);
    expect(catalog.indexNames()).toEqual(["t_k"]);

    run("DROP TABLE t;", catalog);
    expect(catalog.indexNames()).toEqual([]);

    // Re-creating the table must not resurrect a stale index.
    run(
      `CREATE TABLE t (id INTEGER, k INTEGER, s TEXT);
       INSERT INTO t (id, k, s) VALUES (1, 3, 'a');`,
      catalog,
    );
    expect(planOf("SELECT id FROM t WHERE k = 3", catalog)).toContain("SeqScan");
  });

  it("rejects a duplicate index name and an unknown column", () => {
    const catalog = seeded();
    run("CREATE INDEX t_k ON t (k);", catalog);
    expect(() => run("CREATE INDEX t_k ON t (s);", catalog)).toThrow(/already exists/);
    expect(() => run("CREATE INDEX t_nope ON t (missing);", catalog)).toThrow(/no such column/);
  });
});
