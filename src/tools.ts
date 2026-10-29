/**
 * Tool registration: one MCP tool per mapped route, plus meta tools.
 *
 * Names follow {service}_{read|write}_{verb}_{entity} (see naming.ts).
 *
 * Gates (decided at registration time; a tool that is not registered cannot be
 * called, mis-called, or talked into running):
 *   policy "deny" (billing, logins, sends to customers, account settings)  never
 *   GET + read-only POST (Rails datatable/report queries)  always registered
 *   POST / PUT / PATCH  only when SINGLEOPS_ENABLE_WRITE=true
 *   DELETE              only when SINGLEOPS_ENABLE_DELETE=true
 *
 * Call-time guards on registered writes:
 *   dry_run defaults to true: the tool returns the exact request and sends nothing
 *   DELETE needs confirm = "DELETE <path>" for the one record being deleted
 *   at most SINGLEOPS_MAX_WRITES live writes per server run
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { fillPath, type ApiMap, type Route, type Shape } from "./map.js";
import { ApiError, SingleOpsClient, previewRoute, type CallArgs } from "./client.js";
import { AuthError, SessionAuth } from "./auth.js";
import { assignToolNames, verbEntity } from "./naming.js";
import { toMarkdown } from "./format.js";

export const CHARACTER_LIMIT = 25_000;
export const SERVICE = "singleops";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type ResponseFormat = "markdown" | "json";

function ok(data: unknown, format: ResponseFormat = "json"): ToolResult {
  let text = typeof data === "string" ? data : format === "markdown" ? toMarkdown(data) : JSON.stringify(data, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    text =
      text.slice(0, CHARACTER_LIMIT) +
      `\n\n…[truncated: ${text.length} chars total. Narrow the query: use the route's paging params (page/length/start) or filters.]`;
  }
  return { content: [{ type: "text", text }] };
}

function fail(e: unknown): ToolResult {
  let text: string;
  if (e instanceof AuthError) text = `AUTH: ${e.message}`;
  else if (e instanceof ApiError) text = `Error: ${e.message}\n${JSON.stringify(e.body, null, 2)?.slice(0, 4000) ?? ""}`;
  else text = `Error: ${(e as Error).message ?? String(e)}`;
  return { content: [{ type: "text", text }], isError: true };
}

export function isRegistrable(route: Route, cfg: Config): boolean {
  if (route.policy === "deny") return false;
  if (route.method === "GET" || route.readOnly) return true;
  if (route.method === "DELETE") return cfg.enableDelete;
  return cfg.enableWrite;
}

export const isWriteRoute = (r: Route) => r.method !== "GET" && !r.readOnly;

function gateMessage(route: Route): string {
  if (route.policy === "deny") return `Route is denied by policy (${route.denyReason ?? "unsafe"}). It is never exposed.`;
  if (route.method === "DELETE") return "Deletes are disabled (SINGLEOPS_ENABLE_DELETE is not true).";
  return "Writes are disabled (SINGLEOPS_ENABLE_WRITE is not true).";
}

export function annotationsFor(route: Route): ToolAnnotations {
  if (!isWriteRoute(route)) return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  if (route.method === "DELETE") return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
  const update = route.method === "PATCH" || route.method === "PUT";
  return { readOnlyHint: false, destructiveHint: update, idempotentHint: update, openWorldHint: true };
}

/** Body fields as Rails names: client[first_name], job[line_items_attributes][][qty]. */
export function railsFieldNames(shape: Shape | null | undefined, prefix = ""): string[] {
  if (!shape) return [];
  if (shape.type === "array") return railsFieldNames(shape.items, `${prefix}[]`).concat(shape.items ? [] : [`${prefix}[]`]);
  if (shape.type === "object" && shape.properties) {
    return Object.entries(shape.properties).flatMap(([k, v]) => {
      const name = prefix ? `${prefix}[${k}]` : k;
      return v.type === "object" || v.type === "array" ? railsFieldNames(v, name) : [name];
    });
  }
  return prefix ? [prefix] : [];
}

function topKeys(shape: Shape | null | undefined): string[] {
  if (!shape) return [];
  if (shape.type === "object") return Object.keys(shape.properties ?? {});
  if (shape.type === "array") return topKeys(shape.items).map((k) => `[].${k}`);
  return [];
}

