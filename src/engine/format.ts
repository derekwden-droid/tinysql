import type { Row, Value } from "./types.js";

/** Display form of a value. NULL is spelled, not blank, so it is visible. */
export function formatValue(v: Value): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

/** Fixed-width table for stdout. Numbers right-align, everything else left. */
export function formatTable(columns: string[], rows: Row[]): string {
  if (columns.length === 0) return "";

  const cells = rows.map((row) => columns.map((_, i) => formatValue(row[i] ?? null)));
  const widths = columns.map((name, i) =>
    Math.max(name.length, ...cells.map((r) => r[i]!.length), 0),
  );
  const numeric = columns.map((_, i) => rows.length > 0 && rows.every((r) => typeof r[i] === "number"));

  const pad = (text: string, width: number, right: boolean): string =>
    right ? text.padStart(width) : text.padEnd(width);

  const lines: string[] = [];
  lines.push(columns.map((name, i) => pad(name, widths[i]!, numeric[i]!)).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of cells) {
    lines.push(row.map((cell, i) => pad(cell, widths[i]!, numeric[i]!)).join("  "));
  }
  return lines.join("\n");
}

/** `1.234 ms`, with enough precision to be useful on small inputs. */
export function formatMs(ms: number): string {
  if (ms >= 100) return `${ms.toFixed(0)} ms`;
  if (ms >= 1) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(2)} ms`;
}

export function pluralRows(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;
}
