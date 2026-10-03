// Generated from src/engine/format.ts by scripts/build-plugin.ts. Do not edit:
// change the TypeScript source and run `npm run build:plugin`.
/** Display form of a value. NULL is spelled, not blank, so it is visible. */
export function formatValue(v) {
    if (v === null)
        return "NULL";
    if (typeof v === "boolean")
        return v ? "TRUE" : "FALSE";
    return String(v);
}
/** Fixed-width table for stdout. Numbers right-align, everything else left. */
export function formatTable(columns, rows) {
    if (columns.length === 0)
        return "";
    const cells = rows.map((row) => columns.map((_, i) => formatValue(row[i] ?? null)));
    const widths = columns.map((name, i) => Math.max(name.length, ...cells.map((r) => r[i].length), 0));
    const numeric = columns.map((_, i) => rows.length > 0 && rows.every((r) => typeof r[i] === "number"));
    const pad = (text, width, right) => right ? text.padStart(width) : text.padEnd(width);
    const lines = [];
    lines.push(columns.map((name, i) => pad(name, widths[i], numeric[i])).join("  "));
    lines.push(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of cells) {
        lines.push(row.map((cell, i) => pad(cell, widths[i], numeric[i])).join("  "));
    }
    return lines.join("\n");
}
/** `1.234 ms`, with enough precision to be useful on small inputs. */
export function formatMs(ms) {
    if (ms >= 100)
        return `${ms.toFixed(0)} ms`;
    if (ms >= 1)
        return `${ms.toFixed(1)} ms`;
    return `${ms.toFixed(2)} ms`;
}
export function pluralRows(n) {
    return `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;
}
/**
 * The statement the UI's "Create index and rerun" button and the Claude Code
 * plugin both offer. Identifiers are double-quoted so a table created with a
 * quoted, mixed-case name still resolves; for ordinary lowercase names the
 * quotes change nothing.
 */
export function createIndexSql(table, column) {
    return `CREATE INDEX ${quoteIdent(`${table}_${column}`)} ON ${quoteIdent(table)} (${quoteIdent(column)});`;
}
export function quoteIdent(name) {
    return `"${name.replace(/"/g, '""')}"`;
}
