# TinySQL — Claude Build Plan v2 (paste this entire file as the first message)

> v2 changelog: fixed the alias/pushdown hole that prevented the flagship demo from ever
> producing `IndexLookup`; pinned plan-tree shape, NULL ordering, DISTINCT-on-NULL, and
> index/filter equality agreement; corrected the join cardinality estimate; replaced
> `npx tinysql` with a command that works in a fresh clone; made the "no SQL engine
> dependency" and "the planner is real" rules into tests instead of prose.

You are a senior TypeScript systems engineer. Build TinySQL end-to-end in this repository. Do not ask permission to start. Do not scaffold a SaaS. Do not add auth, Stripe, a marketing site, a REST API, or a database server.

## Non-negotiable product decision

TinySQL is a **browser SQL engine you implement**, plus a query-plan visualizer.

- The engine runs entirely in the browser.
- The same engine code must also run under Node via Vitest and a small CLI.
- **Forbidden in v1:** `sql.js`, SQLite.wasm, DuckDB-wasm, AlaSQL, LokiJS, TaffyDB, or any third-party SQL parser/engine. If you reach for one of these, you have failed the spec. This is enforced by `tests/no-forbidden-deps.test.ts`, not by good intentions.
- Allowed libraries: Vite, TypeScript, Vitest, CodeMirror 6, a CSS layer you write yourself. No component UI kit (no shadcn, no MUI, no Tailwind CDN soup of 40 utilities-as-architecture).
- No LLM / AI features in v1. None.

Open source: MIT. There is no credible v1 business here. Do not add pricing pages, waitlists, or "Pro."

---

## What you will create in this session

1. A complete Git repo layout with `.gitignore`, `LICENSE` (MIT), and `README.md`.
2. A working engine: lexer → parser → catalog → planner → executor → hash index.
3. A single-page UI that feels like a tool, not a landing page.
4. Vitest coverage for lexer, parser, planner, executor, indexes, CSV, and a golden end-to-end test.
5. A CLI: `npm run cli -- --file data.csv --query 'SELECT ...'`
6. Sample datasets bundled in-repo, plus an in-browser generator for a table large enough that the planner's choice is visible in wall-clock time.
7. A build that deploys as static files (GitHub Pages compatible).

Ship a program that runs, not a sketch.

---

## Repo layout (create exactly this)

```
tinysql/
  .gitignore
  LICENSE
  README.md
  ARCHITECTURE.md
  package.json
  tsconfig.json
  tsconfig.node.json
  vite.config.ts
  vitest.config.ts
  index.html
  docs/
    BUILD_PLAN.md          # this file, so the repo carries its own contract
  public/
    datasets/
      employees.csv
      departments.csv
      orders.csv
  src/
    main.ts
    styles.css
    ui/
      app.ts
      editor.ts
      schema-panel.ts
      results-table.ts
      plan-view.ts
      status-bar.ts
      dropzone.ts
    engine/
      types.ts
      errors.ts
      lexer.ts
      parser.ts
      ast.ts
      catalog.ts
      planner.ts
      executor.ts
      hash-index.ts
      csv.ts
      format.ts
    cli/
      index.ts
  tests/
    lexer.test.ts
    parser.test.ts
    executor.test.ts
    planner.test.ts
    hash-index.test.ts
    csv.test.ts
    golden.test.ts
    no-forbidden-deps.test.ts
```

Root `package.json` name: `tinysql`. Type module. Scripts:

```
dev, build, preview, test, test:watch, cli
```

Node CLI entry: `src/cli/index.ts`, run via `tsx`.

**Do not promise `npx tinysql` in the README.** The package is unpublished, so `npx tinysql` fails in a fresh clone. The documented invocation is `npm run cli -- --file ... --query '...'`. A `bin` field is fine to include for anyone who runs `npm link`, but the README's quick start must be the command that works on a clone.

---

## Gitignore (use this)

