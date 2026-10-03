// Generated from src/mcp/tools.ts by scripts/build-plugin.ts. Do not edit:
// change the TypeScript source and run `npm run build:plugin`.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import { Catalog, MAX_BYTES } from "../engine/catalog.mjs";
import { createTableFromCsv } from "../engine/csv.mjs";
import { formatError, isTinysqlError } from "../engine/errors.mjs";
import { run } from "../engine/executor.mjs";
import { createIndexSql, formatMs, formatTable, pluralRows } from "../engine/format.mjs";
import { tokenize } from "../engine/lexer.mjs";
import { children, describe, suggestIndex } from "../engine/planner.mjs";
export const MAX_FILES = 8;
export const DEFAULT_MAX_ROWS = 50;
export const MAX_MAX_ROWS = 1000;
/** Text cells longer than this are shortened in the displayed rows only. */
export const MAX_CELL_CHARS = 100;
/** Upper bound on one tool result, so a wide table cannot flood the model's context. */
export const MAX_OUTPUT_CHARS = 60_000;
const TABLES_PROPERTY = {
    type: "object",
    description: 'Map of table name to CSV file path, e.g. {"employees": "data/employees.csv"}. ' +
        "Relative paths resolve against the directory the session started in, and ~ is the home directory. Only files " +
        `ending in .csv, up to ${MAX_BYTES / 1024 / 1024} MB and 200,000 rows each, at most ${MAX_FILES} files.`,
    additionalProperties: { type: "string" },
};
// Annotations are hints for the client. "Read-only" is literal: the tools read
// the files they are given and never write anywhere; CREATE TABLE, INSERT and
// CREATE INDEX only touch the in-memory database that the call discards.
const READ_ONLY = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
/**
 * The two tools the Claude Code plugin exposes. Both are pure functions of
 * their arguments and the files those arguments name: every call builds a
 * fresh in-memory catalog and throws it away afterwards, so nothing persists
 * between calls and no call can see another's tables. The MCP spec treats a
 * stdio process as stateless, and a query that silently depended on an earlier
 * call's CREATE INDEX would be the kind of hidden state that makes a plan
 * impossible to explain.
 */
export const TOOLS = [
    {
        name: "describe_csv",
        title: "Describe CSV files",
        description: "Load CSV files and show each one as TinySQL sees it: column names as SQL must spell " +
            "them, inferred types (INTEGER, REAL, TEXT), distinct values per column, the row count " +
            "and the first rows. Call it before writing SQL against an unfamiliar file. Reads the " +
            "files only; nothing persists after the call.",
        inputSchema: {
            type: "object",
            properties: { tables: TABLES_PROPERTY },
            required: ["tables"],
            additionalProperties: false,
        },
        annotations: { title: "Describe CSV files", ...READ_ONLY },
    },
    {
        name: "run_sql",
        title: "Run SQL and show the plan",
        description: "Run SQL over local CSV files with TinySQL, a from-scratch engine with a visible query " +
            "planner. Each call starts an empty in-memory database, loads the files in `tables`, " +
            "runs the script and returns the last statement's rows plus the plan the engine actually " +
            "ran: estimated vs actual rows per step, base-table rows read, the indexes used, and the " +
            "CREATE INDEX statement that would turn a full scan into an index lookup. Nothing persists " +
            "between calls, so put CREATE INDEX (or CREATE TABLE and INSERT) in the same script as " +
            "the query it serves. Dialect: SELECT [DISTINCT] ... FROM, one inner JOIN ... ON a.col = " +
            "b.col, WHERE with = != <> < <= > >= AND OR NOT, IS [NOT] NULL and LIKE, ORDER BY, LIMIT " +
            "and OFFSET; EXPLAIN SELECT; CREATE TABLE, CREATE INDEX, INSERT, DROP TABLE. Not " +
            "supported: aggregates (COUNT, SUM, AVG, MIN, MAX), GROUP BY, HAVING, LEFT or OUTER JOIN, " +
            "subqueries, UNION, UPDATE, DELETE. Values of different types are never equal (1 = '1' " +
            "is false), and LIKE is case-sensitive.",
        inputSchema: {
            type: "object",
            properties: {
                sql: {
                    type: "string",
                    description: "One or more statements separated by semicolons. The last statement's result is returned.",
                },
                tables: TABLES_PROPERTY,
                max_rows: {
                    type: "integer",
                    minimum: 1,
                    maximum: MAX_MAX_ROWS,
                    default: DEFAULT_MAX_ROWS,
                    description: `Most result rows to show (1-${MAX_MAX_ROWS}, default ${DEFAULT_MAX_ROWS}). Counts and the plan always cover the whole result.`,
                },
            },
            required: ["sql"],
            additionalProperties: false,
        },
        annotations: { title: "Run SQL and show the plan", ...READ_ONLY },
    },
];
/** A problem with the arguments or the files they name, reported back to the model as-is. */
class ArgumentError extends Error {
}
/**
 * Run one tool. Returns null for an unknown tool name, which the protocol layer
 * reports as invalid params; every other failure, including a bug in the engine,
 * comes back as an error result the model can read.
 */
