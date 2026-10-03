// Generated from src/engine/types.ts by scripts/build-plugin.ts. Do not edit:
// change the TypeScript source and run `npm run build:plugin`.
/**
 * Type rank for cross-type ordering. Values of different types are never equal;
 * when ordered, they sort by this rank. Mirrors SQLite's storage-class ordering.
 */
export function typeRank(v) {
    if (v === null)
        return 0;
    switch (typeof v) {
        case "boolean":
            return 1;
        case "number":
            return 2;
        default:
            return 3;
    }
}
/**
 * Whether a value may be stored in a column of the declared type. NULL fits
 * every column. INTEGER and REAL share one numeric domain, so integrality is
 * the only thing between them: `2.0` fits INTEGER because it is `2`; `1.5`
 * does not. The catalog checks this on every write.
 */
export function fitsType(v, type) {
    if (v === null)
        return true;
    switch (type) {
        case "integer":
            return typeof v === "number" && Number.isInteger(v);
        case "real":
            return typeof v === "number" && Number.isFinite(v);
        case "text":
            return typeof v === "string";
        case "boolean":
            return typeof v === "boolean";
        case "null":
            return false;
    }
}
/** The declared type that best describes a runtime value. */
export function runtimeType(v) {
    if (v === null)
        return "null";
    switch (typeof v) {
        case "boolean":
            return "boolean";
        case "number":
            return Number.isInteger(v) ? "integer" : "real";
        default:
            return "text";
    }
}
