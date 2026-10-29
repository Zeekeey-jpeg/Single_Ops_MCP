import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError, SessionAuth, jwtExpiry, unwrapToken } from "../src/auth.js";
import { SingleOpsClient, retryDelayMs } from "../src/client.js";
import { LEAD_ROUTES, fillPath, type AuthSpec, type Route } from "../src/map.js";
import { isRegistrable } from "../src/tools.js";
import { assignToolNames } from "../src/naming.js";
import type { Config } from "../src/config.js";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp: number) => `${b64({ alg: "HS256" })}.${b64({ exp })}.sig`;

function tmpSession(state: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "so-"));
  const f = path.join(dir, "session.json");
  fs.writeFileSync(f, JSON.stringify(state));
  return f;
}

const cfg = (over: Partial<Config> = {}): Config => ({ enableWrite: false, enableDelete: false, maxWrites: 25, maxRps: 1000, baseUrl: "https://app.singleops.com", ...over });
const route = (over: Partial<Route>): Route => ({
  id: "get_api_v1_clients",
  method: "GET",
  path: "/api/v1/clients",
  pathParams: [],
  queryParams: [],
  bodyKind: null,
  body: null,
  response: null,
  statuses: [200],
  seen: 1,
  verified: false,
  auth: "session",
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("gates", () => {
  it("GET always; writes only with the flag; DELETE only with its own flag", () => {
    expect(isRegistrable(route({}), cfg())).toBe(true);
    expect(isRegistrable(route({ method: "POST" }), cfg())).toBe(false);
    expect(isRegistrable(route({ method: "POST" }), cfg({ enableWrite: true }))).toBe(true);
    expect(isRegistrable(route({ method: "DELETE" }), cfg({ enableWrite: true }))).toBe(false);
    expect(isRegistrable(route({ method: "DELETE" }), cfg({ enableDelete: true }))).toBe(true);
    expect(isRegistrable(route({ method: "POST", policy: "deny" }), cfg({ enableWrite: true }))).toBe(false);
  });
  it("tool names fit MCP's 64-char limit", () => {
    expect(assignToolNames([route({ path: "/" + "x".repeat(100) })]).get("get_api_v1_clients")!.length).toBeLessThanOrEqual(64);
  });
});

describe("token helpers", () => {
  it("unwraps JSON-wrapped tokens", () => {
    expect(unwrapToken('{"access_token":"abc.def.ghi"}')).toBe("abc.def.ghi");
    expect(unwrapToken('"plain"')).toBe("plain");
    expect(unwrapToken("raw")).toBe("raw");
  });
  it("reads JWT exp without verifying", () => {
    expect(jwtExpiry(jwt(2000000000))).toBe(2000000000 * 1000);
    expect(jwtExpiry("not-a-jwt")).toBeUndefined();
  });
  it("fills path params and refuses missing ones", () => {
    expect(fillPath("/clients/{id}/jobs/{job_id}", { id: 1, job_id: "a b" })).toBe("/clients/1/jobs/a%20b");
    expect(() => fillPath("/clients/{id}", {})).toThrow(/Missing path parameter/);
  });
});

describe("SessionAuth", () => {
  const cookies = [
    { name: "_singleops_session", value: "sess", domain: ".singleops.com", path: "/", expires: -1 },
    { name: "XSRF-TOKEN", value: "x%2Fy", domain: "app.singleops.com", path: "/", expires: 2000000000 },
    { name: "foreign", value: "no", domain: "example.com", path: "/", expires: -1 },
  ];

  it("replays host cookies, bearer from localStorage, CSRF from cookie on writes only", async () => {
    const spec: AuthSpec = {
      scheme: "bearer+cookie",
      cookieNames: [],
      extraHeaders: { "x-requested-with": "XMLHttpRequest" },
      bearer: { header: "Authorization", source: "localStorage:auth" },
      csrf: { header: "X-XSRF-TOKEN", source: "cookie:XSRF-TOKEN" },
    };
    const file = tmpSession({
      cookies,
      origins: [{ origin: "https://app.singleops.com", localStorage: [{ name: "auth", value: JSON.stringify({ token: jwt(4000000000) }) }] }],
    });
    const a = new SessionAuth(spec, "https://app.singleops.com", file);
    const get = await a.headers("GET");
    expect(get.cookie).toBe("_singleops_session=sess; XSRF-TOKEN=x%2Fy");
    expect(get.authorization).toMatch(/^Bearer ey/);
    expect(get["x-xsrf-token"]).toBeUndefined();
    expect(get["x-requested-with"]).toBe("XMLHttpRequest");
    expect((await a.headers("POST"))["x-xsrf-token"]).toBe("x/y");
  });

  it("fails clearly when the session is missing or the JWT expired", async () => {
    const spec: AuthSpec = { scheme: "bearer", cookieNames: [], extraHeaders: {}, bearer: { header: "Authorization", source: "cookie:jwt" } };
    await expect(new SessionAuth(spec, "https://app.singleops.com", "/nope/session.json").headers("GET")).rejects.toThrow(AuthError);
    const file = tmpSession({ cookies: [{ name: "jwt", value: jwt(1), domain: "app.singleops.com", path: "/", expires: -1 }], origins: [] });
    await expect(new SessionAuth(spec, "https://app.singleops.com", file).headers("GET")).rejects.toThrow(/expired/);
  });

  it("status never includes secret values", () => {
    const file = tmpSession({ cookies, origins: [] });
    const s = JSON.stringify(new SessionAuth({ scheme: "cookie", cookieNames: [], extraHeaders: {} }, "https://app.singleops.com", file).status());
    expect(s).not.toContain("sess\"");
    expect(s).not.toContain("x%2Fy");
    expect(s).toContain("_singleops_session");
  });
});

describe("SingleOpsClient", () => {
  const sessionFile = tmpSession({
    cookies: [{ name: "_singleops_session", value: "sess", domain: "app.singleops.com", path: "/", expires: -1 }],
    origins: [],
  });
  const auth = () => new SessionAuth({ scheme: "cookie", cookieNames: [], extraHeaders: {} }, "https://app.singleops.com", sessionFile);

  it("puts lead credentials in the query for GET and the body for POST", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }));
    const c = new SingleOpsClient(cfg({ leadUserEmail: "api@x", leadUserToken: "tok" }), auth());
    await c.callRoute(LEAD_ROUTES[2], { query: { search_field: "email", search_term: "a" } });
    expect(calls[0].url).toContain("user_email=api%40x");
    expect(calls[0].url).toContain("user_token=tok");
    await c.callRoute(LEAD_ROUTES[3], { body: { client_id: 1 } });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ client_id: 1, user_email: "api@x", user_token: "tok" });
  });

  it("treats 401 and sign-in redirects as auth failure without retrying", async () => {
    const f = vi.fn(async () => new Response("", { status: 302, headers: { location: "/users/sign_in" } }));
    vi.stubGlobal("fetch", f);
    await expect(new SingleOpsClient(cfg(), auth()).callRoute(route({}))).rejects.toThrow(AuthError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries 429 then succeeds", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (n++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response('{"ok":1}'))));
    const res = await new SingleOpsClient(cfg(), auth()).callRoute(route({}));
    expect(res.data).toEqual({ ok: 1 });
  });

  it("honours Retry-After and caps backoff", () => {
    expect(retryDelayMs(0, "2")).toBe(2000);
    expect(retryDelayMs(10, null)).toBeLessThanOrEqual(30_000);
  });
});
