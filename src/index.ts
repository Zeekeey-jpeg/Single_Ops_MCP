#!/usr/bin/env node
/**
 * singleops-mcp-server.
 *
 * Tools are generated at startup from api-map.json (the route map built from
 * the SingleOps web app's own traffic) plus the four documented Lead Entry
 * routes. Re-crawl, re-map, restart: the toolset follows SingleOps' real API.
 *
 *   node dist/index.js            stdio (Claude Code, Claude Desktop, Cursor…)
 *   node dist/index.js --http     Streamable HTTP on 127.0.0.1:3333/mcp (Grok, remote agents)
 */

import http from "node:http";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadDotEnv, redact } from "./env.js";
import { loadConfig } from "./config.js";
import { LEAD_ROUTES, loadMap } from "./map.js";
import { SessionAuth } from "./auth.js";
import { registerAll } from "./tools.js";

const VERSION = "1.0.0";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`singleops-mcp-server ${VERSION}

Usage:
  node dist/index.js           Run over stdio.
  node dist/index.js --http    Run Streamable HTTP at http://$SINGLEOPS_HTTP_HOST:$SINGLEOPS_HTTP_PORT/mcp
                               (defaults 127.0.0.1:3333). Requires SINGLEOPS_HTTP_TOKEN; clients send
                               "Authorization: Bearer <token>".

Setup: npm run login (sign in by hand), then npm run crawl && npm run map to build api-map.json.
`);
  process.exit(0);
}

loadDotEnv();
const cfg = loadConfig();
const map = loadMap();
// Lead routes first so a captured route with the same path keeps its own id.
const routes = [...LEAD_ROUTES, ...map.routes];
const auth = new SessionAuth(map.auth, cfg.baseUrl);
/** Shared across HTTP requests so the write budget is per process, not per request. */
const writeState = { writesUsed: 0 };

function createServer(): { server: McpServer; registered: number; skipped: number } {
  const server = new McpServer({ name: "singleops-mcp-server", version: VERSION });
  const { registered, skipped } = registerAll(server, map, routes, cfg, auth, writeState);
  return { server, registered, skipped };
}

const first = createServer();
process.stderr.write(
  `[singleops-mcp-server] ${first.registered} route tools (+5 meta), ${first.skipped} gated off · ` +
    `map ${map.generatedAt ?? "EMPTY"} · auth ${map.auth.scheme} · write=${cfg.enableWrite} delete=${cfg.enableDelete} · ` +
    `lead token ${redact(cfg.leadUserToken)}\n`,
);

if (!process.argv.includes("--http")) {
  await first.server.connect(new StdioServerTransport());
} else {
  const token = process.env.SINGLEOPS_HTTP_TOKEN?.trim();
  if (!token || token.length < 24) {
    process.stderr.write(
      "[singleops-mcp-server] --http needs SINGLEOPS_HTTP_TOKEN (24+ chars). Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n",
    );
    process.exit(1);
  }
  const host = process.env.SINGLEOPS_HTTP_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.SINGLEOPS_HTTP_PORT ?? 3333);
  const allowedOrigins = (process.env.SINGLEOPS_HTTP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const expected = crypto.createHash("sha256").update(`Bearer ${token}`).digest();

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };

  http
    .createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/health") return send(res, 200, { ok: true, name: "singleops-mcp-server", version: VERSION });
        if (url.pathname !== "/mcp") return send(res, 404, { error: "not found" });
        // DNS-rebinding protection: browsers send Origin; agents and CLIs do not.
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.includes(origin)) return send(res, 403, { error: "origin not allowed" });
        const given = crypto.createHash("sha256").update(req.headers.authorization ?? "").digest();
        if (!crypto.timingSafeEqual(given, expected)) return send(res, 401, { error: "missing or bad bearer token" });
        if (req.method !== "POST") return send(res, 405, { error: "stateless server: POST only" });

        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > 1_000_000) return send(res, 413, { error: "request too large" });
          chunks.push(c as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");

        // Stateless: a fresh server + transport per request prevents request-id collisions between clients.
        const { server } = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) send(res, 400, { error: (e as Error).message });
      }
    })
    .listen(port, host, () => {
      process.stderr.write(`[singleops-mcp-server] Streamable HTTP on http://${host}:${port}/mcp (bearer token required)\n`);
    });
}
