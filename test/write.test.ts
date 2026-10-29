import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/audit.js", () => ({ audit: vi.fn(), shapeOf: (b: unknown) => (b && typeof b === "object" ? Object.keys(b) : typeof b) }));

import { SessionAuth } from "../src/auth.js";
import { ApiError, SingleOpsClient, previewRoute } from "../src/client.js";
import { encodeForm, idFromLocation, railsErrors, railsPairs } from "../src/rails.js";
import { decideWrite, describe as describeRoute, railsFieldNames } from "../src/tools.js";
import type { Config } from "../src/config.js";
import type { Route } from "../src/map.js";
// @ts-expect-error - plain .mjs module, no type declarations
import { extractForms, formsToRoutes, fieldPath } from "../scripts/lib/form-mine.mjs";
// @ts-expect-error - plain .mjs module, no type declarations
import { buildMap } from "../scripts/lib/har-map.mjs";

const cfg = (over: Partial<Config> = {}): Config => ({
  enableWrite: true,
  enableDelete: false,
  maxWrites: 2,
  maxRps: 1000,
  baseUrl: "https://app.singleops.com",
  ...over,
});
const route = (over: Partial<Route>): Route => ({
  id: "post_clients",
  method: "POST",
  path: "/clients",
  pathParams: [],
  queryParams: [],
  bodyKind: "form",
  body: { type: "object", properties: { client: { type: "object", properties: { first_name: { type: "string" } } } } },
  response: null,
  statuses: [],
  seen: 1,
  verified: false,
  auth: "session",
  source: "form",
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

const PAGE = `
<form action="/clients" method="post" class="new_client">
  <input type="hidden" name="authenticity_token" value="TOKEN-SECRET">
  <input type="text" name="client[first_name]" value="Jane">
  <input type="email" name="client[email]" value="jane@example.com">
  <input type="checkbox" name="client[allow_sms]" value="1" checked>
  <select name="client[term_id]"><option value="7" selected>Net 30</option></select>
  <textarea name="client[notes]">Gate code 1234</textarea>
  <input type="text" name="visit_24416437_can_update_recurrence" value="x">
  <input type="submit" name="commit" value="Save">
</form>
<form action="/jobs/55" method="post"><input type="hidden" name="_method" value="patch">
  <input name="job[line_items_attributes][0][qty]" type="number" value="3">
  <input name="job[line_items_attributes][1][qty]" type="number" value="4">
  <input name="job[photos][]" type="file">
</form>
<form action="/clients" method="get"><input name="q" value="jane"></form>
<form action="/users/sign_in" method="post"><input name="user[password]" type="password"></form>
<a href="/tags/9" data-method="delete">Delete</a>
<a href="/jobs/9/edit" data-method="get">Edit</a>
<a href="/timesheet_events/{{:id}}" data-method="delete">x</a>
<form action="/visits/email" method="post"><input name="subject"></form>`;

describe("form mining", () => {
  const forms = extractForms(PAGE, "https://app.singleops.com/clients/new");
  const routes = formsToRoutes([{ forms, pageUrl: "https://app.singleops.com/clients/new" }]);
  const by = (m: string, p: string) => routes.find((r: Route) => r.method === m && r.path === p);

  it("turns forms and data-method links into write routes", () => {
    expect(routes.map((r: Route) => `${r.method} ${r.path}`).sort()).toEqual(
      ["DELETE /tags/{id}", "DELETE /timesheet_events/{id}", "PATCH /jobs/{id}", "POST /clients", "POST /visits/email"].sort(),
    );
  });

  it("reads _method overrides, nested names, arrays and multipart", () => {
    const job = by("PATCH", "/jobs/{id}");
    expect(job.bodyKind).toBe("multipart");
    expect(railsFieldNames(job.body)).toEqual(["job[line_items_attributes][][qty]", "job[photos][]"]);
    expect(fieldPath("a[b][0][c]")).toEqual(["a", "b", "[]", "c"]);
  });

  it("keeps field names, never values, tokens or per-record ids", () => {
    const client = by("POST", "/clients");
    expect(railsFieldNames(client.body)).toEqual([
      "client[first_name]",
      "client[email]",
      "client[allow_sms]",
      "client[term_id]",
      "client[notes]",
    ]);
    const text = JSON.stringify(routes);
    for (const leak of ["Jane", "jane@example.com", "TOKEN-SECRET", "Net 30", "Gate code", "24416437", "password"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("denies sends to customers by policy", () => {
    expect(by("POST", "/visits/email")).toMatchObject({ policy: "deny", denyReason: "sends to customers" });
    expect(by("POST", "/clients").policy).toBeUndefined();
  });

  it("merges into the api map without overriding observed XHR routes", () => {
    const map = buildMap([{ log: { entries: [] } }], { formRoutes: routes });
    expect(map.routes.some((r: Route) => r.path === "/clients" && r.source === "form")).toBe(true);
  });
});

describe("Rails encoding", () => {
  it("brackets nested objects, indexes object arrays, 1/0 booleans", () => {
    expect(railsPairs({ job: { name: "A", on_hold: false, line_items_attributes: [{ qty: 2 }], tag_ids: [1, 2] } })).toEqual([
      ["job[name]", "A"],
      ["job[on_hold]", "0"],
      ["job[line_items_attributes][0][qty]", "2"],
      ["job[tag_ids][]", "1"],
      ["job[tag_ids][]", "2"],
    ]);
    expect(encodeForm({ client: { first_name: "ZZ Test" } })).toBe("client%5Bfirst_name%5D=ZZ+Test");
  });

  it("reads validation errors and redirect ids", () => {
    expect(railsErrors('<div id="error_explanation"><ul><li>Name can&#39;t <b>be</b> blank</li></ul></div>')).toEqual(["Name can&#39;t be blank"]);
    expect(railsErrors("<p>ok</p>")).toBeUndefined();
    expect(idFromLocation("https://app.singleops.com/clients/123")).toBe("123");
    expect(idFromLocation("/jobs/9/edit")).toBe("9");
  });
});

describe("write guard", () => {
  const del = route({ id: "delete_tags_id", method: "DELETE", path: "/tags/{id}", pathParams: ["id"], body: null, source: "link" });

  it("previews by default and sends only on dry_run:false", () => {
    expect(decideWrite(route({}), {}, cfg(), 0)).toEqual({ action: "preview" });
    expect(decideWrite(route({}), { dryRun: false }, cfg(), 0)).toEqual({ action: "send" });
    expect(decideWrite(route({ method: "GET" }), {}, cfg(), 0)).toEqual({ action: "read" });
  });

  it("refuses when gated off, denied, or over budget", () => {
    expect(decideWrite(route({}), { dryRun: false }, cfg({ enableWrite: false }), 0).action).toBe("refuse");
    expect(decideWrite(route({ policy: "deny", denyReason: "x" }), { dryRun: false }, cfg(), 0).action).toBe("refuse");
    expect(decideWrite(route({}), { dryRun: false }, cfg(), 2)).toMatchObject({ action: "refuse", reason: expect.stringMatching(/budget/) });
  });

  it("needs the delete flag and an exact confirm for the one record", () => {
    const on = cfg({ enableDelete: true });
    expect(decideWrite(del, { pathParams: { id: 42 }, dryRun: false }, cfg(), 0).action).toBe("refuse");
    expect(decideWrite(del, { pathParams: { id: 42 }, dryRun: false }, on, 0)).toMatchObject({ reason: expect.stringContaining('"DELETE /tags/42"') });
    expect(decideWrite(del, { pathParams: { id: 42 }, dryRun: false, confirm: "DELETE /tags/43" }, on, 0).action).toBe("refuse");
    expect(decideWrite(del, { pathParams: { id: 42 }, dryRun: false, confirm: "DELETE /tags/42" }, on, 0)).toEqual({ action: "send" });
  });

  it("previews the exact request and describes form fields", () => {
    const p = previewRoute(route({}), { body: { client: { first_name: "ZZ" } } }, "https://app.singleops.com");
    expect(p).toEqual({ method: "POST", url: "https://app.singleops.com/clients", encoding: "form", fields: [["client[first_name]", "ZZ"]] });
    expect(describeRoute(route({}))).toContain("client[first_name]");
    expect(describeRoute(route({}))).toContain("dry_run defaults to true");
  });
});

describe("client: Rails form writes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "so-"));
  const sessionFile = path.join(dir, "session.json");
  fs.writeFileSync(sessionFile, JSON.stringify({ cookies: [{ name: "_s", value: "v", domain: "app.singleops.com", path: "/", expires: -1 }], origins: [] }));
  const auth = () =>
    new SessionAuth(
      { scheme: "cookie+csrf", cookieNames: [], extraHeaders: { "x-requested-with": "XMLHttpRequest" }, csrf: { header: "x-csrf-token", source: "meta" } },
      "https://app.singleops.com",
      sessionFile,
    );
  const page = new Response('<meta name="csrf-token" content="CSRF1">', { status: 200 });

  it("sends a browser-style form and returns the redirected record id", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        if (init?.method === "POST") {
          calls.push(init);
          return new Response("", { status: 302, headers: { location: "https://app.singleops.com/clients/777" } });
        }
        return page.clone();
      }),
    );
    const res = await new SingleOpsClient(cfg(), auth()).callRoute(route({}), { body: { client: { first_name: "ZZ" } } });
    expect(res.data).toEqual({ ok: true, status: 302, redirect: "/clients/777", id: "777" });
    const h = calls[0].headers as Record<string, string>;
    expect(h["x-requested-with"]).toBeUndefined();
    expect(h.accept).toMatch(/text\/html/);
    expect(h["x-csrf-token"]).toBe("CSRF1");
    expect(calls[0].body).toBe("client%5Bfirst_name%5D=ZZ");
  });

  it("turns a re-rendered form with errors into a validation failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) =>
        init?.method === "POST"
          ? new Response('<div id="error_explanation"><li>First name can\'t be blank</li></div>', { status: 200 })
          : page.clone(),
      ),
    );
    const err = await new SingleOpsClient(cfg(), auth()).callRoute(route({}), { body: { client: {} } }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.body).toEqual({ errors: ["First name can't be blank"] });
  });

  it("sends multipart as FormData", async () => {
    let body: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        if (init?.method === "PATCH") {
          body = init.body;
          return new Response("", { status: 302, headers: { location: "/jobs/5" } });
        }
        return page.clone();
      }),
    );
    const r = route({ method: "PATCH", path: "/jobs/{id}", pathParams: ["id"], bodyKind: "multipart" });
    await new SingleOpsClient(cfg(), auth()).callRoute(r, { pathParams: { id: 5 }, body: { job: { name: "ZZ" } } });
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("job[name]")).toBe("ZZ");
  });
});