const words = (s: string) => s.replace(/_/g, " ");

/** One line, for README tables and the discover tool. */
export function shortDescription(route: Route): string {
  if (route.summary) return route.summary;
  const { verb, entity } = verbEntity(route);
  const what = words(entity);
  const base =
    verb === "search"
      ? `Search ${what} (server-side table query: paging, sorting, filters)`
      : verb === "list"
        ? `List ${what}`
        : verb === "get"
          ? `Get ${what}${route.pathParams.length ? " by id" : ""}`
          : `${verb[0].toUpperCase()}${verb.slice(1)} ${what}`;
  const scope = route.pathParams.length && verb !== "get" && verb !== "delete" ? ` for one ${route.pathParams.map((p) => p.replace(/_id$/, "")).join("/")}` : "";
  return `${base}${scope}.`;
}

export function describe(route: Route): string {
  const lines = [
    `${shortDescription(route)} (${route.method} ${route.path})`,
    route.verified ? "Verified route." : "Inferred from the SingleOps web app's own traffic; confirm results.",
  ];
  if (route.queryParams.length) lines.push(`Query params seen: ${route.queryParams.join(", ")}.`);
  if (route.pagination) lines.push(`Paginated via: ${route.pagination.params.join(", ")}.`);
  if (route.source === "form" || route.source === "link") {
    const fields = railsFieldNames(route.body);
    if (fields.length) {
      lines.push(
        `Rails form fields (pass as nested objects, e.g. {"client": {"first_name": "…"}}; send only what you set): ${fields.slice(0, 80).join(", ")}${fields.length > 80 ? ` …+${fields.length - 80}` : ""}.`,
      );
    }
    lines.push("Returns {ok, status, redirect, id} on success (the new/updated record id), or validation errors.");
  } else {
    const bk = topKeys(route.body);
    if (bk.length) lines.push(`Body keys seen: ${bk.slice(0, 40).join(", ")}.`);
    const rk = topKeys(route.response);
    lines.push(rk.length ? `Returns JSON with keys: ${rk.slice(0, 40).join(", ")}.` : "Returns the endpoint's JSON response.");
  }
  if (route.method !== "GET" && route.readOnly) lines.push("Read-only query sent as POST (filters go in body).");
  else if (route.method === "DELETE") lines.push('DELETES LIVE DATA. Needs dry_run:false and confirm:"DELETE <path>". Audited.');
  else if (route.method !== "GET") lines.push("WRITES LIVE DATA. dry_run defaults to true (returns the request, sends nothing); pass dry_run:false to send. Audited.");
  return lines.join(" ");
}

const queryValue = z.union([z.string(), z.number(), z.boolean()]);
const formatParam = z
  .enum(["markdown", "json"])
  .optional()
  .describe('Output format: "markdown" (default, readable tables) or "json" (full raw response).');

function inputSchemaFor(route: Route): z.ZodRawShape {
  const shape: z.ZodRawShape = {};
  for (const p of route.pathParams) {
    shape[p] = z.union([z.string().min(1), z.number().int()]).describe(`Path parameter {${p}} (record id).`);
  }
  for (const q of route.queryParams) {
    if (q in shape) continue;
    shape[q] = queryValue.optional().describe(`Query parameter "${q}".`);
  }
  shape.extra_query = z.record(queryValue).optional().describe("Any additional query parameters.");
  if (route.method !== "GET" && route.method !== "DELETE") {
    shape.body = (isWriteRoute(route) ? z.record(z.unknown()).optional() : z.record(z.unknown()).optional())
      .describe("Request body as a JSON object. Match the fields listed in the description.");
  }
  if (isWriteRoute(route)) {
    shape.dry_run = z.boolean().optional().describe("Default true: return the exact request without sending it. false = send live.");
  } else {
    shape.response_format = formatParam;
  }
  if (route.method === "DELETE") {
    shape.confirm = z.string().optional().describe('Required to send: the literal text "DELETE <path>", e.g. "DELETE /tags/42".');
  }
  return shape;
}

