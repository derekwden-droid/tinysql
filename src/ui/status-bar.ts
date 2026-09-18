import { formatMs, pluralRows } from "../engine/format.js";
import type { QueryResult } from "../engine/executor.js";

/**
 * `24 rows · 3.2 ms · 80 rows touched · index used: emp_dept`
 *
 * `baseline` is the rows-touched count of the same statement before an index
 * was added, shown as `(was N)` so the comparison needs no memory. Rows, not
 * milliseconds: sub-millisecond timings on small tables are noise.
 */
export function renderStatus(
  host: HTMLElement,
  result: QueryResult | null,
  error: string | null,
  baseline?: number,
): void {
  host.replaceChildren();

  if (error !== null) {
    host.append(part(error, "err"));
    return;
  }
  if (result === null) {
    host.append(part("Ready."));
    return;
  }
  if (result.explained === true) {
    host.append(part("plan only"), sep(), part(result.notice ?? "estimates shown"));
    return;
  }
  if (result.columns.length === 0) {
    host.append(part(result.notice ?? "done", "ok"));
    return;
  }

  const pieces: HTMLElement[] = [
    part(pluralRows(result.rows.length)),
    sep(),
    part(formatMs(result.stats.elapsedMs)),
    sep(),
    part(
      `${result.stats.rowsTouched.toLocaleString("en-US")} rows touched` +
        (baseline === undefined ? "" : ` (was ${baseline.toLocaleString("en-US")})`),
    ),
    sep(),
  ];

  pieces.push(
    result.stats.indexesUsed.length > 0
      ? part(`index used: ${result.stats.indexesUsed.join(", ")}`, "ok")
      : part("no index used", "warn"),
  );

  host.append(...pieces);
}

function part(text: string, className?: string): HTMLElement {
  const span = document.createElement("span");
  if (className !== undefined) span.className = className;
  span.textContent = text;
  return span;
}

function sep(): HTMLElement {
  return part("·", "sep");
}