```
node_modules
dist
dist-cli
.DS_Store
*.log
.env
.env.*
coverage
.vite
.idea
.vscode/*
!.vscode/extensions.json
```

Do not gitignore `public/datasets`.

---

## LICENSE

Standard MIT. Copyright year 2026. Copyright holder: use the repo owner name if known, otherwise `TinySQL Contributors`.

---

## README requirements (write this for humans, not buzzwords)

Must include:

- One-paragraph what it is: "A from-scratch SQL engine in TypeScript with a visible query planner."
- Explicit statement: this is **not** SQLite. It is a teaching / inspection engine with a small dialect.
- Supported SQL (copy the dialect section below).
- Quick start: `npm install`, `npm run dev`, `npm test`, and the **working** CLI example.
- Architecture diagram in mermaid: SQL text → lexer → parser → planner → executor.
- How indexes work and when the planner chooses them, **including predicate pushdown**.
- "What we will never do in v1" list (no joins beyond inner equijoin, no UPDATE/DELETE yet, no transactions).
- How to add a new statement type (file + test + one paragraph).
- MIT badge and license pointer.

Do not write "revolutionize" or "AI-powered."

---

## Dialect (implement exactly this, nothing more in v1)

### Types

`INTEGER | REAL | TEXT | BOOLEAN | NULL`

CSV import infers INTEGER / REAL / TEXT. Empty cell → NULL.

### Statements

```
CREATE TABLE name ( col type [, col type]* );
CREATE INDEX name ON table ( col );
DROP TABLE name;
INSERT INTO name ( cols ) VALUES ( v [, v]* ) [, ( v [, v]* )]* ;
SELECT [DISTINCT] items
  [FROM table [alias]]
  [JOIN table [alias] ON qualified.col = qualified.col]
  [WHERE expr]
  [ORDER BY col [ASC|DESC] [, col [ASC|DESC]]*]
  [LIMIT n [OFFSET n]];
EXPLAIN SELECT ...;
```

Three corrections to v1 of this spec, all of which the v1 grammar block contradicted elsewhere in the document:

1. **Table aliases are part of the grammar**, not a footnote. `FROM employees e` and `JOIN departments d` must parse. Aliases are unquoted identifiers, optional, with no `AS`.
2. **`FROM` is optional.** `SELECT 1 AS n, 'x' AS t` is in scope and plans as a one-row `Project` of constants (`Project` with no child).
3. Once a table is aliased, the alias is the only name that refers to it in that statement.

`SELECT` items: `*`, `table.*`, `col`, `table.col`, `col AS alias`.

No subqueries. No `GROUP BY`. No aggregates in v1. No `UNION`. No `LEFT JOIN`. One join max. Join is inner equijoin only (`=` on two columns).

### WHERE / expressions

Operators: `= != <> < <= > >= AND OR NOT`, parentheses, `IS NULL`, `IS NOT NULL`, `LIKE` with `%` and `_` (no regex).

Literals: integers, reals, single-quoted strings with `''` escape, `TRUE`/`FALSE`/`NULL`.

Identifiers: unquoted `[A-Za-z_][A-Za-z0-9_]*` or double-quoted.

Comments: `--` to EOL and `/* */`.

SQL is case-insensitive for keywords. Table/column names fold to lowercase unless double-quoted.

### Value semantics (pin these down; they are the difference between a real engine and a demo)