function splitArgs(route: Route, args: Record<string, unknown>): CallArgs {
  const pathParams: Record<string, string | number> = {};
  const query: Record<string, string | number | boolean | undefined> = {};
  for (const p of route.pathParams) pathParams[p] = args[p] as string | number;
  for (const q of route.queryParams) if (args[q] !== undefined) query[q] = args[q] as string;
  Object.assign(query, (args.extra_query as Record<string, string>) ?? {});
  return { pathParams, query, body: args.body };
}

export type WriteDecision = { action: "read" } | { action: "preview" } | { action: "send" } | { action: "refuse"; reason: string };

/** Call-time guard for one call. Pure, so it is testable without a server. */
export function decideWrite(
  route: Route,
  call: { pathParams?: Record<string, string | number>; dryRun?: boolean; confirm?: string },
  cfg: Config,
  writesUsed: number,
): WriteDecision {
  if (!isRegistrable(route, cfg)) return { action: "refuse", reason: gateMessage(route) };
  if (!isWriteRoute(route)) return { action: "read" };
  if (call.dryRun !== false) return { action: "preview" };
  if (writesUsed >= cfg.maxWrites) {
    return { action: "refuse", reason: `Write budget used (${cfg.maxWrites} per run, SINGLEOPS_MAX_WRITES). Restart the server or raise the limit on purpose.` };
  }
  if (route.method === "DELETE") {
    let target: string;
    try {
      target = fillPath(route.path, call.pathParams ?? {});
    } catch (e) {
      return { action: "refuse", reason: (e as Error).message };
    }
    if (call.confirm?.trim() !== `DELETE ${target}`) {
      return { action: "refuse", reason: `Delete not confirmed. To delete this one record pass confirm: "DELETE ${target}".` };
    }
  }
  return { action: "send" };
}

export interface CatalogEntry {
  name: string;
  route_id: string;
  kind: "read" | "write" | "delete" | "denied" | "meta";
  method: string;
  path: string;
  description: string;
  gate: string;
}

const META: CatalogEntry[] = [
  { name: `${SERVICE}_discover_tools`, route_id: "-", kind: "meta", method: "-", path: "-", gate: "always", description: "List every tool grouped by domain (clients, jobs, visits, reports…), filterable by domain and read/write, with enabled/disabled state." },
  { name: `${SERVICE}_read_whoami`, route_id: "-", kind: "meta", method: "-", path: "-", gate: "always", description: "Connection status: session presence/expiry and auth scheme (no secret values), gates, write budget, and a live probe of one GET route." },
  { name: `${SERVICE}_call_route`, route_id: "-", kind: "meta", method: "-", path: "-", gate: "same as target", description: "Call any mapped route by tool name or route id. Free-form URLs are not accepted; the target's gates and dry-run apply." },
  { name: `${SERVICE}_read_contract_test`, route_id: "-", kind: "meta", method: "-", path: "-", gate: "always", description: "Replay parameter-free GET routes and diff response keys against the map, to detect SingleOps changing its internal API." },
  { name: `${SERVICE}_read_get_qbo_status`, route_id: "-", kind: "meta", method: "-", path: "-", gate: "always", description: "Report the QuickBooks Online connection settings. Check before any bulk write: writes sync to QuickBooks." },
];

/** Every tool the server can expose, enabled or not. Feeds the discover tool and the README. */
export function buildCatalog(routes: Route[]): CatalogEntry[] {
  const names = assignToolNames(routes, SERVICE);
  const rows = routes.map((r): CatalogEntry => {
    const kind = r.policy === "deny" ? "denied" : r.method === "DELETE" ? "delete" : isWriteRoute(r) ? "write" : "read";
    const gate =
      kind === "denied"
        ? `never (${r.denyReason})`
        : kind === "read"
          ? r.auth === "lead_token"
            ? "Lead Entry token"
            : "always"
          : kind === "delete"
            ? "SINGLEOPS_ENABLE_DELETE"
            : "SINGLEOPS_ENABLE_WRITE";
    return { name: names.get(r.id)!, route_id: r.id, kind, method: r.method, path: r.path, description: shortDescription(r), gate };
  });
  return [...META, ...rows];
}