export function callTool(name, args, cwd = process.cwd()) {
    const tool = name === "describe_csv" ? describeCsv : name === "run_sql" ? runSql : null;
    if (tool === null)
        return null;
    try {
        return { text: tool(readArgs(args), cwd), isError: false };
    }
    catch (e) {
        if (e instanceof ArgumentError)
            return { text: e.message, isError: true };
        if (isTinysqlError(e))
            return { text: formatError(e), isError: true };
        return { text: `TinySQL hit an unexpected error: ${errorMessage(e)}`, isError: true };
    }
}
// ---------------------------------------------------------------- describe_csv
function describeCsv(args, cwd) {
    allowOnly(args, ["tables"]);
    const tables = readTables(args.tables, true);
    const catalog = new Catalog();
    const loaded = loadTables(catalog, tables, cwd);
    const sections = loaded.map((table) => {
        const columns = table.columns
            .map((c) => {
            const distinct = catalog.distinctCount(table.name, c.name).toLocaleString("en-US");
            return `${c.name} ${c.type.toUpperCase()} (${distinct} distinct)`;
        })
            .join(", ");
        const sample = catalog.getTable(table.name).rows.slice(0, 5);
        const lines = [
            `Table ${table.name}: ${pluralRows(table.rowCount)}, loaded from ${table.path}`,
            `Columns: ${columns}`,
        ];
        if (sample.length > 0) {
            lines.push(`First ${pluralRows(sample.length)}:`, formatTable(table.columns.map((c) => c.name), sample.map(shortenCells)));
        }
        return lines.join("\n");
    });
    sections.push("Column names were folded to lowercase identifiers from the CSV header. Types come from " +
        "every cell, and an empty cell is NULL.");
    return capOutput(sections.join("\n\n"));
}
// --------------------------------------------------------------------- run_sql
function runSql(args, cwd) {
    allowOnly(args, ["sql", "tables", "max_rows"]);
    const sql = args.sql;
    if (typeof sql !== "string" || sql.trim() === "") {
        throw new ArgumentError("sql is required: one or more SQL statements separated by semicolons.");
    }
    const maxRows = readMaxRows(args.max_rows);
    const tables = readTables(args.tables, false);
    const catalog = new Catalog();
    const loaded = loadTables(catalog, tables, cwd);
    let result;
    try {
        result = run(sql, catalog);
    }
    catch (e) {
        if (!isTinysqlError(e))
            throw e;
        const lines = [formatError(e)];
        if (e.kind === "parse" || e.kind === "lex") {
            const unsupported = findUnsupported(sql);
            if (unsupported !== null) {
                lines.push(`TinySQL does not support ${unsupported}. Its dialect has no aggregates, GROUP BY, ` +
                    "HAVING, outer joins, subqueries, UNION, UPDATE or DELETE, so this query cannot run here.");
            }
        }
        lines.push(describeLoaded(loaded));
        throw new ArgumentError(lines.join("\n"));
    }
    if (result.explained === true && result.plan !== undefined) {
        return capOutput(renderExplain(result.plan));
    }
    if (result.plan === undefined) {
        // CREATE TABLE, INSERT, CREATE INDEX or DROP TABLE as the last statement.
        return [
            result.notice ?? "done",
            "This database lasted only for this call. Repeat these statements in the next run_sql " +
                "call, ahead of the query that needs them.",
        ].join("\n");
    }
    return renderRun(result, result.plan, maxRows);
}
function renderRun(result, plan, maxRows) {
    const { stats } = result;
    const summary = [
        pluralRows(result.rows.length),
        formatMs(stats.elapsedMs),
        `${stats.rowsTouched.toLocaleString("en-US")} rows touched`,
        stats.indexesUsed.length > 0 ? `index used: ${stats.indexesUsed.join(", ")}` : "no index used",
    ].join(" · ");
    const after = [
        "",
        "Plan the engine ran (est = planner estimate, actual = rows produced, read = base-table rows read; the reads add up to rows touched):",
        ...planLines(plan, result.nodeStats),
        ...suggestionLines(plan),
    ].join("\n");
    // Fit the rows to whatever budget the summary and plan leave. formatTable pads
    // every row to one width, so the rows that fit can be counted in one step.
    let shown = Math.min(result.rows.length, maxRows);
    let table = formatTable(result.columns, result.rows.slice(0, shown).map(shortenCells));
    const budget = MAX_OUTPUT_CHARS - summary.length - after.length - 200;
    if (table.length > budget && shown > 0) {
        const [header = "", rule = "", first = ""] = table.split("\n");
        const fit = Math.max(0, Math.floor((budget - header.length - rule.length - 2) / (first.length + 1)));
        shown = Math.min(shown, fit);
        table = formatTable(result.columns, result.rows.slice(0, shown).map(shortenCells));
    }
    const notes = [];
    if (shown < result.rows.length) {
        notes.push(`Showing the first ${shown.toLocaleString("en-US")} of ${pluralRows(result.rows.length)}. ` +
            "Add LIMIT/OFFSET, select fewer columns, or raise max_rows to see others.");
    }
    if (result.rows.slice(0, shown).some((row) => row.some(isLongText))) {
        notes.push(`Text longer than ${MAX_CELL_CHARS} characters is shortened above; the values themselves are whole.`);
    }
    const parts = [summary];
    if (result.columns.length > 0)
        parts.push("", table);
    if (notes.length > 0)
        parts.push("", ...notes);
    return capOutput(parts.join("\n") + "\n" + after);
}
function renderExplain(plan) {
    return [
        "EXPLAIN: estimates only. Run the query without EXPLAIN to see actual rows and rows read.",
        "",
        "Plan (est = planner estimate):",
        ...planLines(plan, undefined),
        ...suggestionLines(plan),
    ].join("\n");
}
/** The plan as an indented tree, one node per line, in the vocabulary of the web UI's plan panel. */
function planLines(plan, nodeStats) {
    const hottest = nodeStats === undefined ? null : findHottest(plan, nodeStats);
    const lines = [];
    const walk = (node, depth) => {
        const detail = describe(node);
        const head = detail === "" ? node.op : `${node.op}(${detail})`;
        const counts = [`est ${node.estRows.toLocaleString("en-US")}`];
        const stats = nodeStats?.get(node.id);
        if (stats !== undefined) {
            counts.push(`actual ${stats.actualRows.toLocaleString("en-US")}`);
            if (stats.rowsTouched > 0)
                counts.push(`read ${stats.rowsTouched.toLocaleString("en-US")}`);
        }
        const mark = node.id === hottest ? "  <- most rows read" : "";
        lines.push(`${"  ".repeat(depth + 1)}${head}  [${counts.join(", ")}]${mark}`);
        for (const child of children(node))
            walk(child, depth + 1);
    };
    walk(plan, 0);
    return lines;
}
/** The node that read the most base-relation rows, if any did. Same rule as the plan panel. */
function findHottest(plan, nodeStats) {
    let best = null;
    let bestRows = 0;
    const walk = (node) => {
        const rows = nodeStats.get(node.id)?.rowsTouched ?? 0;
        if (rows > bestRows) {
            bestRows = rows;
            best = node.id;
        }
        for (const child of children(node))
            walk(child);
    };
    walk(plan);
    return best;
}
function suggestionLines(plan) {
    const suggestion = suggestIndex(plan);
    if (suggestion === null)
        return [];
    const { table, column, reason } = suggestion;
    const why = reason === "join"
        ? `${table}.${column} has no index, so the join rereads every row of ${table} for each outer row.`
        : `${table}.${column} has no index, so this plan reads every row of ${table}.`;
    return [
        "",
        `Index suggestion: ${why} To use an index, put this statement before the query in the same run_sql call:`,
        createIndexSql(table, column),
    ];
}
// ------------------------------------------------------------- loading files
function loadTables(catalog, tables, cwd) {
    const loaded = [];
    for (const [name, path] of tables) {
        const real = checkedPath(path, cwd);
        let text;
        try {
            text = readFileSync(real, "utf8");
        }
        catch (e) {
            throw new ArgumentError(`Cannot read '${path}' (${real}): ${errorMessage(e)}`);
        }
        try {
            const parsed = createTableFromCsv(catalog, name, text);
            loaded.push({ name, path: real, rowCount: parsed.rows.length, columns: parsed.columns });
        }
        catch (e) {
            throw new ArgumentError(`${path}: ${formatError(e)}`);
        }
    }
    return loaded;
}
/**
 * Resolve a path the model passed and refuse anything but a regular .csv file
 * within the size limit. The extension is checked on the path as given and again
 * after following links, so a link named .csv cannot open some other file.
 */
