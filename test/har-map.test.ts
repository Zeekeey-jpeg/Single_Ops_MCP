import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs module, no type declarations
import { buildMap, inferAuth, isReadOnly, mergeShapes, renderMarkdown, routeId, shapeOf, templatePath } from "../scripts/lib/har-map.mjs";

const SECRET_COOKIE = "s3cr3t-session-cookie-value";
const CSRF = "csrf-token-value-123";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig";

function entry(method: string, url: string, opts: { status?: number; reqBody?: unknown; form?: string; res?: unknown; headers?: Record<string, string> } = {}) {
  const headers = Object.entries({ cookie: `_singleops_session=${SECRET_COOKIE}; other=1`, ...(opts.headers ?? {}) }).map(([name, value]) => ({ name, value }));
  return {
    request: {
      method,
      url,
      headers,
      postData:
        opts.reqBody !== undefined
          ? { mimeType: "application/json", text: JSON.stringify(opts.reqBody) }
          : opts.form
            ? { mimeType: "application/x-www-form-urlencoded", text: opts.form }
            : undefined,
    },
    response: {
      status: opts.status ?? 200,
      content: opts.res !== undefined ? { mimeType: "application/json", text: JSON.stringify(opts.res) } : { mimeType: "text/html", text: "" },
    },
  };
}

const har = (...entries: unknown[]) => ({ log: { entries } });

describe("templatePath", () => {
  it("templates a single trailing id as {id}", () => {
    expect(templatePath("/api/v1/clients/123")).toEqual({ path: "/api/v1/clients/{id}", params: ["id"] });
  });
  it("names nested ids after their collection", () => {
    expect(templatePath("/api/v1/clients/12/jobs/34")).toEqual({
      path: "/api/v1/clients/{client_id}/jobs/{job_id}",
      params: ["client_id", "job_id"],
    });
  });
  it("handles .json suffixes, uuids and -ies plurals", () => {
    expect(templatePath("/properties/5/visits/0b7e5c1a-1111-4222-8333-944445555666.json").path).toBe(
      "/properties/{property_id}/visits/{visit_id}.json",
    );
  });
  it("leaves plain segments alone", () => {
    expect(templatePath("/api/v1/clients/search_by_field").params).toEqual([]);
  });
  it("builds stable route ids", () => {
    expect(routeId("GET", "/api/v1/clients/{id}.json")).toBe("get_api_v1_clients_id");
  });
});

describe("shapes", () => {
  it("infers and merges without keeping values", () => {
    const s = mergeShapes(shapeOf({ a: 1, b: "x" }), shapeOf({ a: 1.5, c: null }));
    expect(s).toEqual({ type: "object", properties: { a: { type: "number" }, b: { type: "string" }, c: { type: "null" } } });
  });
});