function domainOf(path: string): string {
  return path.replace(/^\/(?:(?:client|public)\/)?api\/v\d+/, "").split("/").filter(Boolean)[0]?.replace(/\.json$/, "") ?? "root";
}

export function registerAll(
  server: McpServer,
  map: ApiMap,
  routes: Route[],
  cfg: Config,
  auth: SessionAuth,
  state: { writesUsed: number } = { writesUsed: 0 },
): { registered: number; skipped: number } {
  const client = new SingleOpsClient(cfg, auth);
  const names = assignToolNames(routes, SERVICE);
  const byName = new Map<string, Route>();
  for (const r of routes) {
    byName.set(r.id, r);
    byName.set(names.get(r.id)!, r);
  }
  let registered = 0;
  let skipped = 0;

  async function execute(route: Route, call: CallArgs, opts: { dryRun?: boolean; confirm?: string; format?: ResponseFormat }): Promise<ToolResult> {
    const decision = decideWrite(route, { pathParams: call.pathParams, ...opts }, cfg, state.writesUsed);
    try {
      switch (decision.action) {
        case "refuse":
          return fail(new Error(decision.reason));
        case "preview":
          return ok({
            dry_run: true,
            note: "Nothing was sent. Re-call with dry_run:false to send this exact request.",
            request: previewRoute(route, call, cfg.baseUrl),
          });
        case "send":
          state.writesUsed++; // counted before sending: a failed write still spent an attempt
          return ok((await client.callRoute(route, call)).data);
        default:
          return ok((await client.callRoute(route, call)).data, opts.format ?? "markdown");
      }
    } catch (e) {
      return fail(e);
    }
  }

  for (const route of routes) {
    if (!isRegistrable(route, cfg)) {
      skipped++;
      continue;
    }
    const name = names.get(route.id)!;
    server.registerTool(
      name,
      {
        title: shortDescription(route).replace(/\.$/, ""),
        description: describe(route),
        inputSchema: inputSchemaFor(route),
        annotations: annotationsFor(route),
      },
      async (args: Record<string, unknown>) =>
        execute(route, splitArgs(route, args), {
          dryRun: args.dry_run as boolean | undefined,
          confirm: args.confirm as string | undefined,
          format: args.response_format as ResponseFormat | undefined,
        }),
    );
    registered++;
  }

  // ---- Meta tools --------------------------------------------------------

  const catalog = buildCatalog(routes);
  const readMeta: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  server.registerTool(
    `${SERVICE}_discover_tools`,
    {
      title: "Discover SingleOps tools",
      description: META[0].description + " Returns JSON: {totalTools, domains: {<domain>: {tools: [{name, kind, enabled, description}]}}}.",
      inputSchema: {
        domain: z.string().optional().describe('Resource domain, e.g. "clients", "jobs", "visits", "reports", "invoices".'),
        type: z.enum(["read", "write", "delete", "denied", "meta"]).optional().describe("Filter by tool kind."),
      },
      annotations: { ...readMeta, openWorldHint: false },
    },
    async ({ domain, type }) => {
      const out: Record<string, { tools: unknown[] }> = {};
      let total = 0;
      for (const t of catalog) {
        const d = t.kind === "meta" ? "meta" : domainOf(t.path);
        if ((domain && d !== domain) || (type && t.kind !== type)) continue;
        const route = byName.get(t.route_id);
        (out[d] ??= { tools: [] }).tools.push({
          name: t.name,
          kind: t.kind,
          enabled: t.kind === "meta" || (route ? isRegistrable(route, cfg) : false),
          description: t.description,
        });
        total++;
      }
      return ok({ totalTools: total, domains: out });
    },
  );

  server.registerTool(
    `${SERVICE}_read_whoami`,
    { title: "SingleOps connection status", description: META[1].description, inputSchema: {}, annotations: readMeta },
    async () => {
      const status: Record<string, unknown> = {
        auth: auth.status(),
        leadToken: cfg.leadUserEmail && cfg.leadUserToken ? "configured" : "not configured",
        map: { generatedAt: map.generatedAt, routes: map.routes.length },
        gates: {
          write: cfg.enableWrite,
          delete: cfg.enableDelete,
          writeBudget: { used: state.writesUsed, max: cfg.maxWrites },
          deniedByPolicy: routes.filter((r) => r.policy === "deny").length,
        },
        tools: { registered: registered + META.length, skippedByGate: skipped },
      };
      const probe = map.routes.find((r) => r.method === "GET" && r.pathParams.length === 0 && r.auth === "session" && r.path.startsWith("/api/"));
      if (probe) {
        try {
          const res = await client.callRoute(probe);
          status.liveProbe = { route: names.get(probe.id), status: res.status, ok: true };
        } catch (e) {
          status.liveProbe = { route: names.get(probe.id), ok: false, error: (e as Error).message };
        }
      } else {
        status.liveProbe = "No session GET routes mapped. Run `npm run crawl` then `npm run map`.";
      }
      return ok(status);
    },
  );

  server.registerTool(
    `${SERVICE}_call_route`,
    {
      title: "Call a mapped SingleOps route",
      description: META[2].description,
      inputSchema: {
        route: z.string().min(1).describe("Tool name (singleops_read_list_items) or route id (get_items). See singleops_discover_tools."),
        path_params: z.record(z.union([z.string(), z.number()])).optional(),
        query: z.record(queryValue).optional(),
        body: z.record(z.unknown()).optional(),
        dry_run: z.boolean().optional().describe("Writes only. Default true = preview, nothing sent."),
        confirm: z.string().optional().describe('Deletes only: "DELETE <path>".'),
        response_format: formatParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ route: id, path_params, query, body, dry_run, confirm, response_format }) => {
      const route = byName.get(id);
      if (!route) return fail(new Error(`Unknown route "${id}". Use ${SERVICE}_discover_tools to list tool names.`));
      return execute(route, { pathParams: path_params, query, body }, { dryRun: dry_run, confirm, format: response_format });
    },
  );

  server.registerTool(
    `${SERVICE}_read_contract_test`,
    {
      title: "SingleOps API contract test",
      description: META[3].description + " Returns {probed, passed, failed, results[]}.",
      inputSchema: { limit: z.number().int().positive().max(200).optional().describe("Max routes to probe (default 25).") },
      annotations: readMeta,
    },
    async ({ limit }) => {
      const targets = routes.filter((r) => r.method === "GET" && r.pathParams.length === 0 && r.auth === "session").slice(0, limit ?? 25);
      const results: Record<string, unknown>[] = [];
      for (const r of targets) {
        try {
          const res = await client.callRoute(r, { noRetry: true, ...(r.pagination ? { query: { [r.pagination.params[0]]: 1 } } : {}) });
          const expected = topKeys(r.response);
          const actual = inferTop(res.data);
          const missing = expected.filter((k) => !actual.includes(k));
          const added = actual.filter((k) => !expected.includes(k));
          results.push({ tool: names.get(r.id), status: res.status, ok: missing.length === 0, missing, added });
        } catch (e) {
          results.push({ tool: names.get(r.id), ok: false, error: (e as Error).message });
        }
      }
      const passed = results.filter((x) => x.ok).length;
      return ok({ probed: results.length, passed, failed: results.length - passed, results });
    },
  );

  server.registerTool(
    `${SERVICE}_read_get_qbo_status`,
    { title: "QuickBooks connection status", description: META[4].description, inputSchema: {}, annotations: readMeta },
    async () => {
      const qbo = routes.filter((r) => r.method === "GET" && r.pathParams.length === 0 && /quickbooks|qbo|intuit/i.test(r.path));
      if (!qbo.length) return ok({ status: "unknown", reason: "No QuickBooks routes in the map. Visit Settings → Integrations during capture." });
      const out: Record<string, unknown> = {};
      for (const r of qbo) {
        try {
          out[names.get(r.id)!] = (await client.callRoute(r)).data;
        } catch (e) {
          out[names.get(r.id)!] = { error: (e as Error).message };
        }
      }
      return ok({ routes: out });
    },
  );

  return { registered, skipped };
}

function inferTop(data: unknown): string[] {
  if (Array.isArray(data)) {
    const first = data.find((x) => x && typeof x === "object");
    return first ? Object.keys(first).map((k) => `[].${k}`) : [];
  }
  if (data && typeof data === "object") return Object.keys(data);
  return [];
}
