# Architecture

## Data flow

```
SQL text
  -> lexer.ts      hand-written scanner -> Token[] with start/end/line/column
  -> parser.ts     recursive descent, one method per precedence level -> Statement[]
  -> planner.ts    resolves names against the catalog -> PlanNode tree
  -> executor.ts   interprets the tree with generators -> { columns, rows, stats, plan }
```

`catalog.ts` is the only mutable store: tables (`{ def, rows, columnIndex }`) and indexes. Everything
else is a pure function of its input plus the catalog. It is also the one place values meet declared
types: `insert` checks every row with `fitsType` before writing any, so INSERT, CSV import and the
UI's generator all obey the same rule, and `createIndex` allows one index per column.

Rows are flat `Value[]` addressed by ordinal; the planner resolves every column reference to an
ordinal at plan time, so execution never does a string lookup in the hot path.

`run(sql, catalog)` executes a whole `;`-separated script and returns the last statement's result,
which is what makes `CREATE INDEX ...; EXPLAIN SELECT ...;` behave as written.

## Plan shape

Nodes are emitted only when they have work to do — no `Limit` without a `LIMIT`, no empty `Filter`.

Without `DISTINCT`, the sort runs **before** the projection, so `ORDER BY` may name any column
available from `FROM`/`JOIN`:

```
Limit( Project( Sort( Filter_residual( NestedLoopJoin( side, side ) ) ) ) )
```

With `DISTINCT`, the sort must run **after** the projection, so `ORDER BY` is restricted to the
select list (a `PlanningError` otherwise):

```
Limit( Sort( Distinct( Project( Filter_residual( NestedLoopJoin( side, side ) ) ) ) ) )
```

Each `side` is `Filter_pushed( SeqScan | IndexLookup )`. On the inner side of a join that
`IndexLookup` may be keyed by the outer row instead of a literal (rule 5). Ids are assigned pre-order
once the tree is complete and are the key for the executor's per-node counters.

## The index rule

1. Split `WHERE` on `AND` into a flat conjunct list.
2. Resolve every column reference to a `(table, column)` pair, following table aliases. **The rule
   matches on the resolved pair, never on the identifier as written** — otherwise `WHERE e.dept_id = 3`
   would not find the index on `employees(dept_id)`.
3. Attribute each conjunct to the relations it touches. A conjunct touching exactly one relation is
   **pushed down** onto that relation; conjuncts spanning both stay above the join as the residual
   `Filter`. Without this step an index can never fire inside a join query.
4. Per relation, the first pushed conjunct of the form `col = literal` (either operand order, non-NULL
   literal) whose resolved pair has a hash index becomes an `IndexLookup`, consuming that conjunct.
   The relation's remaining conjuncts become a `Filter` directly above it. At most one `IndexLookup`
   per relation.
5. **Join probe.** If the inner (`JOIN`) side would still scan its whole table and its join column has
   an index, the scan becomes an `IndexLookup` keyed by each outer row's join value: an index nested
   loop, shown as `IndexLookup(departments AS d using dept_id on id = e.dept_id)`. A step-4 lookup on
   the inner side wins, since it runs once rather than once per outer row. Only the `JOIN` table is
   probed: the planner never reorders a join to reach an index on the `FROM` table.

Predicates moved below a join have their ordinals rebased by the relation's offset, because they were
resolved against the joined row layout.

**Invariant:** `IndexLookup` and `Filter` are two implementations of one relation and must return the
same rows. `HashIndex` keys are therefore tagged by runtime type (`n:`, `t:`, `b:`) rather than
declared type, so `1` and `1.0` share a bucket while `1` and `'1'` do not. `tests/executor.test.ts`
enforces this as a property over every column and probe value, and holds join probes to the same
standard: for every pair of join columns (same type, INTEGER against REAL, cross-type, NULL keys) a
probing join must return exactly what a rescanning join returns.

**Read backwards.** `suggestIndex(plan)` inverts steps 4 and 5 for the UI. A pushed `col = literal`
left in a `Filter` directly above a `SeqScan` is there only because no index matched, so indexing that
column is exactly what turns the scan into a lookup; likewise a join whose inner side still scans names
its inner join column. `WHERE` suggestions come first. The plan panel offers each as **Create index
and rerun**, which reruns only the script's last statement, so the index is the one thing that
changed. `tests/planner.test.ts` takes suggestions one after another across filter, join, `DISTINCT`
and `LIMIT` shapes, and checks that each produces its `IndexLookup` and that they run out.

## Estimates

Crude and documented, shown in the UI beside the actual counts. The planner is rule-based, so these
are for comparison only and never decide anything:

| Node             | `estRows`                                             |
| ---------------- | ----------------------------------------------------- |
| `SeqScan`        | table row count                                       |
| `IndexLookup`    | `max(1, ceil(rows / max(distinctKeys, 1)))`            |
| `IndexLookup`, join probe | `left *` the above, summed over every probe  |
| `Filter`         | `ceil(child * 0.3)` — once per node, not per conjunct  |
| `NestedLoopJoin` | `ceil(left * right / max(distinctKeys(rightCol), 1))`, with `right` as a scan even when probed |
| `Project`, `Sort`, `Distinct` | child                                    |
| `Limit`          | `min(max(child - offset, 0), count)`                   |

The join divisor matters: a plain `left * right` cross-product estimate reports ~96 rows for the
sample query against an actual 7, which makes the estimator look broken every time the flagship demo
runs.

## Runtime counters

The executor keeps `{ actualRows, rowsTouched }` per plan-node id. `rowsTouched` counts **base
relation** reads only — scans, index lookups, and the join's inner-row visits — so the total is the
number that actually moves when the planner picks an index. An index nested loop visits nothing at
the join node: each probe's rows are counted once, at its `IndexLookup`. That is why the sample join
reads 108 rows, then 71 with `employees(dept_id)` indexed, then 14 with `departments(id)` too.
Derived nodes report `actualRows` only. The plan view marks whichever node read the most rows.

## Execution notes

- Every node is a generator, so `Limit` short-circuits instead of materialising the whole result.
- `NestedLoopJoin` materialises its inner side once and rescans it per outer row, unless the inner
  side is a join probe. Then it runs the inner side once per outer row with that row as the key,
  skips outer rows whose key is NULL, and still re-checks `=`, so the index never decides the answer.
- `Sort` and `Distinct` buffer, by necessity. `Distinct` keys each row with `encodeRowKey`, the row
  form of the index's `encodeKey`. The shared encoding is why two NULLs collapse into one, and the
  JSON around the per-column keys means no text value can forge a column boundary.
- `IndexLookup` runs the index its plan node names, not whatever a fresh `(table, column)` lookup
  would return.
- Comparisons return `boolean | null`; `null` is UNKNOWN. `WHERE` keeps TRUE only.
