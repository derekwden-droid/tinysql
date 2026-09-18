import { ExecError } from "./errors.js";
import { MAX_BYTES, MAX_ROWS, type Catalog } from "./catalog.js";
import { fitsType, type ColumnDef, type Row, type SqlType, type Value } from "./types.js";

export interface CsvTable {
  columns: ColumnDef[];
  rows: Row[];
}

/**
 * RFC4180-ish field splitter: double quotes wrap a field, `""` is a literal
 * quote, and quoted fields may contain commas and newlines. CRLF and LF both
 * end a record.
 */
function splitRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let dirty = false; // whether the current record has any content

  const endField = (): void => {
    record.push(field);
    field = "";
    dirty = true;
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
    dirty = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"' && field === "") {
      quoted = true;
      continue;
    }
    if (c === ",") {
      endField();
      continue;
    }
    if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      endRecord();
      continue;
    }
    if (c === "\n") {
      endRecord();
      continue;
    }
    field += c;
    dirty = true;
  }

  if (quoted) throw new ExecError("unterminated quoted field in CSV");
  if (field !== "" || record.length > 0 || dirty) endRecord();

  // Drop a trailing blank line.
  return records.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Fold a header cell into a usable identifier. */
export function sanitizeIdentifier(raw: string, position: number): string {
  let name = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  name = name.replace(/^_+|_+$/g, "");
  if (name === "") name = `c${position + 1}`;
  if (/^[0-9]/.test(name)) name = `c${name}`;
  return name;
}

function dedupe(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
}

const INTEGER_RE = /^[+-]?[0-9]+$/;
const REAL_RE = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/**
 * The narrowest type that every non-empty cell converts to exactly: INTEGER,
 * then REAL, then TEXT. Every cell, not a sample: a type read off the first N
 * cells is only a guess about the rest, and a wrong guess used to store `1.5`,
 * or the text `abc`, in an INTEGER column. The test is the catalog's own
 * `fitsType`, so a CSV import can never be refused by the insert that follows.
 */
function inferType(cells: string[]): SqlType {
  let seen = 0;
  let allInteger = true;

  for (const cell of cells) {
    if (cell === "") continue;
    seen++;
    const n = Number(cell);
    if (!REAL_RE.test(cell) || !fitsType(n, "real")) return "text";
    if (allInteger && !(INTEGER_RE.test(cell) && fitsType(n, "integer"))) allInteger = false;
  }

  if (seen === 0) return "text";
  return allInteger ? "integer" : "real";
}

function coerce(cell: string, type: SqlType): Value {
  if (cell === "") return null;
  return type === "integer" || type === "real" ? Number(cell) : cell;
}

/** A header row is usable when no cell looks like a number. */
function looksLikeHeader(record: string[]): boolean {
  return record.some((c) => c.trim() !== "") && !record.every((c) => REAL_RE.test(c.trim()));
}

export interface ParseCsvOptions {
  /** Force header handling instead of sniffing. */
  hasHeader?: boolean;
}

export function parseCsv(text: string, options: ParseCsvOptions = {}): CsvTable {
  if (text.length > MAX_BYTES) {
    throw new ExecError(
      `CSV is larger than the ${Math.round(MAX_BYTES / 1024 / 1024)} MB limit`,
    );
  }
  // A BOM would otherwise become part of the first column name.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records = splitRecords(body);
  if (records.length === 0) throw new ExecError("CSV is empty");

  const hasHeader = options.hasHeader ?? looksLikeHeader(records[0]!);
  const width = records[0]!.length;

  const names = hasHeader
    ? dedupe(records[0]!.map((cell, i) => sanitizeIdentifier(cell, i)))
    : Array.from({ length: width }, (_, i) => `c${i + 1}`);

  const dataRecords = hasHeader ? records.slice(1) : records;
  if (dataRecords.length > MAX_ROWS) {
    throw new ExecError(`CSV has more than ${MAX_ROWS.toLocaleString("en-US")} rows`);
  }

  const types = names.map((_, col) => inferType(dataRecords.map((r) => (r[col] ?? "").trim())));
  const columns: ColumnDef[] = names.map((name, i) => ({ name, type: types[i]! }));

  const rows: Row[] = dataRecords.map((record) =>
    names.map((_, col) => coerce((record[col] ?? "").trim(), types[col]!)),
  );

  return { columns, rows };
}

/**
 * Load CSV text as a table. One code path for the browser, the CLI and the
 * tests, so all three agree about types and column names.
 */
export function createTableFromCsv(
  catalog: Catalog,
  name: string,
  text: string,
  options?: ParseCsvOptions,
): CsvTable {
  const parsed = parseCsv(text, options);
  if (catalog.hasTable(name)) catalog.dropTable(name);
  catalog.createTable({ name, columns: parsed.columns });
  catalog.insert(name, parsed.rows);
  return parsed;
}

/** `Employees 2026.csv` -> `employees_2026`. */
export function tableNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, "").replace(/^.*[\\/]/, "");
  return sanitizeIdentifier(base, 0);
}
