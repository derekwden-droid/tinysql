import type { Catalog } from "./catalog.js";
import type { Row } from "./types.js";

export const LARGE_TABLE = "orders_big";
export const LARGE_ROWS = 50_000;

/**
 * What "Generate 50k orders" puts in the editor, and what the golden test runs,
 * so the numbers the README quotes are the numbers the demo shows. It joins the
 * generated orders to the bundled employees so both lessons repeat at scale:
 * the first index click is the WHERE, the second is the join.
 */
export const LARGE_QUERY = `-- ${LARGE_ROWS.toLocaleString("en-US")} rows. Run this, then press "Create index and rerun" twice:
-- once for the WHERE, once for the join. Watch the rows touched and the time.
SELECT o.id, e.name AS employee, o.amount, o.placed_at
FROM ${LARGE_TABLE} o
JOIN employees e ON o.employee_id = e.id
WHERE o.employee_id = 17
ORDER BY o.amount DESC
LIMIT 20;`;

/**
 * A deterministic 50k-row table. Forty-row samples cannot show the planner
 * working: both strategies finish in well under a millisecond and only the row
 * counter moves. At this size the index changes the wall clock.
 */
export function generateLargeTable(catalog: Catalog): void {
  if (catalog.hasTable(LARGE_TABLE)) catalog.dropTable(LARGE_TABLE);
  catalog.createTable({
    name: LARGE_TABLE,
    columns: [
      { name: "id", type: "integer" },
      { name: "employee_id", type: "integer" },
      { name: "amount", type: "real" },
      { name: "placed_at", type: "text" },
    ],
  });

  // Linear congruential generator: same table on every machine, every run.
  let seed = 20260910;
  const nextRandom = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const rows: Row[] = [];
  for (let i = 1; i <= LARGE_ROWS; i++) {
    const employeeId = 1 + Math.floor(nextRandom() * 44);
    const amount = Math.round(nextRandom() * 500000) / 100;
    const day = 1 + Math.floor(nextRandom() * 28);
    const month = 1 + Math.floor(nextRandom() * 12);
    const placedAt = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    rows.push([i, employeeId, amount, placedAt]);
  }
  catalog.insert(LARGE_TABLE, rows);
}