- **Cross-type comparison:** values of different types are never equal. Ordering across types uses a fixed type rank: `null < boolean < number < text`.
- **`1` and `1.0` are the same value.** INTEGER and REAL are one runtime numeric domain. Anything that says otherwise (including index key tagging) is a bug.
- **Three-valued logic everywhere**, not just in `WHERE`: any comparison or `LIKE` with a NULL operand yields unknown. `AND` is false if either side is false, else unknown if either is unknown. `OR` is true if either side is true, else unknown if either is unknown. `NOT unknown` is unknown. `WHERE` keeps rows that evaluate to TRUE only.
- **`DISTINCT` treats two NULLs as duplicates of each other** (this is what SQL says, and it is the opposite of `=`).
- **`ORDER BY` places NULLs first in `ASC`**, last in `DESC`. Document the choice; SQLite does this, Postgres does the reverse.
- **`ORDER BY`** may name any column available from `FROM`/`JOIN`. With `DISTINCT`, it must name a column in the select list — planner raises `PlanningError` otherwise. This mirrors real SQL and falls straight out of the plan shapes below.
- `LIKE` is case-sensitive in v1. Document that.
- No `ORDER BY` ordinals (`ORDER BY 1` is an error).

### Errors

Throw typed errors, never raw `Error` for language issues:

- `LexError { line, column, message }`
- `ParseError { line, column, message, hint? }`
- `PlanningError { message }` — also covers binding failures: unknown table, unknown column, ambiguous column, unknown index.
- `ExecError { message }`

UI must show line/column and underline the token in the editor.

---

## Engine design (this is the whole point)

### types.ts

Define:

```ts
type SqlType = "integer" | "real" | "text" | "boolean" | "null";

interface ColumnDef { name: string; type: SqlType }
interface TableDef { name: string; columns: ColumnDef[] }

type Value = number | string | boolean | null;
type Row = Value[];
```

Use row-id arrays internally. Do not store rows as objects in the hot path. Catalog keeps a name→ordinal map.

### lexer.ts

Hand-written scanner. No regex-as-parser. Emit tokens with `start`, `end`, `line`, `column`.

Token kinds: keyword, ident, number, string, punct (`( ) , * = != <> < <= > >= . ;`), eof.

### parser.ts

Recursive descent. Pratt parser for expressions (AND/OR/NOT + comparisons). Produce AST from `ast.ts`. No parser generator.

Parser must not invent tokens. On failure, report the unexpected token and what would have been valid.

### catalog.ts

In-memory:

- tables: name → { def, rows: Row[], columnIndex }
- indexes: name → HashIndex

`createIndex` builds from current rows. Every subsequent `INSERT` maintains every index on that table. `DROP TABLE` drops that table's indexes with it. If you forget index maintenance, tests will fail.

### planner.ts

Input: Select AST + catalog.
Output: a plan tree, not SQL. Every node carries `id` (assigned pre-order), `estRows`, and an output `schema: ColumnRef[]` so the executor addresses columns by ordinal, never by string lookup in the hot path.

Plan nodes (implement these exact kinds):

```
SeqScan { table }
IndexLookup { table, index, column, value }
Filter { predicate, child }
NestedLoopJoin { left, right, leftCol, rightCol }
Project { items, child? }     // child omitted = one-row constant projection
Sort { keys, child }
Limit { count, offset, child }
Distinct { child }
```

#### Plan shape (pin this; `planner.test.ts` asserts on it)

Without `DISTINCT`:

```
Limit( Project( Sort( Filter_residual( Join( side, side ) ) ) ) )
```

With `DISTINCT`:

```
Limit( Sort( Distinct( Project( Filter_residual( Join( side, side ) ) ) ) ) )
```

where each `side` is `Filter_pushed( SeqScan | IndexLookup )`. Nodes that have nothing to do are omitted entirely — no `Limit` node without a `LIMIT`, no `Filter` with an empty predicate.

#### Index rule (this is the part v1 of the spec got wrong)

1. Split the `WHERE` conjunction on `AND` into a flat list of conjuncts.
2. **Resolve every column reference to a `(table, column)` pair first**, following table aliases. The index rule matches on the resolved pair, never on the identifier as written. `WHERE e.dept_id = 3` must find the index on `employees(dept_id)`.
3. **Push down:** each conjunct referencing exactly one relation is assigned to that relation. Conjuncts referencing both relations stay above the join as the residual `Filter`. Without this step the index can never fire in a join query, no matter how well step 2 works.
4. For each relation, if any of its assigned conjuncts is `col = literal` (either operand order) and a hash index exists on that resolved `(table, column)`, the planner **MUST** emit `IndexLookup` instead of `SeqScan`. That conjunct is consumed; the relation's remaining conjuncts become a `Filter` directly above the lookup. At most one `IndexLookup` per relation.

