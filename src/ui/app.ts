import { Catalog } from "../engine/catalog.js";
import { createTableFromCsv, tableNameFromFile } from "../engine/csv.js";
import { formatError, isTinysqlError } from "../engine/errors.js";
import { run, type QueryResult } from "../engine/executor.js";
import { parse } from "../engine/parser.js";
import type { Row } from "../engine/types.js";
import { createEditor, type EditorHandle } from "./editor.js";
import { installDropzone } from "./dropzone.js";
import { renderPlan } from "./plan-view.js";
import { renderResults } from "./results-table.js";
import { renderSchema, renderSchemaFooter, type SchemaHandlers } from "./schema-panel.js";
import { renderStatus } from "./status-bar.js";

const STORAGE_KEY = "tinysql.editor";
const DATASETS = ["employees", "departments", "orders"] as const;
const LARGE_TABLE = "orders_big";
const LARGE_ROWS = 50_000;

const WELCOME = `-- This ran on load: the plan panel shows it reading every row of employees.
-- Press "Create index and rerun" there to index the WHERE, then again for the join.
SELECT e.name AS employee, d.name AS department, e.salary
FROM employees e
JOIN departments d ON e.dept_id = d.id
WHERE e.dept_id = 3
ORDER BY e.salary DESC;`;

interface Example {
  label: string;
  sql: string;
}

const EXAMPLES: Example[] = [
  {
    label: "Sample join",
    sql: `SELECT e.name AS employee, d.name AS department, e.salary
FROM employees e
JOIN departments d ON e.dept_id = d.id
WHERE e.dept_id = 3
ORDER BY e.salary DESC;`,
  },
  {
    label: "Scan vs index",
    sql: `-- EXPLAIN shows the plan without running it. With no index on
-- employees.dept_id a SeqScan feeds the join; "Create index and rerun" in the
-- plan panel turns it into an IndexLookup. Reload the page to drop indexes.
EXPLAIN SELECT e.name AS employee, d.name AS department
FROM employees e
JOIN departments d ON e.dept_id = d.id
WHERE e.dept_id = 3;`,
  },
  {
    label: "NULLs",
    sql: `-- Two employees have no city. NULL is never equal to anything,
-- so only IS NULL finds them.
SELECT name, city FROM employees WHERE city IS NULL;`,
  },
  {
    label: "LIKE + dates",
    sql: `SELECT id, amount, placed_at
FROM orders
WHERE placed_at LIKE '2026-07%'
ORDER BY amount DESC
LIMIT 10;`,
  },
];

interface Elements {
  editorHost: HTMLElement;
  editorError: HTMLElement;
  results: HTMLElement;
  status: HTMLElement;
  schema: HTMLElement;
  plan: HTMLElement;
  resultsNote: HTMLElement;
  datasets: HTMLElement;
  runButton: HTMLButtonElement;
  explainButton: HTMLButtonElement;
  loadButton: HTMLButtonElement;
  fileInput: HTMLInputElement;
  runHint: HTMLElement;
  app: HTMLElement;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element #${id}`);
  return found as T;
}