describe("buildMap", () => {
  const hars = [
    har(
      entry("GET", "https://app.singleops.com/api/v1/clients?page=2&q=jane&_=17", {
        res: { clients: [{ id: 1, name: "Jane Doe", email: "jane@example.com" }], meta: { total_pages: 9 } },
        headers: { "x-requested-with": "XMLHttpRequest" },
      }),
      entry("GET", "https://app.singleops.com/api/v1/clients/1", { res: { id: 1, name: "Jane Doe" } }),
      entry("GET", "https://app.singleops.com/api/v1/clients/2", { res: { id: 2, name: "John Roe", phone: "555-0100" } }),
      entry("POST", "https://app.singleops.com/api/v1/clients", {
        status: 201,
        reqBody: { client: { name: "ZZ-TEST-MCP", address: "1 Test St" } },
        res: { id: 3 },
        headers: { "x-csrf-token": CSRF },
      }),
      entry("PATCH", "https://app.singleops.com/clients/3", { form: "client%5Bname%5D=ZZ2&authenticity_token=abc", headers: { "x-csrf-token": CSRF } }),
      entry("GET", "https://app.singleops.com/assets/app.js"),
      entry("GET", "https://analytics.example.com/api/track", { res: {} }),
    ),
  ];
  const session = {
    cookies: [{ name: "_singleops_session", value: SECRET_COOKIE, domain: "app.singleops.com", path: "/", expires: -1 }],
    origins: [],
  };
  const map = buildMap(hars, { session, captureNames: ["t.har"] });

  it("collapses ids into one templated route and keeps API routes only", () => {
    const paths = map.routes.map((r: { method: string; path: string }) => `${r.method} ${r.path}`);
    expect(paths).toEqual(["GET /api/v1/clients", "POST /api/v1/clients", "GET /api/v1/clients/{id}"]);
    // The form PATCH to a non-/api, non-JSON path is not an API entry.
  });

  it("records query params (minus cache busters) and pagination", () => {
    const list = map.routes.find((r: { id: string }) => r.id === "get_api_v1_clients");
    expect(list.queryParams).toEqual(["page", "q"]);
    expect(list.pagination).toEqual({ params: ["page"], responseKeys: ["meta"] });
  });

  it("merges response shapes across observations", () => {
    const one = map.routes.find((r: { id: string }) => r.id === "get_api_v1_clients_id");
    expect(Object.keys(one.response.properties).sort()).toEqual(["id", "name", "phone"]);
    expect(one.seen).toBe(2);
  });

  it("detects cookie+csrf auth and keeps the safe extra header", () => {
    expect(map.auth.scheme).toBe("cookie+csrf");
    expect(map.auth.cookieNames).toEqual(["_singleops_session", "other"]);
    expect(map.auth.csrf).toEqual({ header: "x-csrf-token", source: "meta" });
    expect(map.auth.extraHeaders).toEqual({ "x-requested-with": "XMLHttpRequest" });
  });

  it("NEVER contains client values or secrets", () => {
    const text = JSON.stringify(map) + renderMarkdown(map);
    for (const leak of ["Jane Doe", "jane@example.com", "John Roe", "555-0100", "ZZ-TEST-MCP", "1 Test St", SECRET_COOKIE, CSRF, "jane"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("accumulates with a previous map and keeps hand edits", () => {
    const prev = JSON.parse(JSON.stringify(map));
    prev.routes[0].summary = "List clients";
    prev.routes[0].verified = true;
    prev.routes.push({ ...prev.routes[0], id: "get_api_v1_items", path: "/api/v1/items", summary: undefined, verified: false });
    const next = buildMap(hars, { session, previous: prev });
    const list = next.routes.find((r: { id: string }) => r.id === "get_api_v1_clients");
    expect(list.summary).toBe("List clients");
    expect(list.verified).toBe(true);
    expect(next.routes.some((r: { path: string }) => r.path === "/api/v1/items")).toBe(true);
  });
});

describe("isReadOnly", () => {
  it("treats Rails datatable/report POSTs as reads, never saves or auth", () => {
    expect(isReadOnly("POST", "/jobs/jobs_datatable")).toBe(true);
    expect(isReadOnly("POST", "/reports/tree_inventory_report")).toBe(true);
    expect(isReadOnly("POST", "/invoices/invoice_totals")).toBe(true);
    expect(isReadOnly("POST", "/users/save_table_settings")).toBe(false);
    expect(isReadOnly("POST", "/clients")).toBe(false);
    expect(isReadOnly("PATCH", "/jobs/{id}/data_table")).toBe(false);
  });
  it("drops auth endpoints from the map entirely", () => {
    const m = buildMap([har(entry("POST", "https://app.singleops.com/users/sign_in", { reqBody: { user: {} }, res: {} }))]);
    expect(m.routes).toEqual([]);
  });
});

describe("inferAuth", () => {
  it("locates a bearer JWT in localStorage by value, storing only the key", () => {
    const e = entry("GET", "https://app.singleops.com/api/v1/me", { res: {}, headers: { authorization: `Bearer ${JWT}` } });
    const auth = inferAuth([e], {
      cookies: [],
      origins: [{ origin: "https://app.singleops.com", localStorage: [{ name: "auth", value: JSON.stringify({ token: JWT }) }] }],
    });
    expect(auth.bearer).toEqual({ header: "Authorization", source: "localStorage:auth" });
    expect(auth.scheme).toBe("bearer+cookie");
    expect(JSON.stringify(auth)).not.toContain(JWT);
  });

  it("locates a CSRF token mirrored in a cookie", () => {
    const e = entry("POST", "https://app.singleops.com/api/v1/x", { reqBody: {}, res: {}, headers: { "x-xsrf-token": "a b" } });
    const auth = inferAuth([e], { cookies: [{ name: "XSRF-TOKEN", value: "a%20b" }], origins: [] });
    expect(auth.csrf).toEqual({ header: "x-xsrf-token", source: "cookie:XSRF-TOKEN" });
  });
});
