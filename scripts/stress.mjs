#!/usr/bin/env node
/**
 * Smoke + stress test against a MOCK SingleOps (never the real one).
 *
 * Starts a fake SingleOps on 127.0.0.1 that answers every mapped route (and
 * randomly throws 429/500 to exercise retries), starts this MCP server in
 * --http mode pointed at it, then hammers it through real MCP clients:
 *   - auth: no token -> 401, browser Origin -> 403
 *   - tools/list with all gates on
 *   - N concurrent clients x M read calls, plus dry-run and live writes
 *   - write budget, delete confirm, denied routes
 *
 *   npm run build && npm run stress            (N=20, M=10)
 *   node scripts/stress.mjs --clients=50 --calls=20
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => Number(process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d);
const CLIENTS = arg("clients", 20);
const CALLS = arg("calls", 10);
const TOKEN = "stress-" + "x".repeat(40);

// ---- mock SingleOps ------------------------------------------------------
let hits = 0;
let writes = 0;
const mock = http.createServer((req, res) => {
  hits++;
  if (req.url === "/" || req.url?.startsWith("/?")) {
    return res.writeHead(200, { "content-type": "text/html" }).end('<meta name="csrf-token" content="MOCKCSRF">');
  }
  const roll = Math.random();
  if (roll < 0.05) return res.writeHead(429, { "retry-after": "0" }).end();
  if (roll < 0.08) return res.writeHead(500).end();
  if (req.method !== "GET" && !/datatable|data_table|report|totals|check_batch/.test(req.url ?? "")) {
    writes++;
    if (req.headers["x-csrf-token"] !== "MOCKCSRF") return res.writeHead(422).end("Invalid authenticity token");
    return res.writeHead(302, { location: `/records/${1000 + writes}` }).end();
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: 1, name: "mock" }], recordsTotal: 1 }));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;

// ---- MCP server in --http mode, isolated state dir -----------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "so-stress-"));
const port = 30000 + Math.floor(Math.random() * 20000);
// Isolated state: a throwaway session in a temp dir. The real state/ is never read or written.
fs.mkdirSync(path.join(tmp, "state"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "state", "session.json"),
  JSON.stringify({ cookies: [{ name: "_SingleOps_session", value: "mock", domain: "127.0.0.1", path: "/", expires: -1 }], origins: [] }),
);
const env = {
  ...process.env,
  SINGLEOPS_BASE_URL: mockUrl,
  SINGLEOPS_HTTP_TOKEN: TOKEN,
  SINGLEOPS_HTTP_PORT: String(port),
  SINGLEOPS_ENABLE_WRITE: "true",
  SINGLEOPS_ENABLE_DELETE: "true",
  SINGLEOPS_MAX_WRITES: "5",
  SINGLEOPS_MAX_RPS: "500",
  SINGLEOPS_AUDIT_DIR: path.join(tmp, "audit"),
  SINGLEOPS_STATE_DIR: path.join(tmp, "state"),
};
const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js"), "--http"], { env, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/health`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const connect = async () => {
  const c = new Client({ name: "stress", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  return c;
};
const text = (r) => r.content?.[0]?.text ?? "";

try {
  // auth
  const noTok = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("HTTP rejects missing token", noTok.status === 401, `HTTP ${noTok.status}`);
  const badOrigin = await fetch(`${base}/mcp`, { method: "POST", headers: { origin: "https://evil.example", authorization: `Bearer ${TOKEN}` }, body: "{}" });
  check("HTTP rejects foreign browser Origin", badOrigin.status === 403, `HTTP ${badOrigin.status}`);

  // smoke
  const c = await connect();
  const { tools } = await c.listTools();
  const reads = tools.filter((t) => t.annotations?.readOnlyHint);
  const writesT = tools.filter((t) => t.annotations && !t.annotations.readOnlyHint);
  check("tools/list with all gates on", tools.length > 100, `${tools.length} tools, ${reads.length} read-only, ${writesT.length} mutating`);
  check("every tool has title + annotations", tools.every((t) => t.title && t.annotations));
  check("no denied route is exposed", !tools.some((t) => /email_visit|subscription|payment_gateway|create_user|update_user/.test(t.name)));
  const who = await c.callTool({ name: "singleops_read_whoami", arguments: {} });
  check("whoami live probe ok", /"ok": true/.test(text(who)));
  const disc = await c.callTool({ name: "singleops_discover_tools", arguments: { domain: "clients" } });
  check("discover_tools filters by domain", /singleops_write_create_client/.test(text(disc)));

  // writes
  const dry = await c.callTool({ name: "singleops_write_create_client", arguments: { body: { client: { first_name: "ZZ" } } } });
  const before = writes;
  check("write dry-run sends nothing", /"dry_run": true/.test(text(dry)) && /client\[first_name\]/.test(text(dry)) && writes === before);
  const live = await c.callTool({ name: "singleops_write_create_client", arguments: { body: { client: { first_name: "ZZ" } }, dry_run: false } });
  check("live write returns redirect id", /"id": "\d+"/.test(text(live)), text(live).replace(/\s+/g, " ").slice(0, 80));
  const noConfirm = await c.callTool({ name: "singleops_write_delete_tag", arguments: { id: 42, dry_run: false } });
  check("delete without confirm refused", !!noConfirm.isError && /DELETE \/tags\/42/.test(text(noConfirm)));
  const del = await c.callTool({ name: "singleops_write_delete_tag", arguments: { id: 42, dry_run: false, confirm: "DELETE /tags/42" } });
  check("delete with exact confirm sent", !del.isError, text(del).replace(/\s+/g, " ").slice(0, 60));
  let refused = 0;
  for (let i = 0; i < 6; i++) {
    const r = await c.callTool({ name: "singleops_write_create_tag", arguments: { body: { tag: { name: "ZZ" } }, dry_run: false } });
    if (r.isError && /budget/.test(text(r))) refused++;
  }
  check("write budget enforced across requests", refused >= 3, `${refused} refused after budget of 5`);
  const unknown = await c.callTool({ name: "singleops_call_route", arguments: { route: "post_visits_email", dry_run: false } });
  check("call_route cannot reach denied routes", !!unknown.isError && /denied/.test(text(unknown)));
  await c.close();

  // stress
  // Lead Entry tools need a token the mock run does not have.
  const readTools = reads.filter((t) => !t.name.includes("_lead_") && !Object.keys(t.inputSchema?.properties ?? {}).some((k) => (t.inputSchema.required ?? []).includes(k)));
  const t0 = Date.now();
  let okCalls = 0;
  let failCalls = 0;
  const failures = new Set();
  await Promise.all(
    Array.from({ length: CLIENTS }, async (_, ci) => {
      const cl = await connect();
      for (let j = 0; j < CALLS; j++) {
        const tool = readTools[(ci * CALLS + j) % readTools.length];
        const r = await cl.callTool({ name: tool.name, arguments: {} });
        if (r.isError) {
          failCalls++;
          failures.add(tool.name + ": " + text(r).slice(0, 120));
        } else okCalls++;
      }
      await cl.close();
    }),
  );
  const ms = Date.now() - t0;
  check(
    `stress: ${CLIENTS} concurrent clients x ${CALLS} read calls`,
    failCalls === 0,
    `${okCalls} ok, ${failCalls} failed, ${ms} ms, ${(okCalls / (ms / 1000)).toFixed(0)} calls/s, mock injected 5% 429 + 3% 500`,
  );
  for (const f of failures) console.log("      " + f);
  const mem = Number((await (await fetch(`${base}/health`)).json()).ok);
  check("server alive after stress", mem === 1);
} catch (e) {
  check("harness", false, e.stack ?? String(e));
} finally {
  child.kill();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed · mock saw ${hits} requests`);
if (failed && stderr) console.log(stderr.slice(-2000));
process.exit(failed ? 1 : 0);
