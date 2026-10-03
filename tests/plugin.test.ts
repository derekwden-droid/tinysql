import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GENERATED_DIRS, renderPlugin } from "../scripts/build-plugin.js";
import { SERVER_INFO } from "../src/mcp/protocol.js";

/**
 * The plugin folder is what Anthropic's directory validates and what users
 * install, so the directory's published checklist lives here as tests rather
 * than as prose: prose does not fail CI.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = join(ROOT, "plugin");
const ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}/";

/** Every file under `dir`, as "/"-separated paths relative to it. */
function walk(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PLUGIN, path), "utf8")) as Record<string, unknown>;
}

interface Manifest {
  name: string;
  version: string;
  description: string;
  author: { name: string };
  license: string;
  [key: string]: unknown;
}

const manifest = readJson(".claude-plugin/plugin.json") as Manifest;
const files = walk(PLUGIN);

describe("generated plugin files", () => {
  it("match a fresh build of src/ (run `npm run build:plugin` after changing the engine or server)", () => {
    const expected = renderPlugin();
    for (const [path, content] of expected) {
      expect(existsSync(join(ROOT, path)), `${path} is missing`).toBe(true);
      // Git may check text out with CRLF on Windows; the build writes LF.
      const actual = readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
      expect(actual === content, `${path} is stale`).toBe(true);
    }
    const onDisk = GENERATED_DIRS.flatMap((dir) => walk(join(ROOT, dir)).map((file) => `${dir}/${file}`));
    expect(onDisk.filter((path) => !expected.has(path)), "files the build no longer produces").toEqual([]);
  });
});

describe("plugin folder against the directory's checklist", () => {
  it("has a lowercase kebab-case name, metadata, and the server's own name and version", () => {
    expect(manifest.name).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
    expect(manifest.name).toBe(SERVER_INFO.name);
    expect(manifest.version).toBe(SERVER_INFO.version);
    expect(manifest.description).toEqual(expect.any(String));
    expect(manifest.author.name).toEqual(expect.any(String));
    expect(manifest.license).toBe("MIT");
    for (const key of ["homepage", "repository", "documentationUrl", "supportUrl", "privacyPolicyUrl"]) {
      expect(manifest[key], key).toMatch(/^https:\/\//);
    }
  });

  it("points its documentation and privacy links at files in this folder", () => {
    const blob = "https://github.com/derekwden-droid/tinysql/blob/main/plugin/";
    for (const key of ["documentationUrl", "privacyPolicyUrl"]) {
      const url = String(manifest[key]);
      expect(url.startsWith(blob), key).toBe(true);
      expect(files, key).toContain(url.slice(blob.length));
    }
  });

  it("has a listing icon that is a complete PNG inside the folder", () => {
    const icon = String(manifest.icon);
    expect(icon.startsWith("./")).toBe(true);
    const png = readFileSync(join(PLUGIN, icon));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.subarray(-8, -4).toString("latin1")).toBe("IEND");
  });

  it("starts each MCP server by running a file inside the folder with plain arguments", () => {
    const servers = Object.entries(readJson(".mcp.json").mcpServers as Record<string, { command: string; args: string[] }>);
    expect(servers.map(([name]) => name)).toEqual(["tinysql"]);
    for (const [, server] of servers) {
      expect(server.command).toBe("node");
      expect(server.args).toHaveLength(1);
      const [script] = server.args;
      expect(script!.startsWith(ROOT_VAR)).toBe(true);
      expect(files).toContain(script!.slice(ROOT_VAR.length));
    }
  });

  it("has a README of at least 40 words outside code blocks, a LICENSE and a privacy policy", () => {
    const readme = readFileSync(join(PLUGIN, "README.md"), "utf8").replace(/```[\s\S]*?```/g, "");
    expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
    expect(readFileSync(join(PLUGIN, "LICENSE"), "utf8")).toMatch(/^MIT License/);
    expect(files).toContain("PRIVACY.md");
  });

  it("ships no package.json, lockfile, registry config, top-level bin/ or system files", () => {
    const banned = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?|\.npmrc|bunfig\.toml|uv\.toml|\.DS_Store|Thumbs\.db|desktop\.ini)$/;
    expect(files.filter((path) => banned.test(path) || path.startsWith("bin/") || path.includes("__MACOSX"))).toEqual([]);
  });

  it("contains only text files and complete images, each small enough to be read", () => {
    const allowed = /\.(json|md|mjs|csv|png|svg)$|^LICENSE$/;
    expect(files.filter((path) => !allowed.test(path))).toEqual([]);
    expect(files.length).toBeLessThanOrEqual(512);
    for (const path of files) {
      if (path.endsWith(".png")) continue;
      expect(statSync(join(PLUGIN, path)).size, path).toBeLessThan(256 * 1024);
    }
  });

  it("uses file names that are valid on Windows and macOS", () => {
    const device = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
    for (const path of files) {
      for (const part of path.split("/")) {
        expect(part, path).not.toMatch(/[:<>"|?*]|[. ]$/);
        expect(part, path).not.toMatch(device);
      }
    }
    expect(new Set(files.map((path) => path.toLowerCase())).size).toBe(files.length);
  });

  it("gives every skill front matter with a name matching its folder and a one-line description", () => {
    const skills = files.filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path));
    expect(skills).toEqual(["skills/explain/SKILL.md"]);
    for (const path of skills) {
      const text = readFileSync(join(PLUGIN, path), "utf8").replace(/\r\n/g, "\n");
      const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(frontMatter, path).not.toBeNull();
      const fields = new Map(
        frontMatter![1]!.split("\n").map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon), line.slice(colon + 1).trim()] as const;
        }),
      );
      // claude.ai refuses skills with keys outside the Agent Skills spec.
      for (const key of fields.keys()) {
        expect(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]).toContain(key);
      }
      expect(fields.get("name")).toBe(path.split("/")[1]);
      expect(fields.get("description")!.length).toBeGreaterThan(40);
      expect(fields.get("description")!.length).toBeLessThanOrEqual(1024);
    }
  });
});

