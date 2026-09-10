import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Catalog, MAX_BYTES } from "../engine/catalog.js";
import { createTableFromCsv, tableNameFromFile } from "../engine/csv.js";
import { run } from "../engine/executor.js";
import { formatError } from "../engine/errors.js";
import { formatMs, formatTable, pluralRows } from "../engine/format.js";

const USAGE = `tinysql — a from-scratch SQL engine with a visible query planner

Usage:
  npm run cli -- [--table NAME] --file DATA.csv [--file MORE.csv] --query 'SELECT ...'
  npm run cli -- --explain --file DATA.csv --query 'SELECT ...'

Options:
  --file PATH     Load a CSV as a table. Repeatable.
  --table NAME    Name for the next --file. Defaults to the file's base name.
  --query SQL     The SQL to run. Multiple ';'-separated statements are allowed.
  --explain       Show the query plan instead of running the query.
  --help          Show this message.

Example:
  npm run cli -- --file public/datasets/employees.csv \\
                 --file public/datasets/departments.csv \\
                 --query "SELECT e.name AS employee, d.name AS department
                          FROM employees e JOIN departments d ON e.dept_id = d.id
                          WHERE e.dept_id = 3"`;

interface Options {
  files: { path: string; table: string }[];
  query: string | null;
  explain: boolean;
  help: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Options {
  const options: Options = { files: [], query: null, explain: false, help: false };
  let pendingTable: string | null = null;

  const valueOf = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--explain":
        options.explain = true;
        break;
      case "--table":
        pendingTable = valueOf(arg, i);
        i++;
        break;
      case "--file": {
        const path = valueOf(arg, i);
        i++;
        options.files.push({ path, table: pendingTable ?? tableNameFromFile(basename(path)) });
        pendingTable = null;
        break;
      }
      case "--query":
      case "-q":
        options.query = valueOf(arg, i);
        i++;
        break;
      default:
        throw new UsageError(`unknown option '${arg}'`);
    }
  }

  if (pendingTable !== null) {
    throw new UsageError("--table must be followed by a --file");
  }
  return options;
}

function loadFile(catalog: Catalog, path: string, table: string): number {
  let text: string;
  try {
    const stats = statSync(path);
    if (stats.size > MAX_BYTES) {
      throw new Error(`file is larger than the ${Math.round(MAX_BYTES / 1024 / 1024)} MB limit`);
    }
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new UsageError(`cannot read '${path}': ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = createTableFromCsv(catalog, table, text);
  return parsed.rows.length;
}

function main(argv: string[]): number {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}\n`);
    return 1;
  }

  if (options.help || argv.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return options.help ? 0 : 1;
  }

  if (options.query === null) {
    process.stderr.write(`--query is required\n\n${USAGE}\n`);
    return 1;
  }

  const catalog = new Catalog();
  const loadedTables: string[] = [];

  try {
    for (const file of options.files) {
      const rows = loadFile(catalog, file.path, file.table);
      loadedTables.push(`${file.table} (${pluralRows(rows)})`);
    }

    const sql = options.explain && !/^\s*explain\b/i.test(options.query)
      ? `EXPLAIN ${options.query}`
      : options.query;

    const result = run(sql, catalog);

    if (result.notice !== undefined && result.columns.length === 0) {
      process.stdout.write(`${result.notice}\n`);
      return 0;
    }

    process.stdout.write(`${formatTable(result.columns, result.rows)}\n`);

    if (result.explained) {
      process.stdout.write("\nestimates only — drop --explain to run the query\n");
    } else {
      const parts = [
        pluralRows(result.rows.length),
        formatMs(result.stats.elapsedMs),
        `${result.stats.rowsTouched.toLocaleString("en-US")} rows touched`,
      ];
      parts.push(
        result.stats.indexesUsed.length > 0
          ? `index used: ${result.stats.indexesUsed.join(", ")}`
          : "no index used",
      );
      process.stdout.write(`\n${parts.join(" · ")}\n`);
    }
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof UsageError ? e.message : formatError(e)}\n`);
    if (loadedTables.length > 0) {
      process.stderr.write(`loaded tables: ${loadedTables.join(", ")}\n`);
    }
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
