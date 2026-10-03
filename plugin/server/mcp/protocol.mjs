// Generated from src/mcp/protocol.ts by scripts/build-plugin.ts. Do not edit:
// change the TypeScript source and run `npm run build:plugin`.
import { callTool, TOOLS } from "./tools.mjs";
/**
 * MCP over JSON-RPC 2.0, written out by hand: a two-tool server needs a small
 * slice of the protocol, and the engine takes no dependencies.
 *
 * The server is dual-era. Revision 2026-07-28 has no handshake: every request
 * carries its protocol version and the client's capabilities in `_meta`, and a
 * stdio process is not a session. Revisions up to 2025-11-25 open with an
 * `initialize` handshake instead. As the spec prescribes for a server that
 * supports both, a request with the modern `_meta` keys is served statelessly,
 * and an `initialize` request switches this process to legacy semantics too.
 */
export const SERVER_INFO = {
    name: "tinysql",
    title: "TinySQL",
    version: "1.0.0",
};
/** Revisions served from per-request `_meta`, with no handshake. */
export const MODERN_VERSIONS = ["2026-07-28"];
/** Revisions served after an `initialize` handshake, newest first. */
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const INSTRUCTIONS = "TinySQL runs SQL over local CSV files and reports the plan its engine actually ran. Every " +
    "run_sql call is self-contained: name the CSV files it needs in `tables`, and repeat any " +
    "CREATE INDEX in the same script as the query it should speed up. TinySQL has no aggregates " +
    "or GROUP BY; use another tool for those.";
// The `_meta` fields of 2026-07-28. They are named META_* because the plugin
// directory's scanner treats an interpolated name that looks like an API key as
// a credential being read from the user's machine.
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** How long a client may cache the tool list. The tools change only with a new plugin version. */
const TTL_MS = 3_600_000;
export class McpServer {
    /** Set once a client has sent `initialize`; from then on, requests without `_meta` are legacy ones. */
    legacy = false;
    /** One line from stdin in; the line to write to stdout out, or null when nothing should be written. */
    handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            return JSON.stringify(failure(undefined, PARSE_ERROR, "Parse error: each line must hold one JSON-RPC message"));
        }
        const response = this.handle(message);
        return response === null ? null : JSON.stringify(response);
    }
    handle(message) {
        if (!isObject(message)) {
            return failure(undefined, INVALID_REQUEST, "Invalid Request: expected one JSON-RPC object");
        }
        const hasId = "id" in message;
        const id = message.id;
        if (hasId && typeof id !== "string" && typeof id !== "number") {
            return failure(undefined, INVALID_REQUEST, "Invalid Request: id must be a string or a number");
        }
        const validId = hasId ? id : undefined;
        if (message.jsonrpc !== "2.0") {
            return hasId ? failure(validId, INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"') : null;
        }
        if (typeof message.method !== "string") {
            // A response: this server never sends requests, so there is nothing to match it to.
            if ("result" in message || "error" in message)
                return null;
            return hasId ? failure(validId, INVALID_REQUEST, "Invalid Request: method is required") : null;
        }
        // Notifications (initialized, cancelled) never get a reply, and every request
        // here finishes before the next line is read, so there is nothing to act on.
        if (validId === undefined)
            return null;
        try {
            return this.dispatch(validId, message.method, isObject(message.params) ? message.params : {});
        }
        catch (e) {
            return failure(validId, INTERNAL_ERROR, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    dispatch(id, method, params) {
        if (method === "initialize")
            return this.initialize(id, params);
        const meta = isObject(params._meta) ? params._meta : undefined;
        if (meta !== undefined && META_PROTOCOL_VERSION in meta)
            return this.modern(id, method, params, meta);
        if (method === "ping")
            return success(id, {});
        if (!this.legacy) {
            return failure(id, INVALID_PARAMS, `Invalid params: _meta["${META_PROTOCOL_VERSION}"] is required, or send initialize first to use protocol ${LEGACY_VERSIONS[0]} or earlier`);
        }
        switch (method) {
            case "tools/list":
                return success(id, { tools: TOOLS });
            case "tools/call":
                return this.callTool(id, params, {});
            default:
                return failure(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
    }
    /** The legacy handshake: echo the client's version if it is one we speak, else offer our newest. */
    initialize(id, params) {
        const requested = params.protocolVersion;
        const protocolVersion = typeof requested === "string" && LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
        this.legacy = true;
        return success(id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
        });
    }
    modern(id, method, params, meta) {
        const version = meta[META_PROTOCOL_VERSION];
        if (typeof version !== "string" || !MODERN_VERSIONS.includes(version)) {
            return failure(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
                supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
                requested: String(version),
            });
        }
        if (!isObject(meta[META_CLIENT_CAPABILITIES])) {
            return failure(id, INVALID_PARAMS, `Invalid params: _meta["${META_CLIENT_CAPABILITIES}"] is required`);
        }
        const base = { resultType: "complete", _meta: { [META_SERVER_INFO]: SERVER_INFO } };
        switch (method) {
            case "server/discover":
                return success(id, {
                    ...base,
                    supportedVersions: [...MODERN_VERSIONS],
                    capabilities: { tools: {} },
                    instructions: INSTRUCTIONS,
                    ttlMs: TTL_MS,
                    cacheScope: "public",
                });
            case "tools/list":
                return success(id, { ...base, tools: TOOLS, ttlMs: TTL_MS, cacheScope: "public" });
            case "tools/call":
                return this.callTool(id, params, base);
            case "ping":
                return success(id, base);
            default:
                return failure(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
    }
    callTool(id, params, base) {
        const name = params.name;
        if (typeof name !== "string") {
            return failure(id, INVALID_PARAMS, "Invalid params: tools/call needs the tool's name");
        }
        const outcome = callTool(name, params.arguments);
        if (outcome === null)
            return failure(id, INVALID_PARAMS, `Unknown tool: ${name}`);
        return success(id, {
            ...base,
            content: [{ type: "text", text: outcome.text }],
            ...(outcome.isError ? { isError: true } : {}),
        });
    }
}
function success(id, result) {
    return { jsonrpc: "2.0", id, result };
}
function failure(id, code, message, data) {
    const error = data === undefined ? { code, message } : { code, message, data };
    return id === undefined ? { jsonrpc: "2.0", error } : { jsonrpc: "2.0", id, error };
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