export async function start(): Promise<void> {
  const elements: Elements = {
    editorHost: el("editor"),
    editorError: el("editor-error"),
    results: el("results"),
    status: el("status"),
    schema: el("schema-panel"),
    plan: el("plan-panel"),
    resultsNote: el("results-note"),
    datasets: el("dataset-buttons"),
    runButton: el<HTMLButtonElement>("run-btn"),
    explainButton: el<HTMLButtonElement>("explain-btn"),
    loadButton: el<HTMLButtonElement>("load-csv"),
    fileInput: el<HTMLInputElement>("file-input"),
    runHint: el("run-hint"),
    app: el("app"),
  };

  const catalog = new Catalog();
  let lastResult: QueryResult | null = null;

  if (navigator.userAgent.includes("Mac")) elements.runHint.textContent = "⌘ ↵";

  const storedQuery = readStoredQuery();
  const editor: EditorHandle = createEditor(elements.editorHost, {
    initialDoc: storedQuery ?? WELCOME,
    onRun: () => execute(editor.getValue()),
    onExplain: () => explain(),
    onChange: (doc) => {
      try {
        localStorage.setItem(STORAGE_KEY, doc);
      } catch {
        // Private-mode storage failures must not break the editor.
      }
    },
  });

  const handlers: SchemaHandlers = {
    onSelectTable(table) {
      editor.setValue(`SELECT * FROM ${table} LIMIT 50;`);
      execute(editor.getValue());
    },
    onCreateIndex(table, column) {
      execute(createIndexSql(table, column));
    },
    onGenerateLarge() {
      generateLargeTable(catalog);
      refreshSchema();
      editor.setValue(`-- ${LARGE_ROWS.toLocaleString("en-US")} rows. Run this, then press "Create index and rerun"
-- in the plan panel and compare the time and the rows touched.
SELECT id, amount, placed_at
FROM ${LARGE_TABLE}
WHERE employee_id = 17
ORDER BY amount DESC
LIMIT 20;`);
      elements.status.replaceChildren(
        document.createTextNode(
          `${LARGE_TABLE} built with ${LARGE_ROWS.toLocaleString("en-US")} rows — run the query, then add the index.`,
        ),
      );
    },
  };

  // Created once and re-rendered in place, so the schema can refresh freely.
  const schemaFooter = document.createElement("div");
  schemaFooter.className = "panel-footer";
  elements.schema.parentElement?.append(schemaFooter);

  function refreshSchema(): void {
    renderSchema(elements.schema, catalog, handlers);
    renderSchemaFooter(schemaFooter, handlers, catalog.hasTable(LARGE_TABLE));
  }

  function showError(message: string, line?: number, column?: number): void {
    elements.editorError.textContent = message;
    elements.editorError.hidden = false;
    if (line !== undefined) editor.markError(line, column ?? 1);
    renderStatus(elements.status, null, message);
  }

  function clearError(): void {
    elements.editorError.hidden = true;
    elements.editorError.textContent = "";
    editor.clearError();
  }

  function execute(sql: string, baseline?: number): void {
    clearError();
    try {
      const result = run(sql, catalog);
      lastResult = result;
      renderResults(elements.results, result);
      renderPlan(elements.plan, result.plan ?? null, result.nodeStats ?? null, (table, column) =>
        indexAndRerun(table, column, sql, result),
      );
      renderStatus(elements.status, result, null, baseline);
      elements.resultsNote.textContent = result.explained === true ? "query plan" : "";
      elements.results.scrollTop = 0;
      refreshSchema();
    } catch (e) {
      lastResult = null;
      if (isTinysqlError(e)) showError(e.format(), e.line, e.column);
      else showError(formatError(e));
      renderResults(elements.results, null);
      elements.resultsNote.textContent = "";
    }
  }

  /**
   * The plan panel's one-click lesson: add the index the planner is missing,
   * then rerun only the statement that drew the plan, so the index is the one
   * thing that changed. Earlier statements in a script (CREATE TABLE, INSERT)
   * would fail or duplicate rows if they ran twice.
   */
  function indexAndRerun(table: string, column: string, sql: string, before: QueryResult): void {
    if (catalog.findIndex(table, column) === undefined) {
      try {
        run(createIndexSql(table, column), catalog);
      } catch (e) {
        // No position: the error is in generated SQL, not in the editor text.
        showError(isTinysqlError(e) ? e.format() : formatError(e));
        return;
      }
    }
    execute(lastStatement(sql), before.explained === true ? undefined : before.stats.rowsTouched);
  }

  /**
   * Prepend EXPLAIN to the LAST statement, so a script such as
   * `CREATE INDEX ...; SELECT ...` still creates the index and explains the
   * select. The statement's source offset comes from the parser.
   */
  function explain(): void {
    const sql = editor.getValue();
    clearError();
    let target = sql;
    try {
      const statements = parse(sql);
      const last = statements[statements.length - 1];
      if (last !== undefined && last.kind === "select") {
        target = `${sql.slice(0, last.span.start)}EXPLAIN ${sql.slice(last.span.start)}`;
      }
    } catch {
      // Let execute() report the parse error with its position.
    }
    execute(target);
  }

  elements.runButton.addEventListener("click", () => execute(editor.getValue()));
  elements.explainButton.addEventListener("click", () => explain());
  elements.loadButton.addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", () => {
    const files = [...(elements.fileInput.files ?? [])];
    if (files.length > 0) void loadFiles(files);
    elements.fileInput.value = "";
  });

  for (const example of EXAMPLES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = example.label;
    button.addEventListener("click", () => {
      editor.setValue(example.sql);
      execute(example.sql);
    });
    elements.datasets.append(button);
  }

  installDropzone(elements.app, (files) => void loadFiles(files));

  async function loadFiles(files: File[]): Promise<void> {
    const loaded: string[] = [];
    for (const file of files) {
      try {
        const text = await file.text();
        const name = tableNameFromFile(file.name);
        createTableFromCsv(catalog, name, text);
        loaded.push(name);
      } catch (e) {
        showError(formatError(e));
        refreshSchema();
        return;
      }
    }
    refreshSchema();
    if (loaded.length > 0) {
      const first = loaded[0]!;
      editor.setValue(`SELECT * FROM ${first} LIMIT 50;`);
      execute(editor.getValue());
    }
  }

  // Boot: load the bundled datasets, then show whatever the editor holds.
  let booted = true;
  try {
    await Promise.all(
      DATASETS.map(async (name) => {
        const response = await fetch(`${import.meta.env.BASE_URL}datasets/${name}.csv`);
        if (!response.ok) throw new Error(`could not load ${name}.csv (${response.status})`);
        createTableFromCsv(catalog, name, await response.text());
      }),
    );
  } catch (e) {
    booted = false;
    showError(formatError(e));
  }

  refreshSchema();
  if (booted && storedQuery === null) {
    // First visit: run the sample, so the first screen already has a plan to
    // read. A restored query is left for the user to run: it may be half-edited,
    // and a parse error is a worse greeting than an empty panel.
    execute(editor.getValue());
  } else {
    renderResults(elements.results, lastResult);
    renderPlan(elements.plan, null, null);
    // After a failed load, keep the error that showError put in the status line.
    if (booted) renderStatus(elements.status, null, null);
  }
  editor.focus();
}

function readStoredQuery(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored !== null && stored.trim() !== "" ? stored : null;
  } catch {
    return null;
  }
}

/** The last statement of a script: the one whose plan is on screen. */
function lastStatement(sql: string): string {
  try {
    const statements = parse(sql);
    const last = statements[statements.length - 1];
    return last === undefined ? sql : sql.slice(last.span.start);
  } catch {
    return sql;
  }
}

/**
 * Identifiers are double-quoted so a table created with a quoted, mixed-case
 * name still resolves; for ordinary lowercase names the quotes change nothing.
 */
function createIndexSql(table: string, column: string): string {
  return `CREATE INDEX ${quoteIdent(`${table}_${column}`)} ON ${quoteIdent(table)} (${quoteIdent(column)});`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A deterministic 50k-row table. Forty-row samples cannot show the planner
 * working: both strategies finish in well under a millisecond and only the row
 * counter moves. At this size the index changes the wall clock.
 */
function generateLargeTable(catalog: Catalog): void {
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
