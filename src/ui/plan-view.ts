import { children, describe, suggestIndex, type IndexSuggestion, type PlanNode } from "../engine/planner.js";
import type { NodeStats } from "../engine/executor.js";

/**
 * Vertical plan tree. After EXPLAIN it shows estimates only; after a run it adds
 * the actual row counts beside them, and marks whichever node read the most
 * base-relation rows. When an index would turn a scan into a lookup, the panel
 * offers it above the tree as one click.
 */
export function renderPlan(
  host: HTMLElement,
  plan: PlanNode | null,
  nodeStats: Map<number, NodeStats> | null,
  onIndexAndRerun?: (table: string, column: string) => void,
): void {
  host.replaceChildren();

  if (plan === null) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "Run or explain a SELECT to see its plan.";
    host.append(p);
    return;
  }

  if (onIndexAndRerun !== undefined) {
    const suggestion = suggestIndex(plan);
    if (suggestion !== null) host.append(renderSuggestion(suggestion, onIndexAndRerun));
  }

  const hottest = findHottest(plan, nodeStats);
  host.append(renderNode(plan, nodeStats, hottest));

  const legend = document.createElement("p");
  legend.className = "plan-legend";
  legend.textContent =
    nodeStats === null
      ? "est. rows are estimates from table statistics, not measurements."
      : "est. rows are estimates; actual is what the run produced.";
  host.append(legend);
}

function renderNode(
  node: PlanNode,
  nodeStats: Map<number, NodeStats> | null,
  hottest: number | null,
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "plan-branch";

  const card = document.createElement("div");
  card.className = "plan-node";
  const stats = nodeStats?.get(node.id);
  const isHot = hottest !== null && node.id === hottest;
  if (isHot) card.classList.add("hot");

  const opLine = document.createElement("div");
  opLine.className = "plan-op";
  const opName = document.createElement("span");
  opName.className = "op-name";
  opName.textContent = node.op;
  opLine.append(opName);

  // The word "index", not colour alone, marks an index scan.
  if (node.op === "IndexLookup") {
    opLine.append(badge("index", "badge-index"));
  }
  if (isHot) {
    opLine.append(badge("most rows read", "badge-hot"));
  }
  card.append(opLine);

  const detail = describe(node);
  if (detail !== "") {
    const detailLine = document.createElement("div");
    detailLine.className = "plan-detail";
    detailLine.textContent = detail;
    card.append(detailLine);
  }

  const rows = document.createElement("div");
  rows.className = "plan-rows";
  rows.append(span(`est. ${node.estRows.toLocaleString("en-US")}`));
  if (stats !== undefined) {
    rows.append(span(`actual ${stats.actualRows.toLocaleString("en-US")}`, "actual"));
    if (stats.rowsTouched > 0) {
      rows.append(span(`read ${stats.rowsTouched.toLocaleString("en-US")}`));
    }
  }
  card.append(rows);
  wrapper.append(card);

  const kids = children(node);
  if (kids.length > 0) {
    const container = document.createElement("div");
    // A single input stacks straight below its parent; only a join's two inputs
    // fork and indent, so the tree never gets more than one level narrower.
    container.className = kids.length > 1 ? "plan-children fork" : "plan-children";
    for (const child of kids) container.append(renderNode(child, nodeStats, hottest));
    wrapper.append(container);
  }
  return wrapper;
}

function renderSuggestion(
  suggestion: IndexSuggestion,
  onAccept: (table: string, column: string) => void,
): HTMLElement {
  const { table, column } = suggestion;
  const box = document.createElement("div");
  box.className = "plan-suggest";

  const text = document.createElement("p");
  text.append(
    code(`${table}.${column}`),
    document.createTextNode(" has no index, so this plan reads every row of "),
    code(table),
    document.createTextNode("."),
  );

  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary";
  button.textContent = "Create index and rerun";
  button.title = `Add a hash index on ${table}(${column}), then run the same statement again`;
  button.addEventListener("click", () => onAccept(table, column));

  box.append(text, button);
  return box;
}

function code(text: string): HTMLElement {
  const el = document.createElement("code");
  el.textContent = text;
  return el;
}

function badge(text: string, className: string): HTMLElement {
  const el = document.createElement("span");
  el.className = `badge ${className}`;
  el.textContent = text;
  return el;
}

function span(text: string, className?: string): HTMLElement {
  const el = document.createElement("span");
  if (className !== undefined) el.className = className;
  el.textContent = text;
  return el;
}

/** The node that read the most base-relation rows, if any did. */
function findHottest(plan: PlanNode, nodeStats: Map<number, NodeStats> | null): number | null {
  if (nodeStats === null) return null;
  let best: number | null = null;
  let bestRows = 0;
  const walk = (node: PlanNode): void => {
    const rows = nodeStats.get(node.id)?.rowsTouched ?? 0;
    if (rows > bestRows) {
      bestRows = rows;
      best = node.id;
    }
    for (const child of children(node)) walk(child);
  };
  walk(plan);
  return bestRows > 0 ? best : null;
}