describe("guideline conformance", () => {
  it("names tools {service}_{read|write}_{verb}_{entity}", async () => {
    const { assignToolNames } = await import("../src/naming.js");
    const rs = [
      route({ id: "a", method: "GET", path: "/items", source: undefined }),
      route({ id: "b", method: "GET", path: "/visits/{id}.json", pathParams: ["id"] }),
      route({ id: "c", method: "POST", path: "/jobs/jobs_datatable", readOnly: true }),
      route({ id: "d", method: "PATCH", path: "/clients/{id}", pathParams: ["id"] }),
      route({ id: "e", method: "DELETE", path: "/tags/{id}", pathParams: ["id"] }),
      route({ id: "f", method: "GET", path: "/reports/net_sales" }),
      route({ id: "g", method: "PATCH", path: "/jobs/{id}/update_notes", pathParams: ["id"] }),
    ];
    expect([...assignToolNames(rs).values()]).toEqual([
      "singleops_read_list_items",
      "singleops_read_get_visit",
      "singleops_read_search_jobs",
      "singleops_write_update_client",
      "singleops_write_delete_tag",
      "singleops_read_get_net_sales_report",
      "singleops_write_update_job_notes",
    ]);
  });

  it("sets annotations by method", async () => {
    const { annotationsFor } = await import("../src/tools.js");
    expect(annotationsFor(route({ method: "GET" }))).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(annotationsFor(route({ method: "POST" }))).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(annotationsFor(route({ method: "DELETE" }))).toMatchObject({ destructiveHint: true });
  });

  it("renders markdown tables and the catalog covers every route plus meta tools", async () => {
    const { toMarkdown } = await import("../src/format.js");
    const { buildCatalog } = await import("../src/tools.js");
    expect(toMarkdown({ total: 2, data: [{ id: 1, name: "A|B" }, { id: 2, name: "<b>C</b>" }] })).toContain("| 1 | A\\|B |");
    const cat = buildCatalog([route({}), route({ id: "x", method: "POST", path: "/visits/email", policy: "deny", denyReason: "sends to customers" })]);
    expect(cat.length).toBe(7);
    expect(cat.find((c) => c.route_id === "x")?.kind).toBe("denied");
  });
});