function checkedPath(path, cwd) {
    // Shells expand ~ and Node does not, so a path copied from a terminal would otherwise miss.
    const expanded = /^~(?=$|[\\/])/.test(path) ? homedir() + path.slice(1) : path;
    const absolute = resolve(cwd, expanded);
    if (extname(absolute).toLowerCase() !== ".csv") {
        throw new ArgumentError(`'${path}' is not a .csv file. TinySQL only loads files whose names end in .csv.`);
    }
    let real;
    let stats;
    try {
        real = realpathSync(absolute);
        stats = statSync(real);
    }
    catch (e) {
        throw new ArgumentError(`Cannot read '${path}' (looked for ${absolute}): ${errorMessage(e)}`);
    }
    if (extname(real).toLowerCase() !== ".csv") {
        throw new ArgumentError(`'${path}' links to ${real}, which is not a .csv file.`);
    }
    if (!stats.isFile()) {
        throw new ArgumentError(`'${path}' (${real}) is not a regular file.`);
    }
    if (stats.size > MAX_BYTES) {
        const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        throw new ArgumentError(`'${path}' is ${mb(stats.size)}; TinySQL loads CSV files up to ${mb(MAX_BYTES)}.`);
    }
    return real;
}
function describeLoaded(loaded) {
    if (loaded.length === 0)
        return "No CSV files were loaded for this call; name them in `tables`.";
    const tables = loaded.map((t) => `${t.name}(${t.columns.map((c) => c.name).join(", ")})`);
    return `Tables loaded for this call: ${tables.join("; ")}`;
}
// ------------------------------------------------------------------ arguments
function readArgs(args) {
    if (args === undefined || args === null)
        return {};
    if (typeof args !== "object" || Array.isArray(args)) {
        throw new ArgumentError("Tool arguments must be a JSON object.");
    }
    return args;
}
function allowOnly(args, known) {
    const unknown = Object.keys(args).filter((key) => !known.includes(key));
    if (unknown.length > 0) {
        throw new ArgumentError(`Unknown argument ${unknown.map((k) => `'${k}'`).join(", ")}; expected ${known.join(", ")}.`);
    }
}
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Validated table name → path pairs. Names fold to lowercase, as unquoted SQL identifiers do. */
function readTables(value, required) {
    const example = '{"employees": "data/employees.csv"}';
    if (value === undefined || value === null) {
        if (required)
            throw new ArgumentError(`tables is required: map each table name to a CSV path, e.g. ${example}.`);
        return new Map();
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new ArgumentError(`tables must map table names to CSV paths, e.g. ${example}.`);
    }
    const entries = Object.entries(value);
    if (required && entries.length === 0) {
        throw new ArgumentError(`tables is empty: map at least one table name to a CSV path, e.g. ${example}.`);
    }
    if (entries.length > MAX_FILES) {
        throw new ArgumentError(`At most ${MAX_FILES} CSV files can be loaded in one call; got ${entries.length}.`);
    }
    const tables = new Map();
    for (const [rawName, path] of entries) {
        if (!TABLE_NAME.test(rawName)) {
            throw new ArgumentError(`Table name '${rawName}' must be a plain SQL identifier: letters, digits and underscores, not starting with a digit.`);
        }
        const name = rawName.toLowerCase();
        if (tokenize(name)[0]?.kind === "keyword") {
            throw new ArgumentError(`Table name '${rawName}' is a SQL keyword; pick another, such as '${name}s' or '${name}_data'.`);
        }
        if (tables.has(name)) {
            throw new ArgumentError(`Table name '${name}' is given twice (names are case-insensitive).`);
        }
        if (typeof path !== "string" || path.trim() === "") {
            throw new ArgumentError(`The path for table '${rawName}' must be a non-empty string.`);
        }
        tables.set(name, path);
    }
    return tables;
}
function readMaxRows(value) {
    if (value === undefined || value === null)
        return DEFAULT_MAX_ROWS;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_MAX_ROWS) {
        throw new ArgumentError(`max_rows must be a whole number from 1 to ${MAX_MAX_ROWS}.`);
    }
    return value;
}
// --------------------------------------------------------------------- output
function isLongText(value) {
    return typeof value === "string" && value.length > MAX_CELL_CHARS;
}
/** Display copy of a row with long text shortened. The result rows are not touched. */
function shortenCells(row) {
    return row.some(isLongText)
        ? row.map((v) => (typeof v === "string" && v.length > MAX_CELL_CHARS ? `${v.slice(0, MAX_CELL_CHARS - 1)}…` : v))
        : row;
}
function capOutput(text) {
    if (text.length <= MAX_OUTPUT_CHARS)
        return text;
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… output cut at ${MAX_OUTPUT_CHARS.toLocaleString("en-US")} characters.`;
}
const UNSUPPORTED = [
    [/\bgroup\s+by\b/i, "GROUP BY"],
    [/\bhaving\b/i, "HAVING"],
    [/\b(count|sum|avg|min|max)\s*\(/i, "aggregate functions"],
    [/\b(left|right|full|outer|cross)\s+(outer\s+)?join\b/i, "outer joins"],
    [/\(\s*select\b/i, "subqueries"],
    [/\bunion\b/i, "UNION"],
    [/^\s*update\b|;\s*update\b/i, "UPDATE"],
    [/^\s*delete\b|;\s*delete\b/i, "DELETE"],
];
/** Name the first unsupported feature a failed query appears to use, so the model stops retrying it. */
function findUnsupported(sql) {
    for (const [pattern, feature] of UNSUPPORTED)
        if (pattern.test(sql))
            return feature;
    return null;
}
function errorMessage(e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT")
        return "no such file";
    return e instanceof Error ? e.message : String(e);
}
