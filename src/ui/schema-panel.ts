import type { Catalog } from "../engine/catalog.js";

export interface SchemaHandlers {
  /** Clicking a table name loads a starter query for it. */
  onSelectTable(table: string): void;
  /** "index" next to a column creates a hash index on it. */
  onCreateIndex(table: string, column: string): void;
  onGenerateLarge(): void;
}

export function renderSchema(host: HTMLElement, catalog: Catalog, handlers: SchemaHandlers): void {
  host.replaceChildren();

  const tables = catalog.tableNames();
  if (tables.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "No tables loaded. Drop a CSV anywhere on the page.";
    host.append(p);
    return;
  }

  for (const table of tables) {
    host.append(renderTable(catalog, table, handlers));
  }

  const indexes = catalog.indexNames();
  const title = document.createElement("p");
  title.className = "panel-section-title";
  title.textContent = `Indexes (${indexes.length})`;
  host.append(title);

  if (indexes.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "None yet — press “index” beside a column.";
    host.append(p);
  } else {
    const list = document.createElement("ul");
    list.className = "schema-columns";
    for (const name of indexes) {
      const index = catalog.getIndex(name);
      const li = document.createElement("li");
      li.className = "schema-index";
      li.append(document.createTextNode(name));
      if (index !== undefined) {
        const target = document.createElement("span");
        target.className = "target";
        target.textContent = `${index.table}.${index.column} · ${index.distinctKeys.toLocaleString("en-US")} keys`;
        li.append(target);
      }
      list.append(li);
    }
    host.append(list);
  }
}

function renderTable(catalog: Catalog, table: string, handlers: SchemaHandlers): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "schema-table";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "schema-table-btn";
  const name = document.createElement("span");
  name.textContent = table;
  const count = document.createElement("span");
  count.className = "schema-count";
  count.textContent = `${catalog.rowCount(table).toLocaleString("en-US")} rows`;
  button.append(name, count);
  button.title = `Query ${table}`;
  button.addEventListener("click", () => handlers.onSelectTable(table));
  wrapper.append(button);

  const list = document.createElement("ul");
  list.className = "schema-columns";

  for (const column of catalog.columns(table)) {
    const li = document.createElement("li");
    li.className = "schema-column";

    const colName = document.createElement("span");
    colName.className = "schema-column-name";
    colName.textContent = column.name;

    const colType = document.createElement("span");
    colType.className = "schema-column-type";
    colType.textContent = column.type;

    const actions = document.createElement("span");
    actions.className = "schema-column-actions";

    const existing = catalog.findIndex(table, column.name);
    if (existing !== undefined) {
      const badge = document.createElement("span");
      badge.className = "badge badge-index";
      badge.textContent = "index";
      badge.title = `${existing.name} — ${existing.distinctKeys.toLocaleString("en-US")} distinct keys`;
      actions.append(badge);
    } else {
      const create = document.createElement("button");
      create.type = "button";
      create.className = "mini-btn";
      create.textContent = "index";
      create.title = `CREATE INDEX ON ${table} (${column.name})`;
      create.addEventListener("click", () => handlers.onCreateIndex(table, column.name));
      actions.append(create);
    }

    li.append(colName, colType, actions);
    list.append(li);
  }

  wrapper.append(list);
  return wrapper;
}

/** The footer button that makes the planner's choice visible in wall-clock time. */
export function renderSchemaFooter(host: HTMLElement, handlers: SchemaHandlers, exists: boolean): void {
  host.replaceChildren();
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = exists ? "Regenerate 50k orders" : "Generate 50k orders";
  button.addEventListener("click", () => handlers.onGenerateLarge());
  host.append(button);

  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent =
    "40 rows are too few to time. Build a 50,000-row table, then compare a scan with an index.";
  host.append(hint);
}
