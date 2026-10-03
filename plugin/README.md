# TinySQL

Run SQL over CSV files on your computer and see the plan the engine actually ran. TinySQL is a SQL
engine written from scratch in TypeScript, with no SQLite or DuckDB underneath. Every query comes
back with its plan: which table was read in full, where an index was used, how many rows each step
estimated and produced, and how many base-table rows the query touched in total. When one index
would turn a full scan into a lookup, TinySQL names it and gives you the exact `CREATE INDEX`
statement.

It is a way to learn how a query planner thinks, using your own data. Ask Claude why a query reads
so many rows, add the suggested index, and watch the count drop.

## Try it

The plugin ships with three small sample tables (employees, departments and orders), so these
prompts work before you point it at your own files:

1. "Use TinySQL on its sample data to show me how an index changes a query plan."
2. "With TinySQL's sample data, list every order over 1,000 with the name of the employee who placed
   it, largest first, and explain which step reads the most rows."
3. "Describe TinySQL's sample CSV files and tell me which columns would make good indexes."

For the first prompt, Claude runs the same join three times: 108 rows touched with no index, 71
after indexing the `WHERE` column, and 14 after indexing the join column. All three runs return the
same 7 rows.

Your own files work the same way: "Use TinySQL to show the rows in `~/Downloads/sales.csv` where
region is 'West', newest first, and explain the plan."

## What's included

- **`run_sql` tool.** Loads the CSV files you name, runs a SQL script, and returns the rows, the
  plan with estimated and actual counts per step, the indexes used, and an index suggestion.
- **`describe_csv` tool.** Shows how TinySQL reads a CSV file: column names, inferred types
  (INTEGER, REAL or TEXT), distinct values per column, the row count and the first rows.
- **`/tinysql:explain` skill.** Teaches Claude the workflow: describe the files, run the query,
  explain the plan in plain words, then rerun with the suggested index and compare.

## What it reads, runs and sends

- **Reads** only the files Claude passes to a tool, and only if each name ends in `.csv` (checked
  again after following links), up to 20 MB and 200,000 rows per file and 8 files per call.
  Relative paths resolve against the folder your session started in, and `~` means your home folder.
- **Writes** nothing. Each tool call loads its files into a fresh in-memory database and discards
  it when the call returns. `CREATE TABLE`, `INSERT` and `CREATE INDEX` never leave that database.
- **Runs** one local process, `node server/mcp/server.mjs` from this plugin folder, which talks to
  Claude over standard input and output. It has no dependencies to install.
- **Sends** nothing over the network. There is no telemetry and no account. See
  [PRIVACY.md](PRIVACY.md).

Results go back into your conversation with Claude, like the output of any other tool.

## Requirements

- Node.js 18 or later on your `PATH`.
- Claude Code, or Cowork running on your computer. claude.ai chat loads the skill but cannot start
  the local server, so the tools are unavailable there.

## The SQL it understands

TinySQL implements a small dialect on purpose, so the planner stays readable: `SELECT [DISTINCT]`
with one inner `JOIN ... ON a.col = b.col`, `WHERE`, `ORDER BY`, `LIMIT` and `OFFSET`;
`EXPLAIN SELECT`; and `CREATE TABLE`, `CREATE INDEX`, `INSERT` and `DROP TABLE`. It has no
aggregates (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`), no `GROUP BY`, no outer joins, no subqueries, no
`UNION`, and no `UPDATE` or `DELETE`. For those, the skill tells Claude to say that TinySQL
cannot answer and to use another tool.

Values of different types are never equal (`1 = '1'` is false), comparisons with NULL are unknown,
and `LIKE` is case-sensitive. The project's [main README](https://github.com/derekwden-droid/tinysql#readme)
documents every rule, and the [live demo](https://derekwden-droid.github.io/tinysql/) runs the same
engine in a browser.

## Troubleshooting

- **The tools don't appear.** Check that `node --version` prints 18 or later in the terminal you
  start Claude Code from, then run `/mcp` in Claude Code to see the `tinysql` server's status.
- **"not a .csv file".** TinySQL loads only files whose names end in `.csv`. Copy or rename the file.
- **A table or column is missing.** Run `describe_csv` first. Column names come from the CSV header,
  folded to lowercase with spaces and punctuation turned into underscores (`Hire Date` becomes
  `hire_date`).
- **An index from the last query is gone.** That is by design: every call starts empty. Put the
  `CREATE INDEX` statement before the query in the same call.

Report problems at [github.com/derekwden-droid/tinysql/issues](https://github.com/derekwden-droid/tinysql/issues).

## Source and license

The engine lives in [`src/engine`](https://github.com/derekwden-droid/tinysql/tree/main/src/engine)
and the MCP server in [`src/mcp`](https://github.com/derekwden-droid/tinysql/tree/main/src/mcp). The
JavaScript in this folder's `server/` directory is generated from that TypeScript, one file per
module with comments kept, and the repository's tests fail if it goes stale. MIT licensed; see
[LICENSE](LICENSE).
