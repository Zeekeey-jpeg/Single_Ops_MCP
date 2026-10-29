/**
 * HTTP client: throttled, retrying, map-bound.
 *
 * - Only routes from the map can be called (callRoute takes a Route, never a URL).
 * - One request at a time, spaced to SINGLEOPS_MAX_RPS. The API is undocumented
 *   and the account is a live business's: politeness is a safety property.
 * - 429 and 5xx retry with exponential backoff + full jitter, honouring
 *   Retry-After (pattern from sanjibani/singleops-mcp, MIT).
 * - 401/403 never retry: they mean the session is gone, and hammering a login
 *   wall is how accounts get locked.
 */

import type { Config } from "./config.js";
import { AuthError, SessionAuth } from "./auth.js";
import { fillPath, type Route } from "./map.js";
import { audit, shapeOf } from "./audit.js";
import { encodeForm, encodeMultipart, idFromLocation, railsErrors, railsPairs } from "./rails.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface CallArgs {
  pathParams?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Skip 429/5xx retries (probes that should report fast rather than wait out backoff). */
  noRetry?: boolean;
}

export interface CallResult {
  status: number;
  data: unknown;
}

const MAX_RETRIES = 3;

/** Routes mined from Rails HTML forms/links behave like a browser submit, not an XHR API. */
const isFormRoute = (r: Route) => r.source === "form" || r.source === "link";

export interface WritePreview {
  method: string;
  url: string;
  encoding: string;
  fields: [string, string][];
}

/** What a write would send, without sending it or touching the session. */
export function previewRoute(route: Route, args: CallArgs, baseUrl: string): WritePreview {
  const url = new URL(fillPath(route.path, args.pathParams ?? {}), baseUrl);
  for (const [k, v] of Object.entries(args.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  return {
    method: route.method,
    url: url.toString(),
    encoding: route.bodyKind ?? "none",
    fields: route.bodyKind === "json" ? [["(json)", JSON.stringify(args.body ?? {})]] : railsPairs(args.body ?? {}),
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function retryDelayMs(attempt: number, retryAfterHeader?: string | null): number {
  const ra = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 60_000);
  const cap = Math.min(1000 * 2 ** attempt, 30_000);
  return Math.random() * cap;
}

export class SingleOpsClient {
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(
    private readonly cfg: Config,
    private readonly auth: SessionAuth,
  ) {}

  /** Serialises calls and spaces them to maxRps. */
  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const gap = 1000 / this.cfg.maxRps;
    const run = async () => {
      const wait = this.lastAt + gap - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastAt = Date.now();
      return fn();
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async buildRequest(route: Route, args: CallArgs): Promise<{ url: string; init: RequestInit }> {
    const url = new URL(fillPath(route.path, args.pathParams ?? {}), this.cfg.baseUrl);
    for (const [k, v] of Object.entries(args.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    let headers: Record<string, string>;
    let body = args.body;

    if (route.auth === "lead_token") {
      if (!this.cfg.leadUserEmail || !this.cfg.leadUserToken) {
        throw new AuthError(
          "Lead Entry credentials missing. Set SINGLEOPS_LEAD_USER_EMAIL and SINGLEOPS_LEAD_USER_TOKEN in .env.",
        );
      }
      headers = { accept: "application/json" };
      if (route.method === "GET") {
        url.searchParams.set("user_email", this.cfg.leadUserEmail);
        url.searchParams.set("user_token", this.cfg.leadUserToken);
      } else {
        body = { ...(body as object), user_email: this.cfg.leadUserEmail, user_token: this.cfg.leadUserToken };
      }
    } else {
      headers = await this.auth.headers(route.method);
      if (isFormRoute(route)) {
        if (route.remote) {
          headers.accept = "text/javascript, application/javascript, */*; q=0.01";
          headers["x-requested-with"] = "XMLHttpRequest";
        } else {
          headers.accept = "text/html,application/xhtml+xml";
          delete headers["x-requested-with"];
        }
      }
    }

    const init: RequestInit = { method: route.method, headers, redirect: "manual" };
    if (body !== undefined && route.method !== "GET") {
      if (route.bodyKind === "form") {
        headers["content-type"] = "application/x-www-form-urlencoded";
        init.body = encodeForm(body);
      } else if (route.bodyKind === "multipart") {
        init.body = encodeMultipart(body); // fetch sets the multipart boundary header
      } else {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
    }
    return { url: url.toString(), init };
  }

  async callRoute(route: Route, args: CallArgs = {}): Promise<CallResult> {
    const isWrite = route.method !== "GET" && !route.readOnly;
    for (let attempt = 0; ; attempt++) {
      const { url, init } = await this.buildRequest(route, args);
      const res = await this.throttled(() => fetch(url, init));
      const text = await res.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }

      // A redirect to the sign-in page is how session apps say "logged out".
      const location = res.headers.get("location") ?? "";
      if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400 && /sign_in|login/i.test(location))) {
        audit({ kind: "auth_failed", route: route.id, status: res.status });
        throw new AuthError(
          `SingleOps rejected the session (HTTP ${res.status}). Run \`npm run login\` to refresh it.`,
        );
      }

      // Rails answers a stale CSRF token with 422/419: refresh once and retry.
      if (isWrite && (res.status === 419 || res.status === 422) && attempt === 0 && /csrf|authenticity/i.test(text)) {
        this.auth.resetCsrf();
        continue;
      }

      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES && !args.noRetry) {
        await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
        continue;
      }

      // A Rails form says "saved" with a redirect to the record and "rejected" by
      // re-rendering the form with an error block. Translate both.
      const detail = { method: route.method, path: route.path, pathParams: args.pathParams, bodyKeys: shapeOf(args.body) };
      let outcome: unknown;
      if (isWrite && isFormRoute(route)) {
        if (res.status >= 300 && res.status < 400) {
          outcome = { ok: true, status: res.status, redirect: new URL(location, this.cfg.baseUrl).pathname, id: idFromLocation(location) };
        } else if (res.ok) {
          const errors = typeof data === "string" ? railsErrors(data) : undefined;
          if (errors) {
            audit({ kind: "write_failed", route: route.id, status: 422, detail });
            throw new ApiError(`SingleOps rejected ${route.method} ${route.path}: validation failed`, 422, { errors });
          }
          outcome = typeof data === "string" ? { ok: true, status: res.status, note: "Accepted (non-JSON response)." } : data;
        }
      }

      if (isWrite) {
        audit({ kind: res.ok || outcome ? "write" : "write_failed", route: route.id, status: res.status, detail });
      }

      if (outcome !== undefined) return { status: res.status, data: outcome };
      if (!res.ok) {
        throw new ApiError(`SingleOps ${route.method} ${route.path} failed: HTTP ${res.status}`, res.status, data);
      }
      return { status: res.status, data };
    }
  }
}
