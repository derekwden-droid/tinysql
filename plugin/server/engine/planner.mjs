// Generated from src/engine/planner.ts by scripts/build-plugin.ts. Do not edit:
// change the TypeScript source and run `npm run build:plugin`.
import { PlanningError } from "./errors.mjs";
export function exprToString(e) {
    switch (e.kind) {
        case "literal":
            return e.value === null ? "NULL" : typeof e.value === "string" ? `'${e.value}'` : String(e.value);
        case "ordinal":
            return e.label;
        case "binary":
            return `${exprToString(e.left)} ${e.op.toUpperCase()} ${exprToString(e.right)}`;
        case "not":
            return `NOT ${exprToString(e.expr)}`;
        case "isNull":
            return `${exprToString(e.expr)} IS ${e.negated ? "NOT " : ""}NULL`;
        case "like":
            return `${exprToString(e.expr)} LIKE ${exprToString(e.pattern)}`;
    }
}
export function children(node) {
    switch (node.op) {
        case "SeqScan":
        case "IndexLookup":
            return [];
        case "NestedLoopJoin":
            return [node.left, node.right];
        case "Project":
            return node.child ? [node.child] : [];
        default:
            return [node.child];
    }
}
/** One-line description of a node, shared by EXPLAIN, the plan view and tests. */
export function describe(node) {
    switch (node.op) {
        case "SeqScan":
            return aliasLabel(node.table, node.alias);
        case "IndexLookup": {
            const probed = node.probe.kind === "literal" ? literal(node.probe.value) : node.probe.label;
            return `${aliasLabel(node.table, node.alias)} using ${node.index} on ${node.column} = ${probed}`;
        }
        case "Filter":
            return exprToString(node.predicate);
        case "NestedLoopJoin":
            return `${node.leftLabel} = ${node.rightLabel}`;
        case "Project":
            return node.items.map((i) => outputName(i.ref)).join(", ");
        case "Sort":
            return node.keys.map((k) => `${k.label} ${k.direction.toUpperCase()}`).join(", ");
        case "Limit":
            return node.offset > 0 ? `count=${node.count} offset=${node.offset}` : `count=${node.count}`;
        case "Distinct":
            return "";
    }
}
function aliasLabel(table, alias) {
    return alias === table ? table : `${table} AS ${alias}`;
}
function literal(v) {
    if (v === null)
        return "NULL";
    return typeof v === "string" ? `'${v}'` : String(v);
}
function outputName(ref) {
    return ref.table === null ? ref.name : `${ref.table}.${ref.name}`;
}
/**
 * Indented tree rendering. `planner.test.ts` asserts on this string: a planner
 * that skips index selection cannot produce the expected text.
 */
export function serializePlan(node, depth = 0) {
    const pad = "  ".repeat(depth);
    const detail = describe(node);
    const head = detail === "" ? node.op : `${node.op}(${detail})`;
    const lines = [`${pad}${head}`];
    for (const child of children(node))
        lines.push(serializePlan(child, depth + 1));
    return lines.join("\n");
}
export function explainRows(root) {
    const rows = [];
    const walk = (node, depth) => {
        rows.push({ id: node.id, op: node.op, detail: describe(node), estRows: node.estRows, depth });
        for (const child of children(node))
            walk(child, depth + 1);
    };
    walk(root, 0);
    return rows;
}
/**
 * The index rules read backwards: the index that would turn a scan in this plan
 * into an IndexLookup, or null when no index would change anything. WHERE comes
 * first, then the join, which is also the order the demo teaches them in.
 */
export function suggestIndex(plan) {
    return suggestForFilter(plan) ?? suggestForJoin(plan);
}
/**
 * The planner leaves a pushed `col = literal` in a Filter directly above a
 * SeqScan only because no index matched, so indexing that column is exactly
 * what flips the scan. First match in plan order, as the planner matches.
 */