`planner.test.ts` must assert on a **serialized plan tree string**, not merely that a plan came back. Required cases include the aliased join query from the README, which must serialize with `IndexLookup` under the join — a stub planner cannot fake this.

#### Estimates (label them as estimates in the UI)

- `SeqScan` = table row count.
- `IndexLookup` = `max(1, ceil(rowCount / max(distinctKeys, 1)))`. There is no "unique-ish" special case; the formula already yields 1 for a unique column, and "unique-ish" is not a definable predicate.
- `Filter` = `ceil(child * 0.3)`, applied **once per Filter node**, not once per conjunct. Crude and documented.
- `NestedLoopJoin` = `ceil(left * right / max(distinctKeys(rightCol), 1))`. **Not** `left * right`: for the sample query a cross-product estimate gives ~96 against an actual of ~5, and every run of the flagship demo then looks like the estimator is broken, which destroys the teaching point.
- `Project`, `Sort` = child. `Distinct` = child (upper bound). `Limit` = `min(child, count)`.

`EXPLAIN SELECT` returns the plan tree as rows: `id, op, detail, est_rows`, **and** the structured tree on the same result object. Do not bolt this on with a cast — put an optional `plan` field on the result type from the start.

### executor.ts

Interpret the plan with generators so `Limit` short-circuits. Return `{ columns, rows, stats, plan? }` where stats include `rowsTouched`, `indexHits`, `elapsedMs`.

**Per-node counters are a first-class requirement, not a UI garnish.** The UI promises actual-vs-estimate per node and highlights whichever node dominated `rowsTouched`. The executor must accumulate `actualRows` and `rowsTouched` keyed by plan-node `id` and return them attached to the plan. Retrofitting this later is where the `as any` you banned shows up.

**The index must not change the answer.** `IndexLookup` equality and `Filter` equality are two implementations of one relation and must agree exactly. Test this as a property, not an example — see the test list.

### hash-index.ts

Keys are serialized with a runtime-type tag so `1` and `"1"` do not collide: `n:1`, `t:1`, `b:true`. **Tag on the runtime type, not the declared column type** — v1 of this spec suggested `i:` vs `t:`, which would put `1` and `1.0` in different buckets and make `WHERE x = 1.0` silently miss rows that a sequential scan would find. NULL keys live in a separate bucket; equality lookup never returns NULL-keyed rows.

### csv.ts

Parse RFC4180-ish CSV (quotes, doubled quotes, newlines in quotes). Infer types per column from the first 200 non-null cells. Column names from the header row, sanitized: lowercase, non-`[a-z0-9_]` → `_`, leading digit gets a `c` prefix, empty → `c{n}`, duplicates get `_2`, `_3`. If the header is missing or invalid, `c1,c2,...`.

Dates are TEXT. Write `placed_at` as ISO-8601 (`YYYY-MM-DD`) so lexicographic `>` is chronological, and say so in the README.

### Concurrency / limits

Engine is single-threaded. Cap: refuse CSV > 20 MB or > 200,000 rows with a clear error. Document the cap.

---

## CLI

```
npm run cli -- [--table NAME] --file a.csv [--file b.csv] --query 'SELECT ...'
npm run cli -- --explain --file a.csv --query 'SELECT ...'
```

Multiple `--file` flags load multiple tables. Default table name = file basename without extension. `--table` applies to the next `--file`.

Print results as aligned columns to stdout. Exit 1 on error with message on stderr. No colors required.

---

