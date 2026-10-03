---
name: explain
description: Run SQL over local CSV files with TinySQL and explain the plan it actually ran, including the rows each step read, estimated vs actual counts, and which index would turn a full scan into a lookup. Use when someone wants to filter, join or sort CSV rows with SQL, asks why a query reads so many rows, or wants to see what an index changes. Not for COUNT, SUM, GROUP BY or other aggregates, which TinySQL does not support.
license: MIT
compatibility: Needs the TinySQL plugin's local MCP server, which runs in Claude Code and in Cowork on your own computer, and Node.js 18 or later on the PATH.
---

# Explain a query with TinySQL

TinySQL is a small SQL engine with a visible query planner. Its `run_sql` tool returns the rows and the plan the engine executed, so you can show exactly where the work went. Its `describe_csv` tool shows how TinySQL reads a CSV file before you write SQL against it.

If `run_sql` and `describe_csv` are not available in this session, the plugin's local server is not running here. It runs in Claude Code and in Cowork on the user's computer, not in claude.ai chat. Say so plainly. Never imitate the engine's output.

## Workflow

1. Find the CSV files. Use the user's paths. For a demo without their data, use the sample files that ship with the plugin:
   - `${CLAUDE_PLUGIN_ROOT}/examples/employees.csv`: 44 rows of id, name, dept_id, salary, city
   - `${CLAUDE_PLUGIN_ROOT}/examples/departments.csv`: 8 rows of id, name, floor
   - `${CLAUDE_PLUGIN_ROOT}/examples/orders.csv`: 48 rows of id, employee_id, amount, placed_at
2. Call `describe_csv` for any file you have not seen. Column names are folded to lowercase identifiers, so write them as it shows them.
3. Call `run_sql` with every file the query needs in `tables`. Every call starts from an empty database: tables and indexes from an earlier call no longer exist.
4. Explain the plan in plain words, quoting its numbers: which table was read in full (`SeqScan`), where an index was used (`IndexLookup`), which step read the most rows (marked `<- most rows read`), and where the estimates and the actual counts disagree.
5. When the result ends with an index suggestion, explain why that index helps. Then run the same query again with the suggested `CREATE INDEX` statement first in `sql`, and compare `rows touched` before and after. A second suggestion can follow the first: index the `WHERE` column first, then the join column.

On the sample data, this query shows the whole lesson in three runs. It touches 108 rows with no index, 71 rows after `CREATE INDEX "employees_dept_id" ON "employees" ("dept_id");`, and 14 rows once `CREATE INDEX "departments_id" ON "departments" ("id");` is added as well. All three runs return the same 7 rows.

```sql
SELECT e.name AS employee, d.name AS department, e.salary
FROM employees e
JOIN departments d ON e.dept_id = d.id
WHERE e.dept_id = 3
ORDER BY e.salary DESC;
```

## The dialect

- `SELECT [DISTINCT] items FROM table [alias] [JOIN table [alias] ON a.col = b.col] [WHERE ...] [ORDER BY col [ASC|DESC], ...] [LIMIT n [OFFSET n]]`. One inner equijoin per query.
- `EXPLAIN SELECT ...` shows the plan with estimates only.
- `CREATE TABLE`, `CREATE INDEX name ON table (col)`, `INSERT INTO ... VALUES ...` and `DROP TABLE` work inside one call's script.
- Operators: `= != <> < <= > >= AND OR NOT`, `IS NULL`, `IS NOT NULL`, and `LIKE` with `%` and `_`. LIKE is case-sensitive.
- Values of different types are never equal: `1 = '1'` is false. Any comparison with NULL is unknown, so `WHERE x != 3` also drops rows where x is NULL.
- `ORDER BY` puts NULLs first when ascending. Dates are TEXT, and ISO dates such as `2026-07-04` compare in calendar order.
- Give output columns aliases when two of them share a name, as in `e.name AS employee`.

## When TinySQL cannot help

TinySQL has no aggregates (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`), no `GROUP BY` or `HAVING`, no outer joins, no subqueries, no `UNION`, and no `UPDATE` or `DELETE`. If the question needs one of these, say that TinySQL cannot answer it and use another tool for the number. `ORDER BY ... LIMIT 1` can stand in for MIN or MAX when the user wants the row itself.

It reads only files whose names end in `.csv`, up to 20 MB and 200,000 rows each. It never writes files and keeps nothing after a call.