function suggestForFilter(node) {
    if (node.op === "Filter" && node.child.op === "SeqScan") {
        const scan = node.child;
        for (const conjunct of flattenAnd(node.predicate)) {
            const ordinal = equalityProbeOrdinal(conjunct);
            const column = ordinal === null ? undefined : scan.schema[ordinal];
            if (column !== undefined)
                return { table: scan.table, column: column.name, reason: "filter" };
        }
    }
    for (const child of children(node)) {
        const found = suggestForFilter(child);
        if (found !== null)
            return found;
    }
    return null;
}
/**
 * A join whose inner side still scans its whole table (rule 5 found no index
 * on the inner join column) would probe instead once that column is indexed.
 */
function suggestForJoin(node) {
    if (node.op === "NestedLoopJoin") {
        const scan = innerScan(node.right);
        const column = scan?.schema[node.rightCol];
        if (scan !== null && column !== undefined) {
            return { table: scan.table, column: column.name, reason: "join" };
        }
    }
    for (const child of children(node)) {
        const found = suggestForJoin(child);
        if (found !== null)
            return found;
    }
    return null;
}
function flattenAnd(expr) {
    return expr.kind === "binary" && expr.op === "and"
        ? [...flattenAnd(expr.left), ...flattenAnd(expr.right)]
        : [expr];
}
/** The column side of `col = literal`, in either order; mirrors `asEqualityProbe`. */
function equalityProbeOrdinal(expr) {
    if (expr.kind !== "binary" || expr.op !== "=")
        return null;
    const { left, right } = expr;
    if (left.kind === "ordinal" && right.kind === "literal" && right.value !== null)
        return left.index;
    if (right.kind === "ordinal" && left.kind === "literal" && left.value !== null)
        return right.index;
    return null;
}
class Scope {
    relations;
    constructor(relations) {
        this.relations = relations;
    }
    resolve(qualifier, name) {
        if (qualifier !== null) {
            const relIndex = this.relations.findIndex((r) => r.qualifier === qualifier);
            if (relIndex === -1) {
                const known = this.relations.map((r) => r.qualifier).join(", ");
                throw new PlanningError(`unknown table qualifier '${qualifier}'`, known === "" ? undefined : `available: ${known}`);
            }
            const rel = this.relations[relIndex];
            const ordinal = rel.columns.findIndex((c) => c.name === name);
            if (ordinal === -1) {
                throw new PlanningError(`no such column: ${qualifier}.${name}`);
            }
            return {
                index: rel.offset + ordinal,
                ref: { table: rel.qualifier, name, type: rel.columns[ordinal].type },
                relation: relIndex,
            };
        }
        const hits = [];
        this.relations.forEach((rel, relIndex) => {
            const ordinal = rel.columns.findIndex((c) => c.name === name);
            if (ordinal !== -1) {
                hits.push({
                    index: rel.offset + ordinal,
                    ref: { table: rel.qualifier, name, type: rel.columns[ordinal].type },
                    relation: relIndex,
                });
            }
        });
        if (hits.length === 0)
            throw new PlanningError(`no such column: ${name}`);
        if (hits.length > 1) {
            const where = this.relations.map((r) => r.qualifier).join(" and ");
            throw new PlanningError(`ambiguous column '${name}'`, `it exists in ${where}; qualify it`);
        }
        return hits[0];
    }
    all() {
        return this.relations;
    }
}
/** Resolve an AST expression against a scope, recording which relations it touches. */
function resolveExpr(expr, scope, touched) {
    switch (expr.kind) {
        case "literal":
            return { kind: "literal", value: expr.value };
        case "column": {
            const r = scope.resolve(expr.table, expr.name);
            touched.add(r.relation);
            return { kind: "ordinal", index: r.index, label: outputName(r.ref) };
        }
        case "binary":
            return {
                kind: "binary",
                op: expr.op,
                left: resolveExpr(expr.left, scope, touched),
                right: resolveExpr(expr.right, scope, touched),
            };
        case "not":
            return { kind: "not", expr: resolveExpr(expr.expr, scope, touched) };
        case "isNull":
            return { kind: "isNull", expr: resolveExpr(expr.expr, scope, touched), negated: expr.negated };
        case "like":
            return {
                kind: "like",
                expr: resolveExpr(expr.expr, scope, touched),
                pattern: resolveExpr(expr.pattern, scope, touched),
            };
    }
}
/** Flatten an AND chain into conjuncts, so each can be pushed independently. */
function splitConjuncts(expr) {
    if (expr.kind === "binary" && expr.op === "and") {
        return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
    }
    return [expr];
}
function conjoin(preds) {
    return preds.reduce((acc, p) => ({ kind: "binary", op: "and", left: acc, right: p }));
}
// -------------------------------------------------------------------- planner
const FILTER_SELECTIVITY = 0.3;
/** A `col = literal` conjunct that the index rule can consume. */
function asEqualityProbe(conjunct, scope, relIndex) {
    const { expr } = conjunct;
    if (expr.kind !== "binary" || expr.op !== "=")
        return null;
    const sides = [
        [expr.left, expr.right],
        [expr.right, expr.left],
    ];
    for (const [maybeColumn, maybeLiteral] of sides) {
        if (maybeColumn.kind !== "column" || maybeLiteral.kind !== "literal")
            continue;
        // Resolve through the alias: the index rule matches the resolved
        // (table, column) pair, never the identifier as written.
        const r = scope.resolve(maybeColumn.table, maybeColumn.name);
        if (r.relation !== relIndex)
            continue;
        if (maybeLiteral.value === null)
            continue; // `= NULL` is unknown, never an index hit
        return { column: r.ref.name, value: maybeLiteral.value };
    }
    return null;
}
export function planSelect(stmt, catalog) {
    const root = stmt.from === null ? planConstant(stmt) : planFrom(stmt, catalog);
    assignIds(root);
    return root;
}
function planConstant(stmt) {
    const scope = new Scope([]);
    const items = [];
    for (const item of stmt.items) {
        if (item.kind !== "expr") {
            throw new PlanningError("SELECT * requires a FROM clause");
        }
        const touched = new Set();
        const expr = resolveExpr(item.expr, scope, touched);
        items.push({ expr, ref: { table: null, name: itemName(item, expr), type: literalType(expr) } });
    }
    if (stmt.orderBy.length > 0 || stmt.limit !== null) {
        throw new PlanningError("ORDER BY and LIMIT require a FROM clause");
    }
    return { id: 0, op: "Project", items, estRows: 1, schema: items.map((i) => i.ref) };
}
function planFrom(stmt, catalog) {
    const from = stmt.from;
    const relations = [];
    const addRelation = (name, alias) => {
        const columns = catalog.columns(name);
        const qualifier = alias ?? name;
        if (relations.some((r) => r.qualifier === qualifier)) {
            throw new PlanningError(`duplicate table name or alias '${qualifier}'`);
        }
        const offset = relations.reduce((n, r) => n + r.columns.length, 0);
        relations.push({ table: name, qualifier, columns, offset });
    };
    addRelation(from.name, from.alias);
    if (stmt.join !== null)
        addRelation(stmt.join.table.name, stmt.join.table.alias);
    const scope = new Scope(relations);
    // 1. Split WHERE into conjuncts and attribute each to the relations it touches.
    const conjuncts = [];
    if (stmt.where !== null) {
        for (const expr of splitConjuncts(stmt.where)) {
            const touched = new Set();
            const resolved = resolveExpr(expr, scope, touched);
            conjuncts.push({ expr, resolved, touched });
        }
    }
    // 2. Push single-relation conjuncts down; anything spanning both stays above
    //    the join. Without this the index can never fire in a join query.
    const pushed = relations.map(() => []);
    const residual = [];
    for (const c of conjuncts) {
        if (c.touched.size === 1)
            pushed[[...c.touched][0]].push(c);
        else
            residual.push(c);
    }
    // 3. Build each side: IndexLookup when a pushed `col = literal` has an index.
    const sides = relations.map((rel, relIndex) => planRelation(rel, relIndex, pushed[relIndex], scope, catalog));
    let node = sides[0];
    if (stmt.join !== null) {
        node = planJoin(stmt, scope, relations, sides, catalog);
    }
    if (residual.length > 0) {
        const predicate = conjoin(residual.map((c) => c.resolved));
        node = {
            id: 0,
            op: "Filter",
            predicate,
            child: node,
            estRows: Math.ceil(node.estRows * FILTER_SELECTIVITY),
            schema: node.schema,
        };
    }
    const project = buildProject(stmt, scope, node);
    // 4. Plan shape. Without DISTINCT the sort runs before projection, so ORDER BY
    //    may name any column from FROM/JOIN. With DISTINCT it must run after, so
    //    ORDER BY is restricted to the select list — which is what SQL requires.
    if (stmt.distinct) {
        let top = {
            id: 0,
            op: "Distinct",
            child: project,
            estRows: project.estRows,
            schema: project.schema,
        };
        top = applySortOnOutput(stmt, top);
        return applyLimit(stmt, top);
    }
    const sorted = applySortOnInput(stmt, scope, node, project);
    return applyLimit(stmt, sorted);
}
function planRelation(rel, relIndex, pushedConjuncts, scope, catalog) {
    const schema = rel.columns.map((c) => ({
        table: rel.qualifier,
        name: c.name,
        type: c.type,
    }));
    const rowCount = catalog.rowCount(rel.table);
    let scan = null;
    const remaining = [];
    for (const conjunct of pushedConjuncts) {
        if (scan === null) {
            const match = asEqualityProbe(conjunct, scope, relIndex);
            if (match !== null) {
                const index = catalog.findIndex(rel.table, match.column);
                if (index !== undefined) {
                    scan = {
                        id: 0,
                        op: "IndexLookup",
                        table: rel.table,
                        alias: rel.qualifier,
                        index: index.name,
                        column: match.column,
                        probe: { kind: "literal", value: match.value },
                        estRows: rowsPerKey(rowCount, index.distinctKeys),
                        schema,
                    };
                    continue; // conjunct consumed by the lookup
                }
            }
        }
        remaining.push(conjunct);
    }
    let node = scan ?? {
        id: 0,
        op: "SeqScan",
        table: rel.table,
        alias: rel.qualifier,
        estRows: rowCount,
        schema,
    };
    if (remaining.length > 0) {
        // Ordinals were resolved against the joined layout; on a single side the row
        // is only this relation, so shift them back by the relation's offset.
        const predicate = conjoin(remaining.map((c) => rebase(c.resolved, -rel.offset)));
        node = {
            id: 0,
            op: "Filter",
            predicate,
            child: node,
            estRows: Math.ceil(node.estRows * FILTER_SELECTIVITY),
            schema,
        };
    }
    return node;
}
/** Shift every ordinal in an expression, used when moving a predicate below a join. */
function rebase(expr, delta) {
    if (delta === 0)
        return expr;
    switch (expr.kind) {
        case "literal":
            return expr;
        case "ordinal":
            return { kind: "ordinal", index: expr.index + delta, label: expr.label };
        case "binary":
            return { kind: "binary", op: expr.op, left: rebase(expr.left, delta), right: rebase(expr.right, delta) };
        case "not":
            return { kind: "not", expr: rebase(expr.expr, delta) };
        case "isNull":
            return { kind: "isNull", expr: rebase(expr.expr, delta), negated: expr.negated };
        case "like":
            return { kind: "like", expr: rebase(expr.expr, delta), pattern: rebase(expr.pattern, delta) };
    }
}
function planJoin(stmt, scope, relations, sides, catalog) {
    const join = stmt.join;
    const a = resolveJoinSide(join.left, scope);
    const b = resolveJoinSide(join.right, scope);
    if (a.relation === b.relation) {
        throw new PlanningError("the JOIN condition must compare a column from each table");
    }
    // Normalise so the first FROM relation is the left side of the node.
    const [leftSide, rightSide] = a.relation === 0 ? [a, b] : [b, a];
    const leftRel = relations[0];
    const rightRel = relations[1];
    const left = sides[0];
    const scanned = sides[1];
    const leftCol = leftSide.index - leftRel.offset;
    const distinct = Math.max(catalog.distinctCount(rightRel.table, rightSide.ref.name), 1);
    // 5. Index nested loop: rather than reread the whole inner table for every
    //    outer row, probe an index on its join column with that row's key.
    const outer = { ordinal: leftCol, label: outputName(leftSide.ref), rows: left.estRows };
    const right = probeInnerSide(scanned, rightRel, rightSide.ref.name, outer, catalog) ?? scanned;
    return {
        id: 0,
        op: "NestedLoopJoin",
        left,
        right,
        leftCol,
        rightCol: rightSide.index - rightRel.offset,
        leftLabel: outputName(leftSide.ref),
        rightLabel: outputName(rightSide.ref),
        // An equijoin is not a cross product: dividing by the right key's distinct
        // count keeps the estimate near the truth instead of ~20x high. Probing or
        // scanning, the join yields the same rows, so the estimate uses the scan.
        estRows: Math.ceil((left.estRows * scanned.estRows) / distinct),
        schema: [...left.schema, ...right.schema],
    };
}
/**
 * Rule 5, the join probe. When the inner side would scan its whole table (a
 * SeqScan, perhaps under its pushed Filter) and its join column has an index,
 * swap the scan for an IndexLookup keyed by each outer row's join value. A
 * literal lookup on the inner side wins: it runs once, not once per outer row.
 * Only the JOIN table is probed; the planner never reorders a join.
 */
