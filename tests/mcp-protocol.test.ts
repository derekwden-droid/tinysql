import { describe, expect, it } from "vitest";
import {
  INVALID_PARAMS,
  INVALID_REQUEST,
  LEGACY_VERSIONS,
  McpServer,
  METHOD_NOT_FOUND,
  MODERN_VERSIONS,
  PARSE_ERROR,
  SERVER_INFO,
  UNSUPPORTED_PROTOCOL_VERSION,
  type JsonRpcResponse,
} from "../src/mcp/protocol.js";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
};

function modern(id: number, method: string, params: Record<string, unknown> = {}, meta: object = META) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } };
}

function legacy(id: number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

function result(response: JsonRpcResponse | null): Record<string, unknown> {
  expect(response?.error, JSON.stringify(response)).toBeUndefined();
  return response!.result!;
}

function errorCode(response: JsonRpcResponse | null): number | undefined {
  return response?.error?.code;
}

const SELECT_ONE = { name: "run_sql", arguments: { sql: "SELECT 1 AS n" } };

describe("modern requests (2026-07-28, no handshake)", () => {
  it("answer server/discover with versions, capabilities, instructions and cache hints", () => {
    const r = result(new McpServer().handle(modern(1, "server/discover")));
    expect(r).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      cacheScope: "public",
      _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
    });
    expect(r.ttlMs).toBeGreaterThan(0);
    expect(r.instructions).toMatch(/self-contained/);
  });

  it("list the tools with resultType and cache hints", () => {
    const r = result(new McpServer().handle(modern(2, "tools/list")));
    expect(r.resultType).toBe("complete");
    expect((r.tools as { name: string }[]).map((t) => t.name)).toEqual(["describe_csv", "run_sql"]);
    expect(r).toHaveProperty("ttlMs");
    expect(r).toHaveProperty("cacheScope", "public");
  });

  it("call a tool on a fresh server, with no prior request", () => {
    const r = result(new McpServer().handle(modern(3, "tools/call", SELECT_ONE)));
    expect(r.resultType).toBe("complete");
    expect(r.isError).toBeUndefined();
    expect((r.content as { type: string; text: string }[])[0]).toMatchObject({ type: "text" });
    expect((r.content as { text: string }[])[0]!.text).toMatch(/^1 row · /);
  });

  it("return tool failures as error results the model can read", () => {
    const r = result(new McpServer().handle(modern(4, "tools/call", { name: "run_sql", arguments: { sql: "SELEC 1" } })));
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toContain("Tinysql: parse error");
  });

  it("reject an unknown tool as invalid params", () => {
    expect(errorCode(new McpServer().handle(modern(5, "tools/call", { name: "nope" })))).toBe(INVALID_PARAMS);
    expect(errorCode(new McpServer().handle(modern(6, "tools/call", {})))).toBe(INVALID_PARAMS);
  });

  it("reject a version they do not serve and list the ones they do", () => {
    const response = new McpServer().handle(
      modern(7, "tools/list", {}, { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" }),
    );
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: UNSUPPORTED_PROTOCOL_VERSION,
        message: "Unsupported protocol version",
        data: { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: "2099-01-01" },
      },
    });
  });

  it("reject a request that omits the client's capabilities", () => {
    const withoutCapabilities = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
    expect(errorCode(new McpServer().handle(modern(8, "tools/list", {}, withoutCapabilities)))).toBe(INVALID_PARAMS);
  });

  it("answer an unknown method with method not found", () => {
    expect(errorCode(new McpServer().handle(modern(9, "prompts/list")))).toBe(METHOD_NOT_FOUND);
  });
});

describe("legacy clients (initialize handshake)", () => {
  it("get their own protocol version back when it is one the server speaks", () => {
    const r = result(
      new McpServer().handle(
        legacy(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } }),
      ),
    );
    expect(r).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: expect.stringContaining("TinySQL"),
    });
  });

  it("are offered the newest legacy version when they ask for one the server does not know", () => {
    const r = result(new McpServer().handle(legacy(1, "initialize", { protocolVersion: "2030-01-01" })));
    expect(r.protocolVersion).toBe(LEGACY_VERSIONS[0]);
  });

  it("are served without the modern result fields after the handshake", () => {
    const server = new McpServer();
    result(server.handle(legacy(1, "initialize", { protocolVersion: "2025-11-25" })));
    expect(server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();

    const list = result(server.handle(legacy(2, "tools/list")));
    expect(Object.keys(list)).toEqual(["tools"]);

    const call = result(server.handle(legacy(3, "tools/call", SELECT_ONE)));
    expect(Object.keys(call)).toEqual(["content"]);
    expect((call.content as { text: string }[])[0]!.text).toMatch(/^1 row · /);

    expect(errorCode(server.handle(legacy(4, "resources/list")))).toBe(METHOD_NOT_FOUND);
  });

  it("must handshake before anything but ping when they send no modern metadata", () => {
    const server = new McpServer();
    expect(result(server.handle(legacy(1, "ping")))).toEqual({});
    const response = server.handle(legacy(2, "tools/list"));
    expect(errorCode(response)).toBe(INVALID_PARAMS);
    expect(response!.error!.message).toContain("send initialize first");
  });
});

describe("JSON-RPC framing", () => {
  it("never answers a notification or a stray response", () => {
    const server = new McpServer();
    expect(server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })).toBeNull();
    expect(server.handle({ jsonrpc: "2.0", id: 1, result: {} })).toBeNull();
    expect(server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
  });

  it("reports a line that is not JSON", () => {
    expect(JSON.parse(new McpServer().handleLine("{not json")!)).toEqual({
      jsonrpc: "2.0",
      error: { code: PARSE_ERROR, message: expect.stringContaining("Parse error") },
    });
  });

  it("rejects batches and malformed requests", () => {
    const server = new McpServer();
    expect(server.handle([modern(1, "tools/list")])).toMatchObject({ error: { code: INVALID_REQUEST } });
    expect(server.handle({ jsonrpc: "1.0", id: 2, method: "tools/list" })).toMatchObject({
      id: 2,
      error: { code: INVALID_REQUEST },
    });
    const nullId = server.handle({ jsonrpc: "2.0", id: null, method: "tools/list" });
    expect(nullId).toMatchObject({ error: { code: INVALID_REQUEST } });
    expect(nullId).not.toHaveProperty("id");
    expect(server.handle({ jsonrpc: "2.0", id: 3 })).toMatchObject({ id: 3, error: { code: INVALID_REQUEST } });
  });

  it("writes each reply on one line, however many lines the tool output has", () => {
    const line = new McpServer().handleLine(JSON.stringify(modern(1, "tools/call", SELECT_ONE)))!;
    expect(line).not.toContain("\n");
    expect(JSON.parse(line).result.content[0].text).toContain("\n");
  });
});
