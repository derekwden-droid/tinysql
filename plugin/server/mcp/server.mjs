// Generated from src/mcp/server.ts by scripts/build-plugin.ts. Do not edit:
// change the TypeScript source and run `npm run build:plugin`.
import { createInterface } from "node:readline";
import { McpServer } from "./protocol.mjs";
/**
 * The stdio entry point the Claude Code plugin launches: one JSON-RPC message
 * per line on stdin, one reply per line on stdout. Nothing else may reach
 * stdout, so this file never logs. The process exits when stdin closes, which
 * is how an MCP client shuts a stdio server down.
 */
const server = new McpServer();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
    if (line.trim() === "")
        return;
    const reply = server.handleLine(line);
    if (reply !== null)
        process.stdout.write(`${reply}\n`);
});
// A client that goes away mid-reply closes the pipe; there is no one left to tell.
process.stdout.on("error", () => process.exit(0));
