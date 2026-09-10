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

const WELCOME = `-- Three tables are loaded. Run this (Ctrl/Cmd + Enter):
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
    sql: `-- Run this, note "rows touched" in the status bar and the plan on the right.
-- Then press "index" beside employees.dept_id and run it again.
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

  const editor: EditorHandle = createEditor(elements.editorHost, {
    initialDoc: readStoredQuery() ?? WELCOME,
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
      execute(`CREATE INDEX ${table}_${column} ON ${table} (${column});`);
    },
    onGenerateLarge() {
      generateLargeTable(catalog);
      refreshSchema();
      editor.setValue(`-- ${LARGE_ROWS.toLocaleString("en-US")} rows. Run this, then press "index"
-- beside ${LARGE_TABLE}.employee_id and run it again.
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

  function execute(sql: string): void {
    clearError();
    try {
      const result = run(sql, catalog);
      lastResult = result;
      renderResults(elements.results, result);
      renderPlan(elements.plan, result.plan ?? null, result.nodeStats ?? null);
      renderStatus(elements.status, result, null);
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

  // Boot: load the bundled datasets, then render whatever the editor holds.
  try {
    await Promise.all(
      DATASETS.map(async (name) => {
        const response = await fetch(`${import.meta.env.BASE_URL}datasets/${name}.csv`);
        if (!response.ok) throw new Error(`could not load ${name}.csv (${response.status})`);
        createTableFromCsv(catalog, name, await response.text());
      }),
    );
  } catch (e) {
    showError(formatError(e));
  }

  refreshSchema();
  renderResults(elements.results, lastResult);
  renderPlan(elements.plan, null, null);
  renderStatus(elements.status, null, null);
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