interface Reply {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number };
}

interface Conversation {
  replies: Reply[];
  code: number | null;
  stderr: string;
}

/** The text of a tools/call reply. */
function textOf(reply: Reply | undefined): string {
  return (reply?.result?.content as { text: string }[])[0]!.text;
}

/** Send messages to the shipped server, close stdin, and collect every reply until it exits. */
function converse(messages: object[]): Promise<Conversation> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(PLUGIN, "server", "mcp", "server.mjs")], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const replies = stdout.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
        resolve({ replies, code, stderr });
      } catch (e) {
        reject(new Error(`stdout held something other than JSON-RPC lines:\n${stdout}\n${String(e)}`));
      }
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

const EXAMPLE_TABLES = {
  employees: "plugin/examples/employees.csv",
  departments: "plugin/examples/departments.csv",
};
const EXAMPLE_JOIN =
  "SELECT e.name AS employee, d.name AS department FROM employees e JOIN departments d ON e.dept_id = d.id WHERE e.dept_id = 3";

describe("the shipped server over stdio", () => {
  it("serves a legacy client, answers in order, and exits when stdin closes", async () => {
    const { replies, code, stderr } = await converse([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_sql", arguments: { tables: EXAMPLE_TABLES, sql: EXAMPLE_JOIN } } },
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(replies[0]!.result!.protocolVersion).toBe("2025-11-25");
    expect(replies[1]!.result!.tools).toHaveLength(2);
    expect(textOf(replies[2])).toMatch(/^7 rows · .+ · 108 rows touched · no index used/);
  }, 20_000);

  it("serves a modern client with no handshake", async () => {
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
    const { replies, code } = await converse([
      { jsonrpc: "2.0", id: "discover", method: "server/discover", params: { _meta: meta } },
      {
        jsonrpc: "2.0",
        id: "call",
        method: "tools/call",
        params: { _meta: meta, name: "describe_csv", arguments: { tables: { orders: "plugin/examples/orders.csv" } } },
      },
    ]);
    expect(code).toBe(0);
    expect(replies[0]!.result!.supportedVersions).toEqual(["2026-07-28"]);
    expect(replies[1]!.result!.resultType).toBe("complete");
    expect(textOf(replies[1])).toContain("Table orders: 48 rows");
  }, 20_000);
});