function probeInnerSide(inner, rel, column, outer, catalog) {
    const scan = innerScan(inner);
    if (scan === null)
        return null;
    const index = catalog.findIndex(rel.table, column);
    if (index === undefined)
        return null;
    const lookup = {
        id: 0,
        op: "IndexLookup",
        table: rel.table,
        alias: rel.qualifier,
        index: index.name,
        column,
        probe: { kind: "outer", ordinal: outer.ordinal, label: outer.label },
        // Summed over every probe, so it compares directly with the actual count.
        estRows: outer.rows * rowsPerKey(catalog.rowCount(rel.table), index.distinctKeys),
        schema: scan.schema,
    };
    if (inner.op !== "Filter")
        return lookup;
    return { ...inner, child: lookup, estRows: Math.ceil(lookup.estRows * FILTER_SELECTIVITY) };
}
/**
 * The full-table scan a join's inner side would do: a SeqScan, bare or under
 * its pushed Filter. Rule 5 replaces exactly this, and `suggestIndex` offers a
 * join index exactly when it is present, so the two cannot drift apart and the
 * button cannot promise a plan change the planner would not make.
 */
function innerScan(side) {
    const scan = side.op === "Filter" ? side.child : side;
    return scan.op === "SeqScan" ? scan : null;
}
/** Rows one index key is expected to match: `max(1, ceil(rows / distinct keys))`. */
function rowsPerKey(rowCount, distinctKeys) {
    return Math.max(1, Math.ceil(rowCount / Math.max(distinctKeys, 1)));
}
function resolveJoinSide(expr, scope) {
    return scope.resolve(expr.table, expr.name);
}
function buildProject(stmt, scope, child) {
    const items = [];
    for (const item of stmt.items) {
        if (item.kind === "star") {
            for (const rel of scope.all()) {
                rel.columns.forEach((c, i) => {
                    items.push({
                        expr: { kind: "ordinal", index: rel.offset + i, label: `${rel.qualifier}.${c.name}` },
                        ref: { table: rel.qualifier, name: c.name, type: c.type },
                    });
                });
            }
            continue;
        }
        if (item.kind === "tableStar") {
            const rel = scope.all().find((r) => r.qualifier === item.table);
            if (rel === undefined)
                throw new PlanningError(`unknown table qualifier '${item.table}'`);
            rel.columns.forEach((c, i) => {
                items.push({
                    expr: { kind: "ordinal", index: rel.offset + i, label: `${rel.qualifier}.${c.name}` },
                    ref: { table: rel.qualifier, name: c.name, type: c.type },
                });
            });
            continue;
        }
        const touched = new Set();
        const expr = resolveExpr(item.expr, scope, touched);
        const table = item.alias === null && item.expr.kind === "column"
            ? scope.resolve(item.expr.table, item.expr.name).ref.table
            : null;
        items.push({
            expr,
            ref: { table, name: itemName(item, expr), type: itemType(item, expr, scope) },
        });
    }
    return { id: 0, op: "Project", items, child, estRows: child.estRows, schema: items.map((i) => i.ref) };
}
function itemName(item, expr) {
    if (item.kind !== "expr")
        return "?";
    if (item.alias !== null)
        return item.alias;
    if (item.expr.kind === "column")
        return item.expr.name;
    return exprToString(expr);
}
function itemType(item, expr, scope) {
    if (item.kind === "expr" && item.expr.kind === "column") {
        return scope.resolve(item.expr.table, item.expr.name).ref.type;
    }
    return literalType(expr);
}
function literalType(expr) {
    if (expr.kind === "literal") {
        if (expr.value === null)
            return "null";
        if (typeof expr.value === "boolean")
            return "boolean";
        if (typeof expr.value === "number")
            return Number.isInteger(expr.value) ? "integer" : "real";
        return "text";
    }
    return "boolean";
}
/** Sort below the projection: ORDER BY may name any column from FROM/JOIN. */
function applySortOnInput(stmt, scope, input, project) {
    if (stmt.orderBy.length === 0)
        return project;
    const keys = stmt.orderBy.map((k) => {
        const r = scope.resolve(k.column.table, k.column.name);
        return { index: r.index, label: outputName(r.ref), direction: k.direction };
    });
    const sort = {
        id: 0,
        op: "Sort",
        keys,
        child: input,
        estRows: input.estRows,
        schema: input.schema,
    };
    if (project.op !== "Project")
        throw new PlanningError("internal: expected a projection");
    return { ...project, child: sort };
}
/** Sort above the projection: with DISTINCT, ORDER BY must name an output column. */
function applySortOnOutput(stmt, child) {
    if (stmt.orderBy.length === 0)
        return child;
    const keys = stmt.orderBy.map((k) => {
        const matches = child.schema
            .map((ref, index) => ({ ref, index }))
            .filter(({ ref }) => ref.name === k.column.name && (k.column.table === null || ref.table === k.column.table));
        if (matches.length === 0) {
            throw new PlanningError(`ORDER BY column '${outputName({ table: k.column.table, name: k.column.name, type: "null" })}' is not in the select list`, "with SELECT DISTINCT, ORDER BY may only name selected columns");
        }
        if (matches.length > 1) {
            throw new PlanningError(`ambiguous ORDER BY column '${k.column.name}'`, "qualify it");
        }
        const { ref, index } = matches[0];
        return { index, label: outputName(ref), direction: k.direction };
    });
    return { id: 0, op: "Sort", keys, child, estRows: child.estRows, schema: child.schema };
}
function applyLimit(stmt, child) {
    if (stmt.limit === null)
        return child;
    const offset = stmt.offset ?? 0;
    return {
        id: 0,
        op: "Limit",
        count: stmt.limit,
        offset,
        child,
        estRows: Math.min(Math.max(child.estRows - offset, 0), stmt.limit),
        schema: child.schema,
    };
}
/** Pre-order ids; the executor keys its per-node counters on these. */
function assignIds(root) {
    let next = 0;
    const walk = (node) => {
        node.id = next++;
        for (const child of children(node))
            walk(child);
    };
    walk(root);
}
/**
 * Output column labels, with duplicates qualified. `SELECT e.name, d.name`
 * must not render two columns both called `name`.
 */
export function outputColumnNames(schema) {
    const counts = new Map();
    for (const ref of schema)
        counts.set(ref.name, (counts.get(ref.name) ?? 0) + 1);
    return schema.map((ref) => (counts.get(ref.name) ?? 0) > 1 && ref.table !== null ? `${ref.table}.${ref.name}` : ref.name);
}
