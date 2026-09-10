import { formatValue } from "../engine/format.js";
import { compareValues } from "../engine/executor.js";
import type { QueryResult } from "../engine/executor.js";
import type { Row } from "../engine/types.js";

interface SortState {
  column: number;
  direction: "asc" | "desc";
}

/**
 * The results grid. Header clicks sort the rows already on screen; they do not
 * re-run the query, so the plan and statistics stay honest.
 */
export function renderResults(host: HTMLElement, result: QueryResult | null): void {
  host.replaceChildren();
  if (result === null) {
    host.append(placeholder("Run a query to see results."));
    return;
  }

  if (result.columns.length === 0) {
    host.append(placeholder(result.notice ?? "Statement executed."));
    return;
  }

  if (result.rows.length === 0) {
    host.append(placeholder("0 rows", "The query ran and matched nothing."));
    return;
  }

  let sort: SortState | null = null;
  const table = document.createElement("table");
  table.className = "grid";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const isPlanOp = result.explained === true;

  const draw = (): void => {
    const rows = sortedRows(result.rows, sort);
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      result.columns.forEach((_, i) => {
        const value = row[i] ?? null;
        const td = document.createElement("td");
        td.textContent = formatValue(value);
        if (value === null) td.className = "null";
        else if (typeof value === "number") td.className = "num";
        // The EXPLAIN `op` column carries indentation that must survive.
        if (isPlanOp && i === 1) td.classList.add("plan-op");
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.querySelector("tbody")?.remove();
    table.append(tbody);

    headRow.querySelectorAll("th").forEach((th, i) => {
      const arrow = th.querySelector(".sort-arrow");
      const active = sort !== null && sort.column === i;
      if (arrow !== null) arrow.textContent = active ? (sort!.direction === "asc" ? "▲" : "▼") : "";
      th.setAttribute("aria-sort", active ? (sort!.direction === "asc" ? "ascending" : "descending") : "none");
    });
  };

  result.columns.forEach((name, i) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.tabIndex = 0;
    th.append(document.createTextNode(name));
    const arrow = document.createElement("span");
    arrow.className = "sort-arrow";
    th.append(arrow);
    th.title = `Sort by ${name}`;
    const toggle = (): void => {
      sort =
        sort !== null && sort.column === i && sort.direction === "asc"
          ? { column: i, direction: "desc" }
          : { column: i, direction: "asc" };
      draw();
    };
    th.addEventListener("click", toggle);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    headRow.append(th);
  });

  thead.append(headRow);
  table.append(thead);
  draw();
  host.append(table);
}

function sortedRows(rows: Row[], sort: SortState | null): Row[] {
  if (sort === null) return rows;
  const copy = [...rows];
  copy.sort((a, b) => {
    const c = compareValues(a[sort.column] ?? null, b[sort.column] ?? null);
    return sort.direction === "asc" ? c : -c;
  });
  return copy;
}

function placeholder(title: string, detail?: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "results-empty";
  const strong = document.createElement("strong");
  strong.textContent = title;
  div.append(strong);
  if (detail !== undefined) div.append(document.createTextNode(` ${detail}`));
  return div;
}