## UI (user-friendly, not decorative)

One screen. Desktop-first, usable down to 900px. No hamburger. No hero section. No gradient mesh.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│ TinySQL          [Employees] [Departments] [Orders]  Load CSV│
├──────────────┬──────────────────────────────┬───────────────┤
│ SCHEMA       │ EDITOR                       │ PLAN          │
│ table list   │ CodeMirror 6                 │ node tree     │
│ columns      │ Run  ⌘↵   Explain            │               │
│ indexes      │                              │               │
│ Create index │──────────────────────────────│ stats         │
│ button       │ RESULTS                                      │
│              │ grid, sortable by click on header            │
│              │ row count · ms · rows touched                │
└──────────────┴──────────────────────────────────────────────┘
```

- Left ~240px schema. Center editor 40% height, results 60%. Right ~280px plan.
- Status bar at the bottom of results: `24 rows · 3.2 ms · 80 rows touched · index used: emp_dept`

### Editor: CodeMirror 6, decided

v1 of this spec said "textarea / Monaco" and separately said to prefer CodeMirror if the bundle exceeds 1.5 MB gzipped. Monaco plus its workers lands at or over that line, and a plain textarea cannot underline the offending token as required. The choice is already made by the spec's own rules — use CodeMirror 6 with `@codemirror/lang-sql` and stop paying for a mid-build editor swap.

### Behavior

- Three bundled datasets load on first visit (employees, departments, orders).
- Clicking a table inserts `SELECT * FROM name LIMIT 50;`
- "Create index on this column" from the schema panel runs `CREATE INDEX ...`.
- **"Generate 50k orders"** button synthesizes a large table in-browser. 40-row demo tables cannot show a planner working: `SeqScan` and `IndexLookup` both finish in well under a millisecond and only `rows touched` moves. At 50k rows the index changes wall-clock time, which is the entire thing this app exists to show. In-browser generation keeps it out of the repo and out of the static deploy.
- Drag-and-drop CSV onto the window or the left panel. Table name from filename.
- Run on ⌘/Ctrl+Enter. Button also exists.
- Parse errors: red underline on the offending token + message under the editor, no modal.
- Empty results: "0 rows" not a blank void.
- Plan view: vertical tree, each node a card: operator, detail, est rows, actual rows after a run. Highlight the node that dominated `rowsTouched`.
- After EXPLAIN, estimates only. After RUN, actual vs est.
- Do not auto-run on every keystroke.
- Duplicate output column names (`SELECT e.name, d.name`) are disambiguated in the grid by showing the qualified name. Do not render two columns both labelled `name`.

### Visual design

Dark tool UI.

```
--bg:        #101114
--bg-2:      #181a1f
--bg-3:      #1f2229
--border:    #2a2e37
--text:      #e8eaef
--muted:     #8b93a1
--accent:    #7aa2ff
--good:      #3dd68c
--warn:      #e6b450
--bad:       #ff6b6b
--mono:      "IBM Plex Mono", ui-monospace, monospace
--sans:      "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif
```

Load IBM Plex Sans + Mono from a single Google Fonts link. No other fonts.

12px labels, 13px mono editor, 13px grid. Tight padding (8/12). Focus rings on buttons and editor. Schema tables are buttons. Do not use color alone for index-used; include the word "index."

Accessibility: keyboard to run, visible focus, contrast AA, results table has proper column headers. Reduced-motion: plan does not animate.

### Sample data (create these files)

`employees.csv`: id, name, dept_id, salary, city — ≥ 40 rows.
`departments.csv`: id, name, floor — ≥ 8 rows.
`orders.csv`: id, employee_id, amount, placed_at — ≥ 40 rows.

README "try this" snippet:

```sql
CREATE INDEX emp_dept ON employees (dept_id);
EXPLAIN SELECT e.name AS employee, d.name AS department
FROM employees e
JOIN departments d ON e.dept_id = d.id
WHERE e.dept_id = 3;
```

Note the aliases on the output columns: without them the result has two columns named `name`.

---

## Tests (do not skip; do not "add later")

Vitest. Every test file above must exist and pass.

Minimum cases:

- **Lexer:** strings with escaped quotes, comments, `!=` vs `<>`, numbers `1`, `1.0`, `.5`, line/column accuracy on a multi-line statement.
- **Parser:** join + where + order + limit; table aliases; `SELECT` with no `FROM`; error on trailing comma in a column list.
- **Executor:** NULL in WHERE, AND/OR under 3VL, `NOT unknown`, LIKE `%x_`, DISTINCT collapsing NULLs, ORDER BY NULL placement, LIMIT/OFFSET.
- **Planner:** no index → `SeqScan`; `col = 3` with index → `IndexLookup`; extra AND predicate remains in `Filter`; **the aliased join query resolves through the alias and pushes the predicate below the join**; DISTINCT changes the plan shape; asserted as serialized tree strings.
- **Index:** insert after `createIndex` is visible to lookup; `1` vs `"1"` do not collide; `1` and `1.0` **do** collide (same value); `DROP TABLE` removes its indexes.
- **Index/scan equivalence (property test):** for a table of mixed integer/real/text/boolean/NULL values, `SELECT * FROM t WHERE col = X` returns byte-identical rows with the index present and absent, for every distinct X in the column plus values not present. This is the test that catches a planner that changes the answer, and it is worth more than every other planner assertion combined.
- **CSV:** quoted comma, embedded newline, doubled quotes, inferred types, header sanitization.
- **Golden:** load the bundled CSVs, run the sample join, assert the exact employee list for `dept_id = 3`, and assert the same query returns the same rows with and without the index.
- **No forbidden deps:** read `package.json`, assert no dependency field mentions `sql.js`, `sqlite`, `duckdb`, `alasql`, `lokijs`, `taffydb`, or `node-sql-parser`.

If a test is awkward to write, the API is wrong. Fix the API.

---

## package.json details

Dependencies, slim:

- `codemirror`, `@codemirror/lang-sql`, `@codemirror/view`, `@codemirror/state`
- `vite`, `typescript`, `vitest`, `tsx`

No Express. No React. No state library. Vanilla TypeScript UI.

---

## Implementation order (follow this; do not start with CSS)

1. `types.ts` `errors.ts` `ast.ts`
2. `lexer.ts` + tests
3. `parser.ts` + tests
4. `catalog.ts` `hash-index.ts` + tests
5. `planner.ts` + tests
6. `executor.ts` + tests
7. `csv.ts` + golden test with fixtures
8. CLI
9. UI shell that can run `SELECT 1`
10. Schema panel, results, plan view, dropzone, bundled datasets
11. README + ARCHITECTURE.md polish

---

## Quality bar

- Strict TypeScript. `noImplicitAny`. No `as any`.
- Pure engine functions. Catalog is the only mutable store.
- No `console.log` in engine paths.
- Format errors as `Tinysql: parse error at 3:12: expected identifier`
- If you add a feature not in this spec, delete it before finishing.

---

## Out of scope (refuse these if suggested mid-build)

Transactions, UPDATE/DELETE, LEFT JOIN, aggregates, GROUP BY, subqueries, views, persistence beyond `localStorage` of the last query text, user accounts, share-server, AI rewrite, dark/light toggle as a first feature, mobile redesign.

`localStorage` of editor text is allowed so refresh does not wipe work. It is not a backend.

---

## When you are done

1. `npm test` passes.
2. `npm run build` produces static `dist/`.
3. CLI runs the sample query against the bundled CSVs.
4. README can be followed by a stranger in five minutes — including the CLI line, which must be the one that works on a fresh clone.
5. `ARCHITECTURE.md` (≤ 80 lines) describes data flow, the index rule, and the estimate formulas.

Then stop.
